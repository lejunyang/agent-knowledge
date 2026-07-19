import { mkdtemp, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("keeps direct glossary hits ahead of one-hop related memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-glossary-ranking-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "字节业务术语：ocean",
          memory_type: "semantic",
          domain: "bytedance/business/glossary",
          related_domains: ["bytedance/business/ocean-account"],
          scenario: ["business-knowledge", "glossary", "terminology"],
          tags: ["glossary", "ocean"],
          aliases: ["ocean", "巨量"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "ocean 在商业化语境中对应巨量。",
          evidence: ["test"],
          related_knowledge: [
            {
              id: "k_20260705_bytedance_business_ocean_account_account_model",
              relation: "supports",
              reason: "ocean 释义支撑商业化账户体系。"
            }
          ]
        },
        {
          title: "account model",
          memory_type: "semantic",
          domain: "bytedance/business/ocean-account",
          related_domains: [],
          scenario: ["business-knowledge"],
          tags: ["ocean", "account"],
          confidence: 0.95,
          source_authority: "user_confirmed",
          summary: "商业化账户体系包含客户、用户、账户。",
          evidence: ["test"]
        }
      ],
      { target: "active", rebuild: true }
    );

    const ranked = queryMemories(root, {
      task: "ocean 巨量 是什么意思",
      agentRole: "main",
      domains: ["bytedance/business/glossary"],
      scenarios: ["terminology"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked[0]?.document.frontmatter.title).toBe("字节业务术语：ocean");
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

  it("filters validity, visibility, sensitivity, and project scope before ranking", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-policy-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const sourcePath = path.join(
      root,
      "knowledge",
      "semantic",
      "frontend-lint",
      "2026-07-05-vue-sfc-eslint-fallback.md"
    );
    const source = await readFile(sourcePath, "utf8");
    const variants = [
      {
        id: "k_20260705_expired",
        title: "Expired lint rule",
        changes: [
          ["valid_until:\n", "valid_until: 2026-01-01\n"],
          ["visibility: project", "visibility: team"]
        ]
      },
      {
        id: "k_20260705_confidential",
        title: "Confidential lint rule",
        changes: [
          ["sensitivity: internal", "sensitivity: confidential"],
          ["visibility: project", "visibility: team"]
        ]
      },
      {
        id: "k_20260705_other_project",
        title: "Other project lint rule",
        changes: [["visibility: project", "visibility: project\nproject_ids:\n  - project_other"]]
      }
    ];
    for (const variant of variants) {
      let content = source
        .replace("k_20260705_frontend_lint_vue_sfc", variant.id)
        .replace("title: Vue SFC lint 迁移约束", `title: ${variant.title}`)
        .replace("related_knowledge:\n  - id: k_20260705_lint_validation_flow\n    relation: often_used_with\n    reason: Lint 迁移约束通常需要配合验证流程使用。", "related_knowledge: []");
      for (const [from, to] of variant.changes) {
        content = content.replace(from, to);
      }
      await writeFile(path.join(path.dirname(sourcePath), `${variant.id}.md`), content, "utf8");
    }
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "lint rule Vue SFC",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      now: "2026-07-19",
      visibilityScopes: ["project", "team"],
      sensitivityClearance: "internal",
      projectIds: ["project_current"]
    });
    const ids = ranked.map((item) => item.document.frontmatter.id);

    expect(ids).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(ids).not.toContain("k_20260705_expired");
    expect(ids).not.toContain("k_20260705_confidential");
    expect(ids).not.toContain("k_20260705_other_project");
  });

  it("applies the same security policy to related expansion", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-related-policy-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const relatedPath = path.join(
      root,
      "knowledge",
      "procedural",
      "code-review",
      "2026-07-05-lint-validation-flow.md"
    );
    const related = await readFile(relatedPath, "utf8");
    await writeFile(relatedPath, related.replace("sensitivity: internal", "sensitivity: secret"), "utf8");
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "审查 Vue SFC lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      sensitivityClearance: "internal"
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).not.toContain("k_20260705_lint_validation_flow");
  });

  it("recalls Chinese knowledge through CJK lexical n-grams without metadata fallback", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-cjk-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const source = await readFile(
      path.join(root, "knowledge", "semantic", "frontend-lint", "2026-07-05-vue-sfc-eslint-fallback.md"),
      "utf8"
    );
    await mkdir(path.join(root, "knowledge", "semantic", "business"), { recursive: true });
    await writeFile(
      path.join(root, "knowledge", "semantic", "business", "account.md"),
      source
        .replace("k_20260705_frontend_lint_vue_sfc", "k_20260705_business_account_authorization")
        .replace("title: Vue SFC lint 迁移约束", "title: 抖音企业机构账号授权限制")
        .replace("domain: frontend/lint", "domain: bytedance/business/account")
        .replace("  - code-review\n  - lint-migration", "  - business-knowledge")
        .replace("related_knowledge:\n  - id: k_20260705_lint_validation_flow\n    relation: often_used_with\n    reason: Lint 迁移约束通常需要配合验证流程使用。", "related_knowledge: []")
        .replace(
          "Oxlint 负责 TS/JS 快速检查，Vue SFC template 仍需要 ESLint fallback。",
          "商家中心可以给运营人员授权管理抖音企业机构账号，变更主体时需要先解除已有授权。"
        ),
      "utf8"
    );
    rebuildIndex(root);

    const { ranked, debug } = queryMemoriesWithDebug(root, {
      task: "商家中心里如何给运营人员授权管理抖音B号，变更时有哪些限制",
      agentRole: "main"
    });

    expect(debug.fallbackUsed).toBe(false);
    expect(debug.tokens).toContain("授权");
    expect(ranked.map((item) => item.document.frontmatter.id)).toContain(
      "k_20260705_business_account_authorization"
    );
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
      includeTypes: ["semantic", "procedural", "profile", "episodic"],
      now: "2026-07-19",
      visibilityScopes: ["private", "project", "team"],
      sensitivityClearance: "internal",
      projectIds: []
    };
    const ranked = queryMemories(root, request);

    const packet = buildContextPacket({ request, ranked });

    expect(packet.relevant_facts[0]?.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(packet.procedures[0]?.id).toBe("k_20260705_lint_validation_flow");
  });

  it("enforces maxTokens while preserving a valid packet", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-packet-budget-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const request: MemoryQueryRequest = {
      task: "审查 lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 120,
      includeTypes: ["semantic", "procedural", "profile", "episodic"],
      now: "2026-07-19",
      visibilityScopes: ["private", "project", "team"],
      sensitivityClearance: "internal",
      projectIds: []
    };
    const packet = buildContextPacket({ request, ranked: queryMemories(root, request) });
    const { estimateContextPacketTokens } = await import("../src/contextPacket.js");

    expect(estimateContextPacketTokens(packet)).toBeLessThanOrEqual(request.maxTokens);
    expect(
      packet.always_apply.length +
        packet.relevant_facts.length +
        packet.procedures.length +
        packet.examples.length
    ).toBeLessThan(2);
  });
});
