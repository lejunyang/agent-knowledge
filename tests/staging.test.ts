import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  drainStagedEvents,
  getStagingLockPath,
  getStagingStatus,
  stageHookEvent
} from "../src/staging.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("proactive memory staging", () => {
  it("stores bounded metadata and hashes identifiers without raw prompt or tool response", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-staging-"));
    tempDirs.push(root);

    const result = await stageHookEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-secret-id",
      turn_id: "turn-secret-id",
      agent_id: "agent-secret-id",
      agent_type: "memory-writer",
      prompt: "please remember private raw prompt",
      tool_response: { secret: "raw response" },
      last_assistant_message: "a".repeat(10_000),
      cwd: "/tmp/project",
      reason: "completed",
      project_id: "project_123"
    });
    const raw = await readFile(result.eventsPath, "utf8");
    const event = JSON.parse(raw.trim()) as Record<string, unknown>;

    expect(event.event).toBe("hook.subagent_stop");
    expect(event.sessionHash).toMatch(/^[a-f0-9]{16}$/);
    expect(event.turnHash).toMatch(/^[a-f0-9]{16}$/);
    expect(event.agentHash).toMatch(/^[a-f0-9]{16}$/);
    expect(event.agentType).toBe("memory-writer");
    expect(event.promptLength).toBe("please remember private raw prompt".length);
    expect(event.responseLength).toBe(10_000);
    expect(event).not.toHaveProperty("prompt");
    expect(event).not.toHaveProperty("tool_response");
    expect(event).not.toHaveProperty("last_assistant_message");
    expect(raw).not.toContain("private raw prompt");
    expect(raw).not.toContain("raw response");
    expect(raw.length).toBeLessThan(2_000);
  });

  it("drains events once and advances a durable watermark", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-staging-drain-"));
    tempDirs.push(root);
    await stageHookEvent(root, { hook_event_name: "Stop", session_id: "s1", reason: "turn_end" });
    await stageHookEvent(root, { hook_event_name: "SessionEnd", session_id: "s1", reason: "exit" });

    const first = await drainStagedEvents(root, { limit: 10 });
    const second = await drainStagedEvents(root, { limit: 10 });
    const status = await getStagingStatus(root);

    expect(first.events).toHaveLength(2);
    expect(first.watermarkAfter).toBe(2);
    expect(second.events).toEqual([]);
    expect(second.watermarkBefore).toBe(2);
    expect(status.total).toBe(2);
    expect(status.pending).toBe(0);
    expect(status.watermark).toBe(2);
  });

  it("recovers a stale drain lock but refuses an active lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-staging-lock-"));
    tempDirs.push(root);
    await stageHookEvent(root, { hook_event_name: "Stop", session_id: "s1" });
    const lockPath = getStagingLockPath(root);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, "locked", "utf8");

    await expect(drainStagedEvents(root, { lockStaleMs: 60_000 })).rejects.toThrow("already in progress");

    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const drained = await drainStagedEvents(root, { lockStaleMs: 60_000 });

    expect(drained.events).toHaveLength(1);
  });
});
