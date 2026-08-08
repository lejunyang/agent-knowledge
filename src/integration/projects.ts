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
import { ProjectKeySchema } from "../core/schema.js";

export type ProjectInstructionFingerprint = {
  path: string;
  sha256: string;
};

export type ProjectRegistry = {
  version: 2;
  key: string;
  displayName: string;
  aliases: string[];
  identitySource: "git_remote" | "explicit_local_key";
  gitRoot: string;
  remotes: Array<{
    role: "origin";
    normalized: string;
    rawRedacted: string;
  }>;
  detectedAt: string;
  agentInstructions: ProjectInstructionFingerprint[];
};

/** 生成项目 ID 和指令摘要使用的稳定 SHA-256。 */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 执行只读 Git 命令；非仓库或 Git 不可用时返回 undefined。 */
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

/**
 * 规范化 Git remote，去除协议、用户和 `.git` 差异，生成跨机器稳定的项目身份输入。
 */
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

/** 从规范 project key 生成 registry 文件名；该 hash 不进入公共身份或知识 frontmatter。 */
function registryFileId(projectKey: string): string {
  return sha256(projectKey).slice(0, 16);
}

/** 从规范 remote 最后一段生成 CLI 默认显示名。 */
export function projectDisplayName(projectKey: string): string {
  const segments = projectKey.split("/").filter(Boolean);
  return segments.at(-1) ?? projectKey;
}

/** 生成不含 host 的短别名，便于用户查询和 registry 路由。 */
export function projectAliases(projectKey: string): string[] {
  const segments = projectKey.split("/").filter(Boolean);
  return segments.length >= 2
    ? [segments.slice(-2).join("/"), projectDisplayName(projectKey)]
    : [projectKey];
}

/** URL remote 必须移除 userinfo；SCP remote 的 SSH 用户不是凭据，可原样保留。 */
export function redactGitRemote(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remote;
  }
}

/** 收集 Git root 到当前目录链上的 AGENTS 指令文件，不读取或复制其他项目文档。 */
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

/** 返回可重建项目 registry 路径；registry 用于隔离检索，不是业务事实源。 */
export function getProjectRegistryPath(
  rootDir: string,
  projectKey: string
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "projects",
    `${registryFileId(projectKey)}.json`
  );
}

/**
 * 从任意子目录发现 Git root，并注册人类可读的稳定 project key。
 *
 * 有 remote 时直接使用规范 remote；没有 remote 时必须显式提供 `local/...` key，
 * 避免把绝对路径或不可读 hash 写进长期知识。
 */
export async function detectProject(
  rootDir: string,
  cwd = process.cwd(),
  options: { projectKey?: string } = {}
): Promise<ProjectRegistry> {
  const gitRootRaw = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!gitRootRaw) {
    throw new Error(`Current directory is not inside a Git work tree: ${cwd}`);
  }
  const gitRoot = realpathSync(gitRootRaw);
  const rawRemote = runGit(gitRoot, ["config", "--get", "remote.origin.url"]);
  const remote = rawRemote ? normalizeGitRemote(rawRemote) : undefined;
  if (!remote && !options.projectKey) {
    throw new Error(
      "Git remote is missing; provide an explicit project key such as local/owner/project"
    );
  }
  const key = ProjectKeySchema.parse(remote ?? options.projectKey);
  const identitySource = remote ? "git_remote" : "explicit_local_key";
  const agentInstructions: ProjectInstructionFingerprint[] = [];

  for (const filePath of instructionCandidates(gitRoot, cwd)) {
    agentInstructions.push({
      path: path.relative(gitRoot, filePath).split(path.sep).join("/"),
      sha256: sha256(await readFile(filePath, "utf8"))
    });
  }

  const registry: ProjectRegistry = {
    version: 2,
    key,
    displayName: projectDisplayName(key),
    aliases: projectAliases(key),
    identitySource,
    gitRoot,
    remotes:
      remote && rawRemote
        ? [
            {
              role: "origin",
              normalized: remote,
              rawRedacted: redactGitRemote(rawRemote)
            }
          ]
        : [],
    detectedAt: new Date().toISOString(),
    agentInstructions
  };
  const target = getProjectRegistryPath(rootDir, key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return registry;
}
