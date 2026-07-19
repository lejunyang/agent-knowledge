import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCandidateMemory } from "../src/memory/inbox.js";

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

  it("downgrades customer claims and keeps them proposed even when authority is spoofed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-customer-"));
    tempDirs.push(root);

    const result = await writeCandidateMemory(root, {
      title: "客户声称的退款规则",
      memory_type: "semantic",
      domain: "support/refund",
      related_domains: [],
      scenario: ["customer-support"],
      tags: ["observation"],
      confidence: 0.95,
      source_authority: "user_confirmed",
      summary: "客户声称所有退款都无需审核。",
      evidence: ["conversation:customer"],
      capture_mode: "automated_session",
      actor_type: "customer",
      corroboration_count: 1,
      project_ids: ["project_support"]
    });
    const content = await readFile(result.filePath, "utf8");

    expect(result.status).toBe("proposed");
    expect(content).toContain("source_authority: model_inferred");
    expect(content).toContain("capture_mode: automated_session");
    expect(content).toContain("actor_type: customer");
    expect(content).toContain("corroboration_count: 1");
    expect(content).toContain("project_support");
  });

  it("keeps all automated-session candidates proposed regardless of verified-task claims", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-automated-"));
    tempDirs.push(root);

    const result = await writeCandidateMemory(root, {
      title: "自动客服排障经验",
      memory_type: "procedural",
      domain: "support/troubleshooting",
      related_domains: [],
      scenario: ["customer-support"],
      tags: ["automated"],
      confidence: 0.92,
      source_authority: "verified_task",
      summary: "单次客服会话中尝试成功的步骤。",
      evidence: ["session:hashed"],
      capture_mode: "automated_session",
      // Keep one legacy value to verify read compatibility during the migration.
      actor_type: "system",
      corroboration_count: 1,
      project_ids: ["project_support"]
    });

    expect(result.status).toBe("proposed");
  });

  it("writes agent as the canonical actor value", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-agent-"));
    tempDirs.push(root);

    const result = await writeCandidateMemory(root, {
      title: "Agent generated procedure",
      memory_type: "procedural",
      domain: "agent/memory",
      related_domains: [],
      scenario: ["automated-maintenance"],
      tags: ["agent"],
      confidence: 0.8,
      source_authority: "verified_task",
      summary: "A reusable procedure verified by an AI agent.",
      evidence: ["agent:verified"],
      capture_mode: "verified_task",
      actor_type: "agent"
    });
    const content = await readFile(result.filePath, "utf8");

    expect(content).toContain("actor_type: agent");
    expect(content).not.toContain("actor_type: system");
  });

  it("deduplicates an identical candidate instead of rewriting it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-dedupe-"));
    tempDirs.push(root);
    const candidate = {
      title: "重复候选",
      memory_type: "semantic" as const,
      domain: "knowledge/dedupe",
      related_domains: [],
      scenario: ["memory-maintenance"],
      tags: ["dedupe"],
      confidence: 0.7,
      source_authority: "model_inferred" as const,
      summary: "完全相同的候选不重复写入。",
      evidence: ["staging:test"],
      capture_mode: "automated_session" as const,
      actor_type: "agent" as const
    };

    const first = await writeCandidateMemory(root, candidate);
    const second = await writeCandidateMemory(root, candidate);

    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBe(true);
    expect(second.filePath).toBe(first.filePath);
  });

  it("refuses to overwrite a same-identity candidate with different content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-conflict-"));
    tempDirs.push(root);
    const base = {
      title: "同名候选",
      memory_type: "semantic" as const,
      domain: "knowledge/dedupe",
      related_domains: [],
      scenario: ["memory-maintenance"],
      tags: ["dedupe"],
      confidence: 0.7,
      source_authority: "model_inferred" as const,
      evidence: ["staging:test"]
    };
    await writeCandidateMemory(root, { ...base, summary: "第一版内容。" });

    await expect(
      writeCandidateMemory(root, { ...base, summary: "不同的第二版内容。" })
    ).rejects.toThrow("Consolidate or retitle");
  });
});
