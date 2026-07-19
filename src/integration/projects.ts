/**
 * projects 模块把运行目录映射成稳定项目身份。
 *
 * 它只记录 Git identity 和 AGENTS 指令文件的路径/hash，不复制指令正文。
 * 这样知识可以绑定项目，又不会与宿主已经注入的 AGENTS.md 重复或泄漏内容。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";

export type ProjectInstructionFingerprint = {
  path: string;
  sha256: string;
};

export type ProjectRegistry = {
  version: 1;
  id: string;
  identitySource: "git_remote" | "git_path";
  gitRoot: string;
  remote?: string;
  detectedAt: string;
  agentInstructions: ProjectInstructionFingerprint[];
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return output || undefined;
  } catch {
    return undefined;
  }
}

export function normalizeGitRemote(remote: string): string {
  const trimmed = remote.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scpMatch = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpMatch) {
    return `${scpMatch[1]}/${scpMatch[2]}`.toLowerCase().replace(/\/+/g, "/");
  }

  try {
    const url = new URL(trimmed);
    return `${url.hostname}${url.pathname}`.toLowerCase().replace(/\/+/g, "/").replace(/\/$/, "");
  } catch {
    return trimmed.toLowerCase().replace(/\\/g, "/");
  }
}

function projectId(identity: string): string {
  return `project_${sha256(identity).slice(0, 16)}`;
}

function instructionCandidates(gitRoot: string, cwd: string): string[] {
  const resolvedRoot = path.resolve(gitRoot);
  const resolvedCwd = realpathSync(path.resolve(cwd));
  const relative = path.relative(resolvedRoot, resolvedCwd);
  const segments =
    relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? [] : relative.split(path.sep);
  const directories = [resolvedRoot];
  let current = resolvedRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    directories.push(current);
  }

  const files: string[] = [];
  for (const directory of directories) {
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) {
        files.push(candidate);
      }
    }
  }
  return files;
}

export function getProjectRegistryPath(rootDir: string, id: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "projects", `${id}.json`);
}

export async function detectProject(rootDir: string, cwd = process.cwd()): Promise<ProjectRegistry> {
  const gitRootRaw = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRootRaw) {
    throw new Error(`Current directory is not inside a Git work tree: ${cwd}`);
  }
  const gitRoot = realpathSync(gitRootRaw);
  const rawRemote = runGit(gitRoot, ["config", "--get", "remote.origin.url"]);
  const remote = rawRemote ? normalizeGitRemote(rawRemote) : undefined;
  const identitySource = remote ? "git_remote" : "git_path";
  const identity = remote ?? gitRoot;
  const id = projectId(identity);
  const agentInstructions: ProjectInstructionFingerprint[] = [];

  for (const filePath of instructionCandidates(gitRoot, cwd)) {
    agentInstructions.push({
      path: path.relative(gitRoot, filePath).split(path.sep).join("/"),
      sha256: sha256(await readFile(filePath, "utf8"))
    });
  }

  const registry: ProjectRegistry = {
    version: 1,
    id,
    identitySource,
    gitRoot,
    ...(remote ? { remote } : {}),
    detectedAt: new Date().toISOString(),
    agentInstructions
  };
  const target = getProjectRegistryPath(rootDir, id);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}
