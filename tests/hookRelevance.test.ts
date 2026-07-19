import { describe, expect, it } from "vitest";
import {
  decideHookInjection,
  filterCatalogForPrompt,
  isCatalogIntent
} from "../src/hooks/relevance.js";
import type { KnowledgeCatalog } from "../src/storage/catalog.js";
import type { ContextPacket, RankedMemory } from "../src/core/types.js";

function makePacket(): ContextPacket {
  return {
    context_version: "1.0",
    scene: {
      task_type: "main",
      domains: [],
      scenarios: []
    },
    always_apply: [],
    relevant_facts: [
      {
        id: "k_lint",
        title: "Vue lint 规则",
        content: "Vue SFC template 需要 ESLint fallback。",
        confidence: 0.9,
        source: ["test"]
      }
    ],
    procedures: [],
    examples: [],
    warnings: [],
    sources: ["test"]
  };
}

function makeRanked(score: number): RankedMemory[] {
  return [
    {
      document: {
        filePath: "knowledge/semantic/lint.md",
        frontmatter: {
          id: "k_lint",
          type: "semantic",
          title: "Vue lint 规则",
          aliases: ["vue-lint"],
          domain: "frontend/lint",
          related_domains: [],
          scenario: ["lint-migration"],
          tags: ["vue"],
          status: "active",
          confidence: 0.9,
          source_authority: "documented",
          source: ["test"],
          related_knowledge: [],
          supersedes: [],
          conflicts_with: [],
          visibility: "project",
          sensitivity: "internal",
          project_ids: [],
          capture_mode: "direct_material",
          actor_type: "owner",
          corroboration_count: 1,
          created_at: "2026-07-19",
          updated_at: "2026-07-19",
          valid_from: "2026-07-19",
          valid_until: null
        },
        body: "Vue SFC template 需要 ESLint fallback。"
      },
      lexicalScore: score,
      embeddingScore: score,
      scenarioScore: score,
      confidenceScore: 0.9,
      sourceAuthorityScore: 0.75,
      relationScore: 0,
      rrfScore: score,
      finalScore: score
    }
  ];
}

function makeCatalog(): KnowledgeCatalog {
  return {
    rootDir: "/tmp",
    generatedAt: "2026-07-19T00:00:00.000Z",
    catalogPath: "/tmp/knowledge/_catalog.md",
    written: false,
    total: 3,
    byStatus: { active: 3 },
    byType: { semantic: 3 },
    byDomain: { "frontend/lint": 1, "backend/database": 1, "support/refund": 1 },
    byScenario: { "lint-migration": 1, migration: 1, refund: 1 },
    byAlias: { "vue-lint": 1 },
    registry: {
      domains: ["backend/database", "frontend/lint", "support/refund"],
      scenarios: ["lint-migration", "migration", "refund"],
      aliases: ["vue-lint"]
    },
    items: [
      {
        id: "k_lint",
        title: "Vue lint 规则",
        aliases: ["vue-lint"],
        type: "semantic",
        status: "active",
        domain: "frontend/lint",
        scenarios: ["lint-migration"],
        tags: ["vue"],
        confidence: 0.9,
        sourceAuthority: "documented",
        updatedAt: "2026-07-19",
        filePath: "knowledge/semantic/lint.md",
        summary: "Vue SFC lint fallback"
      },
      {
        id: "k_database",
        title: "数据库迁移",
        aliases: [],
        type: "semantic",
        status: "active",
        domain: "backend/database",
        scenarios: ["migration"],
        tags: ["database"],
        confidence: 0.8,
        sourceAuthority: "documented",
        updatedAt: "2026-07-19",
        filePath: "knowledge/semantic/database.md",
        summary: "database migration"
      },
      {
        id: "k_refund",
        title: "退款规则",
        aliases: [],
        type: "semantic",
        status: "active",
        domain: "support/refund",
        scenarios: ["refund"],
        tags: ["support"],
        confidence: 0.8,
        sourceAuthority: "documented",
        updatedAt: "2026-07-19",
        filePath: "knowledge/semantic/refund.md",
        summary: "refund policy"
      }
    ]
  };
}

describe("hook relevance", () => {
  it("recognizes explicit catalog browsing intent", () => {
    expect(isCatalogIntent("我有哪些知识和 SOP？")).toBe(true);
    expect(isCatalogIntent("show my memory catalog")).toBe(true);
    expect(isCatalogIntent("修复当前 lint 错误")).toBe(false);
  });

  it("stays silent for no results and below-threshold results", () => {
    expect(
      decideHookInjection({
        prompt: "普通问题",
        ranked: [],
        packet: makePacket(),
        minScore: 0.55
      }).decision
    ).toBe("none");
    expect(
      decideHookInjection({
        prompt: "lint 问题",
        ranked: makeRanked(0.3),
        packet: makePacket(),
        minScore: 0.55
      }).decision
    ).toBe("below_threshold");
  });

  it("injects only the context packet for reliable task matches", () => {
    const result = decideHookInjection({
      prompt: "修复 Vue lint migration",
      ranked: makeRanked(0.8),
      packet: makePacket(),
      minScore: 0.55
    });

    expect(result.decision).toBe("context");
    expect(result.additionalContext).toContain("relevant_facts");
    expect(result.additionalContext).not.toContain("catalog");
    expect(result.additionalContext).not.toContain("runtime");
  });

  it("returns at most five prompt-related catalog items for catalog intent", () => {
    const filtered = filterCatalogForPrompt(makeCatalog(), "有哪些 Vue lint 知识？", 5);

    expect(filtered.items.map((item) => item.id)).toEqual(["k_lint"]);
    expect(filtered.domains).toEqual(["frontend/lint"]);
    expect(filtered.scenarios).toEqual(["lint-migration"]);
  });
});
