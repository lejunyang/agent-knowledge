import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPolicyProposals,
  logMemoryFeedback,
  minePolicyProposals,
  recordQueryPacket,
  recordQueryRetrieval,
  rebuildIndex
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** 写一条带稳定 scope 的隐私安全 query run，供 feedback mining 使用。 */
function recordScopedRun(root: string, id: string): void {
  recordQueryRetrieval(root, {
    queryRunId: id,
    task: `account deletion query ${id}`,
    domains: ["account/deletion"],
    scenarios: ["support"],
    projectKeys: [],
    retrievalMode: "lexical",
    candidateIds: ["k_recovery"],
    resultScores: [
      { id: "k_recovery", finalScore: 0.8, queryCoverageScore: 0.5 }
    ]
  });
  recordQueryPacket(root, {
    queryRunId: id,
    injectedIds: ["k_recovery"]
  });
}

describe("deterministic memory-use policy mining", () => {
  it("mines one retrieval proposal from three independent scoped failures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-mine-feedback-"));
    tempDirs.push(root);
    for (const id of ["query-1", "query-2", "query-3"]) {
      recordScopedRun(root, id);
      logMemoryFeedback(root, {
        memoryId: "k_recovery",
        usefulness: "not_useful",
        reason: "wrong_route",
        queryRunId: id,
        expectedMemoryIds: ["k_delete"],
        forbiddenMemoryIds: ["k_recovery"]
      });
    }

    const result = await minePolicyProposals(root, {
      minIndependentEvidence: 3,
      now: new Date("2026-08-09T00:00:00.000Z")
    });
    const [proposal] = await listPolicyProposals(root);

    expect(result).toMatchObject({
      feedbackGroups: 1,
      evalGroups: 0
    });
    expect(result.proposalIds).toHaveLength(1);
    expect(proposal?.source).toBe("feedback_mining");
    expect(proposal?.evidenceSummary).toMatchObject({
      independentQueryRuns: 3,
      feedbackEvents: 3
    });
    expect(proposal?.candidate).toMatchObject({
      kind: "retrieval_lesson",
      status: "shadow",
      applicability: {
        domains: ["account/deletion"],
        scenarios: ["support"]
      },
      directive: {
        prefer_memory_ids: ["k_delete"],
        suppress_memory_ids: ["k_recovery"]
      }
    });
    expect(proposal?.candidate.evidence.feedback_keys).toHaveLength(3);
    expect(
      proposal?.candidate.evidence.feedback_keys.every((key) =>
        /^feedback_sha256_[a-f0-9]{64}$/.test(key)
      )
    ).toBe(true);
    expect(JSON.stringify(proposal)).not.toContain("\\u0000");
  });

  it("does not count repeated runs or unscoped failures toward the threshold", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-mine-threshold-"));
    tempDirs.push(root);
    recordScopedRun(root, "query-one");
    for (let index = 0; index < 5; index += 1) {
      logMemoryFeedback(root, {
        memoryId: "k_recovery",
        usefulness: "not_useful",
        reason: "wrong_route",
        queryRunId: "query-one"
      });
    }
    recordQueryRetrieval(root, {
      queryRunId: "query-unscoped",
      task: "unscoped",
      domains: [],
      scenarios: [],
      projectKeys: [],
      retrievalMode: "lexical",
      candidateIds: [],
      resultScores: []
    });
    logMemoryFeedback(root, {
      usefulness: "not_useful",
      reason: "should_abstain",
      queryRunId: "query-unscoped"
    });

    const result = await minePolicyProposals(root, {
      minIndependentEvidence: 3
    });

    expect(result.proposalIds).toEqual([]);
    expect(await listPolicyProposals(root)).toEqual([]);
  });

  it("mines eval failures without writing synthetic query runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-mine-eval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    const evalPath = path.join(root, "policy-eval.yaml");
    await writeFile(
      evalPath,
      `cases:
  - id: forbidden-1
    task: 审查 Vue SFC lint 迁移方案
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: []
    forbidden_memories: [k_20260705_frontend_lint_vue_sfc]
  - id: forbidden-2
    task: 审查 Vue SFC lint 迁移方案
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: []
    forbidden_memories: [k_20260705_frontend_lint_vue_sfc]
  - id: forbidden-3
    task: 审查 Vue SFC lint 迁移方案
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: []
    forbidden_memories: [k_20260705_frontend_lint_vue_sfc]
`,
      "utf8"
    );

    const result = await minePolicyProposals(root, {
      evalFiles: [evalPath],
      minIndependentEvidence: 3,
      now: new Date("2026-08-09T00:00:00.000Z")
    });
    const proposal = (await listPolicyProposals(root)).find(
      (item) => item.source === "eval_mining"
    );

    expect(result.evalGroups).toBe(1);
    expect(proposal?.evidenceSummary.evalCases).toBe(3);
    expect(proposal?.candidate.evidence.eval_case_ids).toEqual([
      "forbidden-1",
      "forbidden-2",
      "forbidden-3"
    ]);
    expect(proposal?.candidate).toMatchObject({
      kind: "retrieval_lesson",
      directive: {
        suppress_memory_ids: ["k_20260705_frontend_lint_vue_sfc"]
      }
    });
  });
});
