/**
 * Policy simulation 在显式 eval 上离线编译临时 QueryPlan/ReasoningContract。
 *
 * 它不写用户配置、不改变普通 query/Hook，也不产生 active Policy。报告和 history 只保存
 * case ID/hash、Policy ID、指标和 deterministic violation，不保存 task 或知识正文。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { MemoryQueryRequestSchema } from "../core/schema.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { buildContextPacket } from "../retrieval/contextPacket.js";
import {
  loadEvalSuite,
  runEvalSuite,
  type EvalCase
} from "../retrieval/eval.js";
import { queryMemoriesWithDebug } from "../retrieval/query.js";
import { listPolicies } from "./store.js";
import type {
  MemoryUsePolicy,
  ReasoningPolicy,
  RetrievalLesson
} from "./types.js";

const SimulationMetricsSchema = z
  .object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    recallAt1: z.number().nonnegative(),
    recallAt3: z.number().nonnegative(),
    falseInjectionRate: z.number().nonnegative(),
    abstentionFailureRate: z.number().nonnegative()
  })
  .strict();

const SimulationCaseResultSchema = z
  .object({
    caseId: z.string().min(1),
    caseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    applicablePolicyIds: z.array(z.string()),
    baselinePassed: z.boolean(),
    shadowPassed: z.boolean(),
    baselineInjectedIds: z.array(z.string()),
    shadowInjectedIds: z.array(z.string()),
    reasoningDecision: z.enum(["proceed", "warn", "abstain"]),
    reasoningExpectedDecision: z
      .enum(["proceed", "warn", "abstain"])
      .optional(),
    reasoningPassed: z.boolean(),
    reasoningViolations: z.array(z.string())
  })
  .strict();

const PolicySimulationHistoryEntrySchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(/^policy_simulation_[a-f0-9]{24}$/),
    generatedAt: z.string().datetime(),
    policyIds: z.array(z.string()),
    baseline: SimulationMetricsSchema,
    shadow: SimulationMetricsSchema,
    caseResults: z.array(SimulationCaseResultSchema)
  })
  .strict();

export type PolicySimulationMetrics = z.output<
  typeof SimulationMetricsSchema
>;
export type PolicySimulationCaseResult = z.output<
  typeof SimulationCaseResultSchema
>;
export type PolicySimulationHistoryEntry = z.output<
  typeof PolicySimulationHistoryEntrySchema
>;
export type PolicySimulationReport = PolicySimulationHistoryEntry & {
  jsonPath: string;
  markdownPath: string;
  historyPath: string;
};

export type PolicySimulationHistoryResult = {
  entries: PolicySimulationHistoryEntry[];
  skipped: Array<{ file: string; reason: string }>;
};

/** 稳定去重字符串，保证同一组 Policy 和 case 产生可比较输出。 */
function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Case ID 优先使用显式 ID，否则使用不含 task 原文的 hash ID。 */
function caseIdentity(evalCase: EvalCase): {
  caseId: string;
  caseHash: `sha256:${string}`;
} {
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        task: evalCase.task,
        domains: evalCase.domains,
        scenarios: evalCase.scenarios,
        projectKeys: evalCase.project_keys ?? []
      })
    )
    .digest("hex");
  return {
    caseId: evalCase.id ?? `eval_case_${hash.slice(0, 20)}`,
    caseHash: `sha256:${hash}`
  };
}

/** 非空 Policy scope 字段必须与 case 相交；query term 条件按 any/all/excluded 解释。 */
function policyApplies(policy: MemoryUsePolicy, evalCase: EvalCase): boolean {
  if (policy.status !== "shadow") {
    return false;
  }
  const scope = policy.applicability;
  const intersects = (required: string[], actual: string[]): boolean =>
    required.length === 0 || required.some((item) => actual.includes(item));
  if (
    !intersects(scope.domains, evalCase.domains) ||
    !intersects(scope.scenarios, evalCase.scenarios) ||
    !intersects(scope.project_keys, evalCase.project_keys ?? [])
  ) {
    return false;
  }
  const task = evalCase.task.toLowerCase();
  if (
    scope.excluded_terms.some((term) =>
      task.includes(term.toLowerCase())
    )
  ) {
    return false;
  }
  if (
    scope.query_terms_any.length > 0 &&
    !scope.query_terms_any.some((term) =>
      task.includes(term.toLowerCase())
    )
  ) {
    return false;
  }
  return scope.query_terms_all.every((term) =>
    task.includes(term.toLowerCase())
  );
}

/** 把 applicable Retrieval Lesson 编译成仅本次 simulation 使用的临时计划。 */
function retrievalPlan(policies: RetrievalLesson[]): {
  routeDomains: string[];
  routeScenarios: string[];
  preferIds: string[];
  suppressIds: string[];
  abstainIfNoPreferred: boolean;
} {
  return {
    routeDomains: unique(
      policies.flatMap((policy) => policy.directive.route_domains)
    ),
    routeScenarios: unique(
      policies.flatMap((policy) => policy.directive.route_scenarios)
    ),
    preferIds: unique(
      policies.flatMap((policy) => policy.directive.prefer_memory_ids)
    ),
    suppressIds: unique(
      policies.flatMap((policy) => policy.directive.suppress_memory_ids)
    ),
    abstainIfNoPreferred: policies.some(
      (policy) => policy.directive.abstain_if_no_preferred_memory
    )
  };
}

/** 从 packet 提取实际注入 ID，复用 production token budget 后的结果。 */
function packetIds(packet: ReturnType<typeof buildContextPacket>): string[] {
  return [
    ...packet.route,
    ...packet.claims,
    ...packet.procedures,
    ...packet.principles,
    ...packet.episodes
  ].map((item) => item.id);
}

/** 计算单个 shadow retrieval 结果，不持久化 query-run。 */
function shadowRetrieval(
  rootDir: string,
  evalCase: EvalCase,
  policies: RetrievalLesson[]
): {
  passed: boolean;
  matchedIds: string[];
  injectedIds: string[];
  falseInjection: boolean;
  abstentionFailure: boolean;
} {
  const plan = retrievalPlan(policies);
  const request = MemoryQueryRequestSchema.parse({
    task: evalCase.task,
    agentRole: "main",
    domains: unique([...evalCase.domains, ...plan.routeDomains]),
    scenarios: unique([...evalCase.scenarios, ...plan.routeScenarios]),
    projectKeys: evalCase.project_keys ?? [],
    maxTokens: evalCase.max_tokens ?? 4500,
    now: evalCase.now ?? new Date().toISOString().slice(0, 10),
    visibilityScopes: ["private", "project", "team"],
    sensitivityClearance: "internal",
    includeTypes: ["profile", "semantic", "episodic", "procedural"]
  });
  const base = queryMemoriesWithDebug(rootDir, request, { log: false });
  const preferred = new Set(plan.preferIds);
  const suppressed = new Set(plan.suppressIds);
  let ranked = base.ranked
    .filter((memory) => !suppressed.has(memory.document.frontmatter.id))
    .sort((left, right) => {
      const leftPreferred = preferred.has(left.document.frontmatter.id);
      const rightPreferred = preferred.has(right.document.frontmatter.id);
      return (
        Number(rightPreferred) - Number(leftPreferred) ||
        right.finalScore - left.finalScore ||
        left.document.frontmatter.id.localeCompare(
          right.document.frontmatter.id
        )
      );
    });
  if (
    plan.abstainIfNoPreferred &&
    plan.preferIds.length > 0 &&
    !ranked.some((memory) =>
      preferred.has(memory.document.frontmatter.id)
    )
  ) {
    ranked = [];
  }
  const matchedIds = ranked.map(
    (memory) => memory.document.frontmatter.id
  );
  const injectedIds = packetIds(buildContextPacket({ request, ranked }));
  const missingExpected = evalCase.expected_memories.filter(
    (id) => !injectedIds.includes(id)
  );
  const presentForbidden = evalCase.forbidden_memories.filter((id) =>
    injectedIds.includes(id)
  );
  const abstentionFailure = Boolean(
    evalCase.abstain && injectedIds.length > 0
  );
  return {
    passed:
      missingExpected.length === 0 &&
      presentForbidden.length === 0 &&
      !abstentionFailure,
    matchedIds,
    injectedIds,
    falseInjection: presentForbidden.length > 0 || abstentionFailure,
    abstentionFailure
  };
}

/** 计算 expected ID 在 top K 的平均覆盖率。 */
function recallAt(
  results: Array<{ matchedIds: string[] }>,
  cases: EvalCase[],
  k: 1 | 3
): number {
  const answerable = cases
    .map((evalCase, index) => ({
      evalCase,
      result: results[index]!
    }))
    .filter(({ evalCase }) => evalCase.expected_memories.length > 0);
  if (answerable.length === 0) {
    return 1;
  }
  return (
    answerable.reduce((sum, { evalCase, result }) => {
      const top = new Set(result.matchedIds.slice(0, k));
      return (
        sum +
        evalCase.expected_memories.filter((id) => top.has(id)).length /
          evalCase.expected_memories.length
      );
    }, 0) / answerable.length
  );
}

/** 从 baseline suite 生成不含延迟和 task 的稳定指标。 */
function baselineMetrics(
  suite: Awaited<ReturnType<typeof runEvalSuite>>,
  cases: EvalCase[]
): PolicySimulationMetrics {
  const expectedAbstentions = cases.filter((item) => item.abstain).length;
  const abstentionFailures = cases.filter(
    (item, index) => item.abstain && !suite.results[index]!.abstained
  ).length;
  return {
    total: suite.total,
    passed: suite.passed,
    failed: suite.failed,
    recallAt1: suite.metrics.recallAt[1],
    recallAt3: suite.metrics.recallAt[3],
    falseInjectionRate: suite.metrics.falseInjectionRate,
    abstentionFailureRate:
      expectedAbstentions === 0
        ? 0
        : abstentionFailures / expectedAbstentions
  };
}

/** 汇总 shadow retrieval 指标。 */
function shadowMetrics(
  results: ReturnType<typeof shadowRetrieval>[],
  cases: EvalCase[]
): PolicySimulationMetrics {
  const expectedAbstentions = cases.filter((item) => item.abstain).length;
  const abstentionFailures = results.filter(
    (result) => result.abstentionFailure
  ).length;
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    recallAt1: recallAt(results, cases, 1),
    recallAt3: recallAt(results, cases, 3),
    falseInjectionRate:
      results.length === 0
        ? 0
        : results.filter((result) => result.falseInjection).length /
          results.length,
    abstentionFailureRate:
      expectedAbstentions === 0
        ? 0
        : abstentionFailures / expectedAbstentions
  };
}

/** 对单个 Reasoning Policy 执行确定性检查。 */
function reasoningViolations(
  policy: ReasoningPolicy,
  evalCase: EvalCase
): string[] {
  const context = evalCase.reasoning_context;
  if (!context) {
    return [];
  }
  const violations: string[] = [];
  for (const check of policy.directive.checks) {
    if (check === "unresolved_conflict" && context.has_unresolved_conflict) {
      violations.push(check);
    } else if (check === "expired_fact" && context.has_expired_fact) {
      violations.push(check);
    } else if (
      check === "missing_documented_evidence" &&
      !context.has_documented_evidence
    ) {
      violations.push(check);
    } else if (
      check === "insufficient_detail" &&
      !context.expanded_layers.includes("knowledge")
    ) {
      violations.push(check);
    } else if (
      check === "high_risk_without_evidence" &&
      context.operation_risk === "high" &&
      !context.has_documented_evidence
    ) {
      violations.push(check);
    }
  }
  for (const layer of policy.directive.required_layers) {
    if (!context.expanded_layers.includes(layer)) {
      violations.push(`required_layer:${layer}`);
    }
  }
  return unique(violations);
}

/** 合并多个 reasoning policy；abstain 高于 warn，高于 proceed。 */
function reasoningDecision(
  policies: ReasoningPolicy[],
  evalCase: EvalCase
): {
  decision: "proceed" | "warn" | "abstain";
  violations: string[];
} {
  let decision: "proceed" | "warn" | "abstain" = "proceed";
  const violations: string[] = [];
  for (const policy of policies) {
    const current = reasoningViolations(policy, evalCase);
    violations.push(...current);
    if (current.length === 0) {
      continue;
    }
    if (policy.directive.decision_on_violation === "abstain") {
      decision = "abstain";
    } else if (decision === "proceed") {
      decision = "warn";
    }
  }
  return { decision, violations: unique(violations) };
}

/** 写 0600 原子 JSON 文件。 */
async function writeAtomicJson(
  target: string,
  value: unknown
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

/** 生成不含 task 的 Markdown 指标和逐 case 状态表。 */
function reportMarkdown(report: PolicySimulationHistoryEntry): string {
  const lines = [
    "# Memory Use Policy Shadow Simulation",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "| Pipeline | Passed | Failed | Recall@1 | Recall@3 | False Injection | Abstention Failure |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| Baseline | ${report.baseline.passed} | ${report.baseline.failed} | ${report.baseline.recallAt1.toFixed(4)} | ${report.baseline.recallAt3.toFixed(4)} | ${report.baseline.falseInjectionRate.toFixed(4)} | ${report.baseline.abstentionFailureRate.toFixed(4)} |`,
    `| Shadow | ${report.shadow.passed} | ${report.shadow.failed} | ${report.shadow.recallAt1.toFixed(4)} | ${report.shadow.recallAt3.toFixed(4)} | ${report.shadow.falseInjectionRate.toFixed(4)} | ${report.shadow.abstentionFailureRate.toFixed(4)} |`,
    "",
    "| Case | Policies | Baseline | Shadow | Reasoning |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const item of report.caseResults) {
    lines.push(
      `| ${item.caseId} | ${item.applicablePolicyIds.join(", ") || "-"} | ${item.baselinePassed ? "pass" : "fail"} | ${item.shadowPassed ? "pass" : "fail"} | ${item.reasoningDecision}${item.reasoningPassed ? "" : " (mismatch)"} |`
    );
  }
  lines.push(
    "",
    "Shadow simulation never changes normal query or Hook behavior."
  );
  return `${lines.join("\n")}\n`;
}

/** 执行完整 baseline/shadow simulation 并写最新报告和长期 safe history。 */
export async function simulatePolicies(options: {
  rootDir: string;
  evalFile: string;
  outputDir: string;
  now?: () => Date;
}): Promise<PolicySimulationReport> {
  const generatedAt = (options.now?.() ?? new Date()).toISOString();
  const suite = await loadEvalSuite(options.evalFile);
  const policies = await listPolicies(options.rootDir);
  const baselineSuite = await runEvalSuite(options.rootDir, suite);
  const shadowResults: ReturnType<typeof shadowRetrieval>[] = [];
  const caseResults: PolicySimulationCaseResult[] = [];

  for (const [index, evalCase] of suite.cases.entries()) {
    const applicable = policies.filter((policy) =>
      policyApplies(policy, evalCase)
    );
    const retrievalPolicies = applicable.filter(
      (policy): policy is RetrievalLesson =>
        policy.kind === "retrieval_lesson"
    );
    const reasoningPolicies = applicable.filter(
      (policy): policy is ReasoningPolicy =>
        policy.kind === "reasoning_policy"
    );
    const shadow = shadowRetrieval(
      options.rootDir,
      evalCase,
      retrievalPolicies
    );
    shadowResults.push(shadow);
    const reasoning = reasoningDecision(reasoningPolicies, evalCase);
    const identity = caseIdentity(evalCase);
    const expectedDecision = evalCase.expected_reasoning_decision;
    caseResults.push(
      SimulationCaseResultSchema.parse({
        ...identity,
        applicablePolicyIds: applicable.map((policy) => policy.id),
        baselinePassed: baselineSuite.results[index]!.passed,
        shadowPassed: shadow.passed,
        baselineInjectedIds: baselineSuite.results[index]!.injectedIds,
        shadowInjectedIds: shadow.injectedIds,
        reasoningDecision: reasoning.decision,
        reasoningExpectedDecision: expectedDecision,
        reasoningPassed:
          expectedDecision === undefined ||
          reasoning.decision === expectedDecision,
        reasoningViolations: reasoning.violations
      })
    );
  }

  const baseline = baselineMetrics(baselineSuite, suite.cases);
  const shadow = shadowMetrics(shadowResults, suite.cases);
  const policyIds = policies
    .filter((policy) => policy.status === "shadow")
    .map((policy) => policy.id);
  const id = `policy_simulation_${createHash("sha256")
    .update(
      JSON.stringify({
        generatedAt,
        policyIds,
        cases: caseResults.map((item) => item.caseHash)
      })
    )
    .digest("hex")
    .slice(0, 24)}`;
  const historyEntry = PolicySimulationHistoryEntrySchema.parse({
    version: 1,
    id,
    generatedAt,
    policyIds,
    baseline,
    shadow,
    caseResults
  });
  const outputDir = path.resolve(options.outputDir);
  const jsonPath = path.join(outputDir, "policy-simulation.json");
  const markdownPath = path.join(outputDir, "policy-simulation.md");
  const historyPath = resolveWorkspacePath(
    options.rootDir,
    ".memory",
    "policies",
    "simulations",
    `${id}.json`
  );
  await writeAtomicJson(jsonPath, historyEntry);
  await mkdir(path.dirname(markdownPath), {
    recursive: true,
    mode: 0o700
  });
  await writeFile(markdownPath, reportMarkdown(historyEntry), {
    encoding: "utf8",
    mode: 0o600
  });
  await chmod(markdownPath, 0o600);
  await writeAtomicJson(historyPath, historyEntry);
  return {
    ...historyEntry,
    jsonPath,
    markdownPath,
    historyPath
  };
}

/** 读取 simulation history；损坏文件进入 skipped，不阻断其他趋势记录。 */
export async function listPolicySimulationHistory(
  rootDir: string
): Promise<PolicySimulationHistoryResult> {
  const directory = resolveWorkspacePath(
    rootDir,
    ".memory",
    "policies",
    "simulations"
  );
  if (!existsSync(directory)) {
    return { entries: [], skipped: [] };
  }
  const entries: PolicySimulationHistoryEntry[] = [];
  const skipped: PolicySimulationHistoryResult["skipped"] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    try {
      entries.push(
        PolicySimulationHistoryEntrySchema.parse(
          JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
        )
      );
    } catch (error) {
      skipped.push({
        file: entry.name,
        reason: (error instanceof Error ? error.message : String(error)).slice(
          0,
          300
        )
      });
    }
  }
  entries.sort(
    (left, right) =>
      right.generatedAt.localeCompare(left.generatedAt) ||
      right.id.localeCompare(left.id)
  );
  skipped.sort((left, right) => left.file.localeCompare(right.file));
  return { entries, skipped };
}
