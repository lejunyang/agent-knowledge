/**
 * Ingestion core 编排 Connector -> 脱敏 -> Vault -> source manifest -> checkpoint。
 *
 * 每个 source 生成可重放 job；只有 completed/skipped 才推进 checkpoint，failed 保持待重试。
 * 完整内容只写 Vault，Git 事实层只写版本、section、redaction 摘要和 Vault handle。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  buildSourceManifest,
  buildSourceVersion,
  classifySourceUpdate,
  compareSourceVersionProbe,
  SourceManifestSchema,
  type SourceUpdateClassification,
  type SourceManifest
} from "../storage/sourceManifest.js";
import {
  getVaultObjectPath,
  putVaultObject,
  type VaultOptions
} from "../vault/core.js";
import {
  EVIDENCE_REDACTION_PROFILE,
  redactEvidenceText,
  redactIngestionError
} from "./redaction.js";
import {
  ConnectorIdSchema,
  ConnectorInventoryIdentitySchema,
  ConnectorProcessingProfileSchema,
  ConnectorSourceDescriptorSchema,
  EvidenceRedactionPolicySchema,
  type ConnectorCursor,
  type EvidenceRedactionPolicy,
  type IngestionJob,
  type IngestionRunResult,
  type KnowledgeConnector
} from "./types.js";

/**
 * Ingestion core profile 覆盖 manifest/section 编排算法。
 *
 * 修改 source manifest 构建、section 切分或 Vault/manifest 对齐语义时必须递增，使上游版本
 * 未变的 source 也重新处理；Connector normalize 与 redaction profile 会额外拼入。
 */
export const INGESTION_CORE_PROFILE = "ingestion-core-v1";

/** 生成 job/checkpoint 文件名使用的稳定短 hash。 */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

/** 返回 Connector 单实例锁路径；锁属于可恢复运行状态，不进入 Git。 */
export function getConnectorLockPath(
  rootDir: string,
  connectorId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "locks",
    `${shortHash(connectorId)}.lock`
  );
}

/** 返回 connector checkpoint 路径。 */
export function getConnectorCheckpointPath(
  rootDir: string,
  connectorId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "checkpoints",
    `${shortHash(connectorId)}.json`
  );
}

/** 返回单个 ingestion job 路径。 */
export function getIngestionJobPath(rootDir: string, jobId: string): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "jobs",
    `${jobId}.json`
  );
}

/** 返回 Git 可跟踪 source manifest 路径。 */
export function getSourceManifestPath(
  rootDir: string,
  sourceId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    "knowledge",
    "source-manifests",
    `${sourceId}.json`
  );
}

/** 原子写 checkpoint、job 或 source manifest；敏感运行状态可显式收紧权限。 */
async function writeAtomic(
  target: string,
  content: string,
  mode = 0o644
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, target);
}

/** 检查本机 PID 是否仍存活；权限错误也视为存活，避免误删他人进程锁。 */
function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
    );
  }
}

/**
 * 获取 Connector 互斥锁。
 *
 * 同一 Connector 并发运行会产生 checkpoint 丢失更新，因此必须在 discover 前加锁。
 * 进程崩溃留下且 PID 已不存在的锁可删除一次重试；存活或无法解析的锁一律拒绝。
 */
async function acquireConnectorLock(
  rootDir: string,
  connectorId: string
): Promise<{ path: string; token: string }> {
  const lockPath = getConnectorLockPath(rootDir, connectorId);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const content = `${JSON.stringify({
    version: 1,
    connectorId,
    pid: process.pid,
    token,
    createdAt: new Date().toISOString()
  })}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, content, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      return { path: lockPath, token };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      let owner: { pid?: unknown } = {};
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
        };
      } catch {
        throw new Error(`Connector ingestion is already locked: ${connectorId}`);
      }
      if (
        typeof owner.pid !== "number" ||
        processIsAlive(owner.pid) ||
        attempt > 0
      ) {
        throw new Error(`Connector ingestion is already locked: ${connectorId}`);
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Connector ingestion is already locked: ${connectorId}`);
}

/** 只释放自己持有的锁，避免旧进程 finally 删除新进程刚取得的锁。 */
async function releaseConnectorLock(lock: {
  path: string;
  token: string;
}): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lock.path, "utf8")) as {
      token?: unknown;
    };
    if (current.token === lock.token) {
      await rm(lock.path, { force: true });
    }
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

/**
 * 在 Connector 互斥锁内执行操作。
 *
 * Source review 与 ingestion 必须复用同一把锁；否则 reviewer 校验完 fingerprint 后，
 * Connector 仍可能更新 manifest，随后旧 reviewer 会覆盖新版本。锁覆盖完整 callback，
 * finally 只释放当前 token 持有的锁。
 */
export async function withConnectorIngestionLock<T>(
  rootDir: string,
  connectorId: string,
  operation: () => Promise<T>
): Promise<T> {
  const parsedConnectorId = ConnectorIdSchema.parse(connectorId);
  const lock = await acquireConnectorLock(rootDir, parsedConnectorId);
  try {
    return await operation();
  } finally {
    await releaseConnectorLock(lock);
  }
}

/** 读取 connector checkpoint；缺失时返回 null。 */
export async function readConnectorCheckpoint(
  rootDir: string,
  connectorId: string
): Promise<ConnectorCursor | null> {
  const target = getConnectorCheckpointPath(rootDir, connectorId);
  if (!existsSync(target)) {
    return null;
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as ConnectorCursor;
  if (
    parsed.version !== 1 ||
    parsed.connectorId !== connectorId ||
    (parsed.inventoryIdentity !== undefined &&
      typeof parsed.inventoryIdentity !== "string") ||
    typeof parsed.updatedAt !== "string" ||
    !parsed.sources ||
    typeof parsed.sources !== "object" ||
    Array.isArray(parsed.sources)
  ) {
    throw new Error(`Invalid connector checkpoint: ${connectorId}`);
  }
  return parsed;
}

/** 读取已有 source manifest；缺失表示首次摄入。 */
async function readSourceManifest(
  rootDir: string,
  sourceId: string
): Promise<SourceManifest | null> {
  const target = getSourceManifestPath(rootDir, sourceId);
  if (!existsSync(target)) {
    return null;
  }
  return SourceManifestSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** job ID 包含随机 attempt ID，避免同毫秒内重试覆盖审计记录。 */
function ingestionJobId(
  connectorId: string,
  sourceId: string,
  probe: unknown
): string {
  return `ingest_${shortHash(
    JSON.stringify({ connectorId, sourceId, probe, attempt: randomUUID() })
  )}`;
}

/** 写入完成或失败 job；error 只保存 message，不含原始 payload/stack。 */
async function writeJob(rootDir: string, job: IngestionJob): Promise<void> {
  await writeAtomic(
    getIngestionJobPath(rootDir, job.id),
    `${JSON.stringify(job, null, 2)}\n`,
    0o600
  );
}

/** 推进单个 source checkpoint；调用前必须确保 job 已成功持久化。 */
async function updateCheckpoint(
  rootDir: string,
  cursor: ConnectorCursor,
  input: {
    sourceId: string;
    versionFingerprint: string;
    lastCheckedAt: string;
    lastClassification: string;
  }
): Promise<void> {
  cursor.sources[input.sourceId] = {
    sourceId: input.sourceId,
    versionFingerprint: input.versionFingerprint,
    lastCheckedAt: input.lastCheckedAt,
    lastClassification: input.lastClassification
  };
  cursor.updatedAt = input.lastCheckedAt;
  await writeAtomic(
    getConnectorCheckpointPath(rootDir, cursor.connectorId),
    `${JSON.stringify(cursor, null, 2)}\n`,
    0o600
  );
}

/** 实际执行有界摄入；外层函数负责 Connector 互斥锁。 */
async function runConnectorIngestionLocked(
  rootDir: string,
  connector: KnowledgeConnector,
  options: {
    vault: VaultOptions;
    redactionPolicy: EvidenceRedactionPolicy;
    limit?: number;
    now?: () => Date;
  }
): Promise<IngestionRunResult> {
  const connectorId = ConnectorIdSchema.parse(connector.id);
  const connectorProcessingProfile = ConnectorProcessingProfileSchema.parse(
    connector.processingProfile
  );
  const processingProfile = `${INGESTION_CORE_PROFILE}:${connectorProcessingProfile}:${EVIDENCE_REDACTION_PROFILE}:${options.redactionPolicy}`;
  const previousCursor = await readConnectorCheckpoint(rootDir, connector.id);
  const rawInventoryIdentity =
    await connector.inventoryIdentity?.() ?? undefined;
  const inventoryIdentity =
    rawInventoryIdentity === undefined
      ? undefined
      : ConnectorInventoryIdentitySchema.parse(rawInventoryIdentity);
  if (connector.inventoryMode === "complete" && !inventoryIdentity) {
    throw new Error(
      `Complete inventory Connector requires a stable inventory identity: ${connector.id}`
    );
  }
  if (
    previousCursor &&
    (previousCursor.inventoryIdentity ?? undefined) !== inventoryIdentity
  ) {
    throw new Error(
      `Connector inventory identity changed; use a new connector ID: ${connector.id}`
    );
  }
  const cursor: ConnectorCursor =
    previousCursor ?? {
      version: 1,
      connectorId: connector.id,
      ...(inventoryIdentity ? { inventoryIdentity } : {}),
      updatedAt: new Date(0).toISOString(),
      sources: {}
    };
  const jobs: IngestionJob[] = [];
  const discoveredSourceIds = new Set<string>();
  let discovered = 0;
  const limit = Math.max(0, options.limit ?? Number.MAX_SAFE_INTEGER);
  // 显式 limit 代表有界抽样，即使实际数量小于 limit 也不能证明 inventory 完整。
  let inventoryTruncated = options.limit !== undefined;
  const inventoryVersion = await connector.inventoryVersion?.() ?? null;

  for await (const discoveredDescriptor of connector.discover(previousCursor)) {
    if (discovered >= limit) {
      inventoryTruncated = true;
      break;
    }
    discovered += 1;
    const descriptor = ConnectorSourceDescriptorSchema.parse(
      discoveredDescriptor
    );
    if (descriptor.connectorId !== connector.id) {
      throw new Error(
        `Connector descriptor ID mismatch: ${descriptor.connectorId}`
      );
    }
    discoveredSourceIds.add(descriptor.sourceId);
    if (
      (descriptor.artifactKind === "transcript" ||
        descriptor.artifactKind === "tool_trace") &&
      options.redactionPolicy !== "secrets-and-pii"
    ) {
      throw new Error(
        `${descriptor.artifactKind} ingestion requires secrets-and-pii redaction`
      );
    }
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const persistedExternalKey = redactEvidenceText(
      descriptor.externalKey,
      options.redactionPolicy
    ).text;
    const persistedTitle = redactEvidenceText(
      descriptor.title,
      options.redactionPolicy
    ).text;
    const jobId = ingestionJobId(
      connector.id,
      descriptor.sourceId,
      descriptor.probe
    );
    const previousManifest = await readSourceManifest(
      rootDir,
      descriptor.sourceId
    );
    if (
      previousManifest &&
      previousManifest.availability === "available" &&
      previousManifest.processing_profile === processingProfile &&
      previousManifest.vault_object !== undefined &&
      existsSync(getVaultObjectPath(rootDir, previousManifest.vault_object)) &&
      compareSourceVersionProbe(previousManifest.version, descriptor.probe) ===
        "unchanged"
    ) {
      const refreshedVersion = buildSourceVersion({
        observedAt: descriptor.probe.observed_at,
        upstream: descriptor.probe.upstream,
        contentHash: previousManifest.version.content_hash
      });
      const refreshedManifest = SourceManifestSchema.parse({
        ...previousManifest,
        version: refreshedVersion
      });
      const manifestPath = getSourceManifestPath(
        rootDir,
        descriptor.sourceId
      );
      if (
        refreshedVersion.fingerprint !==
        previousManifest.version.fingerprint
      ) {
        await writeAtomic(
          manifestPath,
          `${JSON.stringify(refreshedManifest, null, 2)}\n`
        );
      }
      const classification =
        refreshedVersion.fingerprint ===
        previousManifest.version.fingerprint
          ? "unchanged"
          : "metadata_only";
      const job: IngestionJob = {
        version: 1,
        id: jobId,
        connectorId: connector.id,
        sourceId: descriptor.sourceId,
        externalKey: persistedExternalKey,
        status: "skipped",
        startedAt,
        finishedAt: (options.now?.() ?? new Date()).toISOString(),
        classification,
        skipReason: "upstream_version_unchanged",
        vaultObject: previousManifest.vault_object,
        sourceManifestPath: manifestPath
      };
      await writeJob(rootDir, job);
      await updateCheckpoint(rootDir, cursor, {
        sourceId: descriptor.sourceId,
        versionFingerprint: refreshedVersion.fingerprint,
        lastCheckedAt: job.finishedAt,
        lastClassification: classification
      });
      jobs.push(job);
      continue;
    }

    try {
      const raw = await connector.fetch(descriptor);
      const normalized = await connector.normalize(descriptor, raw);
      if (
        !normalized.bytes.equals(
          Buffer.from(normalized.textForManifest, "utf8")
        )
      ) {
        throw new Error(
          `Connector normalized bytes differ from manifest text: ${descriptor.externalKey}`
        );
      }
      const redacted = redactEvidenceText(
        normalized.textForManifest,
        options.redactionPolicy
      );
      const redactedBytes = Buffer.from(redacted.text, "utf8");
      const vaultObject = await putVaultObject(
        rootDir,
        {
          bytes: redactedBytes,
          contentType: normalized.contentType
        },
        options.vault
      );
      const manifest = buildSourceManifest({
        sourceId: descriptor.sourceId,
        connector: descriptor.connectorId,
        artifactKind: descriptor.artifactKind,
        externalKey: persistedExternalKey,
        title: persistedTitle,
        content: redacted.text,
        observedAt: descriptor.probe.observed_at,
        upstreamVersion: descriptor.probe.upstream,
        projectKeys: descriptor.projectKeys,
        contentType: normalized.contentType,
        contentBytes: redactedBytes.length,
        redactionPolicy: options.redactionPolicy,
        processingProfile,
        redactions: redacted.counts,
        processingStatus: "pending",
        vaultObject: vaultObject.id
      });
      const contentClassification = classifySourceUpdate(
        previousManifest,
        manifest
      );
      const classification: SourceUpdateClassification =
        contentClassification === "unchanged" &&
        previousManifest?.processing_profile !== manifest.processing_profile
          ? "metadata_only"
          : contentClassification;
      const processingStatus =
        classification !== "content_changed" &&
        classification !== "restored" &&
        previousManifest
          ? previousManifest.processing_status
          : "pending";
      const finalizedManifest =
        processingStatus === manifest.processing_status
          ? manifest
          : SourceManifestSchema.parse({
              ...manifest,
              processing_status: processingStatus,
              ...(previousManifest?.processing_reason
                ? { processing_reason: previousManifest.processing_reason }
                : {}),
              ...(previousManifest?.duplicate_of
                ? { duplicate_of: previousManifest.duplicate_of }
                : {}),
              ...(previousManifest?.processed_at
                ? { processed_at: previousManifest.processed_at }
                : {}),
              ...(previousManifest?.processed_content_hash
                ? {
                    processed_content_hash:
                      previousManifest.processed_content_hash
                  }
                : {}),
              refined_knowledge_ids:
                previousManifest?.refined_knowledge_ids ?? []
            });
      const reviewSafeManifest =
        classification === "content_changed" || classification === "restored"
          ? SourceManifestSchema.parse({
              ...finalizedManifest,
              processing_status: "pending",
              processing_reason: undefined,
              duplicate_of: undefined,
              processed_at: undefined,
              processed_content_hash: undefined,
              refined_knowledge_ids: []
            })
          : finalizedManifest;
      const manifestPath = getSourceManifestPath(rootDir, descriptor.sourceId);
      await writeAtomic(
        manifestPath,
        `${JSON.stringify(reviewSafeManifest, null, 2)}\n`
      );
      const finishedAt = (options.now?.() ?? new Date()).toISOString();
      const job: IngestionJob = {
        version: 1,
        id: jobId,
        connectorId: connector.id,
        sourceId: descriptor.sourceId,
        externalKey: persistedExternalKey,
        status: "completed",
        startedAt,
        finishedAt,
        classification,
        vaultObject: vaultObject.id,
        sourceManifestPath: manifestPath,
        redactions: redacted.counts
      };
      await writeJob(rootDir, job);
      await updateCheckpoint(rootDir, cursor, {
        sourceId: descriptor.sourceId,
        versionFingerprint: reviewSafeManifest.version.fingerprint,
        lastCheckedAt: finishedAt,
        lastClassification: classification
      });
      jobs.push(job);
    } catch (error) {
      const job: IngestionJob = {
        version: 1,
        id: jobId,
        connectorId: connector.id,
        sourceId: descriptor.sourceId,
        externalKey: persistedExternalKey,
        status: "failed",
        startedAt,
        finishedAt: (options.now?.() ?? new Date()).toISOString(),
        error: redactIngestionError(error, options.redactionPolicy)
      };
      await writeJob(rootDir, job);
      jobs.push(job);
    }
  }

  if (connector.inventoryMode === "complete" && !inventoryTruncated) {
    for (const previousSourceId of Object.keys(previousCursor?.sources ?? {})) {
      if (discoveredSourceIds.has(previousSourceId)) {
        continue;
      }
      const previousManifest = await readSourceManifest(
        rootDir,
        previousSourceId
      );
      if (
        !previousManifest ||
        previousManifest.connector !== connector.id ||
        previousManifest.availability === "missing"
      ) {
        continue;
      }
      const startedAt = (options.now?.() ?? new Date()).toISOString();
      const removedManifest = SourceManifestSchema.parse({
        ...previousManifest,
        availability: "missing",
        missing_since: startedAt,
        ...(inventoryVersion
          ? {
              version: buildSourceVersion({
                observedAt: inventoryVersion.observed_at,
                upstream: {
                  ...previousManifest.version.upstream,
                  ...inventoryVersion.upstream
                },
                contentHash: previousManifest.version.content_hash
              })
            }
          : {}),
        processing_status: "pending",
        processing_reason: undefined,
        duplicate_of: undefined,
        processed_at: undefined,
        processed_content_hash: undefined,
        refined_knowledge_ids: []
      });
      const manifestPath = getSourceManifestPath(rootDir, previousSourceId);
      await writeAtomic(
        manifestPath,
        `${JSON.stringify(removedManifest, null, 2)}\n`
      );
      const finishedAt = (options.now?.() ?? new Date()).toISOString();
      const job: IngestionJob = {
        version: 1,
        id: ingestionJobId(
          connector.id,
          previousSourceId,
          removedManifest.version
        ),
        connectorId: connector.id,
        sourceId: previousSourceId,
        externalKey: previousManifest.external_key,
        status: "completed",
        startedAt,
        finishedAt,
        classification: "removed",
        vaultObject: previousManifest.vault_object,
        sourceManifestPath: manifestPath
      };
      await writeJob(rootDir, job);
      await updateCheckpoint(rootDir, cursor, {
        sourceId: previousSourceId,
        versionFingerprint: removedManifest.version.fingerprint,
        lastCheckedAt: finishedAt,
        lastClassification: "removed"
      });
      jobs.push(job);
    }
  }

  return {
    connectorId: connector.id,
    discovered,
    completed: jobs.filter((job) => job.status === "completed").length,
    skipped: jobs.filter((job) => job.status === "skipped").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    jobs,
    checkpointPath: getConnectorCheckpointPath(rootDir, connector.id)
  };
}

/**
 * 对单个 Connector 执行有界增量摄入。
 *
 * completed/skipped source 才推进 checkpoint；单 source 失败写审计 job 并允许后续重试。
 * 同一 Connector 在同一 workspace 中互斥运行，防止并发 checkpoint 覆盖。
 */
export async function runConnectorIngestion(
  rootDir: string,
  connector: KnowledgeConnector,
  options: {
    vault: VaultOptions;
    redactionPolicy: EvidenceRedactionPolicy;
    limit?: number;
    now?: () => Date;
  }
): Promise<IngestionRunResult> {
  const connectorId = ConnectorIdSchema.parse(connector.id);
  ConnectorProcessingProfileSchema.parse(connector.processingProfile);
  EvidenceRedactionPolicySchema.parse(options.redactionPolicy);
  if (
    options.limit !== undefined &&
    (!Number.isSafeInteger(options.limit) || options.limit < 0)
  ) {
    throw new Error("ingest limit must be a non-negative safe integer");
  }
  return withConnectorIngestionLock(rootDir, connectorId, () =>
    runConnectorIngestionLocked(rootDir, connector, options)
  );
}
