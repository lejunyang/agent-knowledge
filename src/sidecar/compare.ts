/**
 * Sidecar comparison 对同一 eval cases 运行 native baseline 和外部 shadow search。
 *
 * 只有显式 nativeMemoryId 能映射到 expected/forbidden ID；纯文本结果单独计为 unmapped，
 * 但在 abstain case 中仍表示外部后端返回了候选。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EvalCase } from "../retrieval/eval.js";
import {
  SidecarConfigSchema,
  type SidecarConfig,
  type SidecarConfigInput,
  type SidecarSearchResponse
} from "./types.js";
import { searchSidecar } from "./httpAdapter.js";
import { writeSidecarRun } from "./store.js";

export type ProviderComparisonMetrics = {
  cases: number;
  passed: number;
  failed: number;
  recallAt1: number;
  recallAt3: number;
  falseInjectionRate: number;
  abstentionPrecision: number;
  abstentionFailureRate: number;
  averageLatencyMs: number;
  unmappedResults: number;
};

export type SidecarComparisonReport = {
  generatedAt: string;
  providers: Record<string, ProviderComparisonMetrics>;
  jsonPath: string;
  markdownPath: string;
};

type ComparisonSearch = {
  ids: string[];
  returnedCount?: number;
  unmappedResults?: number;
  latencyMs: number;
};

/** 计算单个 provider 在全部 cases 上的指标。 */
function providerMetrics(
  cases: EvalCase[],
  results: ComparisonSearch[]
): ProviderComparisonMetrics {
  let passed = 0;
  let recallAt1 = 0;
  let recallAt3 = 0;
  let falseInjections = 0;
  let predictedAbstentions = 0;
  let correctAbstentions = 0;
  let expectedAbstentions = 0;
  let abstentionFailures = 0;
  let latency = 0;
  let unmappedResults = 0;
  for (const [index, evalCase] of cases.entries()) {
    const result = results[index] ?? {
      ids: [],
      returnedCount: 0,
      unmappedResults: 0,
      latencyMs: 0
    };
    const returnedCount = result.returnedCount ?? result.ids.length;
    const expected = evalCase.expected_memories;
    const missing = expected.filter((id) => !result.ids.includes(id));
    const forbidden = evalCase.forbidden_memories.filter((id) =>
      result.ids.includes(id)
    );
    const abstained = returnedCount === 0;
    const abstentionSatisfied = evalCase.abstain ? abstained : true;
    const casePassed =
      missing.length === 0 &&
      forbidden.length === 0 &&
      abstentionSatisfied;
    if (casePassed) {
      passed += 1;
    }
    if (expected.length === 0) {
      recallAt1 += 1;
      recallAt3 += 1;
    } else {
      recallAt1 += expected.filter((id) => result.ids.slice(0, 1).includes(id)).length / expected.length;
      recallAt3 += expected.filter((id) => result.ids.slice(0, 3).includes(id)).length / expected.length;
    }
    if (forbidden.length > 0 || (evalCase.abstain && !abstained)) {
      falseInjections += 1;
    }
    if (evalCase.abstain) {
      expectedAbstentions += 1;
      if (!abstained) {
        abstentionFailures += 1;
      }
    }
    if (abstained) {
      predictedAbstentions += 1;
      if (evalCase.abstain) {
        correctAbstentions += 1;
      }
    }
    latency += result.latencyMs;
    unmappedResults += result.unmappedResults ?? 0;
  }
  return {
    cases: cases.length,
    passed,
    failed: cases.length - passed,
    recallAt1: cases.length === 0 ? 1 : recallAt1 / cases.length,
    recallAt3: cases.length === 0 ? 1 : recallAt3 / cases.length,
    falseInjectionRate:
      cases.length === 0 ? 0 : falseInjections / cases.length,
    abstentionPrecision:
      predictedAbstentions === 0
        ? 1
        : correctAbstentions / predictedAbstentions,
    abstentionFailureRate:
      expectedAbstentions === 0
        ? 0
        : abstentionFailures / expectedAbstentions,
    averageLatencyMs: cases.length === 0 ? 0 : latency / cases.length,
    unmappedResults
  };
}

/** 生成方便 Git/通知阅读的 Markdown 指标表。 */
function reportMarkdown(report: Omit<SidecarComparisonReport, "jsonPath" | "markdownPath">): string {
  const lines = [
    "# Sidecar Shadow Comparison",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Provider | Passed | Failed | Recall@1 | Recall@3 | False Injection | Abstention Failure | Avg Latency | Unmapped |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const [provider, metrics] of Object.entries(report.providers)) {
    lines.push(
      `| ${provider} | ${metrics.passed} | ${metrics.failed} | ${metrics.recallAt1.toFixed(4)} | ${metrics.recallAt3.toFixed(4)} | ${metrics.falseInjectionRate.toFixed(4)} | ${metrics.abstentionFailureRate.toFixed(4)} | ${metrics.averageLatencyMs.toFixed(2)} ms | ${metrics.unmappedResults} |`
    );
  }
  lines.push(
    "",
    "External sidecar results are shadow-only and never become Agent Knowledge facts."
  );
  return `${lines.join("\n")}\n`;
}

/** 运行 native + sidecars，对比结果写 JSON/Markdown 与 `.memory` run artifact。 */
export async function compareSidecars(options: {
  rootDir: string;
  cases: EvalCase[];
  configs: SidecarConfigInput[];
  outputDir: string;
  nativeSearch: (task: string, evalCase: EvalCase) => Promise<{
    ids: string[];
    latencyMs: number;
  }>;
  sidecarSearch?: (
    config: SidecarConfig,
    task: string,
    evalCase: EvalCase
  ) => Promise<SidecarSearchResponse>;
  now?: () => Date;
}): Promise<SidecarComparisonReport> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const providers: Record<string, ProviderComparisonMetrics> = {};
  const nativeResults: ComparisonSearch[] = [];
  for (const evalCase of options.cases) {
    const result = await options.nativeSearch(evalCase.task, evalCase);
    nativeResults.push({
      ids: result.ids,
      returnedCount: result.ids.length,
      unmappedResults: 0,
      latencyMs: result.latencyMs
    });
  }
  providers.native = providerMetrics(options.cases, nativeResults);

  for (const rawConfig of options.configs) {
    const config = SidecarConfigSchema.parse(rawConfig);
    const results: ComparisonSearch[] = [];
    for (const evalCase of options.cases) {
      const response = options.sidecarSearch
        ? await options.sidecarSearch(config, evalCase.task, evalCase)
        : await searchSidecar(config, evalCase.task);
      const ids = response.results.flatMap((item) =>
        item.nativeMemoryId ? [item.nativeMemoryId] : []
      );
      results.push({
        ids,
        returnedCount: response.results.length,
        unmappedResults: response.results.filter(
          (item) => !item.nativeMemoryId
        ).length,
        latencyMs: response.latencyMs
      });
    }
    providers[config.id] = providerMetrics(options.cases, results);
  }

  const reportCore = { generatedAt, providers };
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const jsonPath = path.join(outputDir, "sidecar-comparison.json");
  const markdownPath = path.join(outputDir, "sidecar-comparison.md");
  await writeFile(
    jsonPath,
    `${JSON.stringify(reportCore, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await writeFile(markdownPath, reportMarkdown(reportCore), {
    encoding: "utf8",
    mode: 0o600
  });
  const startedAt = generatedAt;
  const completedAt = (options.now?.() ?? new Date()).toISOString();
  await writeSidecarRun(options.rootDir, {
    sidecarId: "comparison",
    provider: "hindsight",
    operation: "compare",
    status: "succeeded",
    startedAt,
    completedAt,
    latencyMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
    artifact: reportCore
  });
  return { ...reportCore, jsonPath, markdownPath };
}
