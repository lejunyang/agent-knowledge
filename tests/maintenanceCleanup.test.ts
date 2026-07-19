import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonlLog, getLogFilePath } from "../src/core/logging.js";
import {
  appendSubagentEvent,
  getSubagentLogPath,
  readSubagentLogs
} from "../src/hooks/subagentLogs.js";
import {
  applyMaintenanceCleanup,
  planMaintenanceCleanup
} from "../src/memory/cleanup.js";
import {
  getFeedbackLedgerPath,
  readFeedbackScores
} from "../src/memory/feedbackLedger.js";
import {
  extractMaintenanceObservations,
  getObservationStatus
} from "../src/memory/observations.js";
import { logMemoryFeedback } from "../src/retrieval/feedback.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs = [];
});

/** 创建隔离 workspace，避免清理测试触碰真实运行日志。 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(
    path.join(tmpdir(), "agent-knowledge-maintenance-cleanup-")
  );
  tempDirs.push(root);
  return root;
}

describe("maintenance cleanup", () => {
  it("keeps dry-run read-only and refuses to delete pending SubagentStop logs", async () => {
    const root = await createRoot();
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStop",
      session_id: "session-pending",
      agent_id: "agent-pending",
      agent_type: "memory-writer",
      result: "A reusable result that has not been extracted yet."
    });
    logMemoryFeedback(root, {
      memoryId: "k_pending",
      usefulness: "useful",
      queryRunId: "query-pending"
    });

    const plan = await planMaintenanceCleanup(root);

    expect(plan.applied).toBe(false);
    expect(plan.pendingSourceEvents).toBe(1);
    expect(plan.unmatchedStarts).toBe(0);
    expect(plan.subagentLogFiles).toHaveLength(1);
    expect(plan.feedbackEvents).toBe(1);
    expect(existsSync(getFeedbackLedgerPath(root))).toBe(false);
    await expect(applyMaintenanceCleanup(root)).rejects.toThrow(
      "pending SubagentStop"
    );
    expect(existsSync(getSubagentLogPath(root))).toBe(true);
    expect(existsSync(getFeedbackLedgerPath(root))).toBe(false);
  });

  it("refuses cleanup while a SubagentStart is still unmatched", async () => {
    const root = await createRoot();
    await appendSubagentEvent(root, {
      hook_event_name: "SubagentStart",
      session_id: "session-running",
      agent_id: "agent-running",
      agent_type: "memory-writer"
    });

    const plan = await planMaintenanceCleanup(root);

    expect(plan.pendingSourceEvents).toBe(0);
    expect(plan.unmatchedStarts).toBe(1);
    await expect(applyMaintenanceCleanup(root)).rejects.toThrow(
      "unmatched SubagentStart"
    );
    expect(existsSync(getSubagentLogPath(root))).toBe(true);
  });

  it("deletes consumed Subagent logs and feedback rows while preserving operational logs", async () => {
    const root = await createRoot();
    await appendSubagentEvent(
      root,
      {
        hook_event_name: "SubagentStart",
        session_id: "session-clean",
        agent_id: "agent-clean",
        agent_type: "memory-writer"
      },
      { now: "2026-07-19T00:00:00.000Z" }
    );
    await appendSubagentEvent(
      root,
      {
        hook_event_name: "SubagentStop",
        session_id: "session-clean",
        agent_id: "agent-clean",
        agent_type: "memory-writer",
        result: "A reusable verified procedure result."
      },
      { now: "2026-07-19T00:00:01.000Z" }
    );
    await extractMaintenanceObservations(root);
    appendJsonlLog(root, {
      event: "query",
      queryRunId: "query-clean",
      debug: { resultIds: ["k_clean"] }
    });
    logMemoryFeedback(root, {
      memoryId: "k_clean",
      usefulness: "useful",
      queryRunId: "query-clean"
    });

    const result = await applyMaintenanceCleanup(root);
    const remainingLogs = (await readFile(getLogFilePath(root), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string });

    expect(result.applied).toBe(true);
    expect(result.deletedSubagentLogFiles).toHaveLength(1);
    expect(result.removedFeedbackEvents).toBe(1);
    expect(await readSubagentLogs(root, {})).toEqual([]);
    expect(await getObservationStatus(root)).toMatchObject({
      sourceEvents: 0,
      sourceWatermark: 0,
      pendingSourceEvents: 0,
      observations: 1
    });
    expect(remainingLogs.map((event) => event.event)).toEqual(["query"]);
    expect(readFeedbackScores(root).get("k_clean")).toBe(1);
    expect(existsSync(getFeedbackLedgerPath(root))).toBe(true);
  });

  it("keeps the latest feedback per memory and query after source logs are removed", async () => {
    const root = await createRoot();
    logMemoryFeedback(root, {
      memoryId: "k_feedback",
      usefulness: "useful",
      queryRunId: "query-shared"
    });
    logMemoryFeedback(root, {
      memoryId: "k_feedback",
      usefulness: "not_useful",
      queryRunId: "query-shared"
    });
    logMemoryFeedback(root, {
      memoryId: "k_feedback",
      usefulness: "useful",
      queryRunId: "query-independent"
    });

    const result = await applyMaintenanceCleanup(root);

    expect(result.removedFeedbackEvents).toBe(3);
    expect(readFeedbackScores(root).get("k_feedback")).toBe(0);
    expect(existsSync(getLogFilePath(root))).toBe(false);

    const second = await applyMaintenanceCleanup(root);
    expect(second.removedFeedbackEvents).toBe(0);
    expect(readFeedbackScores(root).get("k_feedback")).toBe(0);

    logMemoryFeedback(root, {
      memoryId: "k_feedback",
      usefulness: "useful",
      queryRunId: "query-shared"
    });
    await applyMaintenanceCleanup(root);
    expect(readFeedbackScores(root).get("k_feedback")).toBe(2);
  });
});
