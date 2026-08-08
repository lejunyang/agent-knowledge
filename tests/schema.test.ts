import { describe, expect, it } from "vitest";
import { KnowledgeFrontmatterSchema, MemoryQueryRequestSchema } from "../src/core/schema.js";

describe("KnowledgeFrontmatterSchema", () => {
  it("accepts a valid semantic memory frontmatter", () => {
    const parsed = KnowledgeFrontmatterSchema.parse({
      schema_version: 2,
      id: "k_20260705_frontend_lint_vue_sfc",
      kind: "semantic",
      layer: "knowledge",
      title: "Vue SFC lint 迁移约束",
      synopsis: "Vue SFC template 仍需要 ESLint fallback。",
      aliases: [
        {
          value: "vue-lint",
          kind: "user_phrase",
          weight: 0.8,
          source: "user_confirmed"
        },
        {
          value: "sfc-lint",
          kind: "technical_identifier",
          weight: 0.9,
          source: "documented"
        }
      ],
      domain: "frontend/lint",
      related_domains: ["ci/performance", "monorepo/tooling"],
      scenarios: [
        { id: "code-review", role: "primary", weight: 0.9 },
        { id: "lint-migration", role: "primary", weight: 1 }
      ],
      tags: [
        {
          value: "vue-sfc",
          weight: 0.9,
          source: "taxonomy",
          retrieval: true
        }
      ],
      status: "active",
      confidence: 0.86,
      source_authority: "user_confirmed",
      source: ["conversation:2026-07-05-agent-memory-design"],
      claims: [
        {
          id: "claim_vue_sfc_fallback",
          statement: "Vue SFC template 仍需要 ESLint fallback。",
          status: "supported",
          confidence: 0.86,
          evidence: [
            {
              source_id: "src_lint_design",
              section_id: "sec_vue_sfc",
              quote_hash:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ]
        }
      ],
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
      project_keys: ["github.com/example/repo"],
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
      valid_from: "2026-07-05",
      valid_until: null
    });

    expect(parsed.kind).toBe("semantic");
    expect(parsed.aliases.map((alias) => alias.value)).toEqual([
      "vue-lint",
      "sfc-lint"
    ]);
    expect(parsed.related_domains).toEqual(["ci/performance", "monorepo/tooling"]);
  });

  it("defaults aliases to an empty array", () => {
    const parsed = KnowledgeFrontmatterSchema.parse({
      schema_version: 2,
      id: "k_20260705_frontend_lint_defaults",
      kind: "semantic",
      layer: "knowledge",
      title: "Defaults",
      synopsis: "Defaults",
      domain: "frontend/lint",
      scenarios: [{ id: "code-review", role: "primary", weight: 1 }],
      status: "active",
      confidence: 0.7,
      source_authority: "documented",
      claims: [],
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
      valid_from: "2026-07-05"
    });

    expect(parsed.aliases).toEqual([]);
  });

  it("rejects the removed system actor value", () => {
    expect(() =>
      KnowledgeFrontmatterSchema.parse({
        schema_version: 2,
        id: "k_20260719_actor_compatibility",
        kind: "semantic",
        layer: "knowledge",
        title: "Actor compatibility",
        synopsis: "Actor compatibility",
        domain: "agent/memory",
        scenarios: [{ id: "compatibility", role: "primary", weight: 1 }],
        status: "active",
        confidence: 0.8,
        source_authority: "documented",
        claims: [],
        actor_type: "system",
        created_at: "2026-07-19",
        updated_at: "2026-07-19",
        valid_from: "2026-07-19"
      })
    ).toThrow();
  });

  it("accepts structured episode provenance and defaults legacy memories to none", () => {
    const withoutEpisodes = KnowledgeFrontmatterSchema.parse({
      schema_version: 2,
      id: "k_20260719_legacy_episode",
      kind: "semantic",
      layer: "knowledge",
      title: "Legacy memory",
      synopsis: "Legacy memory",
      domain: "agent/memory",
      scenarios: [{ id: "compatibility", role: "primary", weight: 1 }],
      status: "active",
      confidence: 0.8,
      source_authority: "documented",
      claims: [],
      created_at: "2026-07-19",
      updated_at: "2026-07-19",
      valid_from: "2026-07-19"
    });
    const withEpisodes = KnowledgeFrontmatterSchema.parse({
      ...withoutEpisodes,
      id: "k_20260719_episode",
      episodes: [
        {
          episode_id: "episode-1",
          session_hash: "session-a",
          turn_hash: "turn-a",
          project_key: "github.com/example/repo",
          observed_at: "2026-07-19T00:00:00.000Z",
          evidence_refs: ["test:one"]
        }
      ]
    });

    expect(withoutEpisodes.episodes).toEqual([]);
    expect(withEpisodes.episodes[0]?.session_hash).toBe("session-a");
  });

  it("rejects invalid confidence values", () => {
    expect(() =>
      KnowledgeFrontmatterSchema.parse({
        schema_version: 2,
        id: "k_bad",
        kind: "semantic",
        layer: "knowledge",
        title: "Bad",
        synopsis: "Bad",
        domain: "frontend/lint",
        scenarios: [{ id: "code-review", role: "primary", weight: 1 }],
        status: "active",
        confidence: 1.5,
        source_authority: "model_inferred",
        source: [],
        claims: [],
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
    expect(parsed.includeTypes).toEqual([
      "profile",
      "semantic",
      "episodic",
      "procedural",
      "principle"
    ]);
  });
});
