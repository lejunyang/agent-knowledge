/**
 * Memory-use Policy 是与业务知识分离的行为控制资产。
 *
 * P0-P2 只允许 `shadow` 或 `deprecated`，不能通过 schema 偷渡 runtime active；P3 必须在
 * 独立评审后显式扩展状态和执行契约。
 */
import { z } from "zod";
import { ProjectKeySchema } from "../core/knowledgeV2.js";

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

const PolicyIdSchema = z
  .string()
  .regex(/^policy_[a-z0-9]+(?:_[a-z0-9]+)*$/);

const PolicyApplicabilitySchema = z
  .object({
    domains: z.array(z.string().min(1)).max(20).default([]),
    scenarios: z.array(z.string().min(1)).max(20).default([]),
    project_keys: z.array(ProjectKeySchema).max(20).default([]),
    query_terms_any: z.array(z.string().min(1)).max(30).default([]),
    query_terms_all: z.array(z.string().min(1)).max(20).default([]),
    excluded_terms: z.array(z.string().min(1)).max(30).default([])
  })
  .strict()
  .superRefine((scope, context) => {
    if (
      scope.domains.length === 0 &&
      scope.scenarios.length === 0 &&
      scope.project_keys.length === 0 &&
      scope.query_terms_any.length === 0 &&
      scope.query_terms_all.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policy applicability must define a bounded scope"
      });
    }
  });

const PolicyEvidenceSchema = z
  .object({
    query_run_ids: z.array(z.string().min(1)).max(500).default([]),
    feedback_keys: z.array(z.string().min(1)).max(500).default([]),
    eval_case_ids: z.array(z.string().min(1)).max(500).default([])
  })
  .strict();

const PolicyBaseSchema = z.object({
  version: z.literal(1),
  id: PolicyIdSchema,
  status: z.enum(["shadow", "deprecated"]),
  title: z.string().min(1).max(200),
  rationale: z.string().min(1).max(2_000),
  priority: z.number().int().min(0).max(1_000).default(50),
  applicability: PolicyApplicabilitySchema,
  evidence: PolicyEvidenceSchema,
  created_at: DateStringSchema,
  updated_at: DateStringSchema
});

export const RetrievalLessonSchema = PolicyBaseSchema.extend({
  kind: z.literal("retrieval_lesson"),
  directive: z
    .object({
      route_domains: z.array(z.string().min(1)).max(20).default([]),
      route_scenarios: z.array(z.string().min(1)).max(20).default([]),
      prefer_memory_ids: z.array(z.string().min(1)).max(100).default([]),
      suppress_memory_ids: z.array(z.string().min(1)).max(100).default([]),
      abstain_if_no_preferred_memory: z.boolean().default(false),
      require_source_refresh: z.boolean().default(false)
    })
    .strict()
});

export const ReasoningPolicyCheckSchema = z.enum([
  "unresolved_conflict",
  "expired_fact",
  "missing_documented_evidence",
  "insufficient_detail",
  "high_risk_without_evidence"
]);

export const ReasoningPolicySchema = PolicyBaseSchema.extend({
  kind: z.literal("reasoning_policy"),
  directive: z
    .object({
      checks: z.array(ReasoningPolicyCheckSchema).min(1).max(20),
      required_layers: z
        .array(z.enum(["synopsis", "knowledge", "evidence"]))
        .max(3)
        .default([]),
      authority_order: z
        .array(
          z.enum([
            "documented",
            "user_confirmed",
            "verified_task",
            "model_inferred"
          ])
        )
        .max(4)
        .default([]),
      decision_on_violation: z.enum(["warn", "abstain"])
    })
    .strict()
});

export const MemoryUsePolicySchema = z.discriminatedUnion("kind", [
  RetrievalLessonSchema,
  ReasoningPolicySchema
]);

export type RetrievalLesson = z.output<typeof RetrievalLessonSchema>;
export type ReasoningPolicy = z.output<typeof ReasoningPolicySchema>;
export type MemoryUsePolicy = z.output<typeof MemoryUsePolicySchema>;
export type MemoryUsePolicyInput = z.input<typeof MemoryUsePolicySchema>;
