/**
 * Source manifest 把完整证据映射为稳定、可引用的 section。
 *
 * manifest 只保存内容 hash、标题路径、字符范围、review receipt 和 Vault handle；它不保存
 * 正文 preview 或完整原文。调用方必须先完成隐私脱敏再构建 manifest，避免可 Git 跟踪的
 * 导航层泄漏未治理内容。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Source manifest 需被独立 Node 数据脚本直接加载，因此在本模块保留同一 project key 契约，
 * 不引入源码态不存在的 `.js` runtime 依赖。KnowledgeDocument 的规范定义仍在 knowledgeV2。
 */
const SourceProjectKeySchema = z
  .string()
  .min(3)
  .regex(
    /^(?:[a-z0-9.-]+\/[a-z0-9._/-]+|local\/[a-z0-9._/-]+)$/,
    "expected a normalized Git remote or explicit local key"
  );

export const SourceProcessingStatusSchema = z.enum([
  "pending",
  "refined",
  "duplicate",
  "obsolete",
  "no_long_term_value",
  "blocked"
]);

/**
 * Connector 的上游版本信号用于廉价探测。
 *
 * 不同来源可提供不同信号：飞书使用 revision/updated_at，HTTP 使用 ETag，
 * Git/GitHub 使用 commit SHA。字段全部可选，因为部分旧系统只能在抓取后比较 content hash。
 */
export const UpstreamVersionSchema = z.object({
  revision: z.string().min(1).optional(),
  updated_at: z.string().datetime().optional(),
  etag: z.string().min(1).optional(),
  commit_sha: z.string().regex(/^[a-fA-F0-9]{7,64}$/).optional(),
  path_hash: z.string().regex(/^[a-fA-F0-9]{7,64}$/).optional(),
  opaque_version: z.string().min(1).optional()
});

/** 完整版本记录同时保存上游信号、抓取观察时间和正文 hash。 */
export const SourceVersionSchema = z.object({
  observed_at: z.string().datetime(),
  upstream: UpstreamVersionSchema.default({}),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/)
});

/** 轻量 probe 不含正文 hash，可在下载完整 source 前判断是否值得抓取。 */
export const SourceVersionProbeSchema = z.object({
  observed_at: z.string().datetime(),
  upstream: UpstreamVersionSchema
});

/** source section 是 claim/evidence 使用的最小稳定引用单元。 */
export const SourceSectionSchema = z.object({
  section_id: z.string().regex(/^sec_[a-f0-9]{20}$/),
  heading_path: z.array(z.string().min(1)).min(1),
  text_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive()
});

/** manifest 是 Git 可跟踪导航；完整 evidence object 只保存在加密 Vault。 */
export const SourceManifestSchema = z
  .object({
    schema_version: z.literal(5),
    source_id: z.string().regex(/^src_[A-Za-z0-9_.-]+$/),
    connector: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/),
    artifact_kind: z
      .enum([
        "document",
        "transcript",
        "tool_trace",
        "attachment",
        "repository"
      ]),
    external_key: z.string().min(1),
    title: z.string().min(1),
    project_keys: z.array(SourceProjectKeySchema),
    content_type: z.string().min(1),
    content_bytes: z.number().int().nonnegative(),
    redaction_policy: z
      .enum([
        "secrets-only",
        "secrets-and-pii",
        "connector-specific",
        "not-applied"
      ]),
    processing_profile: z.string().min(1),
    redactions: z.record(z.string(), z.number().int().positive()),
    availability: z.enum(["available", "missing"]),
    missing_since: z.string().datetime().optional(),
    version: SourceVersionSchema,
    processing_status: SourceProcessingStatusSchema.default("pending"),
    processing_reason: z.string().min(1).optional(),
    duplicate_of: z.string().min(1).optional(),
    processed_at: z.string().datetime().optional(),
    processed_content_hash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    refined_knowledge_ids: z
      .array(z.string().regex(/^k_[a-zA-Z0-9_]+$/))
      .default([]),
    vault_object: z
      .string()
      .regex(/^vault_sha256_[a-f0-9]{64}$/)
      .optional(),
    sections: z.array(SourceSectionSchema).min(1)
  })
  .superRefine((manifest, context) => {
    const isSensitiveStream =
      manifest.artifact_kind === "transcript" ||
      manifest.artifact_kind === "tool_trace";
    if (
      isSensitiveStream &&
      manifest.redaction_policy !== "secrets-and-pii"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["redaction_policy"],
        message:
          "transcript and tool_trace manifests require secrets-and-pii redaction"
      });
    }
    if (
      manifest.availability === "missing" &&
      manifest.missing_since === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missing_since"],
        message: "missing source manifests require missing_since"
      });
    }
    if (
      manifest.availability === "available" &&
      manifest.missing_since !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["missing_since"],
        message: "available source manifests cannot keep missing_since"
      });
    }
    if (manifest.processing_status === "pending") {
      if (
        manifest.processed_at !== undefined ||
        manifest.processed_content_hash !== undefined ||
        manifest.processing_reason !== undefined ||
        manifest.duplicate_of !== undefined ||
        manifest.refined_knowledge_ids.length > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["processing_status"],
          message: "pending source manifests cannot keep a review receipt"
        });
      }
      return;
    }
    if (
      manifest.processed_at === undefined ||
      manifest.processed_content_hash === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processed_content_hash"],
        message: "reviewed source manifests require processed_at and processed_content_hash"
      });
    }
    if (
      manifest.processing_status === "refined" &&
      manifest.refined_knowledge_ids.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refined_knowledge_ids"],
        message: "refined source manifests require active knowledge IDs"
      });
    }
    if (
      manifest.processing_status !== "refined" &&
      manifest.refined_knowledge_ids.length > 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refined_knowledge_ids"],
        message: "only refined source manifests can keep knowledge IDs"
      });
    }
    if (
      manifest.processing_status === "duplicate" &&
      manifest.duplicate_of === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duplicate_of"],
        message: "duplicate source manifests require duplicate_of"
      });
    }
    if (
      manifest.processing_status !== "duplicate" &&
      manifest.duplicate_of !== undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["duplicate_of"],
        message: "only duplicate source manifests can keep duplicate_of"
      });
    }
    if (
      (manifest.processing_status === "blocked" ||
        manifest.processing_status === "obsolete" ||
        manifest.processing_status === "no_long_term_value" ||
        manifest.processing_status === "duplicate") &&
      manifest.processing_reason === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processing_reason"],
        message: "reviewed source status requires processing_reason"
      });
    }
  });

export type SourceManifest = z.output<typeof SourceManifestSchema>;
export type SourceVersion = z.output<typeof SourceVersionSchema>;
export type SourceVersionProbe = z.output<typeof SourceVersionProbeSchema>;
export type SourceProbeComparison = "unchanged" | "changed" | "unknown";
export type SourceUpdateClassification =
  | "new"
  | "unchanged"
  | "metadata_only"
  | "content_changed"
  | "removed"
  | "restored";
export type SourceRefreshDecision = {
  action: "skip" | "fetch";
  comparison: SourceProbeComparison;
  reason:
    | "upstream_version_unchanged"
    | "upstream_version_changed"
    | "upstream_version_unavailable";
};

/** 返回稳定 SHA-256 hex；manifest 外部统一加 `sha256:` 前缀。 */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 以固定字段顺序构造版本 fingerprint，避免 JSON key 顺序造成伪更新。 */
export function sourceVersionFingerprint(input: {
  upstream?: z.input<typeof UpstreamVersionSchema>;
  contentHash: string;
}): string {
  const upstream = UpstreamVersionSchema.parse(input.upstream ?? {});
  return `sha256:${sha256(
    JSON.stringify({
      revision: upstream.revision ?? null,
      updated_at: upstream.updated_at ?? null,
      etag: upstream.etag ?? null,
      commit_sha: upstream.commit_sha?.toLowerCase() ?? null,
      path_hash: upstream.path_hash?.toLowerCase() ?? null,
      opaque_version: upstream.opaque_version ?? null,
      content_hash: input.contentHash
    })
  )}`;
}

/** 构造经过 schema 校验的完整版本记录。 */
export function buildSourceVersion(input: {
  observedAt: string;
  contentHash: string;
  upstream?: z.input<typeof UpstreamVersionSchema>;
}): SourceVersion {
  const normalizedContentHash = input.contentHash.startsWith("sha256:")
    ? input.contentHash
    : `sha256:${input.contentHash}`;
  return SourceVersionSchema.parse({
    observed_at: input.observedAt,
    upstream: input.upstream ?? {},
    content_hash: normalizedContentHash,
    fingerprint: sourceVersionFingerprint({
      upstream: input.upstream,
      contentHash: normalizedContentHash
    })
  });
}

type ComparableVersionField = keyof z.output<typeof UpstreamVersionSchema>;

const VERSION_FIELD_PRIORITY: ComparableVersionField[] = [
  "path_hash",
  "commit_sha",
  "revision",
  "etag",
  "opaque_version",
  "updated_at"
];

/** 比较单个上游版本字段；Git hash 忽略大小写，其他字段做精确比较。 */
function sameVersionField(
  field: ComparableVersionField,
  left: string,
  right: string
): boolean {
  return field === "commit_sha" || field === "path_hash"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * 用轻量 probe 判断是否需要重新抓取。
 *
 * 只比较双方共同具备的最高优先级信号；没有共同信号时返回 unknown，调用方必须抓取后
 * 比较 content hash，不能把“缺少版本信息”误判成“没有更新”。
 */
export function compareSourceVersionProbe(
  previous: SourceVersion,
  currentProbe: SourceVersionProbe
): SourceProbeComparison {
  const previousVersion = SourceVersionSchema.parse(previous);
  const current = SourceVersionProbeSchema.parse(currentProbe);
  for (const field of VERSION_FIELD_PRIORITY) {
    const left = previousVersion.upstream[field];
    const right = current.upstream[field];
    if (left !== undefined && right !== undefined) {
      return sameVersionField(field, left, right) ? "unchanged" : "changed";
    }
  }
  return "unknown";
}

/** 把 probe 比较转换为 Connector 可直接执行的抓取决策。 */
export function decideSourceRefresh(
  previous: SourceVersion,
  currentProbe: SourceVersionProbe
): SourceRefreshDecision {
  const comparison = compareSourceVersionProbe(previous, currentProbe);
  if (comparison === "unchanged") {
    return {
      action: "skip",
      comparison,
      reason: "upstream_version_unchanged"
    };
  }
  return {
    action: "fetch",
    comparison,
    reason:
      comparison === "changed"
        ? "upstream_version_changed"
        : "upstream_version_unavailable"
  };
}

/**
 * 完整抓取后分类 source 变化。
 *
 * 上游 revision/更新时间变化但正文 hash 相同属于 metadata_only，不触发知识重蒸馏；
 * content hash 变化才需要重新切 section、失效 claim 并运行增量蒸馏。
 */
export function classifySourceUpdate(
  previous: SourceManifest | null,
  current: SourceManifest
): SourceUpdateClassification {
  const next = SourceManifestSchema.parse(current);
  if (!previous) {
    return "new";
  }
  const before = SourceManifestSchema.parse(previous);
  if (
    before.availability === "available" &&
    next.availability === "missing"
  ) {
    return "removed";
  }
  if (
    before.availability === "missing" &&
    next.availability === "available"
  ) {
    return "restored";
  }
  if (before.version.content_hash !== next.version.content_hash) {
    return "content_changed";
  }
  if (before.version.fingerprint !== next.version.fingerprint) {
    return "metadata_only";
  }
  return "unchanged";
}

/** 去除 XML 标签并归一化空白；输入必须已经完成 secret/PII 脱敏。 */
function stripXml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 使用 source、heading path 和正文 hash 生成 section ID。
 *
 * 标题不变但正文变化时 ID 会变化，使受影响 claim 进入重新验证；其他 section 不受影响。
 */
export function sourceSectionId(
  sourceId: string,
  headingPath: string[],
  text: string
): string {
  return `sec_${sha256(
    JSON.stringify([sourceId, headingPath, sha256(text.trim())])
  ).slice(0, 20)}`;
}

type HeadingMatch = {
  level: number;
  title: string;
  start: number;
  contentStart: number;
};

/** 提取 h1-h6；非法空标题忽略，最终由正文 fallback 保证至少一个 section。 */
function headingsIn(content: string): HeadingMatch[] {
  const headings: HeadingMatch[] = [];
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  for (const match of content.matchAll(pattern)) {
    const title = stripXml(match[2] ?? "");
    const start = match.index ?? 0;
    if (!title) {
      continue;
    }
    headings.push({
      level: Number.parseInt(match[1] ?? "1", 10),
      title,
      start,
      contentStart: start + match[0].length
    });
  }
  return headings;
}

/** 根据当前 heading 级别维护完整父标题路径，避免只保留叶子标题造成歧义。 */
function updateHeadingPath(
  current: string[],
  heading: HeadingMatch
): string[] {
  return [...current.slice(0, heading.level - 1), heading.title];
}

/**
 * 构建单个 source manifest。
 *
 * 有 heading 时每个 heading 到下一个 heading 构成 section；没有 heading 时整篇正文
 * 作为 `正文` section。section range 使用原始脱敏 XML 偏移，便于 Vault 后续定点读取。
 */
export function buildSourceManifest(input: {
  sourceId: string;
  connector: string;
  artifactKind?: z.input<typeof SourceManifestSchema>["artifact_kind"];
  externalKey: string;
  title: string;
  content: string;
  observedAt: string;
  projectKeys?: string[];
  contentType?: string;
  contentBytes?: number;
  redactionPolicy?: z.input<typeof SourceManifestSchema>["redaction_policy"];
  processingProfile?: string;
  redactions?: Record<string, number>;
  upstreamVersion?: z.input<typeof UpstreamVersionSchema>;
  processingStatus?: z.input<typeof SourceProcessingStatusSchema>;
  processingReason?: string;
  duplicateOf?: string;
  processedAt?: string;
  processedContentHash?: string;
  refinedKnowledgeIds?: string[];
  vaultObject?: string;
}): SourceManifest {
  const headings = headingsIn(input.content);
  const sections: Array<z.input<typeof SourceSectionSchema>> = [];
  const contentHash = `sha256:${sha256(input.content)}`;
  const processingStatus = input.processingStatus ?? "pending";
  let headingPath: string[] = [];

  for (const [index, heading] of headings.entries()) {
    headingPath = updateHeadingPath(headingPath, heading);
    const end = headings[index + 1]?.start ?? input.content.length;
    const sectionText = stripXml(
      input.content.slice(heading.contentStart, end)
    );
    // 空 heading 仍保留标题文本作为证据，保证 section hash 与人类可见结构一致。
    const normalizedText = sectionText || heading.title;
    sections.push({
      section_id: sourceSectionId(
        input.sourceId,
        headingPath,
        normalizedText
      ),
      heading_path: headingPath,
      text_hash: `sha256:${sha256(normalizedText)}`,
      char_start: heading.start,
      char_end: Math.max(heading.start + 1, end)
    });
  }

  if (sections.length === 0) {
    const text = stripXml(input.content) || input.title;
    sections.push({
      section_id: sourceSectionId(input.sourceId, ["正文"], text),
      heading_path: ["正文"],
      text_hash: `sha256:${sha256(text)}`,
      char_start: 0,
      char_end: Math.max(1, input.content.length)
    });
  }

  return SourceManifestSchema.parse({
    schema_version: 5,
    source_id: input.sourceId,
    connector: input.connector,
    artifact_kind: input.artifactKind ?? "document",
    external_key: input.externalKey,
    title: input.title,
    project_keys: input.projectKeys ?? [],
    content_type: input.contentType ?? "text/plain",
    content_bytes:
      input.contentBytes ?? Buffer.byteLength(input.content, "utf8"),
    redaction_policy: input.redactionPolicy ?? "not-applied",
    processing_profile: input.processingProfile ?? "legacy-unversioned",
    redactions: input.redactions ?? {},
    availability: "available",
    version: buildSourceVersion({
      observedAt: input.observedAt,
      contentHash,
      upstream: input.upstreamVersion
    }),
    processing_status: processingStatus,
    ...(input.processingReason
      ? { processing_reason: input.processingReason }
      : {}),
    ...(input.duplicateOf ? { duplicate_of: input.duplicateOf } : {}),
    ...(processingStatus === "pending"
      ? {}
      : {
          processed_at: input.processedAt ?? input.observedAt,
          processed_content_hash: input.processedContentHash ?? contentHash
        }),
    refined_knowledge_ids: input.refinedKnowledgeIds ?? [],
    ...(input.vaultObject ? { vault_object: input.vaultObject } : {}),
    sections
  });
}
