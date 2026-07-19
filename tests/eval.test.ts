import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/storage/indexer.js";
import { loadEvalSuite, runEvalCase, runEvalSuite } from "../src/retrieval/eval.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("runEvalCase", () => {
  it("reports expected memories and forbidden misses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "审查 lint 迁移方案",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      expected_memories: ["k_20260705_frontend_lint_vue_sfc"],
      forbidden_memories: ["k_20260601_deprecated_lint_flow"]
    });

    expect(result.passed).toBe(true);
    expect(result.missingExpected).toEqual([]);
    expect(result.presentForbidden).toEqual([]);
  });

  it("reports rank-aware retrieval, abstention, latency, and packet token metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-metrics-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "审查 Vue SFC lint 迁移方案",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      expected_memories: ["k_20260705_frontend_lint_vue_sfc"],
      expected_ranks: {
        k_20260705_frontend_lint_vue_sfc: 1
      },
      relevance_grades: {
        k_20260705_frontend_lint_vue_sfc: 3,
        k_20260705_lint_validation_flow: 2
      },
      forbidden_memories: ["k_20260601_deprecated_lint_flow"],
      abstain: false,
      language: "zh-CN",
      domain: "frontend/lint"
    });

    expect(result.passed).toBe(true);
    expect(result.rankById.k_20260705_frontend_lint_vue_sfc).toBe(1);
    expect(result.recallAt).toMatchObject({ 1: 1, 3: 1, 5: 1 });
    expect(result.reciprocalRank).toBe(1);
    expect(result.ndcg).toBeGreaterThan(0.9);
    expect(result.falseInjection).toBe(false);
    expect(result.abstained).toBe(false);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.packetTokens).toBeGreaterThan(0);
  });

  it("passes abstention cases when no memory is injected", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-abstain-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "完全不存在的量子烹饪规则如何迁移",
      domains: [],
      scenarios: [],
      expected_memories: [],
      forbidden_memories: [],
      abstain: true,
      language: "zh-CN",
      domain: "unknown"
    });

    expect(result.passed).toBe(true);
    expect(result.abstained).toBe(true);
    expect(result.falseInjection).toBe(false);
    expect(result.matchedIds).toEqual([]);
  });

  it("aggregates suite metrics and validates YAML input", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-suite-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const yamlPath = path.join(root, "suite.yaml");
    await writeFile(
      yamlPath,
      `cases:
  - task: 审查 lint 迁移方案
    domains: [frontend/lint]
    scenarios: [lint-migration]
    expected_memories: [k_20260705_frontend_lint_vue_sfc]
    expected_ranks:
      k_20260705_frontend_lint_vue_sfc: 2
    relevance_grades:
      k_20260705_frontend_lint_vue_sfc: 3
    forbidden_memories: []
    abstain: false
    language: zh-CN
    domain: frontend/lint
  - task: 没有答案的 hard negative
    domains: []
    scenarios: []
    expected_memories: []
    forbidden_memories: []
    abstain: true
    language: zh-CN
    domain: unknown
`,
      "utf8"
    );

    const loaded = await loadEvalSuite(yamlPath);
    const suite = await runEvalSuite(root, loaded);

    expect(loaded.cases).toHaveLength(2);
    expect(suite.total).toBe(2);
    expect(suite.passed).toBe(2);
    expect(suite.metrics.recallAt).toMatchObject({ 1: 1, 3: 1, 5: 1 });
    expect(suite.metrics.mrr).toBe(1);
    expect(suite.metrics.falseInjectionRate).toBe(0);
    expect(suite.metrics.abstentionPrecision).toBe(1);
    expect(suite.metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(suite.metrics.averagePacketTokens).toBeGreaterThanOrEqual(0);
  });
});
