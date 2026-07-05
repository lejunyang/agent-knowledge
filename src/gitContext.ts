import { execFileSync } from "node:child_process";

export type GitRuntimeContext = {
  cwd: string;
  isGit: boolean;
  gitRoot?: string;
  gitOrigin?: string;
};

function runGit(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Hook 运行目录由宿主决定，不能假设一定是项目根目录。
 * 这里只做只读探测，失败时返回 isGit=false，避免 hook 因 Git 不存在或目录非仓库而中断主流程。
 */
export function getGitRuntimeContext(cwd = process.cwd()): GitRuntimeContext {
  const insideWorkTree = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") {
    return { cwd, isGit: false };
  }

  const gitRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  const gitOrigin = runGit(cwd, ["config", "--get", "remote.origin.url"]);

  return {
    cwd,
    isGit: true,
    ...(gitRoot ? { gitRoot } : {}),
    ...(gitOrigin ? { gitOrigin } : {})
  };
}
