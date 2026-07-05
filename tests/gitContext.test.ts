import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGitRuntimeContext } from "../src/gitContext.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("getGitRuntimeContext", () => {
  it("reports non-git directories without throwing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-non-git-"));
    tempDirs.push(root);

    expect(getGitRuntimeContext(root)).toEqual({
      cwd: root,
      isGit: false
    });
  });

  it("detects git root and origin from a nested directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-git-"));
    tempDirs.push(root);
    const nested = path.join(root, "packages", "demo");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", "git@example.com:demo/repo.git"], { cwd: root });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(nested, { recursive: true }));

    expect(getGitRuntimeContext(nested)).toEqual({
      cwd: nested,
      isGit: true,
      gitRoot: await realpath(root),
      gitOrigin: "git@example.com:demo/repo.git"
    });
  });
});
