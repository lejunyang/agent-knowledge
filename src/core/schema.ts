/**
 * 运行时 schema 是写入和读取知识时的安全网。
 *
 * TypeScript 类型只能约束编译期调用方，无法保护 CLI JSON 输入、Markdown frontmatter
 * 或其他 agent 生成的候选知识。V2 KnowledgeDocument 的权威契约位于
 * `knowledgeV2.ts`；这里保留统一公共入口和 query schema。
 */
import { z } from "zod";
import {
  KnowledgeDocumentV2Schema,
  KnowledgeFrontmatterV2Schema,
  ProjectKeySchema,
  SensitivitySchema,
  VisibilitySchema
} from "./knowledgeV2.js";

export {
  ActorTypeSchema,
  CaptureModeSchema,
  EpisodeProvenanceSchema,
  EvidenceAnchorSchema,
  KnowledgeClaimSchema,
  KnowledgeDocumentV2Schema as KnowledgeDocumentSchema,
  KnowledgeFrontmatterV2Schema as KnowledgeFrontmatterSchema,
  KnowledgeKindSchema as MemoryTypeSchema,
  KnowledgeLayerSchema,
  KnowledgeRelationSchema,
  MemoryStatusSchema,
  ProjectKeySchema,
  RelatedKnowledgeSchema,
  SensitivitySchema,
  SourceAuthoritySchema,
  VisibilitySchema,
  WeightedAliasSchema,
  WeightedScenarioSchema,
  WeightedTagSchema
} from "./knowledgeV2.js";

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

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
  includeTypes: z
    .array(
      z.enum([
        "profile",
        "semantic",
        "episodic",
        "procedural",
        "principle"
      ])
    )
    .default([
      "profile",
      "semantic",
      "episodic",
      "procedural",
      "principle"
    ]),
  now: DateStringSchema.default(() => new Date().toISOString().slice(0, 10)),
  visibilityScopes: z.array(VisibilitySchema).default(["private", "project", "team"]),
  sensitivityClearance: SensitivitySchema.default("internal"),
  projectKeys: z.array(ProjectKeySchema).default([])
});
