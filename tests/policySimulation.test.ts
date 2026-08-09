import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPolicySimulationHistory,
  rebuildIndex,
  simulatePolicies,
  writePolicy
} from "../src/index.js";
import type { MemoryUsePolicyInput } from "../src/policy/types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("memory-use policy shadow simulation", () => {
  it("improves retrieval safety in shadow without changing normal query state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-sim-retrieval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    await writePolicy(root, {
      version: 1,
      id: "policy_lint_suppress_procedure",
      kind: "retrieval_lesson",
      status: "shadow",
      title: "该评测只注入 Vue SFC 约束",
      rationale: "验证 shadow suppression 能降低 forbidden injection。",
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
        query_run_ids: [],
        feedback_keys: [],
        eval_case_ids: ["lint-shadow"]
      },
      directive: {
        route_domains: [],
        route_scenarios: [],
        prefer_memory_ids: ["k_20260705_frontend_lint_vue_sfc"],
        suppress_memory_ids: ["k_20260705_lint_validation_flow"],
        abstain_if_no_preferred_memory: false,
        require_source_refresh: false
      },
      created_at: "2026-08-09",
      updated_at: "2026-08-09"
    } satisfies MemoryUsePolicyInput);
    const evalPath = path.join(root, "simulation.yaml");
    await writeFile(
      evalPath,
      `cases:
  - id: lint-shadow
    task: 审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: [k_20260705_frontend_lint_vue_sfc]
    forbidden_memories: [k_20260705_lint_validation_flow]
    abstain: false
`,
      "utf8"
    );
    const outputDir = path.join(root, "reports");

    const report = await simulatePolicies({
      rootDir: root,
      evalFile: evalPath,
      outputDir,
      now: () => new Date("2026-08-09T00:00:00.000Z")
    });

    expect(report.baseline).toMatchObject({ passed: 0, failed: 1 });
    expect(report.shadow).toMatchObject({
      passed: 1,
      failed: 0,
      falseInjectionRate: 0
    });
    expect(report.caseResults[0]).toMatchObject({
      caseId: "lint-shadow",
      applicablePolicyIds: ["policy_lint_suppress_procedure"],
      baselinePassed: false,
      shadowPassed: true
    });
    expect(JSON.stringify(report)).not.toContain("审查 Vue");
    expect(await readFile(report.markdownPath, "utf8")).not.toContain(
      "审查 Vue"
    );
    expect((await stat(report.historyPath)).mode & 0o777).toBe(0o600);
  });

  it("evaluates deterministic reasoning contracts and stores safe history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-sim-reasoning-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    await writePolicy(root, {
      version: 1,
      id: "policy_support_conflict_abstain",
      kind: "reasoning_policy",
      status: "shadow",
      title: "客服冲突必须 abstain",
      rationale: "未解决冲突不能按 confidence 选一个。",
      priority: 100,
      applicability: {
        domains: ["frontend/lint"],
        scenarios: ["support"],
        project_keys: [],
        query_terms_any: [],
        query_terms_all: [],
        excluded_terms: []
      },
      evidence: {
        query_run_ids: [],
        feedback_keys: [],
        eval_case_ids: ["reasoning-conflict"]
      },
      directive: {
        checks: ["unresolved_conflict", "high_risk_without_evidence"],
        required_layers: ["knowledge", "evidence"],
        authority_order: ["documented", "user_confirmed"],
        decision_on_violation: "abstain"
      },
      created_at: "2026-08-09",
      updated_at: "2026-08-09"
    } satisfies MemoryUsePolicyInput);
    const evalPath = path.join(root, "reasoning.yaml");
    await writeFile(
      evalPath,
      `cases:
  - id: reasoning-conflict
    task: 客服冲突场景
    domains: [frontend/lint]
    scenarios: [support]
    expected_memories: []
    forbidden_memories: []
    reasoning_context:
      has_unresolved_conflict: true
      has_expired_fact: false
      has_documented_evidence: false
      expanded_layers: [synopsis]
      operation_risk: high
    expected_reasoning_decision: abstain
`,
      "utf8"
    );

    const report = await simulatePolicies({
      rootDir: root,
      evalFile: evalPath,
      outputDir: path.join(root, "reports"),
      now: () => new Date("2026-08-09T01:00:00.000Z")
    });
    const [caseResult] = report.caseResults;
    const history = await listPolicySimulationHistory(root);

    expect(caseResult).toMatchObject({
      caseId: "reasoning-conflict",
      reasoningDecision: "abstain",
      reasoningExpectedDecision: "abstain",
      reasoningPassed: true
    });
    expect(caseResult?.reasoningViolations).toEqual(
      expect.arrayContaining([
        "unresolved_conflict",
        "high_risk_without_evidence",
        "required_layer:evidence"
      ])
    );
    expect(history.entries).toHaveLength(1);
    expect(history.skipped).toEqual([]);
    expect(JSON.stringify(history)).not.toContain("客服冲突场景");
  });

  it("does not apply deprecated or out-of-scope policies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-sim-scope-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    await writePolicy(root, {
      version: 1,
      id: "policy_other_scope",
      kind: "retrieval_lesson",
      status: "deprecated",
      title: "其他领域规则",
      rationale: "不应参与当前 shadow。",
      priority: 100,
      applicability: {
        domains: ["account/deletion"],
        scenarios: ["support"],
        project_keys: [],
        query_terms_any: [],
        query_terms_all: [],
        excluded_terms: []
      },
      evidence: {
        query_run_ids: [],
        feedback_keys: [],
        eval_case_ids: []
      },
      directive: {
        route_domains: [],
        route_scenarios: [],
        prefer_memory_ids: [],
        suppress_memory_ids: ["k_20260705_frontend_lint_vue_sfc"],
        abstain_if_no_preferred_memory: false,
        require_source_refresh: false
      },
      created_at: "2026-08-09",
      updated_at: "2026-08-09"
    } satisfies MemoryUsePolicyInput);
    const evalPath = path.join(root, "scope.yaml");
    await writeFile(
      evalPath,
      `cases:
  - id: scope-case
    task: 审查 Vue SFC lint 迁移方案
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: [k_20260705_frontend_lint_vue_sfc]
    forbidden_memories: []
`,
      "utf8"
    );

    const report = await simulatePolicies({
      rootDir: root,
      evalFile: evalPath,
      outputDir: path.join(root, "reports")
    });

    expect(report.caseResults[0]?.applicablePolicyIds).toEqual([]);
    expect(report.shadow).toEqual(report.baseline);
  });
});
