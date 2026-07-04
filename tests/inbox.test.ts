import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCandidateMemory } from "../src/inbox.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("writeCandidateMemory", () => {
  it("writes safe model-inferred memories to _inbox as proposed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-"));
    tempDirs.push(root);

    const result = await writeCandidateMemory(root, {
      title: "Lint 迁移验证流程",
      memory_type: "procedural",
      domain: "frontend/lint",
      related_domains: ["ci/performance"],
      scenario: ["lint-migration"],
      tags: ["oxlint"],
      confidence: 0.72,
      source_authority: "model_inferred",
      summary: "迁移 lint 配置后应按 Oxlint -> ESLint fallback -> Oxfmt 顺序验证。",
      evidence: ["conversation:test"]
    });

    expect(result.status).toBe("proposed");
    const content = await readFile(result.filePath, "utf8");
    expect(content).toContain("status: proposed");
    expect(content).toContain("Lint 迁移验证流程");
  });

  it("rejects candidates containing API keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-secret-"));
    tempDirs.push(root);

    await expect(
      writeCandidateMemory(root, {
        title: "Leaked token",
        memory_type: "semantic",
        domain: "security",
        related_domains: [],
        scenario: ["debugging"],
        tags: ["secret"],
        confidence: 0.9,
        source_authority: "model_inferred",
        summary: "OPENAI_API_KEY=sk-1234567890abcdef1234567890abcdef",
        evidence: ["conversation:test"]
      })
    ).rejects.toThrow("Candidate contains secret-like content");
  });

  it("rejects candidates that would produce invalid frontmatter", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-invalid-"));
    tempDirs.push(root);

    await expect(
      writeCandidateMemory(root, {
        title: "Invalid confidence",
        memory_type: "semantic",
        domain: "frontend/lint",
        related_domains: [],
        scenario: ["debugging"],
        tags: [],
        confidence: 1.2,
        source_authority: "model_inferred",
        summary: "置信度超过 schema 上限。",
        evidence: ["conversation:test"]
      })
    ).rejects.toThrow();
  });
});
