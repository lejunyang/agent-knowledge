/**
 * Git workspace 模块只负责初始化独立的知识数据仓库。
 *
 * 它不添加 remote、不 commit、不复制旧知识，也不会把 Vault 对象写入 Git。目标目录如果
 * 位于另一个 Git worktree 内会被拒绝，避免内部业务知识误进入代码仓库历史。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { initKnowledgeWorkspace } from "./workspace.js";
import { resolveWorkspacePath } from "../core/paths.js";

const DATA_GITIGNORE = `.memory/
.vault/
local_exports/
*.tmp
.DS_Store
.agent-knowledge.local.json
`;

const DATA_SECURITY = `# Knowledge Data Security

- Do not commit credentials, cookies, private keys, or unredacted customer data.
- Keep complete evidence objects under the encrypted Vault; Git stores manifests and reviewed Markdown.
- Publishing an attachment copies it into Git history; review authorization, PII, active content, and remote visibility first.
- Review the remote destination and repository visibility before the first push.
`;

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

/** 只创建缺失文件，不覆盖用户已经定制的数据仓库策略。 */
async function writeFileIfMissing(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      return;
    }
    throw error;
  }
}

/** 判断 target 是否被另一个 Git root 包含；同路径已初始化则允许幂等执行。 */
function assertSeparateGitDirectory(rootDir: string): void {
  const resolvedRoot = path.resolve(rootDir);
  const probeDirectory = existsSync(resolvedRoot)
    ? resolvedRoot
    : path.dirname(resolvedRoot);
  const containingRoot = runGit(probeDirectory, ["rev-parse", "--show-toplevel"]);
  if (
    containingRoot &&
    path.resolve(containingRoot) !== resolvedRoot
  ) {
    throw new Error(
      "Knowledge Git workspace must use a separate directory outside an unrelated Git repository"
    );
  }
}

export type KnowledgeGitStatus = {
  isGit: boolean;
  root: string;
  remote: string | null;
  branch: string | null;
  dirty: boolean;
  trackedKnowledgeFiles: number;
  trackedPolicyFiles: number;
};

/**
 * 初始化 private-data-safe Git 工作区。
 *
 * 调用方后续必须自行创建 private remote 并确认访问控制；本函数不执行任何网络或 commit。
 */
export async function initializeKnowledgeGitWorkspace(
  rootDir: string
): Promise<{ initialized: boolean; rootDir: string }> {
  const resolvedRoot = path.resolve(rootDir);
  assertSeparateGitDirectory(resolvedRoot);
  await mkdir(resolvedRoot, { recursive: true });
  await initKnowledgeWorkspace(resolvedRoot);
  await writeFileIfMissing(
    resolveWorkspacePath(resolvedRoot, ".gitignore"),
    DATA_GITIGNORE
  );
  await writeFileIfMissing(
    resolveWorkspacePath(resolvedRoot, "SECURITY.md"),
    DATA_SECURITY
  );
  if (runGit(resolvedRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: resolvedRoot,
      stdio: "ignore"
    });
  }
  return { initialized: true, rootDir: resolvedRoot };
}

/** 返回不含知识正文的 Git 状态摘要，供 doctor 和 smoke 使用。 */
export async function getKnowledgeGitStatus(
  rootDir: string
): Promise<KnowledgeGitStatus> {
  const resolvedRoot = path.resolve(rootDir);
  const isGit =
    runGit(resolvedRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
  if (!isGit) {
    return {
      isGit: false,
      root: resolvedRoot,
      remote: null,
      branch: null,
      dirty: false,
      trackedKnowledgeFiles: 0,
      trackedPolicyFiles: 0
    };
  }
  const tracked = runGit(resolvedRoot, ["ls-files", "knowledge"]) ?? "";
  const trackedPolicies = runGit(resolvedRoot, ["ls-files", "policies"]) ?? "";
  // 只返回数量；文件路径和知识标题仍留在本地 Git 工具中，避免 doctor 输出扩大暴露面。
  const trackedKnowledgeFiles = tracked
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean).length;
  const trackedPolicyFiles = trackedPolicies
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean).length;
  return {
    isGit: true,
    root:
      runGit(resolvedRoot, ["rev-parse", "--show-toplevel"]) ?? resolvedRoot,
    remote: runGit(resolvedRoot, ["config", "--get", "remote.origin.url"]) ?? null,
    branch:
      runGit(resolvedRoot, ["branch", "--show-current"]) ?? null,
    dirty: Boolean(runGit(resolvedRoot, ["status", "--porcelain"])),
    trackedKnowledgeFiles,
    trackedPolicyFiles
  };
}
