import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectProject, getProjectRegistryPath, normalizeGitRemote } from "../src/integration/projects.js";

const execFileAsync = promisify(execFile);
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))
  );
  tempDirs = [];
});

describe("project identity", () => {
  it("normalizes common HTTPS and SSH Git remotes", () => {
    expect(normalizeGitRemote("git@github.com:Example/Repo.git")).toBe("github.com/example/repo");
    expect(normalizeGitRemote("https://github.com/Example/Repo.git/")).toBe("github.com/example/repo");
    expect(normalizeGitRemote("ssh://git@code.example.com/team/repo.git")).toBe("code.example.com/team/repo");
  });

  it("detects a stable remote-based project and records AGENTS hashes without content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-project-"));
    const nested = path.join(root, "packages", "app");
    const knowledgeRoot = path.join(root, "memory-root");
    tempDirs.push(root);
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["remote", "add", "origin", "git@github.com:Example/Repo.git"], { cwd: root });
    await writeFile(path.join(root, "AGENTS.md"), "SECRET PROJECT INSTRUCTION", "utf8");
    await writeFile(path.join(nested, "AGENTS.override.md"), "nested override", "utf8");

    const project = await detectProject(knowledgeRoot, nested);
    const registry = await readFile(getProjectRegistryPath(knowledgeRoot, project.id), "utf8");

    expect(project.id).toMatch(/^project_[a-f0-9]{16}$/);
    expect(project.identitySource).toBe("git_remote");
    expect(project.remote).toBe("github.com/example/repo");
    expect(project.agentInstructions.map((item) => item.path)).toEqual([
      "AGENTS.md",
      "packages/app/AGENTS.override.md"
    ]);
    expect(project.agentInstructions.every((item) => item.sha256.length === 64)).toBe(true);
    expect(registry).not.toContain("SECRET PROJECT INSTRUCTION");
    expect(registry).not.toContain("nested override");
  });

  it("falls back to a local path identity when no remote exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-project-local-"));
    const knowledgeRoot = path.join(root, "memory-root");
    tempDirs.push(root);
    await execFileAsync("git", ["init"], { cwd: root });

    const first = await detectProject(knowledgeRoot, root);
    const second = await detectProject(knowledgeRoot, root);

    expect(first.identitySource).toBe("git_path");
    expect(first.id).toBe(second.id);
    expect(first.gitRoot).toBe(realpathSync(root));
  });
});
