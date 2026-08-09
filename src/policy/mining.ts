/**
 * Policy mining 把结构化 feedback 和显式 eval failure 聚类成 shadow proposal。
 *
 * 本模块完全确定性：不读取自由文本 note、不调用模型、不推断未知业务含义。只有相同 scope、
 * 相同 failure reason 且达到独立证据门槛的分组才能生成 proposal。
 */
import { createHash } from "node:crypto";
import {
  readFeedbackLedger,
  refreshFeedbackLedger,
  type FeedbackLedgerEntry
} from "../memory/feedbackLedger.js";
import { loadEvalSuite, runEvalSuite, type EvalCase } from "../retrieval/eval.js";
import { createPolicyProposal } from "./proposals.js";
import { listQueryRuns, type QueryRun } from "./queryRuns.js";
import type {
  MemoryUsePolicyInput,
  ReasoningPolicyCheckSchema
} from "./types.js";

type MiningOptions = {
  evalFiles?: string[];
  minIndependentEvidence?: number;
  now?: Date;
};

export type PolicyMiningResult = {
  feedbackGroups: number;
  evalGroups: number;
  proposalIds: string[];
};

const RETRIEVAL_REASONS = new Set([
  "wrong_route",
  "missing_expected",
  "forbidden_injection",
  "should_abstain",
  "stale_source"
]);

const REASONING_REASONS = new Set([
  "insufficient_detail",
  "conflicting_evidence",
  "reasoning_failure"
]);

type PolicyScope = {
  domains: string[];
  scenarios: string[];
  projectKeys: string[];
};

type FeedbackGroup = {
  reason: NonNullable<FeedbackLedgerEntry["reason"]>;
  scope: PolicyScope;
  entries: FeedbackLedgerEntry[];
  queryRuns: QueryRun[];
};

type EvalFailure = {
  id: string;
  scope: PolicyScope;
  expectedIds: string[];
  forbiddenIds: string[];
  abstain: boolean;
};

/** 稳定排序并去重字符串，保证相同证据输入生成相同 proposal。 */
function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Scope 至少需要 domain/scenario/project 之一，禁止挖出默认全局 Policy。 */
function boundedScope(scope: PolicyScope): boolean {
  return (
    scope.domains.length > 0 ||
    scope.scenarios.length > 0 ||
    scope.projectKeys.length > 0
  );
}

/** 生成 scope 分组 key；数组排序后语义相同的输入可以稳定聚合。 */
function scopeKey(scope: PolicyScope): string {
  return JSON.stringify({
    domains: unique(scope.domains),
    scenarios: unique(scope.scenarios),
    projectKeys: unique(scope.projectKeys)
  });
}

/** 用不可逆短 hash 生成合法 Policy ID，避免把业务术语直接放进路径。 */
function minedPolicyId(kind: string, identity: unknown): string {
  return `policy_mined_${kind}_${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")
    .slice(0, 16)}`;
}

/** 把内部可能含 NUL 分隔符的 ledger key 转为 Git/YAML 友好的不可逆 evidence ref。 */
function feedbackRef(key: string): string {
  return `feedback_sha256_${createHash("sha256")
    .update(key)
    .digest("hex")}`;
}

/** 把内部 scope 转成 Policy schema 字段。 */
function applicability(scope: PolicyScope) {
  return {
    domains: unique(scope.domains),
    scenarios: unique(scope.scenarios),
    project_keys: unique(scope.projectKeys),
    query_terms_any: [],
    query_terms_all: [],
    excluded_terms: []
  };
}

/** Feedback reason 编译为有限 reasoning checks，不能使用自由文本生成 prompt。 */
function reasoningChecks(
  reason: FeedbackGroup["reason"]
): Array<
  "unresolved_conflict" | "insufficient_detail" | "missing_documented_evidence"
> {
  if (reason === "conflicting_evidence") {
    return ["unresolved_conflict"];
  }
  if (reason === "insufficient_detail") {
    return ["insufficient_detail"];
  }
  return ["missing_documented_evidence"];
}

/** 从一个达到门槛的 feedback group 构造 shadow Policy。 */
function policyFromFeedbackGroup(
  group: FeedbackGroup,
  now: Date
): MemoryUsePolicyInput {
  const queryRunIds = unique(group.queryRuns.map((run) => run.id));
  const feedbackKeys = unique(
    group.entries.map((entry) => feedbackRef(entry.key))
  );
  const identity = {
    reason: group.reason,
    scope: group.scope,
    queryRunIds,
    feedbackKeys
  };
  const date = now.toISOString().slice(0, 10);
  if (RETRIEVAL_REASONS.has(group.reason)) {
    const expectedIds = unique(
      group.entries.flatMap((entry) => entry.expectedMemoryIds)
    );
    const forbiddenIds = unique([
      ...group.entries.flatMap((entry) => entry.forbiddenMemoryIds),
      ...group.entries.flatMap((entry) =>
        entry.memoryId && entry.usefulness === "not_useful"
          ? [entry.memoryId]
          : []
      )
    ]);
    return {
      version: 1,
      id: minedPolicyId("retrieval", identity),
      kind: "retrieval_lesson",
      status: "shadow",
      title: `Mined retrieval lesson: ${group.reason}`,
      rationale:
        "The same structured retrieval failure repeated across independent query runs in one bounded scope.",
      priority: 50,
      applicability: applicability(group.scope),
      evidence: {
        query_run_ids: queryRunIds,
        feedback_keys: feedbackKeys,
        eval_case_ids: []
      },
      directive: {
        route_domains:
          group.reason === "wrong_route" || group.reason === "missing_expected"
            ? unique(group.scope.domains)
            : [],
        route_scenarios: [],
        prefer_memory_ids: expectedIds,
        suppress_memory_ids: forbiddenIds,
        abstain_if_no_preferred_memory: group.reason === "should_abstain",
        require_source_refresh: group.reason === "stale_source"
      },
      created_at: date,
      updated_at: date
    };
  }
  return {
    version: 1,
    id: minedPolicyId("reasoning", identity),
    kind: "reasoning_policy",
    status: "shadow",
    title: `Mined reasoning policy: ${group.reason}`,
    rationale:
      "The same structured reasoning failure repeated across independent query runs in one bounded scope.",
    priority: 50,
    applicability: applicability(group.scope),
    evidence: {
      query_run_ids: queryRunIds,
      feedback_keys: feedbackKeys,
      eval_case_ids: []
    },
    directive: {
      checks: reasoningChecks(group.reason),
      required_layers:
        group.reason === "insufficient_detail"
          ? ["knowledge"]
          : ["knowledge", "evidence"],
      authority_order: ["documented", "user_confirmed", "verified_task"],
      decision_on_violation:
        group.reason === "conflicting_evidence" ? "abstain" : "warn"
    },
    created_at: date,
    updated_at: date
  };
}

/** 聚类 feedback；同 queryRunId 的重复事件只贡献一个独立证据。 */
function feedbackGroups(
  entries: FeedbackLedgerEntry[],
  runs: QueryRun[]
): FeedbackGroup[] {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const groups = new Map<string, FeedbackGroup>();
  for (const entry of entries) {
    if (
      !entry.reason ||
      (!RETRIEVAL_REASONS.has(entry.reason) &&
        !REASONING_REASONS.has(entry.reason)) ||
      !entry.queryRunId
    ) {
      continue;
    }
    const run = runById.get(entry.queryRunId);
    if (!run) {
      continue;
    }
    const scope: PolicyScope = {
      domains: run.domains,
      scenarios: run.scenarios,
      projectKeys: run.projectKeys
    };
    if (!boundedScope(scope)) {
      continue;
    }
    const key = `${entry.reason}\0${scopeKey(scope)}`;
    const group = groups.get(key) ?? {
      reason: entry.reason,
      scope,
      entries: [],
      queryRuns: []
    };
    group.entries.push(entry);
    if (!group.queryRuns.some((item) => item.id === run.id)) {
      group.queryRuns.push(run);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 为没有显式 ID 的 eval case 生成不可逆稳定标识。 */
function evalCaseId(evalCase: EvalCase): string {
  return (
    evalCase.id ??
    `eval_case_${createHash("sha256")
      .update(
        JSON.stringify({
          task: evalCase.task,
          domains: evalCase.domains,
          scenarios: evalCase.scenarios,
          projectKeys: evalCase.project_keys ?? []
        })
      )
      .digest("hex")
      .slice(0, 20)}`
  );
}

/** 运行显式 eval 文件并提取可解释 failure；runEvalSuite 保持 log=false。 */
async function collectEvalFailures(
  rootDir: string,
  files: string[]
): Promise<EvalFailure[]> {
  const failures: EvalFailure[] = [];
  for (const file of files) {
    const suite = await loadEvalSuite(file);
    const result = await runEvalSuite(rootDir, suite);
    for (const [index, item] of result.results.entries()) {
      if (item.passed) {
        continue;
      }
      const evalCase = suite.cases[index]!;
      const scope: PolicyScope = {
        domains: evalCase.domains,
        scenarios: evalCase.scenarios,
        projectKeys: evalCase.project_keys ?? []
      };
      if (!boundedScope(scope)) {
        continue;
      }
      failures.push({
        id: evalCaseId(evalCase),
        scope,
        expectedIds: item.missingExpected,
        forbiddenIds: item.presentForbidden,
        abstain: Boolean(evalCase.abstain && !item.abstained)
      });
    }
  }
  return failures;
}

/** 把同 scope、同 failure shape 的 eval failures 聚类。 */
function groupEvalFailures(failures: EvalFailure[]): EvalFailure[][] {
  const groups = new Map<string, EvalFailure[]>();
  for (const failure of failures) {
    const kind =
      failure.forbiddenIds.length > 0
        ? "forbidden"
        : failure.abstain
          ? "abstain"
          : "missing";
    const key = `${kind}\0${scopeKey(failure.scope)}`;
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** 从达到门槛的 eval failure group 构造 retrieval proposal。 */
function policyFromEvalGroup(
  group: EvalFailure[],
  now: Date
): MemoryUsePolicyInput {
  const first = group[0]!;
  const expectedIds = unique(group.flatMap((item) => item.expectedIds));
  const forbiddenIds = unique(group.flatMap((item) => item.forbiddenIds));
  const evalCaseIds = unique(group.map((item) => item.id));
  const identity = {
    scope: first.scope,
    expectedIds,
    forbiddenIds,
    abstain: group.some((item) => item.abstain),
    evalCaseIds
  };
  const date = now.toISOString().slice(0, 10);
  return {
    version: 1,
    id: minedPolicyId("eval", identity),
    kind: "retrieval_lesson",
    status: "shadow",
    title: "Mined retrieval lesson from eval failures",
    rationale:
      "The same retrieval failure shape repeated across explicit eval cases in one bounded scope.",
    priority: 50,
    applicability: applicability(first.scope),
    evidence: {
      query_run_ids: [],
      feedback_keys: [],
      eval_case_ids: evalCaseIds
    },
    directive: {
      route_domains: expectedIds.length > 0 ? unique(first.scope.domains) : [],
      route_scenarios: [],
      prefer_memory_ids: expectedIds,
      suppress_memory_ids: forbiddenIds,
      abstain_if_no_preferred_memory: group.some((item) => item.abstain),
      require_source_refresh: false
    },
    created_at: date,
    updated_at: date
  };
}

/** 挖掘 feedback/eval proposal；不会接受、写 Git Policy 或修改 query pipeline。 */
export async function minePolicyProposals(
  rootDir: string,
  options: MiningOptions = {}
): Promise<PolicyMiningResult> {
  const threshold = Math.max(3, options.minIndependentEvidence ?? 3);
  const now = options.now ?? new Date();
  refreshFeedbackLedger(rootDir);
  const ledger = readFeedbackLedger(rootDir);
  const runs = await listQueryRuns(rootDir);
  const eligibleFeedbackGroups = feedbackGroups(
    Object.values(ledger.entries),
    runs
  ).filter((group) => group.queryRuns.length >= threshold);
  const evalFailures = await collectEvalFailures(
    rootDir,
    options.evalFiles ?? []
  );
  const eligibleEvalGroups = groupEvalFailures(evalFailures).filter(
    (group) => group.length >= threshold
  );
  const proposalIds: string[] = [];

  for (const group of eligibleFeedbackGroups) {
    const proposal = await createPolicyProposal(rootDir, {
      candidate: policyFromFeedbackGroup(group, now),
      source: "feedback_mining",
      evidenceSummary: {
        independentQueryRuns: group.queryRuns.length,
        feedbackEvents: group.entries.length,
        evalCases: 0
      },
      now
    });
    proposalIds.push(proposal.id);
  }
  for (const group of eligibleEvalGroups) {
    const proposal = await createPolicyProposal(rootDir, {
      candidate: policyFromEvalGroup(group, now),
      source: "eval_mining",
      evidenceSummary: {
        independentQueryRuns: 0,
        feedbackEvents: 0,
        evalCases: group.length
      },
      now
    });
    proposalIds.push(proposal.id);
  }

  return {
    feedbackGroups: eligibleFeedbackGroups.length,
    evalGroups: eligibleEvalGroups.length,
    proposalIds: unique(proposalIds)
  };
}
