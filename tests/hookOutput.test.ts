import { describe, expect, it } from "vitest";
import { coarseCatalogForHook, compactCatalogForHook } from "../src/hookOutput.js";
import type { KnowledgeCatalog } from "../src/catalog.js";

function makeCatalog(): KnowledgeCatalog {
  return {
    rootDir: "/tmp/knowledge",
    generatedAt: "2026-07-06T00:00:00.000Z",
    catalogPath: "/tmp/knowledge/knowledge/_catalog.md",
    written: false,
    total: 1,
    byStatus: { active: 1 },
    byType: { semantic: 1 },
    byDomain: { "bytedance/business/glossary": 1 },
    byScenario: { terminology: 1 },
    byAlias: { aweme: 1 },
    registry: {
      domains: ["bytedance/business/glossary"],
      scenarios: ["terminology"],
      aliases: ["aweme"]
    },
    items: [
      {
        id: "k_20260705_bytedance_business_glossary_aweme",
        title: "字节业务术语：aweme",
        aliases: ["aweme", "抖音"],
        type: "semantic",
        status: "active",
        domain: "bytedance/business/glossary",
        scenarios: ["terminology"],
        tags: ["glossary"],
        confidence: 0.9,
        sourceAuthority: "user_confirmed",
        updatedAt: "2026-07-06",
        filePath: "knowledge/semantic/bytedance/business/glossary/aweme.md",
        summary: "aweme 通常指抖音。"
      }
    ]
  };
}

describe("hook catalog output", () => {
  it("keeps no-hit hook context coarse", () => {
    const output = coarseCatalogForHook(makeCatalog());

    expect(output).toEqual({
      total: 1,
      byStatus: { active: 1 },
      byType: { semantic: 1 },
      domains: ["bytedance/business/glossary"],
      scenarios: ["terminology"]
    });
    expect(output).not.toHaveProperty("aliases");
    expect(output).not.toHaveProperty("items");
  });

  it("keeps detailed catalog available when context is injected", () => {
    const output = compactCatalogForHook(makeCatalog());

    expect(output).toMatchObject({
      aliases: ["aweme"],
      items: [
        {
          id: "k_20260705_bytedance_business_glossary_aweme",
          aliases: ["aweme", "抖音"]
        }
      ]
    });
  });
});
