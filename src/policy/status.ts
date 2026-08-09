/**
 * Policy status 提供不含 task/正文的运行成熟度摘要。
 *
 * 它只读取 query-run、feedback ledger、proposal、Policy 和 simulation history；不会运行 mining、
 * 接受 proposal、deprecate Policy 或修改 query 行为。
 */
import {
  readFeedbackLedger,
  refreshFeedbackLedger
} from "../memory/feedbackLedger.js";
import { listPolicies } from "./store.js";
import { listPolicyProposals } from "./proposals.js";
import { listQueryRuns } from "./queryRuns.js";
import { listPolicySimulationHistory } from "./simulation.js";

export type PolicyStatus = {
  queryRuns: number;
  completedQueryRuns: number;
  scopedQueryRuns: number;
  structuredFeedback: number;
  pendingProposals: number;
  acceptedProposals: number;
  rejectedProposals: number;
  shadowPolicies: number;
  deprecatedPolicies: number;
  simulations: number;
  p3EvidenceReady: boolean;
  p3EvidenceThreshold: {
    minimumScopedCompletedQueryRuns: number;
    requiresShadowPolicy: boolean;
    requiresManualMetricReview: true;
  };
};

/** 汇总证据数量；P3 readiness 仍需人工检查 2–4 周时长和安全指标。 */
export async function getPolicyStatus(rootDir: string): Promise<PolicyStatus> {
  refreshFeedbackLedger(rootDir);
  const runs = await listQueryRuns(rootDir);
  const feedback = Object.values(readFeedbackLedger(rootDir).entries);
  const proposals = await listPolicyProposals(rootDir);
  const policies = await listPolicies(rootDir);
  const history = await listPolicySimulationHistory(rootDir);
  const completedQueryRuns = runs.filter(
    (run) => run.injectedIds.length > 0 || run.abstained
  ).length;
  const scopedQueryRuns = runs.filter(
    (run) =>
      (run.domains.length > 0 ||
        run.scenarios.length > 0 ||
        run.projectKeys.length > 0) &&
      (run.injectedIds.length > 0 || run.abstained)
  ).length;
  const shadowPolicies = policies.filter(
    (policy) => policy.status === "shadow"
  ).length;

  return {
    queryRuns: runs.length,
    completedQueryRuns,
    scopedQueryRuns,
    structuredFeedback: feedback.filter((entry) => entry.reason).length,
    pendingProposals: proposals.filter(
      (proposal) => proposal.status === "pending"
    ).length,
    acceptedProposals: proposals.filter(
      (proposal) => proposal.status === "accepted"
    ).length,
    rejectedProposals: proposals.filter(
      (proposal) => proposal.status === "rejected"
    ).length,
    shadowPolicies,
    deprecatedPolicies: policies.filter(
      (policy) => policy.status === "deprecated"
    ).length,
    simulations: history.entries.length,
    p3EvidenceReady: scopedQueryRuns >= 30 && shadowPolicies > 0,
    p3EvidenceThreshold: {
      minimumScopedCompletedQueryRuns: 30,
      requiresShadowPolicy: true,
      requiresManualMetricReview: true
    }
  };
}
