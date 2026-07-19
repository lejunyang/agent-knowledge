import { mkdtemp, cp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getIndexDbPath, rebuildIndex } from "../src/storage/indexer.js";

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
      const aliasRows = db
        .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank")
        .all('"vue-lint"') as Array<{ id: string }>;
      const metadata = db.prepare("SELECT aliases FROM memories WHERE id = ?").get("k_20260705_frontend_lint_vue_sfc") as {
        aliases: string;
      };

      expect(count.count).toBe(2);
      expect(ftsRows.map((row) => row.id)).toContain("k_20260705_frontend_lint_vue_sfc");
      expect(ftsRows.map((row) => row.id)).toContain("k_20260705_lint_validation_flow");
      expect(aliasRows.map((row) => row.id)).toContain("k_20260705_frontend_lint_vue_sfc");
      expect(JSON.parse(metadata.aliases)).toEqual(["vue-lint", "sfc-lint"]);
    } finally {
      db.close();
    }
  });

  it("never indexes active-looking Markdown under _inbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-index-inbox-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const source = await readFile(
      path.join(root, "knowledge", "semantic", "frontend-lint", "2026-07-05-vue-sfc-eslint-fallback.md"),
      "utf8"
    );
    await writeFile(
      path.join(root, "knowledge", "_inbox", "active-looking.md"),
      source.replace("k_20260705_frontend_lint_vue_sfc", "k_20260705_inbox_must_not_index"),
      "utf8"
    );

    const result = rebuildIndex(root);
    const db = new DatabaseSync(result.dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT id FROM memories WHERE id = ?").get("k_20260705_inbox_must_not_index");
      expect(row).toBeUndefined();
      expect(result.indexed).toBe(2);
    } finally {
      db.close();
    }
  });

  it("adds CJK n-grams to the lexical index", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-index-cjk-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const result = rebuildIndex(root);
    const db = new DatabaseSync(result.dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?")
        .all('"迁移"') as Array<{ id: string }>;
      expect(rows.map((row) => row.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    } finally {
      db.close();
    }
  });
});
