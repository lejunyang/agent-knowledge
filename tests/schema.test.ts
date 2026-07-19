import { describe, expect, it } from "vitest";
import { KnowledgeFrontmatterSchema, MemoryQueryRequestSchema } from "../src/core/schema.js";

describe("KnowledgeFrontmatterSchema", () => {
  it("accepts a valid semantic memory frontmatter", () => {
    const parsed = KnowledgeFrontmatterSchema.parse({
      id: "k_20260705_frontend_lint_vue_sfc",
      type: "semantic",
      title: "Vue SFC lint 迁移约束",
      aliases: ["vue-lint", "sfc-lint"],
      domain: "frontend/lint",
      related_domains: ["ci/performance", "monorepo/tooling"],
      scenario: ["code-review", "lint-migration"],
      tags: ["oxlint", "eslint", "vue-sfc"],
      status: "active",
      confidence: 0.86,
      source_authority: "user_confirmed",
      source: ["conversation:2026-07-05-agent-memory-design"],
      related_knowledge: [
        {
          id: "k_20260705_ci_three_stage_validation",
          relation: "depends_on",
          reason: "当前规则依赖 CI 三阶段校验链路"
        }
      ],
      supersedes: [],
      conflicts_with: [],
      visibility: "project",
      sensitivity: "internal",
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
      valid_from: "2026-07-05",
      valid_until: null
    });

    expect(parsed.type).toBe("semantic");
    expect(parsed.aliases).toEqual(["vue-lint", "sfc-lint"]);
    expect(parsed.related_domains).toEqual(["ci/performance", "monorepo/tooling"]);
  });

  it("defaults aliases to an empty array", () => {
    const parsed = KnowledgeFrontmatterSchema.parse({
      id: "k_20260705_frontend_lint_defaults",
      type: "semantic",
      title: "Defaults",
      domain: "frontend/lint",
      scenario: ["code-review"],
      status: "active",
      confidence: 0.7,
      source_authority: "documented",
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
      valid_from: "2026-07-05"
    });

    expect(parsed.aliases).toEqual([]);
  });

  it("rejects the removed system actor value", () => {
    expect(() =>
      KnowledgeFrontmatterSchema.parse({
        id: "k_20260719_actor_compatibility",
        type: "semantic",
        title: "Actor compatibility",
        domain: "agent/memory",
        scenario: ["compatibility"],
        status: "active",
        confidence: 0.8,
        source_authority: "documented",
        actor_type: "system",
        created_at: "2026-07-19",
        updated_at: "2026-07-19",
        valid_from: "2026-07-19"
      })
    ).toThrow();
  });

  it("accepts structured episode provenance and defaults legacy memories to none", () => {
    const legacy = KnowledgeFrontmatterSchema.parse({
      id: "k_20260719_legacy_episode",
      type: "semantic",
      title: "Legacy memory",
      domain: "agent/memory",
      scenario: ["compatibility"],
      status: "active",
      confidence: 0.8,
      source_authority: "documented",
      created_at: "2026-07-19",
      updated_at: "2026-07-19",
      valid_from: "2026-07-19"
    });
    const withEpisodes = KnowledgeFrontmatterSchema.parse({
      ...legacy,
      id: "k_20260719_episode",
      episodes: [
        {
          episode_id: "episode-1",
          session_hash: "session-a",
          turn_hash: "turn-a",
          project_id: "project-a",
          observed_at: "2026-07-19T00:00:00.000Z",
          evidence_refs: ["test:one"]
        }
      ]
    });

    expect(legacy.episodes).toEqual([]);
    expect(withEpisodes.episodes[0]?.session_hash).toBe("session-a");
  });

  it("rejects invalid confidence values", () => {
    expect(() =>
      KnowledgeFrontmatterSchema.parse({
        id: "k_bad",
        type: "semantic",
        title: "Bad",
        domain: "frontend/lint",
        scenario: ["code-review"],
        status: "active",
        confidence: 1.5,
        source_authority: "model_inferred",
        source: [],
        created_at: "2026-07-05",
        updated_at: "2026-07-05",
        valid_from: "2026-07-05"
      })
    ).toThrow();
  });
});

describe("MemoryQueryRequestSchema", () => {
  it("defaults maxTokens and includeTypes", () => {
    const parsed = MemoryQueryRequestSchema.parse({
      task: "审查 lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"]
    });

    expect(parsed.maxTokens).toBe(4500);
    expect(parsed.includeTypes).toEqual(["profile", "semantic", "episodic", "procedural"]);
  });
});
