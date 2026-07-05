import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { catalogKnowledge, getLogFilePath } from "../src/index.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("catalogKnowledge", () => {
  it("returns catalog data and refreshes knowledge/_catalog.md", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-catalog-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const catalog = await catalogKnowledge(root);

    expect(catalog.total).toBeGreaterThanOrEqual(2);
    expect(catalog.items.map((item) => item.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(catalog.registry.domains).toContain("frontend/lint");
    expect(catalog.registry.scenarios).toContain("lint-migration");
    expect(catalog.registry.aliases).toContain("vue-lint");
    expect(catalog.written).toBe(true);

    const markdown = await readFile(path.join(root, "knowledge", "_catalog.md"), "utf8");
    expect(markdown).toContain("# Knowledge Catalog");
    expect(markdown).toContain("## Registry");
    expect(markdown).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(markdown).toContain("vue-lint");
  });

  it("writes JSONL catalog logs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-catalog-logs-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    await catalogKnowledge(root, { write: false });

    const logLines = (await readFile(getLogFilePath(root), "utf8")).trim().split("\n");
    const log = JSON.parse(logLines.at(-1) ?? "{}") as { event?: string; written?: boolean; total?: number };

    expect(log.event).toBe("catalog");
    expect(log.written).toBe(false);
    expect(log.total).toBeGreaterThanOrEqual(2);
  });
});
