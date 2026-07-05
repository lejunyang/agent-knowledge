/**
 * 路径模块把所有文件访问限制在 workspace root 内。
 *
 * 其他模块不应自己拼接未校验的绝对路径。这样可以避免 hook 或外部 agent
 * 传入 `../` 造成越界读写。
 */
import path from "node:path";

export const KNOWLEDGE_DIRS = [
  "knowledge/_inbox",
  "knowledge/_archive",
  "knowledge/profile",
  "knowledge/semantic",
  "knowledge/episodic",
  "knowledge/procedural",
  "knowledge/sources"
] as const;

/**
 * 安全地解析 workspace 内路径。
 *
 * 使用 `path.relative` 而不是简单 `startsWith`，因为同前缀兄弟目录
 * 例如 `/tmp/root` 和 `/tmp/root-sibling` 会绕过朴素前缀判断。
 */
export function resolveWorkspacePath(rootDir: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to access path outside workspace: ${resolvedTarget}`);
  }

  return resolvedTarget;
}

/**
 * 索引和 Markdown frontmatter 中统一使用 POSIX 相对路径，避免不同系统路径分隔符导致 diff 抖动。
 */
export function toPosixRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
