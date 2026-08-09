import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FeedbackReasonSchema,
  logMemoryFeedback
} from "../src/retrieval/feedback.js";
import { getLogFilePath } from "../src/core/logging.js";
import {
  readFeedbackLedger,
  refreshFeedbackLedger
} from "../src/memory/feedbackLedger.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("logMemoryFeedback", () => {
  it("appends memory usefulness feedback to JSONL logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-feedback-"));
    tempDirs.push(root);

    const result = logMemoryFeedback(root, {
      memoryId: "k_20260705_frontend_lint_vue_sfc",
      usefulness: "useful",
      queryRunId: "query-123",
      task: "审查 lint 迁移方案",
      note: "命中了正确的 Vue SFC fallback 约束"
    });

    expect(result.status).toBe("logged");
    expect(result.memoryId).toBe("k_20260705_frontend_lint_vue_sfc");
    const lines = (await readFile(getLogFilePath(root), "utf8")).trim().split("\n");
    const log = JSON.parse(lines.at(-1) ?? "{}") as {
      event?: string;
      memoryId?: string;
      usefulness?: string;
      queryRunId?: string;
      taskLength?: number;
      note?: string;
    };

    expect(log).toMatchObject({
      event: "feedback.memory_usefulness",
      memoryId: "k_20260705_frontend_lint_vue_sfc",
      usefulness: "useful",
      queryRunId: "query-123",
      note: "命中了正确的 Vue SFC fallback 约束"
    });
    expect(log.taskLength).toBeGreaterThan(0);
  });

  it("records structured failure reasons and expected/forbidden memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-feedback-reason-"));
    tempDirs.push(root);

    logMemoryFeedback(root, {
      memoryId: "k_wrong",
      usefulness: "not_useful",
      reason: "wrong_route",
      queryRunId: "query-route-1",
      expectedMemoryIds: ["k_expected"],
      forbiddenMemoryIds: ["k_wrong"]
    });
    refreshFeedbackLedger(root);
    const entry = Object.values(readFeedbackLedger(root).entries)[0];

    expect(entry).toMatchObject({
      memoryId: "k_wrong",
      usefulness: "not_useful",
      reason: "wrong_route",
      queryRunId: "query-route-1",
      expectedMemoryIds: ["k_expected"],
      forbiddenMemoryIds: ["k_wrong"]
    });
  });

  it("supports query-level feedback when no single memory is responsible", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-feedback-query-"));
    tempDirs.push(root);

    const result = logMemoryFeedback(root, {
      usefulness: "not_useful",
      reason: "should_abstain",
      queryRunId: "query-abstain-1"
    });
    refreshFeedbackLedger(root);
    const entry = Object.values(readFeedbackLedger(root).entries)[0];

    expect(result.memoryId).toBeUndefined();
    expect(entry).toMatchObject({
      usefulness: "not_useful",
      reason: "should_abstain",
      queryRunId: "query-abstain-1"
    });
    expect(entry?.memoryId).toBeUndefined();
  });

  it("rejects invalid usefulness values", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-feedback-invalid-"));
    tempDirs.push(root);

    expect(() =>
      logMemoryFeedback(root, {
        memoryId: "k_20260705_frontend_lint_vue_sfc",
        usefulness: "great"
      })
    ).toThrow();
    expect(() => FeedbackReasonSchema.parse("guess")).toThrow();
  });
});
