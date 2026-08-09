import { access, cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/storage/indexer.js";
import {
  getQueryRunLedgerPath,
  getLogFilePath,
  listQueryRuns,
  MemoryQueryRequestSchema,
  queryMemoriesWithDebug,
  readQueryRun
} from "../src/index.js";
import { buildContextPacket } from "../src/retrieval/contextPacket.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("privacy-safe query run ledger", () => {
  it("persists candidate and injected IDs without retaining task text", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-query-run-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    const task = "审查 Vue SFC lint 迁移方案，不能泄露这段查询原文";
    const request = MemoryQueryRequestSchema.parse({
      task,
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    const result = queryMemoriesWithDebug(root, request);
    const packet = buildContextPacket({
      request,
      ranked: result.ranked,
      queryRun: {
        rootDir: root,
        queryRunId: result.debug.queryRunId
      }
    });
    const run = await readQueryRun(root, result.debug.queryRunId);
    const content = await readFile(getQueryRunLedgerPath(root), "utf8");
    const operationalLog = await readFile(getLogFilePath(root), "utf8");

    expect(run).not.toBeNull();
    expect(run?.taskHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(run?.taskLength).toBe(task.length);
    expect(run?.candidateIds).toEqual(result.debug.resultIds);
    expect(run?.injectedIds).toEqual(
      [
        ...packet.route,
        ...packet.claims,
        ...packet.procedures,
        ...packet.principles,
        ...packet.episodes
      ].map((item) => item.id)
    );
    expect(run?.abstained).toBe(false);
    expect(content).not.toContain(task);
    expect(content).not.toContain("不能泄露");
    expect(operationalLog).not.toContain(task);
    expect(operationalLog).not.toContain("ftsQuery");
    expect(operationalLog).not.toContain('"tokens"');
    expect(operationalLog).toContain("k_20260705_frontend_lint_vue_sfc");
    expect((await stat(getQueryRunLedgerPath(root))).mode & 0o777).toBe(0o600);
  });

  it("does not persist synthetic or explicitly disabled query runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-policy-query-off-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    queryMemoriesWithDebug(
      root,
      {
        task: "synthetic eval query",
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"]
      },
      { log: false }
    );

    expect(await listQueryRuns(root)).toEqual([]);
    await expect(access(getQueryRunLedgerPath(root))).rejects.toThrow();
  });
});
