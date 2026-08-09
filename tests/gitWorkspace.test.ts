import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getKnowledgeGitStatus,
  initializeKnowledgeGitWorkspace
} from "../src/storage/gitWorkspace.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

describe("knowledge Git workspace", () => {
  it("initializes a private-data-safe repository layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "knowledge-data-"));
    tempDirs.push(root);

    const result = await initializeKnowledgeGitWorkspace(root);
    const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
    const security = await readFile(path.join(root, "SECURITY.md"), "utf8");
    const status = await getKnowledgeGitStatus(root);

    expect(result.initialized).toBe(true);
    expect(status.isGit).toBe(true);
    expect(status.remote).toBeNull();
    expect(status.trackedKnowledgeFiles).toBe(0);
    expect(status.trackedPolicyFiles).toBe(0);
    expect(gitignore).toContain(".memory/");
    expect(gitignore).toContain(".vault/");
    expect(gitignore).not.toContain("knowledge/");
    expect(gitignore).not.toContain("policies/");
    expect(security).toContain("Do not commit credentials");
  });

  it("refuses initialization inside an unrelated code repository", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "code-repo-"));
    const nested = path.join(parent, "knowledge-data");
    tempDirs.push(parent);
    await execFileAsync("git", ["init"], { cwd: parent });

    await expect(
      initializeKnowledgeGitWorkspace(nested)
    ).rejects.toThrow(/separate directory/i);
  });
});
