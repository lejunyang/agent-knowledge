import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendSubagentEvent } from "../src/hooks/subagentLogs.js";
import {
  extractMaintenanceObservations,
  getObservationStatus,
  readMaintenanceObservations
} from "../src/memory/observations.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("maintenance observation extraction", () => {
  it("extracts SubagentStop text with provenance and skips events without reusable output", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-observations-"));
    tempDirs.push(root);
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-1",
      turn_id: "turn-1",
      agent_id: "agent-1",
      agent_type: "memory-writer",
      project_id: "project-1",
      task: "Summarize refund review procedure",
      result: {
        title: "Refund review procedure",
        domain: "support/refund",
        summary: "High-value refunds require an authorized reviewer.",
        memory_type: "procedural",
        source_authority: "verified_task"
      }
    });
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-2",
      agent_id: "agent-2",
      agent_type: "memory-reader",
      result: null
    });

    const result = await extractMaintenanceObservations(root);
    const observations = await readMaintenanceObservations(root);

    expect(result.extracted).toBe(1);
    expect(result.skipped).toBe(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      title: "Refund review procedure",
      domain: "support/refund",
      summary: "High-value refunds require an authorized reviewer.",
      sessionHash: "session-1",
      sourceAuthority: "verified_task",
      memoryType: "procedural"
    });
    expect(observations[0]?.episode).toMatchObject({
      session_hash: "session-1",
      turn_hash: "turn-1",
      project_id: "project-1"
    });
  });

  it("uses text fallback precedence and remains idempotent via a source watermark", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-observation-watermark-"));
    tempDirs.push(root);
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-1",
      agent_type: "general-purpose",
      prompt: "Investigate project rule",
      output: "The project must run typecheck before build."
    });

    const first = await extractMaintenanceObservations(root);
    const second = await extractMaintenanceObservations(root);
    const observations = await readMaintenanceObservations(root);
    const status = await getObservationStatus(root);

    expect(first.extracted).toBe(1);
    expect(second.extracted).toBe(0);
    expect(observations[0]?.summary).toBe("The project must run typecheck before build.");
    expect(status.pendingSourceEvents).toBe(0);
    expect(status.observations).toBe(1);
  });
});
