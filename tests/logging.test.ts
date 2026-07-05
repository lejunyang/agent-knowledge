import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendJsonlLog, getLogFilePath } from "../src/logging.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("appendJsonlLog", () => {
  it("does not throw when best-effort log writing fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-log-best-effort-"));
    tempDirs.push(root);
    await writeFile(path.join(root, ".memory"), "not a directory", "utf8");

    expect(() => appendJsonlLog(root, { event: "hook.session_start" })).not.toThrow();
    expect(getLogFilePath(root)).toContain(".memory/logs/");
  });

  it("throws when strict log writing fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-log-strict-"));
    tempDirs.push(root);
    await writeFile(path.join(root, ".memory"), "not a directory", "utf8");

    expect(() => appendJsonlLog(root, { event: "feedback.memory_usefulness" }, { strict: true })).toThrow();
  });
});
