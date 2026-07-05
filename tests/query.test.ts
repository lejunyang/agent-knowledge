import { mkdtemp, cp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPacket } from "../src/contextPacket.js";
import { rebuildIndex } from "../src/indexer.js";
import { captureMaterial } from "../src/organizer.js";
import { queryMemories, queryMemoriesWithDebug } from "../src/query.js";
import { getLogFilePath } from "../src/logging.js";
import type { MemoryQueryRequest } from "../src/types.js";
import type { EmbeddingScorer, MemoryReranker } from "../src/scoring.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("queryMemories", () => {
  it("retrieves lint migration knowledge with related procedures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_lint_validation_flow");
  });

  it("does not expand related memories excluded by includeTypes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-types-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(ranked.map((item) => item.document.frontmatter.id)).not.toContain("k_20260705_lint_validation_flow");
  });

  it("expands domain and scenario aliases during filtering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-alias-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "review vue lint migration",
      agentRole: "main",
      domains: ["vue-lint"],
      scenarios: ["validation-flow"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_lint_validation_flow");
  });

  it("matches hierarchical domains and fuzzy scenario labels", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-fuzzy-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "ESLint fallback",
      agentRole: "main",
      domains: ["frontend"],
      scenarios: ["code review"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
  });

  it("does not match sibling domains just because they share a segment", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-domain-boundary-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "商业化账户状态",
          memory_type: "semantic",
          domain: "bytedance/business/account",
          related_domains: [],
          scenario: ["business-knowledge"],
          tags: ["account"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "商业化账户状态属于通用账户体系。",
          evidence: ["test"]
        },
        {
          title: "抖音企业机构账号流程",
          memory_type: "semantic",
          domain: "bytedance/business/aweme-enterprise-account",
          related_domains: [],
          scenario: ["business-knowledge"],
          tags: ["b-account"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "抖音企业机构账号流程属于B号业务。",
          evidence: ["test"]
        }
      ],
      { target: "active", rebuild: true }
    );

    const ranked = queryMemories(root, {
      task: "account 状态和流程",
      agentRole: "main",
      domains: ["bytedance/business/aweme-enterprise-account"],
      scenarios: ["business-knowledge"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.title)).toContain("抖音企业机构账号流程");
    expect(ranked.map((item) => item.document.frontmatter.title)).not.toContain("商业化账户状态");
  });

  it("suppresses full-table fallback when domain and scenario are missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-no-fallback-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const { ranked, debug } = queryMemoriesWithDebug(root, {
      task: "完全不匹配的检索词",
      agentRole: "main",
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked).toEqual([]);
    expect(debug.fallbackUsed).toBe(false);
    expect(debug.fallbackSuppressedReason).toBe("missing_domain_or_scenario");
  });

  it("writes JSONL query logs with debug summary", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-logs-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    queryMemoriesWithDebug(root, {
      task: "审查 Vue SFC lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    const logLines = (await readFile(getLogFilePath(root), "utf8")).trim().split("\n");
    const log = JSON.parse(logLines.at(-1) ?? "{}") as { event?: string; debug?: { resultIds?: string[] } };

    expect(log.event).toBe("query");
    expect(log.debug?.resultIds).toContain("k_20260705_frontend_lint_vue_sfc");
  });

  it("includes embedding scorer and reranker details in debug scores", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-score-debug-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const { ranked, debug } = queryMemoriesWithDebug(root, {
      task: "审查 Vue SFC lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(debug.queryRunId).toMatch(/[0-9a-f-]{36}/);
    expect(debug.scoring).toEqual({
      embeddingScorer: "default-local-token-cosine",
      reranker: "default-weighted-linear"
    });
    expect(debug.resultScores).toHaveLength(ranked.length);
    expect(debug.resultScores[0]?.embeddingScore).toBeGreaterThanOrEqual(0);
    expect(debug.resultScores[0]?.finalScore).toBe(ranked[0]?.finalScore);
  });

  it("accepts pluggable embedding scorers and rerankers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-plugins-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    const embeddingScorer: EmbeddingScorer = {
      name: "test-procedural-boost",
      score: ({ document }) => (document.frontmatter.type === "procedural" ? 1 : 0)
    };
    const reranker: MemoryReranker = {
      name: "test-embedding-only",
      rerank: ({ features }) => features.embeddingScore
    };

    const { ranked, debug } = queryMemoriesWithDebug(
      root,
      {
        task: "审查 Vue SFC lint 迁移方案",
        agentRole: "main",
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"],
        paths: [],
        maxTokens: 4500,
        includeTypes: ["semantic", "procedural", "profile", "episodic"]
      },
      { embeddingScorer, reranker }
    );

    expect(debug.scoring).toEqual({
      embeddingScorer: "test-procedural-boost",
      reranker: "test-embedding-only"
    });
    expect(ranked[0]?.document.frontmatter.id).toBe("k_20260705_lint_validation_flow");
    expect(ranked[0]?.embeddingScore).toBe(1);
  });
});

describe("buildContextPacket", () => {
  it("groups semantic and procedural memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-packet-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const request: MemoryQueryRequest = {
      task: "审查 lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    };
    const ranked = queryMemories(root, request);

    const packet = buildContextPacket({ request, ranked });

    expect(packet.relevant_facts[0]?.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(packet.procedures[0]?.id).toBe("k_20260705_lint_validation_flow");
  });
});
