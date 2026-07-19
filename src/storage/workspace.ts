/**
 * workspace 模块负责创建和发现人类可读知识库目录。
 *
 * 它只管理 `knowledge/` 事实源，不处理 `.memory/` 索引。这个边界确保初始化知识库
 * 不会意外创建或污染机器索引。
 */
import { mkdir, writeFile } from "node:fs/promises";
import fg from "fast-glob";
import { KNOWLEDGE_DIRS, resolveWorkspacePath, toPosixRelativePath } from "../core/paths.js";
import { isDiscoverableKnowledgeFile } from "./knowledgePaths.js";

const README = `# Knowledge Base

This directory is the human-readable fact source for agent memory.

- \`profile/\`: stable preferences and project rules.
- \`semantic/\`: business facts, concepts, system boundaries.
- \`episodic/\`: historical tasks, incidents, lessons.
- \`procedural/\`: reusable procedures and SOPs.
- \`sources/\`: source summaries and provenance.
- \`_inbox/\`: proposed memories awaiting review.
- \`_archive/\`: deprecated or rejected memories.
- \`_inbox-skills/\`: reviewed Skill drafts; not knowledge facts.
`;

/** 只创建缺失的 workspace 模板文件，绝不覆盖用户已有 Markdown。 */
async function writeFileIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return;
    }
    throw error;
  }
}

/**
 * 初始化知识库目录和人类可读的索引占位文件。
 *
 * 这些文件是给人类审阅用的，不参与 FTS 索引。
 */
export async function initKnowledgeWorkspace(rootDir: string): Promise<void> {
  for (const dir of KNOWLEDGE_DIRS) {
    await mkdir(resolveWorkspacePath(rootDir, dir), { recursive: true });
  }

  await writeFileIfMissing(resolveWorkspacePath(rootDir, "knowledge", "README.md"), README);
  await writeFileIfMissing(resolveWorkspacePath(rootDir, "knowledge", "_catalog.md"), "# Knowledge Catalog\n");
  await writeFileIfMissing(resolveWorkspacePath(rootDir, "knowledge", "_conflicts.md"), "# Knowledge Conflicts\n");
  await writeFileIfMissing(resolveWorkspacePath(rootDir, "knowledge", "_review_queue.md"), "# Review Queue\n");
}

/**
 * 发现可作为事实源的 Markdown 文件。
 *
 * 生成型 catalog/review 文件会被排除，避免它们反过来污染知识检索。
 */
export async function discoverKnowledgeFiles(rootDir: string): Promise<string[]> {
  const entries = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: true
  });

  return entries
    .map((file) => toPosixRelativePath(rootDir, file))
    .filter(isDiscoverableKnowledgeFile)
    .sort();
}
