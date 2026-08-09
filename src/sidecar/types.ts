/**
 * External memory sidecar 只作为 shadow 投影和实验后端。
 *
 * 配置严格禁止凭据原值；外部返回不会成为 KnowledgeDocument，最多写入 `.memory/sidecars`
 * artifact 和比较报告。
 */
import { z } from "zod";
import { AutomationRetrySchema } from "../automation/types.js";

export const SidecarProviderSchema = z.enum(["hindsight", "memu", "mem0"]);
export type SidecarProvider = z.output<typeof SidecarProviderSchema>;

const EnvironmentVariableSchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/, "expected an environment variable name");

export const SidecarConfigSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    provider: SidecarProviderSchema,
    mode: z.literal("shadow"),
    baseUrl: z.string().url(),
    scope: z.string().min(1).max(200),
    auth: z
      .object({
        tokenEnv: EnvironmentVariableSchema,
        headerName: z
          .string()
          .regex(/^[A-Za-z0-9-]+$/)
          .default("Authorization"),
        prefix: z.string().max(30).default("Bearer ")
      })
      .strict()
      .optional(),
    endpoints: z
      .object({
        health: z.string().min(1),
        ingest: z.string().min(1),
        search: z.string().min(1),
        status: z.string().min(1).optional()
      })
      .strict(),
    timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    retry: AutomationRetrySchema.default({}),
    polling: z
      .object({
        intervalMs: z.number().int().min(1).max(60_000).default(1_000),
        maxAttempts: z.number().int().min(1).max(100).default(30)
      })
      .strict()
      .default({}),
    metadata: z.record(z.union([z.string(), z.number(), z.boolean()])).default({})
  })
  .strict();

export type SidecarConfig = z.output<typeof SidecarConfigSchema>;
export type SidecarConfigInput = z.input<typeof SidecarConfigSchema>;

export type SidecarItem = {
  id: string;
  text: string;
  metadata: Record<string, unknown>;
};

export type SidecarSearchResult = {
  text: string;
  score: number;
  nativeMemoryId?: string;
  metadata: Record<string, unknown>;
};

export type SidecarSearchResponse = {
  provider: SidecarProvider;
  sidecarId: string;
  query: string;
  latencyMs: number;
  results: SidecarSearchResult[];
  runId?: string;
};

export const SidecarRunSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^sidecar_run_[a-f0-9]{24}$/),
    sidecarId: z.string().min(1),
    provider: z.union([SidecarProviderSchema, z.literal("comparison")]),
    operation: z.enum(["doctor", "ingest", "search", "compare"]),
    status: z.enum(["succeeded", "failed"]),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    latencyMs: z.number().nonnegative(),
    artifactPath: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    error: z.string().max(500).optional()
  })
  .strict();

export type SidecarRun = z.output<typeof SidecarRunSchema>;
