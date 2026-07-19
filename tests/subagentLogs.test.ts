import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendSubagentEvent,
  getSubagentLogStatus,
  readSubagentLogs
} from "../src/hooks/subagentLogs.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("detailed subagent logs", () => {
  it("preserves raw payload and pairs start/stop events with duration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-subagent-logs-"));
    tempDirs.push(root);
    await appendSubagentEvent(
      root,
      {
        hook_event_name: "SubagentStart",
        session_id: "session-1",
        turn_id: "turn-1",
        agent_id: "agent-1",
        agent_type: "memory-writer",
        thread_name: "writer task",
        model: "gpt-test",
        permission_mode: "default",
        cwd: "/tmp/project",
        transcript_path: "/tmp/transcript.jsonl",
        prompt: "full unredacted input"
      },
      { now: "2026-07-19T00:00:00.000Z" }
    );
    await appendSubagentEvent(
      root,
      {
        hook_event_name: "SubagentStop",
        session_id: "session-1",
        turn_id: "turn-1",
        agent_id: "agent-1",
        agent_type: "memory-writer",
        result: {
          should_store: false,
          reason: "full unredacted result"
        }
      },
      { now: "2026-07-19T00:00:03.500Z" }
    );

    const logs = await readSubagentLogs(root, {});

    expect(logs).toHaveLength(2);
    expect(logs[0]?.payload.prompt).toBe("full unredacted input");
    expect(logs[1]?.payload.result).toEqual({
      should_store: false,
      reason: "full unredacted result"
    });
    expect(logs[1]).toMatchObject({
      paired: true,
      durationMs: 3500,
      agentId: "agent-1",
      agentType: "memory-writer"
    });
  });

  it("reports unmatched starts and stops and supports filtering", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-subagent-status-"));
    tempDirs.push(root);
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStart",
      session_id: "session-1",
      agent_id: "agent-1",
      agent_type: "memory-reader"
    });
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-2",
      agent_id: "agent-2",
      agent_type: "memory-writer"
    });

    const status = await getSubagentLogStatus(root);
    const writerLogs = await readSubagentLogs(root, {
      agentType: "memory-writer",
      limit: 10
    });

    expect(status).toMatchObject({
      totalEvents: 2,
      unmatchedStarts: 1,
      unmatchedStops: 1
    });
    expect(writerLogs).toHaveLength(1);
    expect(writerLogs[0]?.agentType).toBe("memory-writer");
  });

  it("skips writes when detailed logging is disabled", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-subagent-disabled-"));
    tempDirs.push(root);

    const result = await appendSubagentEvent(
      root,
      {
        hook_event_name: "SubagentStart",
        agent_id: "agent-1"
      },
      { enabled: false }
    );

    expect(result.written).toBe(false);
    expect(await readSubagentLogs(root, {})).toEqual([]);
  });
});
