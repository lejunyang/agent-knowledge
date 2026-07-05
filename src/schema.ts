/**
 * 运行时 schema 是写入和读取知识时的安全网。
 *
 * TypeScript 类型只能约束编译期调用方，无法保护 CLI JSON 输入、Markdown frontmatter
 * 或其他 agent 生成的候选知识。因此所有外部输入都应先经过这里的 Zod schema。
 */
import { z } from "zod";

export const MemoryTypeSchema = z.enum(["profile", "semantic", "episodic", "procedural", "source"]);
export const MemoryStatusSchema = z.enum(["proposed", "active", "deprecated", "rejected"]);
export const SourceAuthoritySchema = z.enum(["user_confirmed", "model_inferred", "documented", "verified_task"]);
export const VisibilitySchema = z.enum(["private", "project", "team"]);
export const SensitivitySchema = z.enum(["public", "internal", "confidential", "secret"]);
export const KnowledgeRelationSchema = z.enum([
  "depends_on",
  "refines",
  "supports",
  "conflicts_with",
  "supersedes",
  "often_used_with"
]);

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * related_knowledge 是精确关系边。
 *
 * reason 必填，是为了让人类审阅时知道为什么两条知识被关联，避免形成不可解释的黑盒图谱。
 */
export const RelatedKnowledgeSchema = z.object({
  id: z.string().min(1),
  relation: KnowledgeRelationSchema,
  reason: z.string().min(1)
});

/**
 * Markdown frontmatter 的权威 schema。
 *
 * 默认值只用于低风险字段，例如可见性和空数组；事实类字段仍要求显式提供，防止自动写入过于随意。
 */
export const KnowledgeFrontmatterSchema = z.object({
  id: z.string().regex(/^k_[a-zA-Z0-9_]+$/),
  type: MemoryTypeSchema,
  title: z.string().min(1),
  domain: z.string().min(1),
  related_domains: z.array(z.string().min(1)).default([]),
  scenario: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).default([]),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  source_authority: SourceAuthoritySchema,
  source: z.array(z.string()).default([]),
  related_knowledge: z.array(RelatedKnowledgeSchema).default([]),
  supersedes: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default("project"),
  sensitivity: SensitivitySchema.default("internal"),
  created_at: DateStringSchema,
  updated_at: DateStringSchema,
  valid_from: DateStringSchema,
  valid_until: DateStringSchema.nullable().default(null)
});

/**
 * 解析后的 Markdown 文档必须同时拥有合法 metadata 和正文。
 */
export const KnowledgeDocumentSchema = z.object({
  filePath: z.string().min(1),
  frontmatter: KnowledgeFrontmatterSchema,
  body: z.string()
});

/**
 * 查询请求 schema 会补齐默认 includeTypes 和 token 预算。
 *
 * 这样 CLI、hook 和库调用都能共享相同默认行为。
 */
export const MemoryQueryRequestSchema = z.object({
  task: z.string().min(1),
  agentRole: z.string().default("main"),
  paths: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  scenarios: z.array(z.string()).default([]),
  maxTokens: z.number().int().positive().default(4500),
  includeTypes: z.array(z.enum(["profile", "semantic", "episodic", "procedural"])).default([
    "profile",
    "semantic",
    "episodic",
    "procedural"
  ])
});
