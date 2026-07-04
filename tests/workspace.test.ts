import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverKnowledgeFiles, initKnowledgeWorkspace } from "../src/workspace.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("initKnowledgeWorkspace", () => {
  it("creates the expected knowledge directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-"));
    tempDirs.push(root);

    await initKnowledgeWorkspace(root);

    await expect(stat(path.join(root, "knowledge", "_inbox"))).resolves.toBeDefined();
    await expect(stat(path.join(root, "knowledge", "semantic"))).resolves.toBeDefined();
    await expect(stat(path.join(root, "knowledge", "procedural"))).resolves.toBeDefined();
  });
});

describe("discoverKnowledgeFiles", () => {
  it("returns markdown files outside generated catalogs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-"));
    tempDirs.push(root);

    await initKnowledgeWorkspace(root);
    const files = await discoverKnowledgeFiles(root);

    expect(files.every((file) => file.endsWith(".md"))).toBe(true);
    expect(files.some((file) => file.endsWith("_catalog.md"))).toBe(false);
  });
});
