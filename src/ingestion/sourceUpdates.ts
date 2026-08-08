/**
 * Source update checker 只读取 Connector probe 与本地 manifest，绝不抓取正文。
 *
 * 报告位于 `.memory`，用于回答“哪些来源可能更新”；它不会更新 source manifest、Vault、
 * checkpoint 或审阅 receipt。确定性 content change 依赖 path/blob hash，只有 revision、
 * ETag、mtime 等信号变化时标为 update_unknown，等待显式 ingestion 抓取后确认 content hash。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  SourceManifestSchema,
  SourceVersionProbeSchema,
  SourceVersionSchema,
  UpstreamVersionSchema,
  type SourceManifest,
  type SourceVersion,
  type SourceVersionProbe
} from "../storage/sourceManifest.js";
import { getVaultObjectPath } from "../vault/core.js";
import {
  buildIngestionProcessingProfile,
  withConnectorIngestionLock
} from "./core.js";
import {
  ConnectorInventoryIdentitySchema,
  ConnectorInventoryStatusSchema,
  ConnectorSourceDescriptorSchema,
  type KnowledgeConnector
} from "./types.js";
import {
  ConnectorRegistrationSchema,
  listConnectorRegistrations,
  type ConnectorRegistration
} from "./registry.js";

/** probe-only 检查输出的精确状态；unknown 与确定更新分开，避免虚假确定性。 */
export const SourceUpdateStateSchema = z.enum([
  "new",
  "unchanged",
  "metadata_only",
  "content_changed",
  "update_unknown",
  "processing_profile_changed",
  "evidence_missing",
  "removed",
  "restored"
]);

export type SourceUpdateState = z.output<typeof SourceUpdateStateSchema>;

const UpstreamVersionFieldSchema = z.enum([
  "path_hash",
  "commit_sha",
  "revision",
  "etag",
  "opaque_version",
  "updated_at"
]);

const SourceUpdateItemSchema = z
  .object({
    sourceId: z.string().regex(/^src_[A-Za-z0-9_.-]+$/),
    state: SourceUpdateStateSchema,
    reason: z.string().min(1),
    requiresIngestion: z.boolean(),
    requiresDistillation: z.boolean(),
    verificationRequired: z.boolean(),
    changedFields: z.array(UpstreamVersionFieldSchema),
    previousVersion: SourceVersionSchema.optional(),
    observedProbe: SourceVersionProbeSchema.optional()
  })
  .strict();

export type SourceUpdateItem = z.output<typeof SourceUpdateItemSchema>;

const SourceUpdateSummarySchema = z
  .object({
    new: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    metadata_only: z.number().int().nonnegative(),
    content_changed: z.number().int().nonnegative(),
    update_unknown: z.number().int().nonnegative(),
    processing_profile_changed: z.number().int().nonnegative(),
    evidence_missing: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    restored: z.number().int().nonnegative(),
    updatesAvailable: z.number().int().nonnegative(),
    verificationRequired: z.number().int().nonnegative()
  })
  .strict();

const SourceUpdateInventorySchema = z
  .object({
    mode: z.enum(["partial", "complete"]),
    complete: z.boolean(),
    unresolved: z.number().int().nonnegative(),
    removalsEvaluated: z.boolean(),
    discovered: z.number().int().nonnegative(),
    tracked: z.number().int().nonnegative(),
    reason: z.string().min(1).optional()
  })
  .strict();

/** 更新报告明确记录无网络边界和所检查快照类型。 */
export const SourceUpdateReportSchema = z
  .object({
    version: z.literal(1),
    connectorId: z.string().min(1),
    connectorKind: z.enum([
      "files",
      "transcripts",
      "git",
      "lark-export"
    ]),
    checkedAt: z.string().datetime(),
    registrationUpdatedAt: z.string().datetime(),
    registrationGeneration: z
      .string()
      .regex(/^registration_sha256_[a-f0-9]{64}$/),
    scopeFingerprint: z
      .string()
      .regex(/^scope_sha256_[a-f0-9]{64}$/),
    networkAccess: z.literal("none"),
    freshnessBoundary: z.enum([
      "local-filesystem",
      "local-git-ref",
      "offline-lark-export"
    ]),
    inventory: SourceUpdateInventorySchema,
    summary: SourceUpdateSummarySchema,
    items: z.array(SourceUpdateItemSchema)
  })
  .strict();

export type SourceUpdateReport = z.output<typeof SourceUpdateReportSchema>;

export type ConnectorSourceUpdateHealth = {
  connectorId: string;
  connectorKind: ConnectorRegistration["kind"];
  state: "unchecked" | "current" | "stale";
  registrationUpdatedAt: string;
  checkedAt?: string;
  updatesAvailable: number;
  verificationRequired: number;
};

export type SourceUpdateHealth = {
  registeredConnectors: number;
  uncheckedConnectors: number;
  staleChecks: number;
  updatesAvailable: number;
  verificationRequired: number;
  connectors: ConnectorSourceUpdateHealth[];
};

const VERSION_FIELDS = [
  "path_hash",
  "commit_sha",
  "revision",
  "etag",
  "opaque_version",
  "updated_at"
] as const;

type UpstreamVersionField = (typeof VERSION_FIELDS)[number];

const DETERMINISTIC_UPDATE_STATES = new Set<SourceUpdateState>([
  "new",
  "metadata_only",
  "content_changed",
  "processing_profile_changed",
  "evidence_missing",
  "removed",
  "restored"
]);

/** 用 Connector ID 的稳定短 hash 生成本地报告文件名。 */
function reportFileName(connectorId: string): string {
  return `${createHash("sha256")
    .update(connectorId)
    .digest("hex")
    .slice(0, 20)}.json`;
}

/** 返回某个 Connector 的最近一次更新检查报告路径。 */
export function getSourceUpdateReportPath(
  rootDir: string,
  connectorId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "update-checks",
    reportFileName(connectorId)
  );
}

/** 原子写 0600 报告；报告可能含本地 source identity，不进入 Git 或同步。 */
async function writeSourceUpdateReport(
  rootDir: string,
  report: SourceUpdateReport
): Promise<void> {
  const target = getSourceUpdateReportPath(rootDir, report.connectorId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(
    temporary,
    `${JSON.stringify(SourceUpdateReportSchema.parse(report), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await rename(temporary, target);
}

/** 读取最近报告；未检查过返回 null，损坏报告直接失败而不是伪装健康。 */
export async function readSourceUpdateReport(
  rootDir: string,
  connectorId: string
): Promise<SourceUpdateReport | null> {
  const target = getSourceUpdateReportPath(rootDir, connectorId);
  if (!existsSync(target)) {
    return null;
  }
  const report = SourceUpdateReportSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
  if (report.connectorId !== connectorId) {
    throw new Error(`Source update report connector mismatch: ${connectorId}`);
  }
  return report;
}

/**
 * 汇总已登记 Connector 的最近更新检查健康度。
 *
 * 报告必须绑定当前 registration snapshot 才算 current；重新登记通常发生在每次 ingestion
 * 之前，因此摄入后旧报告自动变 stale。stale/unchecked 报告不再贡献更新数量，避免已经摄入
 * 的变化继续在 `source list` 和 quality audit 中误报。
 */
export async function getSourceUpdateHealth(
  rootDir: string
): Promise<SourceUpdateHealth> {
  const registrations = await listConnectorRegistrations(rootDir);
  const connectors: ConnectorSourceUpdateHealth[] = [];
  for (const registration of registrations) {
    const report = await readSourceUpdateReport(
      rootDir,
      registration.connectorId
    );
    const current =
      report !== null &&
      report.registrationGeneration === registration.generation &&
      report.scopeFingerprint === registration.scopeFingerprint;
    const state: ConnectorSourceUpdateHealth["state"] =
      report === null ? "unchecked" : current ? "current" : "stale";
    connectors.push({
      connectorId: registration.connectorId,
      connectorKind: registration.kind,
      state,
      registrationUpdatedAt: registration.updatedAt,
      ...(report ? { checkedAt: report.checkedAt } : {}),
      updatesAvailable: current ? report.summary.updatesAvailable : 0,
      verificationRequired: current
        ? report.summary.verificationRequired
        : 0
    });
  }
  return {
    registeredConnectors: connectors.length,
    uncheckedConnectors: connectors.filter(
      (connector) => connector.state !== "current"
    ).length,
    staleChecks: connectors.filter(
      (connector) => connector.state === "stale"
    ).length,
    updatesAvailable: connectors.reduce(
      (sum, connector) => sum + connector.updatesAvailable,
      0
    ),
    verificationRequired: connectors.reduce(
      (sum, connector) => sum + connector.verificationRequired,
      0
    ),
    connectors
  };
}

/** 加载当前 Connector 的严格 v5 manifest；旧 schema 必须重建，不能参与更新判断。 */
async function loadConnectorManifests(
  rootDir: string,
  connectorId: string
): Promise<SourceManifest[]> {
  const directory = resolveWorkspacePath(
    rootDir,
    "knowledge",
    "source-manifests"
  );
  if (!existsSync(directory)) {
    return [];
  }
  const manifests: SourceManifest[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name)
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const manifest = SourceManifestSchema.parse(
      JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
    );
    if (manifest.connector === connectorId) {
      manifests.push(manifest);
    }
  }
  return manifests.sort((left, right) =>
    left.source_id.localeCompare(right.source_id)
  );
}

/** Git hash 比较忽略大小写；其他 provider version 必须精确相等。 */
function sameField(
  field: UpstreamVersionField,
  left: string,
  right: string
): boolean {
  return field === "path_hash" || field === "commit_sha"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** 返回全部增删改的 upstream 字段，供用户解释为何需要重新摄入。 */
function changedVersionFields(
  previous: SourceVersion,
  probe: SourceVersionProbe
): UpstreamVersionField[] {
  const before = UpstreamVersionSchema.parse(previous.upstream);
  const current = UpstreamVersionSchema.parse(probe.upstream);
  return VERSION_FIELDS.filter((field) => {
    const left = before[field];
    const right = current[field];
    if (left === undefined || right === undefined) {
      return left !== right;
    }
    return !sameField(field, left, right);
  });
}

/**
 * 找到双方共同拥有的最高优先级版本信号。
 *
 * 与 ingestion core 相同，path hash 优先于仓库 commit/revision；但本模块还继续检查低优先级
 * 字段，用于把“正文未变、上游 metadata 变化”显示为 metadata_only。
 */
function primarySharedSignal(
  previous: SourceVersion,
  probe: SourceVersionProbe
): {
  field: UpstreamVersionField;
  equal: boolean;
} | null {
  for (const field of VERSION_FIELDS) {
    const left = previous.upstream[field];
    const right = probe.upstream[field];
    if (left !== undefined && right !== undefined) {
      return { field, equal: sameField(field, left, right) };
    }
  }
  return null;
}

/** 把状态映射为后续 ingestion/distillation 动作，保持 CLI 与审计解释一致。 */
function actionForState(state: SourceUpdateState): {
  requiresIngestion: boolean;
  requiresDistillation: boolean;
  verificationRequired: boolean;
} {
  switch (state) {
    case "unchanged":
      return {
        requiresIngestion: false,
        requiresDistillation: false,
        verificationRequired: false
      };
    case "metadata_only":
    case "processing_profile_changed":
    case "evidence_missing":
      return {
        requiresIngestion: true,
        requiresDistillation: false,
        verificationRequired: false
      };
    case "update_unknown":
      return {
        requiresIngestion: true,
        requiresDistillation: false,
        verificationRequired: true
      };
    case "new":
    case "content_changed":
    case "removed":
    case "restored":
      return {
        requiresIngestion: true,
        requiresDistillation: true,
        verificationRequired: false
      };
  }
}

/** 构造经过 schema 校验的单项，避免不同分支漏掉动作字段。 */
function updateItem(input: {
  sourceId: string;
  state: SourceUpdateState;
  reason: string;
  changedFields?: UpstreamVersionField[];
  previousVersion?: SourceVersion;
  observedProbe?: SourceVersionProbe;
}): SourceUpdateItem {
  return SourceUpdateItemSchema.parse({
    sourceId: input.sourceId,
    state: input.state,
    reason: input.reason,
    ...actionForState(input.state),
    changedFields: input.changedFields ?? [],
    ...(input.previousVersion
      ? { previousVersion: input.previousVersion }
      : {}),
    ...(input.observedProbe ? { observedProbe: input.observedProbe } : {})
  });
}

/** 根据 manifest、processing profile、Vault 和 probe 分类单个已发现 source。 */
function classifyDiscoveredSource(input: {
  manifest: SourceManifest | null;
  sourceId: string;
  probe: SourceVersionProbe;
  expectedProcessingProfile: string;
  rootDir: string;
}): SourceUpdateItem {
  const { manifest, sourceId, probe } = input;
  if (!manifest) {
    return updateItem({
      sourceId,
      state: "new",
      reason: "source_not_ingested",
      observedProbe: probe
    });
  }
  if (manifest.availability === "missing") {
    return updateItem({
      sourceId,
      state: "restored",
      reason: "missing_source_rediscovered",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields: changedVersionFields(manifest.version, probe)
    });
  }
  if (manifest.processing_profile !== input.expectedProcessingProfile) {
    return updateItem({
      sourceId,
      state: "processing_profile_changed",
      reason: "processing_profile_changed",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields: changedVersionFields(manifest.version, probe)
    });
  }
  if (
    !manifest.vault_object ||
    !existsSync(getVaultObjectPath(input.rootDir, manifest.vault_object))
  ) {
    return updateItem({
      sourceId,
      state: "evidence_missing",
      reason: "current_vault_evidence_missing",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields: changedVersionFields(manifest.version, probe)
    });
  }
  const primary = primarySharedSignal(manifest.version, probe);
  const changedFields = changedVersionFields(manifest.version, probe);
  if (!primary) {
    return updateItem({
      sourceId,
      state: "update_unknown",
      reason: "no_shared_upstream_version_signal",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields
    });
  }
  if (!primary.equal) {
    return updateItem({
      sourceId,
      state:
        primary.field === "path_hash"
          ? "content_changed"
          : "update_unknown",
      reason:
        primary.field === "path_hash"
          ? "content_identity_changed"
          : "upstream_version_changed_requires_fetch",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields
    });
  }
  if (changedFields.length > 0) {
    return updateItem({
      sourceId,
      state: "metadata_only",
      reason: "content_identity_stable_metadata_changed",
      previousVersion: manifest.version,
      observedProbe: probe,
      changedFields
    });
  }
  return updateItem({
    sourceId,
    state: "unchanged",
    reason: "upstream_version_unchanged",
    previousVersion: manifest.version,
    observedProbe: probe
  });
}

/** 创建全状态零值 summary，再按 items 统一汇总。 */
function summarize(items: SourceUpdateItem[]): SourceUpdateReport["summary"] {
  const summary: SourceUpdateReport["summary"] = {
    new: 0,
    unchanged: 0,
    metadata_only: 0,
    content_changed: 0,
    update_unknown: 0,
    processing_profile_changed: 0,
    evidence_missing: 0,
    removed: 0,
    restored: 0,
    updatesAvailable: 0,
    verificationRequired: 0
  };
  for (const item of items) {
    summary[item.state] += 1;
    if (DETERMINISTIC_UPDATE_STATES.has(item.state)) {
      summary.updatesAvailable += 1;
    }
    if (item.verificationRequired) {
      summary.verificationRequired += 1;
    }
  }
  return SourceUpdateSummarySchema.parse(summary);
}

/** 将登记类型投影为用户可解释的本地新鲜度边界。 */
function freshnessBoundary(
  registration: ConnectorRegistration
): SourceUpdateReport["freshnessBoundary"] {
  switch (registration.kind) {
    case "files":
    case "transcripts":
      return "local-filesystem";
    case "git":
      return "local-git-ref";
    case "lark-export":
      return "offline-lark-export";
  }
}

/**
 * 在 Connector 锁内执行无正文更新检查。
 *
 * 函数只调用 inventory/discover/probe，不调用 fetch/normalize。完整 inventory 只有在 provider
 * 声明 complete 且 identity 与登记一致时才推断 removed；报告不会修改 manifest/checkpoint。
 */
export async function checkConnectorSourceUpdates(
  rootDir: string,
  connector: KnowledgeConnector,
  rawRegistration: ConnectorRegistration,
  options: { now?: () => Date } = {}
): Promise<SourceUpdateReport> {
  const registration = ConnectorRegistrationSchema.parse(rawRegistration);
  if (
    connector.id !== registration.connectorId ||
    connector.id !== rawRegistration.connectorId
  ) {
    throw new Error(
      `Connector registration does not match runtime Connector: ${connector.id}`
    );
  }
  return withConnectorIngestionLock(rootDir, connector.id, async () => {
    const inventoryMode = connector.inventoryMode ?? "partial";
    const rawIdentity = await connector.inventoryIdentity?.();
    const inventoryIdentity =
      rawIdentity === null || rawIdentity === undefined
        ? undefined
        : ConnectorInventoryIdentitySchema.parse(rawIdentity);
    if (inventoryMode === "complete") {
      if (
        !inventoryIdentity ||
        inventoryIdentity !== registration.inventoryIdentity
      ) {
        throw new Error(
          `Connector inventory identity changed; use a new connector ID: ${connector.id}`
        );
      }
    }
    const rawInventoryStatus = await connector.inventoryStatus?.();
    const inventoryStatus = rawInventoryStatus
      ? ConnectorInventoryStatusSchema.parse(rawInventoryStatus)
      : { complete: true, unresolved: 0 };
    const removalsEvaluated =
      inventoryMode === "complete" && inventoryStatus.complete;
    const manifests = await loadConnectorManifests(rootDir, connector.id);
    const manifestById = new Map(
      manifests.map((manifest) => [manifest.source_id, manifest])
    );
    const expectedProcessingProfile = buildIngestionProcessingProfile(
      connector,
      registration.redactionPolicy
    );
    const discovered = new Set<string>();
    const items: SourceUpdateItem[] = [];

    for await (const rawDescriptor of connector.discover(null)) {
      const descriptor = ConnectorSourceDescriptorSchema.parse(rawDescriptor);
      if (descriptor.connectorId !== connector.id) {
        throw new Error(
          `Connector descriptor ID mismatch: ${descriptor.connectorId}`
        );
      }
      if (discovered.has(descriptor.sourceId)) {
        throw new Error(
          `Connector discovered duplicate source ID: ${descriptor.sourceId}`
        );
      }
      discovered.add(descriptor.sourceId);
      items.push(
        classifyDiscoveredSource({
          manifest: manifestById.get(descriptor.sourceId) ?? null,
          sourceId: descriptor.sourceId,
          probe: SourceVersionProbeSchema.parse(descriptor.probe),
          expectedProcessingProfile,
          rootDir
        })
      );
    }

    if (removalsEvaluated) {
      for (const manifest of manifests) {
        if (
          manifest.availability !== "available" ||
          discovered.has(manifest.source_id)
        ) {
          continue;
        }
        items.push(
          updateItem({
            sourceId: manifest.source_id,
            state: "removed",
            reason: "source_missing_from_complete_inventory",
            previousVersion: manifest.version
          })
        );
      }
    }

    items.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const report = SourceUpdateReportSchema.parse({
      version: 1,
      connectorId: connector.id,
      connectorKind: registration.kind,
      checkedAt: (options.now?.() ?? new Date()).toISOString(),
      registrationUpdatedAt: registration.updatedAt,
      registrationGeneration: registration.generation,
      scopeFingerprint: registration.scopeFingerprint,
      networkAccess: "none",
      freshnessBoundary: freshnessBoundary(registration),
      inventory: {
        mode: inventoryMode,
        complete: inventoryStatus.complete,
        unresolved: inventoryStatus.unresolved,
        removalsEvaluated,
        discovered: discovered.size,
        tracked: manifests.length,
        ...(inventoryStatus.reason
          ? { reason: inventoryStatus.reason }
          : {})
      },
      summary: summarize(items),
      items
    });
    await writeSourceUpdateReport(rootDir, report);
    return report;
  });
}
