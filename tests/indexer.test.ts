import { mkdtemp, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getIndexDbPath, rebuildIndex } from "../src/indexer.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("rebuildIndex", () => {
  it("indexes active knowledge files into SQLite and FTS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-index-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const result = rebuildIndex(root);

    expect(result.indexed).toBe(2);
    expect(result.dbPath).toBe(getIndexDbPath(root));
    expect(result.dbPath.endsWith(".memory/index.sqlite")).toBe(true);

    const db = new DatabaseSync(result.dbPath, { readOnly: true });
    try {
      const count = db.prepare("SELECT COUNT(*) AS count FROM memories").get() as { count: number };
      const ftsRows = db
        .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank")
        .all("eslint") as Array<{ id: string }>;

      expect(count.count).toBe(2);
      expect(ftsRows.map((row) => row.id)).toContain("k_20260705_frontend_lint_vue_sfc");
      expect(ftsRows.map((row) => row.id)).toContain("k_20260705_lint_validation_flow");
    } finally {
      db.close();
    }
  });
});
