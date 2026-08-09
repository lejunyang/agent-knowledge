/**
 * 后台自动化契约只描述有界输入、任务状态和通知，不包含外部凭据原值。
 *
 * 这些结构会写入 `.memory` 供不同 Agent CLI 和进程管理器复用；active Markdown、Vault
 * evidence 和外部服务响应都不属于 profile 本身。
 */
import path from "node:path";
import { z } from "zod";
import { ConnectorIdSchema } from "../ingestion/types.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "expected an absolute path");

const EnvironmentVariableSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "expected an environment variable name");

/** 重试配置刻意限制次数和最大等待，防止后台任务无限消耗资源。 */
export const AutomationRetrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10).default(3),
    baseDelayMs: z.number().int().min(1).max(60_000).default(1_000),
    maxDelayMs: z.number().int().min(1).max(300_000).default(30_000)
  })
  .refine(
    (value) => value.maxDelayMs >= value.baseDelayMs,
    "maxDelayMs must be greater than or equal to baseDelayMs"
  );

export type AutomationRetry = z.output<typeof AutomationRetrySchema>;

/** Lark 在线刷新只允许显式 roots、身份、批次、限流和重试，不能自行扩大空间范围。 */
const LarkAutomationSourceSchema = z
  .object({
    kind: z.literal("lark"),
    connectorId: ConnectorIdSchema,
    roots: z.array(z.string().url()).min(1).max(100),
    exportDir: AbsolutePathSchema,
    identity: z.enum(["user", "bot"]).default("user"),
    maxDocuments: z.number().int().min(1).max(10_000).default(500),
    rateLimit: z
      .object({
        minIntervalMs: z.number().int().min(0).max(60_000).default(250)
      })
      .default({}),
    retry: AutomationRetrySchema.default({})
  })
  .strict();

/** Git 在线刷新只 fetch allowlist remote/ref，不执行 pull、checkout、merge 或 push。 */
const GitAutomationSourceSchema = z
  .object({
    kind: z.literal("git"),
    connectorId: ConnectorIdSchema,
    repositoryDir: AbsolutePathSchema,
    remote: z.string().regex(/^[A-Za-z0-9._-]+$/).default("origin"),
    refs: z.array(z.string().min(1)).min(1).max(20),
    retry: AutomationRetrySchema.default({})
  })
  .strict();

export const AutomationSourceSchema = z.discriminatedUnion("kind", [
  LarkAutomationSourceSchema,
  GitAutomationSourceSchema
]);

/** Callback 只持久化 URL 和凭据环境变量名；原值由运行进程注入。 */
export const CallbackConfigSchema = z
  .object({
    url: z.string().url(),
    tokenEnv: EnvironmentVariableSchema.optional(),
    headerName: z
      .string()
      .regex(/^[A-Za-z0-9-]+$/)
      .default("Authorization"),
    headerPrefix: z.string().max(30).default("Bearer "),
    timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
    retry: AutomationRetrySchema.default({})
  })
  .strict();

export type CallbackConfig = z.output<typeof CallbackConfigSchema>;
export type CallbackConfigInput = z.input<typeof CallbackConfigSchema>;

/** 自动化 profile 是其他 Agent CLI 的唯一授权输入；未知字段严格拒绝。 */
export const AutomationProfileSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    knowledgeRoot: AbsolutePathSchema,
    sources: z.array(AutomationSourceSchema).max(100).default([]),
    tasks: z
      .object({
        refreshSources: z.boolean().default(true),
        maintenance: z.boolean().default(true),
        audit: z.boolean().default(true),
        evalFiles: z.array(AbsolutePathSchema).max(50).default([]),
        deliverNotifications: z.boolean().default(true)
      })
      .strict()
      .default({}),
    agent: z
      .object({
        maxRuntimeMinutes: z.number().int().min(1).max(24 * 60).default(30),
        maxQuestions: z.number().int().min(1).max(100).default(20),
        systemPrompt: AbsolutePathSchema
      })
      .strict(),
    callback: CallbackConfigSchema.optional()
  })
  .strict();

export type AutomationProfile = z.output<typeof AutomationProfileSchema>;

export const AutomationJobStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "needs_confirmation"
]);

/** Job 只保存执行摘要和 artifact 路径，不复制完整 prompt、evidence 或凭据。 */
export const AutomationJobSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^job_[a-f0-9]{24}$/),
    profileId: z.string().min(1),
    idempotencyKey: z.string().min(1).max(300),
    trigger: z.enum(["manual", "schedule", "callback"]),
    status: AutomationJobStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    summary: z.string().max(1_000).optional(),
    artifacts: z.array(z.string().min(1)).max(100).default([]),
    error: z.string().max(500).optional()
  })
  .strict();

export type AutomationJob = z.output<typeof AutomationJobSchema>;

export const NotificationTypeSchema = z.enum([
  "confirmation_required",
  "source_updates_found",
  "source_refresh_failed",
  "inventory_incomplete",
  "maintenance_proposals_ready",
  "eval_regression",
  "sidecar_regression",
  "automation_failed"
]);

export const NotificationStatusSchema = z.enum([
  "pending",
  "delivered",
  "failed",
  "acked"
]);

/** Notification details 只允许 JSON 值；调用方必须先脱敏并保持体积有界。 */
const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema)
  ])
);

export const NotificationSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^notification_[a-f0-9]{24}$/),
    type: NotificationTypeSchema,
    severity: z.enum(["info", "warning", "error"]),
    title: z.string().min(1).max(200),
    summary: z.string().min(1).max(2_000),
    dedupeKey: z.string().min(1).max(300),
    details: z.record(JsonValueSchema),
    status: NotificationStatusSchema,
    attempts: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    nextAttemptAt: z.string().datetime().optional(),
    deliveredAt: z.string().datetime().optional(),
    ackedAt: z.string().datetime().optional(),
    lastError: z.string().max(500).optional()
  })
  .strict();

export type Notification = z.output<typeof NotificationSchema>;

export type NotificationInput = {
  type: z.output<typeof NotificationTypeSchema>;
  severity: "info" | "warning" | "error";
  title: string;
  summary: string;
  dedupeKey: string;
  details: Record<string, unknown>;
};
