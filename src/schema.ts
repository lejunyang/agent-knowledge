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

export const RelatedKnowledgeSchema = z.object({
  id: z.string().min(1),
  relation: KnowledgeRelationSchema,
  reason: z.string().min(1)
});

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

export const KnowledgeDocumentSchema = z.object({
  filePath: z.string().min(1),
  frontmatter: KnowledgeFrontmatterSchema,
  body: z.string()
});

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
