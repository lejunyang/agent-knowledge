import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readSidecarComparisonHistory,
  writeSidecarRun
} from "../src/sidecar/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("sidecar comparison history", () => {
  it("returns safe metrics newest-first and skips malformed artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-history-"));
    tempDirs.push(root);
    const metrics = {
      cases: 2,
      passed: 2,
      failed: 0,
      recallAt1: 1,
      recallAt3: 1,
      falseInjectionRate: 0,
      abstentionPrecision: 1,
      abstentionFailureRate: 0,
      averageLatencyMs: 5,
      unmappedResults: 0
    };

    const older = await writeSidecarRun(root, {
      sidecarId: "comparison",
      provider: "comparison",
      operation: "compare",
      status: "succeeded",
      startedAt: "2026-08-09T00:00:00.000Z",
      completedAt: "2026-08-09T00:00:01.000Z",
      latencyMs: 1_000,
      artifact: {
        generatedAt: "2026-08-09T00:00:00.000Z",
        providers: { native: metrics }
      }
    });
    const newer = await writeSidecarRun(root, {
      sidecarId: "comparison",
      provider: "comparison",
      operation: "compare",
      status: "succeeded",
      startedAt: "2026-08-10T00:00:00.000Z",
      completedAt: "2026-08-10T00:00:01.000Z",
      latencyMs: 1_000,
      artifact: {
        generatedAt: "2026-08-10T00:00:00.000Z",
        providers: {
          native: metrics,
          "mem0-local": { ...metrics, passed: 1, failed: 1 }
        }
      }
    });
    const malformed = await writeSidecarRun(root, {
      sidecarId: "comparison",
      provider: "comparison",
      operation: "compare",
      status: "succeeded",
      startedAt: "2026-08-11T00:00:00.000Z",
      completedAt: "2026-08-11T00:00:01.000Z",
      latencyMs: 1_000,
      artifact: { generatedAt: "invalid", providers: {} }
    });

    const history = await readSidecarComparisonHistory(root);

    expect(history.entries.map((entry) => entry.runId)).toEqual([
      newer.id,
      older.id
    ]);
    expect(history.entries[0]?.providers["mem0-local"]?.failed).toBe(1);
    expect(history.skipped.map((entry) => entry.runId)).toEqual([
      malformed.id
    ]);
    expect(JSON.stringify(history)).not.toContain('"query"');
  });
});
