import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/storage/indexer.js";
import {
  loadEvalCorpus,
  loadEvalSuite,
  materializeEvalCorpus,
  runEvalCase,
  runEvalSuite
} from "../src/retrieval/eval.js";
import { captureMaterial } from "../src/memory/organizer.js";
import { DeterministicLocalEmbeddingProvider, embedKnowledgeIndex } from "../src/retrieval/embeddings.js";
import { DeterministicBatchReranker } from "../src/retrieval/reranker.js";

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

  it("evaluates forbidden injection against the token-bounded context packet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-injection-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      max_tokens: 200,
      expected_memories: ["k_20260705_frontend_lint_vue_sfc"],
      forbidden_memories: ["k_20260705_lint_validation_flow"]
    });

    expect(result.passed).toBe(true);
    expect(result.matchedIds).toContain("k_20260705_lint_validation_flow");
    expect(result.injectedIds).toEqual(["k_20260705_frontend_lint_vue_sfc"]);
    expect(result.presentForbidden).toEqual([]);
    expect(result.falseInjection).toBe(false);
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

  it("evaluates project-scoped knowledge only in the declared project context", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-project-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          id: "k_eval_project_scoped",
          title: "项目专用发布流程",
          aliases: ["project release marker"],
          memory_type: "procedural",
          domain: "project/release",
          related_domains: [],
          scenario: ["release"],
          tags: ["project"],
          confidence: 0.95,
          source_authority: "user_confirmed",
          summary: "该发布流程只适用于 project_alpha。",
          evidence: ["test:project"],
          project_ids: ["project_alpha"]
        }
      ],
      { target: "active", rebuild: true }
    );

    const matched = await runEvalCase(root, {
      task: "project release marker",
      domains: [],
      scenarios: [],
      project_ids: ["project_alpha"],
      expected_memories: ["k_eval_project_scoped"],
      forbidden_memories: []
    });
    const isolated = await runEvalCase(root, {
      task: "project release marker",
      domains: [],
      scenarios: [],
      project_ids: ["project_beta"],
      expected_memories: [],
      forbidden_memories: ["k_eval_project_scoped"],
      abstain: true
    });

    expect(matched.passed).toBe(true);
    expect(matched.matchedIds).toContain("k_eval_project_scoped");
    expect(isolated.passed).toBe(true);
    expect(isolated.matchedIds).toEqual([]);
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
    expect(suite.metrics.recallAt).toMatchObject({ 3: 1, 5: 1 });
    expect(suite.metrics.mrr).toBeGreaterThanOrEqual(0.5);
    expect(suite.metrics.falseInjectionRate).toBe(0);
    expect(suite.metrics.abstentionPrecision).toBe(1);
    expect(suite.metrics.averageLatencyMs).toBeGreaterThanOrEqual(0);
    expect(suite.metrics.averagePacketTokens).toBeGreaterThanOrEqual(0);
  });

  it("materializes and passes the complete 17-topic retrieval corpus", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-complete-"));
    tempDirs.push(root);
    const corpus = await loadEvalCorpus("eval/cases/retrieval-complete.yaml");
    await materializeEvalCorpus(root, corpus);

    const index = rebuildIndex(root);
    const suite = await runEvalSuite(root, { cases: corpus.cases });

    expect(corpus.documents.filter((document) => document.status === "active")).toHaveLength(17);
    expect(corpus.documents.filter((document) => document.status === "deprecated")).toHaveLength(1);
    expect(index.indexed).toBe(17);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(20);
    expect(suite.failed).toBe(0);
    expect(suite.metrics.recallAt[1]).toBe(1);
    expect(suite.metrics.falseInjectionRate).toBe(0);
    expect(suite.metrics.abstentionPrecision).toBe(1);
  });

  it("supports lexical, hybrid, and reranked eval pipelines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-pipelines-"));
    tempDirs.push(root);
    const corpus = await loadEvalCorpus("eval/cases/retrieval-complete.yaml");
    await materializeEvalCorpus(root, corpus);
    rebuildIndex(root);
    const provider = new DeterministicLocalEmbeddingProvider(64);
    await embedKnowledgeIndex(root, { provider });
    const subset = { cases: corpus.cases.slice(0, 4) };

    const lexical = await runEvalSuite(root, subset, { pipeline: "lexical" });
    const hybrid = await runEvalSuite(root, subset, {
      pipeline: "hybrid",
      embeddingProvider: provider
    });
    const reranked = await runEvalSuite(root, subset, {
      pipeline: "reranked",
      embeddingProvider: provider,
      batchReranker: new DeterministicBatchReranker({
        score: ({ query, document }) =>
          document.toLowerCase().includes(query.split(/\s+/)[0]!.toLowerCase()) ? 1 : 0.5
      }),
      minScore: 0
    });

    expect(lexical.total).toBe(4);
    expect(hybrid.total).toBe(4);
    expect(reranked.total).toBe(4);
  });
});
