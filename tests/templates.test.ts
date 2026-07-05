import { lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { linkTraeTemplates } from "../src/templates.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("linkTraeTemplates", () => {
  it("links TRAE agent and hooks templates into a target config directory", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-target-"));
    tempDirs.push(targetDir);

    const result = await linkTraeTemplates({
      packageRoot: process.cwd(),
      targetDir
    });

    const agentTarget = path.join(targetDir, "agents", "memory-writer.md");
    const hooksTarget = path.join(targetDir, "hooks.json");

    expect((await lstat(agentTarget)).isSymbolicLink()).toBe(true);
    expect((await lstat(hooksTarget)).isSymbolicLink()).toBe(true);
    expect(path.resolve(path.dirname(agentTarget), await readlink(agentTarget))).toBe(
      path.join(process.cwd(), "templates", "trae", "agents", "memory-writer.md")
    );
    expect(result.linked.map((item) => item.status)).toEqual(["linked", "linked"]);
  });

  it("is idempotent when targets already link to the same templates", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-idempotent-"));
    tempDirs.push(targetDir);

    await linkTraeTemplates({ packageRoot: process.cwd(), targetDir });
    const result = await linkTraeTemplates({ packageRoot: process.cwd(), targetDir });

    expect(result.linked.map((item) => item.status)).toEqual(["already-linked", "already-linked"]);
  });

  it("refuses to overwrite existing files unless force is set", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-existing-"));
    tempDirs.push(targetDir);
    await writeFile(path.join(targetDir, "hooks.json"), "{}", "utf8");

    await expect(linkTraeTemplates({ packageRoot: process.cwd(), targetDir })).rejects.toThrow("Refusing to overwrite");
    await expect(linkTraeTemplates({ packageRoot: process.cwd(), targetDir, force: true })).resolves.toMatchObject({
      targetDir
    });
  });
});
