/**
 * Sidecar history 从 `.memory/sidecars` 的 comparison artifact 汇总长期指标。
 *
 * Artifact 只包含 eval 指标，不含 query/result 文本；损坏或旧格式记录会被显式跳过，
 * 不能让一个坏文件阻断整段历史审计。
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { listSidecarRuns } from "./store.js";

const ProviderMetricsSchema = z
  .object({
    cases: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    recallAt1: z.number().nonnegative(),
    recallAt3: z.number().nonnegative(),
    falseInjectionRate: z.number().nonnegative(),
    abstentionPrecision: z.number().nonnegative(),
    abstentionFailureRate: z.number().nonnegative(),
    averageLatencyMs: z.number().nonnegative(),
    unmappedResults: z.number().int().nonnegative()
  })
  .strict();

const ComparisonArtifactSchema = z
  .object({
    generatedAt: z.string().datetime(),
    providers: z.record(ProviderMetricsSchema)
  })
  .strict();

/** 单次 comparison 的安全指标快照，不包含 query 或 result 文本。 */
export type SidecarHistoryEntry = {
  runId: string;
  generatedAt: string;
  completedAt: string;
  providers: z.output<typeof ComparisonArtifactSchema>["providers"];
};

/** 历史读取同时返回可用记录与被隔离的损坏 run。 */
export type SidecarHistoryResult = {
  entries: SidecarHistoryEntry[];
  skipped: Array<{ runId: string; reason: string }>;
};

/** 读取按时间倒序的安全指标历史；limit 只作用于成功解析的 comparison。 */
export async function readSidecarComparisonHistory(
  rootDir: string,
  options: { limit?: number } = {}
): Promise<SidecarHistoryResult> {
  const limit = z.number().int().min(1).max(1_000).parse(options.limit ?? 50);
  const runs = (await listSidecarRuns(rootDir))
    .filter((run) => run.operation === "compare")
    .sort(
      (left, right) =>
        right.completedAt.localeCompare(left.completedAt) ||
        right.id.localeCompare(left.id)
    );
  const entries: SidecarHistoryEntry[] = [];
  const skipped: SidecarHistoryResult["skipped"] = [];
  for (const run of runs) {
    if (entries.length >= limit) {
      break;
    }
    try {
      const artifact = ComparisonArtifactSchema.parse(
        JSON.parse(await readFile(run.artifactPath, "utf8"))
      );
      entries.push({
        runId: run.id,
        generatedAt: artifact.generatedAt,
        completedAt: run.completedAt,
        providers: artifact.providers
      });
    } catch (error) {
      skipped.push({
        runId: run.id,
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          300
        )
      });
    }
  }
  return { entries, skipped };
}
