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

export function resolveWorkspacePath(rootDir: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);

  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to access path outside workspace: ${resolvedTarget}`);
  }

  return resolvedTarget;
}

export function toPosixRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
