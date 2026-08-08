/**
 * Source review 模块连接 versioned manifest、加密 Vault 与精炼 KnowledgeDocument。
 *
 * list/show 只返回 Git 可审阅 metadata；完整 evidence 只能 export 到显式 0600 文件。
 * mark 使用 fingerprint + review token 做乐观锁，并验证 refined knowledge 的 active/current anchors。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";
import { redactEvidenceText } from "../ingestion/redaction.js";
import {
  listConnectorCheckpoints,
  withConnectorIngestionLock
} from "../ingestion/core.js";
import {
  getSourceUpdateHealth,
  type SourceUpdateHealth
} from "../ingestion/sourceUpdates.js";
import { parseKnowledgeMarkdown } from "./markdown.js";
import {
  SourceManifestSchema,
  SourceProcessingStatusSchema,
  type SourceManifest
} from "./sourceManifest.js";
import { discoverKnowledgeFiles } from "./workspace.js";
import {
  writeVaultObjectToFile,
  type VaultOptions
} from "../vault/core.js";

const ReviewableStatusSchema = SourceProcessingStatusSchema.exclude([
  "pending"
]);
const FingerprintSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);
const KnowledgeIdSchema = z.string().regex(/^k_[a-zA-Z0-9_]+$/);

export type SourceReviewState = "pending" | "stale" | "current" | "missing";

export type SourceListItem = {
  sourceId: string;
  connector: string;
  artifactKind: string;
  title: string;
  externalKey: string;
  projectKeys: string[];
  availability: "available" | "missing";
  processingStatus: z.output<typeof SourceProcessingStatusSchema>;
  processingReason?: string;
  reviewState: SourceReviewState;
  versionFingerprint: string;
  contentHash: string;
  observedAt: string;
  processedAt?: string;
  refinedKnowledgeIds: string[];
  sections: number;
  vaultBacked: boolean;
};

export type SourceListResult = {
  total: number;
  byStatus: Record<string, number>;
  byReviewState: Record<string, number>;
  updateHealth: SourceUpdateHealth;
  inventory: {
    incompleteConnectors: number;
    unresolved: number;
    failedSources: number;
    connectors: Array<{
      connectorId: string;
      mode: "partial" | "complete";
      complete: boolean;
      unresolved: number;
      failedSources: number;
      reason?: string;
    }>;
  };
  items: SourceListItem[];
};

export type SourceDetail = SourceListItem & {
  expectedFingerprint: string;
  reviewToken: string;
  contentType: string;
  contentBytes: number;
  redactionPolicy: string;
  redactions: Record<string, number>;
  processingProfile: string;
  upstreamVersion: SourceManifest["version"]["upstream"];
  duplicateOf?: string;
  exportAvailable: boolean;
  sectionsDetail: SourceManifest["sections"];
};

export type MarkSourceResult = {
  sourceId: string;
  processingStatus: z.output<typeof ReviewableStatusSchema>;
  processingReason?: string;
  reviewState: SourceReviewState;
  fingerprint: string;
  processedContentHash: string;
  processedAt: string;
  refinedKnowledgeIds: string[];
  duplicateOf?: string;
};

/** 返回 source manifest 规范路径；source ID schema 防止路径逃逸。 */
function sourceManifestPath(rootDir: string, sourceId: string): string {
  const parsed = z
    .string()
    .regex(/^src_[A-Za-z0-9_.-]+$/)
    .parse(sourceId);
  return resolveWorkspacePath(
    rootDir,
    "knowledge",
    "source-manifests",
    `${parsed}.json`
  );
}

/** 读取并严格校验单个 source manifest。 */
async function readSourceManifest(
  rootDir: string,
  sourceId: string
): Promise<SourceManifest> {
  const target = sourceManifestPath(rootDir, sourceId);
  if (!existsSync(target)) {
    throw new Error(`Source manifest not found: ${sourceId}`);
  }
  return SourceManifestSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** 原子更新 Git 可跟踪 manifest，不留下半写 review receipt。 */
async function writeSourceManifest(
  rootDir: string,
  manifest: SourceManifest
): Promise<void> {
  const target = sourceManifestPath(rootDir, manifest.source_id);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(
    temporary,
    `${JSON.stringify(SourceManifestSchema.parse(manifest), null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 }
  );
  await rename(temporary, target);
}

/** 根据 receipt 与当前版本计算是否需要重新审阅。 */
export function sourceReviewState(
  manifest: SourceManifest
): SourceReviewState {
  if (manifest.availability === "missing") {
    if (manifest.processing_status === "pending") {
      return "missing";
    }
    return manifest.processed_content_hash === manifest.version.content_hash
      ? "current"
      : "stale";
  }
  if (manifest.processing_status === "pending") {
    return "pending";
  }
  return manifest.processed_content_hash === manifest.version.content_hash
    ? "current"
    : "stale";
}

/** 把 manifest 投影成不含完整 evidence、密文或对象路径的列表项。 */
function sourceListItem(manifest: SourceManifest): SourceListItem {
  return {
    sourceId: manifest.source_id,
    connector: manifest.connector,
    artifactKind: manifest.artifact_kind,
    title: manifest.title,
    externalKey: manifest.external_key,
    projectKeys: manifest.project_keys,
    availability: manifest.availability,
    processingStatus: manifest.processing_status,
    ...(manifest.processing_reason
      ? { processingReason: manifest.processing_reason }
      : {}),
    reviewState: sourceReviewState(manifest),
    versionFingerprint: manifest.version.fingerprint,
    contentHash: manifest.version.content_hash,
    observedAt: manifest.version.observed_at,
    ...(manifest.processed_at ? { processedAt: manifest.processed_at } : {}),
    refinedKnowledgeIds: manifest.refined_knowledge_ids,
    sections: manifest.sections.length,
    vaultBacked: manifest.vault_object !== undefined
  };
}

/** review token 只覆盖审阅 receipt/availability，防止同版本并发 reviewer 互相覆盖。 */
function sourceReviewToken(manifest: SourceManifest): string {
  return `review_sha256_${createHash("sha256")
    .update(
      JSON.stringify({
        source_id: manifest.source_id,
        fingerprint: manifest.version.fingerprint,
        availability: manifest.availability,
        processing_status: manifest.processing_status,
        processing_reason: manifest.processing_reason ?? null,
        duplicate_of: manifest.duplicate_of ?? null,
        processed_at: manifest.processed_at ?? null,
        processed_content_hash: manifest.processed_content_hash ?? null,
        refined_knowledge_ids: [...manifest.refined_knowledge_ids].sort()
      })
    )
    .digest("hex")}`;
}

/** 加载全部严格 v5 source manifest；非法 JSON/schema 必须失败，不能在队列中静默遗漏。 */
async function loadSourceManifests(rootDir: string): Promise<SourceManifest[]> {
  const files = await fg("knowledge/source-manifests/**/*.json", {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true
  });
  const manifests: SourceManifest[] = [];
  for (const filePath of files.sort()) {
    manifests.push(
      SourceManifestSchema.parse(
        JSON.parse(
          await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")
        )
      )
    );
  }
  return manifests;
}

/** 列出 source 审阅队列，可按状态、availability、project 和 needs-review 过滤。 */
export async function listSources(
  rootDir: string,
  options: {
    statuses?: string[];
    availability?: "available" | "missing";
    projectKeys?: string[];
    needsReview?: boolean;
  } = {}
): Promise<SourceListResult> {
  const statuses = options.statuses
    ? new Set(options.statuses.map((status) => SourceProcessingStatusSchema.parse(status)))
    : null;
  const projects = new Set(options.projectKeys ?? []);
  const manifests = await loadSourceManifests(rootDir);
  const items = manifests
    .map(sourceListItem)
    .filter((item) => !statuses || statuses.has(item.processingStatus))
    .filter(
      (item) =>
        options.availability === undefined ||
        item.availability === options.availability
    )
    .filter(
      (item) =>
        projects.size === 0 ||
        item.projectKeys.some((projectKey) => projects.has(projectKey))
    )
    .filter(
      (item) =>
        options.needsReview !== true ||
        item.reviewState === "pending" ||
        item.reviewState === "stale" ||
        item.reviewState === "missing"
    )
    .sort(
      (left, right) =>
        left.reviewState.localeCompare(right.reviewState) ||
        left.sourceId.localeCompare(right.sourceId)
    );
  const byStatus: Record<string, number> = {};
  const byReviewState: Record<string, number> = {};
  for (const item of items) {
    byStatus[item.processingStatus] =
      (byStatus[item.processingStatus] ?? 0) + 1;
    byReviewState[item.reviewState] =
      (byReviewState[item.reviewState] ?? 0) + 1;
  }
  const connectors = [
    ...new Set(manifests.map((manifest) => manifest.connector))
  ];
  const checkpoints = await listConnectorCheckpoints(rootDir);
  const updateHealth = await getSourceUpdateHealth(rootDir);
  for (const checkpoint of checkpoints) {
    connectors.push(checkpoint.connectorId);
  }
  const inventory: SourceListResult["inventory"]["connectors"] = [];
  for (const connectorId of [...new Set(connectors)].sort()) {
    const checkpoint =
      checkpoints.find((item) => item.connectorId === connectorId) ?? null;
    const status = checkpoint?.inventoryStatus;
    if (!status) {
      continue;
    }
    inventory.push({
      connectorId,
      complete: status.complete,
      unresolved: status.unresolved,
      failedSources: Object.keys(checkpoint?.failures ?? {}).length,
      mode: status.mode,
      ...(status.reason ? { reason: status.reason } : {})
    });
  }
  return {
    total: items.length,
    byStatus,
    byReviewState,
    updateHealth,
    inventory: {
      incompleteConnectors: inventory.filter(
        (item) => item.mode === "complete" && !item.complete
      ).length,
      unresolved: inventory.reduce(
        (sum, item) => sum + item.unresolved,
        0
      ),
      failedSources: inventory.reduce(
        (sum, item) => sum + item.failedSources,
        0
      ),
      connectors: inventory
    },
    items
  };
}

/** 显示单个 source metadata、section heading/hash/range 和 export handle，不解密 Vault。 */
export async function showSource(
  rootDir: string,
  sourceId: string
): Promise<SourceDetail> {
  const manifest = await readSourceManifest(rootDir, sourceId);
  return {
    ...sourceListItem(manifest),
    expectedFingerprint: manifest.version.fingerprint,
    reviewToken: sourceReviewToken(manifest),
    contentType: manifest.content_type,
    contentBytes: manifest.content_bytes,
    redactionPolicy: manifest.redaction_policy,
    redactions: manifest.redactions,
    processingProfile: manifest.processing_profile,
    upstreamVersion: manifest.version.upstream,
    ...(manifest.duplicate_of ? { duplicateOf: manifest.duplicate_of } : {}),
    exportAvailable:
      manifest.vault_object !== undefined,
    sectionsDetail: manifest.sections
  };
}

/** 先校验 source fingerprint，再把完整 evidence 解密到显式 0600 文件。 */
export async function exportSourceEvidence(
  rootDir: string,
  input: {
    sourceId: string;
    expectedFingerprint: string;
    outputPath: string;
    overwrite?: boolean;
  },
  options: VaultOptions
): Promise<{
  sourceId: string;
  fingerprint: string;
  outputPath: string;
  bytes: number;
  contentType: string;
}> {
  const expectedFingerprint = FingerprintSchema.parse(
    input.expectedFingerprint
  );
  const initial = await readSourceManifest(rootDir, input.sourceId);
  return withConnectorIngestionLock(rootDir, initial.connector, async () => {
    const manifest = await readSourceManifest(rootDir, input.sourceId);
    if (manifest.connector !== initial.connector) {
      throw new Error(`Source connector changed: ${input.sourceId}`);
    }
    if (manifest.version.fingerprint !== expectedFingerprint) {
      throw new Error(`Source fingerprint changed: ${input.sourceId}`);
    }
    if (!manifest.vault_object) {
      throw new Error(`Source evidence is not exportable: ${input.sourceId}`);
    }
    await assertOutsideWorkspace(rootDir, input.outputPath);
    const exported = await writeVaultObjectToFile(
      rootDir,
      {
        id: manifest.vault_object,
        outputPath: input.outputPath,
        overwrite: input.overwrite
      },
      options
    );
    return {
      sourceId: manifest.source_id,
      fingerprint: manifest.version.fingerprint,
      outputPath: exported.outputPath,
      bytes: exported.bytes,
      contentType: exported.contentType
    };
  });
}

/** 找到输出路径最近的已存在祖先，解析 symlink 后再次确认不落入 workspace。 */
async function assertOutsideWorkspace(
  rootDir: string,
  outputPath: string
): Promise<void> {
  const workspace = await realpath(path.resolve(rootDir)).catch(() =>
    path.resolve(rootDir)
  );
  const resolvedOutput = path.resolve(outputPath);
  const lexicalRelative = path.relative(path.resolve(rootDir), resolvedOutput);
  if (
    lexicalRelative === "" ||
    (!lexicalRelative.startsWith("..") &&
      !path.isAbsolute(lexicalRelative))
  ) {
    throw new Error("Source evidence output must be outside the knowledge workspace");
  }
  const missingSegments: string[] = [];
  let existingAncestor = resolvedOutput;
  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  const realAncestor = await realpath(existingAncestor);
  const realTarget = path.resolve(realAncestor, ...missingSegments);
  const realRelative = path.relative(workspace, realTarget);
  if (
    realRelative === "" ||
    (!realRelative.startsWith("..") && !path.isAbsolute(realRelative))
  ) {
    throw new Error("Source evidence output must be outside the knowledge workspace");
  }
}

/** reason 会进入 Git，若内置 secret/PII detector 会改写它则直接拒绝落盘。 */
function validateProcessingReason(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }
  const trimmed = reason.trim();
  if (!trimmed) {
    throw new Error("Source processing reason cannot be empty");
  }
  if (redactEvidenceText(trimmed, "secrets-and-pii").text !== trimmed) {
    throw new Error("Source processing reason contains secret or PII");
  }
  return trimmed.slice(0, 1000);
}

/** 加载 active 正式知识，供 refined receipt 验证 knowledge ID 和 current anchor。 */
async function activeKnowledgeById(rootDir: string) {
  const documents = new Map<
    string,
    ReturnType<typeof parseKnowledgeMarkdown>
  >();
  for (const filePath of await discoverKnowledgeFiles(rootDir)) {
    const document = parseKnowledgeMarkdown(
      filePath,
      await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")
    );
    if (document.frontmatter.status === "active") {
      documents.set(document.frontmatter.id, document);
    }
  }
  return documents;
}

/** 确认 refined knowledge 对当前 source 至少有一个仍能解析的 claim anchor。 */
async function validateRefinedKnowledge(
  rootDir: string,
  manifest: SourceManifest,
  knowledgeIds: string[]
): Promise<string[]> {
  const ids = [...new Set(knowledgeIds.map((id) => KnowledgeIdSchema.parse(id)))];
  if (ids.length === 0) {
    throw new Error("Refined source requires at least one active knowledge ID");
  }
  const documents = await activeKnowledgeById(rootDir);
  const sections = new Map(
    manifest.sections.map((section) => [section.section_id, section.text_hash])
  );
  for (const id of ids) {
    const document = documents.get(id);
    if (!document) {
      throw new Error(`Refined source requires active knowledge: ${id}`);
    }
    const hasCurrentAnchor = document.frontmatter.claims.some(
      (claim) =>
        claim.status === "supported" &&
        claim.evidence.some(
          (anchor) =>
            anchor.source_id === manifest.source_id &&
            sections.get(anchor.section_id) === anchor.quote_hash
        )
    );
    if (!hasCurrentAnchor) {
      throw new Error(
        `Active knowledge does not contain a current source anchor: ${id}`
      );
    }
  }
  return ids;
}

/** 标记当前 source 版本的审阅结果；fingerprint 变化时在任何写入前失败。 */
export async function markSourceReviewed(
  rootDir: string,
  input: {
    sourceId: string;
    expectedFingerprint: string;
    expectedReviewToken: string;
    status: string;
    reason?: string;
    duplicateOf?: string;
    knowledgeIds?: string[];
    now?: () => Date;
  }
): Promise<MarkSourceResult> {
  const expectedFingerprint = FingerprintSchema.parse(
    input.expectedFingerprint
  );
  const expectedReviewToken = z
    .string()
    .regex(/^review_sha256_[a-f0-9]{64}$/)
    .parse(input.expectedReviewToken);
  const status = ReviewableStatusSchema.parse(input.status);
  const initial = await readSourceManifest(rootDir, input.sourceId);
  return withConnectorIngestionLock(rootDir, initial.connector, async () => {
    const manifest = await readSourceManifest(rootDir, input.sourceId);
    if (manifest.connector !== initial.connector) {
      throw new Error(`Source connector changed: ${input.sourceId}`);
    }
    if (manifest.version.fingerprint !== expectedFingerprint) {
      throw new Error(`Source fingerprint changed: ${input.sourceId}`);
    }
    if (sourceReviewToken(manifest) !== expectedReviewToken) {
      throw new Error(`Source review receipt changed: ${input.sourceId}`);
    }
    if (
      manifest.availability === "missing" &&
      status !== "obsolete" &&
      status !== "blocked"
    ) {
      throw new Error(
        `Missing source can only be marked obsolete or blocked: ${input.sourceId}`
      );
    }
    const reason = validateProcessingReason(input.reason);
    if (
      status !== "refined" &&
      (reason === undefined || reason.length === 0)
    ) {
      throw new Error(`Source status ${status} requires a processing reason`);
    }
    let duplicateOf: string | undefined;
    let refinedKnowledgeIds: string[] = [];
    if (status === "refined") {
      refinedKnowledgeIds = await validateRefinedKnowledge(
        rootDir,
        manifest,
        input.knowledgeIds ?? []
      );
    } else if (status === "duplicate") {
      duplicateOf = z
        .string()
        .regex(/^src_[A-Za-z0-9_.-]+$/)
        .parse(input.duplicateOf);
      if (duplicateOf === manifest.source_id) {
        throw new Error("Source cannot be duplicate of itself");
      }
      const target = await readSourceManifest(rootDir, duplicateOf).catch(() => {
        throw new Error(`Duplicate source not found: ${duplicateOf}`);
      });
      if (target.availability !== "available") {
        throw new Error(`Duplicate source is not available: ${duplicateOf}`);
      }
    if (target.processing_status === "duplicate") {
      throw new Error(
        `Duplicate source target must be canonical, not another duplicate: ${duplicateOf}`
      );
    }
    }
    const processedAt = (input.now?.() ?? new Date()).toISOString();
    const updated = SourceManifestSchema.parse({
      ...manifest,
      processing_status: status,
      processing_reason: reason,
      duplicate_of: duplicateOf,
      processed_at: processedAt,
      processed_content_hash: manifest.version.content_hash,
      refined_knowledge_ids: refinedKnowledgeIds
    });
    await writeSourceManifest(rootDir, updated);
    return {
      sourceId: updated.source_id,
      processingStatus: status,
      ...(updated.processing_reason
        ? { processingReason: updated.processing_reason }
        : {}),
      reviewState: sourceReviewState(updated),
      fingerprint: updated.version.fingerprint,
      processedContentHash: updated.processed_content_hash!,
      processedAt: updated.processed_at!,
      refinedKnowledgeIds: updated.refined_knowledge_ids,
      ...(updated.duplicate_of ? { duplicateOf: updated.duplicate_of } : {})
    };
  });
}
