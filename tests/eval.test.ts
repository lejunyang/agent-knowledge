import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/indexer.js";
import { runEvalCase } from "../src/eval.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("runEvalCase", () => {
  it("reports expected memories and forbidden misses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "审查 lint 迁移方案",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      expected_memories: ["k_20260705_frontend_lint_vue_sfc"],
      forbidden_memories: ["k_20260601_deprecated_lint_flow"]
    });

    expect(result.passed).toBe(true);
    expect(result.missingExpected).toEqual([]);
    expect(result.presentForbidden).toEqual([]);
  });
});
