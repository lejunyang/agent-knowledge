import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverKnowledgeFiles, initKnowledgeWorkspace } from "../src/storage/workspace.js";
import { getDefaultKnowledgeRoot, resolveWorkspacePath } from "../src/core/paths.js";

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

  it("hard-excludes knowledge and Skill review artifacts even when they contain Markdown", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-isolation-"));
    tempDirs.push(root);

    await initKnowledgeWorkspace(root);
    await mkdir(path.join(root, "knowledge", "_inbox"), { recursive: true });
    await mkdir(path.join(root, "knowledge", "_archive"), { recursive: true });
    await mkdir(
      path.join(root, "knowledge", "_inbox-skills", "proposal-skill"),
      { recursive: true }
    );
    await writeFile(path.join(root, "knowledge", "_inbox", "candidate.md"), "# candidate\n", "utf8");
    await writeFile(path.join(root, "knowledge", "_archive", "old.md"), "# old\n", "utf8");
    await writeFile(
      path.join(
        root,
        "knowledge",
        "_inbox-skills",
        "proposal-skill",
        "SKILL.md"
      ),
      "---\nname: proposal-skill\ndescription: Review draft\n---\n",
      "utf8"
    );

    const files = await discoverKnowledgeFiles(root);

    expect(files).not.toContain("knowledge/_inbox/candidate.md");
    expect(files).not.toContain("knowledge/_archive/old.md");
    expect(files).not.toContain(
      "knowledge/_inbox-skills/proposal-skill/SKILL.md"
    );
  });
});

describe("resolveWorkspacePath", () => {
  it("rejects sibling paths that share the same prefix", () => {
    const root = path.join(tmpdir(), "agent-knowledge-root");

    expect(() => resolveWorkspacePath(root, "..", "agent-knowledge-root-sibling", "file.md")).toThrow(
      "Refusing to access path outside workspace"
    );
  });
});

describe("getDefaultKnowledgeRoot", () => {
  it("uses ~/.agent_knowledge as the default workspace root", () => {
    expect(getDefaultKnowledgeRoot()).toBe(path.join(homedir(), ".agent_knowledge"));
  });
});
