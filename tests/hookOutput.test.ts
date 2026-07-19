import { describe, expect, it } from "vitest";
import { hookContextJson } from "../src/hooks/hookOutput.js";
import type { KnowledgeCatalog } from "../src/storage/catalog.js";

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

describe("hook output", () => {
  it("returns no stdout payload when additional context is empty", () => {
    expect(hookContextJson("UserPromptSubmit", "")).toBeNull();
  });

  it("wraps non-empty additional context in the hook protocol", () => {
    expect(hookContextJson("UserPromptSubmit", "relevant context")).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "relevant context"
      }
    });
  });
});
