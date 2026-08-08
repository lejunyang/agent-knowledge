import { describe, expect, it } from "vitest";
import { KnowledgeFrontmatterV2Schema } from "../src/core/knowledgeV2.js";

describe("KnowledgeFrontmatterV2Schema", () => {
  it("parses layered knowledge with weighted metadata and evidence", () => {
    const parsed = KnowledgeFrontmatterV2Schema.parse({
      schema_version: 2,
      id: "k_account_identity_boundary",
      kind: "semantic",
      layer: "knowledge",
      title: "商业化 UID 与抖音 UID 的账号组边界",
      synopsis: "两类 UID 属于不同账号组，不能默认相等。",
      aliases: [
        {
          value: "账号组边界",
          kind: "user_phrase",
          weight: 0.9,
          source: "documented"
        }
      ],
      domain: "bytedance/business/account",
      related_domains: [],
      scenarios: [
        {
          id: "support/account-login",
          role: "primary",
          weight: 0.95
        }
      ],
      tags: [
        {
          value: "account",
          weight: 0.8,
          source: "taxonomy",
          retrieval: true
        }
      ],
      status: "active",
      confidence: 0.96,
      source_authority: "documented",
      source: ["source:src_account_guide"],
      claims: [
        {
          id: "claim_uid_group_boundary",
          statement: "商业化 UID 与抖音 UID 属于不同账号组。",
          status: "supported",
          confidence: 0.96,
          evidence: [
            {
              source_id: "src_account_guide",
              section_id: "sec_login_identity",
              quote_hash:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ]
        }
      ],
      related_knowledge: [],
      supersedes: [],
      conflicts_with: [],
      visibility: "project",
      sensitivity: "internal",
      project_keys: ["github.com/lejunyang/agent-knowledge"],
      capture_mode: "direct_material",
      actor_type: "owner",
      corroboration_count: 1,
      episodes: [],
      created_at: "2026-08-09",
      updated_at: "2026-08-09",
      valid_from: "2026-08-09",
      valid_until: null
    });

    expect(parsed.kind).toBe("semantic");
    expect(parsed.layer).toBe("knowledge");
    expect(parsed.project_keys).toEqual([
      "github.com/lejunyang/agent-knowledge"
    ]);
    expect(parsed.claims[0]?.evidence[0]?.section_id).toBe(
      "sec_login_identity"
    );
  });

  it("rejects supported claims without evidence", () => {
    expect(() =>
      KnowledgeFrontmatterV2Schema.parse({
        schema_version: 2,
        id: "k_unsupported",
        kind: "semantic",
        layer: "knowledge",
        title: "Unsupported",
        synopsis: "Unsupported",
        domain: "test/domain",
        scenarios: [{ id: "test", role: "primary", weight: 1 }],
        status: "active",
        confidence: 0.8,
        source_authority: "documented",
        claims: [
          {
            id: "claim_unsupported",
            statement: "No evidence",
            status: "supported",
            confidence: 0.8,
            evidence: []
          }
        ],
        created_at: "2026-08-09",
        updated_at: "2026-08-09",
        valid_from: "2026-08-09"
      })
    ).toThrow(/evidence/i);
  });
});
