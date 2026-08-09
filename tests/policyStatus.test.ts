import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPolicyProposal,
  getPolicyStatus,
  logMemoryFeedback,
  recordQueryPacket,
  recordQueryRetrieval,
  writePolicy
} from "../src/index.js";
import type { MemoryUsePolicyInput } from "../src/policy/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

const policy = {
  version: 1 as const,
  id: "policy_status_smoke",
  kind: "retrieval_lesson" as const,
  status: "shadow" as const,
  title: "Status smoke policy",
  rationale: "Verify readiness counters without exposing task text.",
  priority: 50,
  applicability: {
    domains: ["frontend/lint"],
    scenarios: ["lint-migration"],
    project_keys: [],
    query_terms_any: [],
    query_terms_all: [],
    excluded_terms: []
  },
  evidence: {
    query_run_ids: ["query-status-1"],
    feedback_keys: [],
    eval_case_ids: []
  },
  directive: {
    route_domains: [],
    route_scenarios: [],
    prefer_memory_ids: [],
    suppress_memory_ids: [],
    abstain_if_no_preferred_memory: false,
    require_source_refresh: false
  },
  created_at: "2026-08-09",
  updated_at: "2026-08-09"
} satisfies MemoryUsePolicyInput;

describe("memory-use policy status", () => {
  it("summarizes safe readiness counters without task text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-status-"));
    tempDirs.push(root);
    for (let index = 1; index <= 30; index += 1) {
      const id = `query-status-${index}`;
      recordQueryRetrieval(root, {
        queryRunId: id,
        task: `private task ${index}`,
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"],
        projectKeys: [],
        retrievalMode: "lexical",
        candidateIds: [],
        resultScores: []
      });
      recordQueryPacket(root, { queryRunId: id, injectedIds: [] });
    }
    logMemoryFeedback(root, {
      usefulness: "not_useful",
      reason: "should_abstain",
      queryRunId: "query-status-1"
    });
    await writePolicy(root, policy);
    await createPolicyProposal(root, {
      candidate: {
        ...policy,
        id: "policy_status_pending"
      },
      source: "manual",
      evidenceSummary: {
        independentQueryRuns: 3,
        feedbackEvents: 1,
        evalCases: 0
      }
    });

    const status = await getPolicyStatus(root);

    expect(status).toMatchObject({
      queryRuns: 30,
      completedQueryRuns: 30,
      scopedQueryRuns: 30,
      structuredFeedback: 1,
      pendingProposals: 1,
      shadowPolicies: 1,
      deprecatedPolicies: 0,
      simulations: 0,
      p3EvidenceReady: true
    });
    expect(JSON.stringify(status)).not.toContain("private task");
  });
});
