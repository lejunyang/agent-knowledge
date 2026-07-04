import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildContextPacket } from "../src/contextPacket.js";
import { rebuildIndex } from "../src/indexer.js";
import { queryMemories } from "../src/query.js";
import type { MemoryQueryRequest } from "../src/types.js";

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
