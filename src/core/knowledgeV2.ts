/**
 * V2 知识契约把“内容类型”和“抽象层级”拆成两个正交维度。
 *
 * Markdown 中的 synopsis 用于低成本路由，正文承载可执行解释，claim/evidence
 * 用于回溯来源。SQLite、embedding、graph 和外部 memory backend 都只是投影，
 * 不能替代 Markdown 与后续 Evidence Vault 中的事实源。
 */
import { z } from "zod";

export const KnowledgeKindSchema = z.enum([
  "profile",
  "semantic",
  "episodic",
  "procedural",
  "principle",
  "skill",
  "source"
]);
export const KnowledgeLayerSchema = z.enum([
  "synopsis",
  "knowledge",
  "evidence"
]);
export const MemoryStatusSchema = z.enum([
  "proposed",
  "active",
  "deprecated",
  "rejected"
]);
export const SourceAuthoritySchema = z.enum([
  "user_confirmed",
  "model_inferred",
  "documented",
  "verified_task"
]);
export const VisibilitySchema = z.enum(["private", "project", "team"]);
export const SensitivitySchema = z.enum([
  "public",
  "internal",
  "confidential",
  "secret"
]);
export const CaptureModeSchema = z.enum([
  "explicit_remember",
  "verified_task",
  "automated_session",
  "direct_material"
]);
export const ActorTypeSchema = z.enum([
  "owner",
  "teammate",
  "customer",
  "agent"
]);
export const KnowledgeRelationSchema = z.enum([
  "depends_on",
  "refines",
  "supports",
  "conflicts_with",
  "supersedes",
  "often_used_with"
]);

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * 项目 key 优先使用规范化 Git remote；没有 remote 时必须由用户显式提供
 * `local/...`，不能把不可读 hash 或绝对路径暴露为知识作用域。
 */
export const ProjectKeySchema = z
  .string()
  .min(3)
  .regex(
    /^(?:[a-z0-9.-]+\/[a-z0-9._/-]+|local\/[a-z0-9._/-]+)$/,
    "expected a normalized Git remote or explicit local key"
  );

/** alias 保存语义、来源和权重，避免通用短词获得与规范术语相同的检索影响。 */
export const WeightedAliasSchema = z.object({
  value: z.string().min(1),
  kind: z.enum([
    "abbreviation",
    "translation",
    "previous_name",
    "user_phrase",
    "query_observed",
    "technical_identifier"
  ]),
  weight: z.number().min(0).max(1),
  source: z.enum([
    "documented",
    "user_confirmed",
    "query_observed"
  ]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  positive_hits: z.number().int().nonnegative().default(0),
  negative_hits: z.number().int().nonnegative().default(0)
});

/** scenario 区分主场景和次场景，并显式表达关联强度。 */
export const WeightedScenarioSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["primary", "secondary"]),
  weight: z.number().min(0).max(1)
});

/** provenance 类 tag 可以保留给审计，但可通过 retrieval=false 排除检索。 */
export const WeightedTagSchema = z.object({
  value: z.string().min(1),
  weight: z.number().min(0).max(1),
  source: z.enum(["taxonomy", "documented", "observed"]),
  retrieval: z.boolean().default(true)
});

/** 精确知识关系必须附 reason，避免形成无法解释的图谱边。 */
export const RelatedKnowledgeSchema = z.object({
  id: z.string().min(1),
  relation: KnowledgeRelationSchema,
  reason: z.string().min(1)
});

/**
 * evidence anchor 指向 source manifest 中的稳定 section。
 *
 * quote_hash 让后续 Vault 展开时可以验证原文没有被静默替换；char range 只是
 * 可选的快速定位信息，不能代替 section/hash 身份。
 */
export const EvidenceAnchorSchema = z.object({
  source_id: z.string().min(1),
  section_id: z.string().min(1),
  quote_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().positive().optional()
});

/** supported claim 必须有证据；没有证据的判断只能保持 disputed 或 proposal。 */
export const KnowledgeClaimSchema = z
  .object({
    id: z.string().regex(/^claim_[a-zA-Z0-9_]+$/),
    statement: z.string().min(1),
    status: z.enum(["supported", "disputed", "superseded"]),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceAnchorSchema).default([])
  })
  .superRefine((claim, context) => {
    if (claim.status === "supported" && claim.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "supported claim requires evidence"
      });
    }
  });

/** episode 只保存可审计引用；完整会话与工具轨迹由 Evidence Vault 管理。 */
export const EpisodeProvenanceSchema = z.object({
  episode_id: z.string().min(1),
  session_hash: z.string().min(1),
  turn_hash: z.string().min(1).optional(),
  project_key: ProjectKeySchema.optional(),
  observed_at: z.string().datetime(),
  evidence_refs: z.array(z.string().min(1)).default([])
});

/**
 * V2 Markdown frontmatter 的唯一权威 schema。
 *
 * 本项目允许不兼容升级，因此没有 V1 fallback；旧知识必须从原始证据重建，
 * 不能通过默认权重或空 claim 伪装成经过 V2 治理的知识。
 */
export const KnowledgeFrontmatterV2Schema = z.object({
  schema_version: z.literal(2),
  id: z.string().regex(/^k_[a-zA-Z0-9_]+$/),
  kind: KnowledgeKindSchema,
  layer: KnowledgeLayerSchema,
  title: z.string().min(1),
  synopsis: z.string().min(1).max(1200),
  aliases: z.array(WeightedAliasSchema).max(16).default([]),
  domain: z.string().min(1),
  related_domains: z.array(z.string().min(1)).default([]),
  scenarios: z.array(WeightedScenarioSchema).min(1).max(6),
  tags: z.array(WeightedTagSchema).max(12).default([]),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  source_authority: SourceAuthoritySchema,
  source: z.array(z.string()).default([]),
  claims: z.array(KnowledgeClaimSchema).default([]),
  related_knowledge: z.array(RelatedKnowledgeSchema).default([]),
  supersedes: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default("project"),
  sensitivity: SensitivitySchema.default("internal"),
  project_keys: z.array(ProjectKeySchema).default([]),
  capture_mode: CaptureModeSchema.default("direct_material"),
  actor_type: ActorTypeSchema.default("owner"),
  corroboration_count: z.number().int().nonnegative().default(1),
  episodes: z.array(EpisodeProvenanceSchema).default([]),
  created_at: DateStringSchema,
  updated_at: DateStringSchema,
  valid_from: DateStringSchema,
  valid_until: DateStringSchema.nullable().default(null)
});

/** 解析后的知识必须同时拥有合法 frontmatter 和可审阅正文。 */
export const KnowledgeDocumentV2Schema = z.object({
  filePath: z.string().min(1),
  frontmatter: KnowledgeFrontmatterV2Schema,
  body: z.string()
});

export type KnowledgeKind = z.output<typeof KnowledgeKindSchema>;
export type KnowledgeLayer = z.output<typeof KnowledgeLayerSchema>;
export type MemoryStatus = z.output<typeof MemoryStatusSchema>;
export type SourceAuthority = z.output<typeof SourceAuthoritySchema>;
export type Visibility = z.output<typeof VisibilitySchema>;
export type Sensitivity = z.output<typeof SensitivitySchema>;
export type CaptureMode = z.output<typeof CaptureModeSchema>;
export type ActorType = z.output<typeof ActorTypeSchema>;
export type KnowledgeRelation = z.output<typeof KnowledgeRelationSchema>;
export type WeightedAlias = z.output<typeof WeightedAliasSchema>;
export type WeightedScenario = z.output<typeof WeightedScenarioSchema>;
export type WeightedTag = z.output<typeof WeightedTagSchema>;
export type RelatedKnowledge = z.output<typeof RelatedKnowledgeSchema>;
export type EvidenceAnchor = z.output<typeof EvidenceAnchorSchema>;
export type KnowledgeClaim = z.output<typeof KnowledgeClaimSchema>;
export type EpisodeProvenance = z.output<typeof EpisodeProvenanceSchema>;
export type KnowledgeFrontmatter = z.output<
  typeof KnowledgeFrontmatterV2Schema
>;
export type KnowledgeDocument = z.output<typeof KnowledgeDocumentV2Schema>;
