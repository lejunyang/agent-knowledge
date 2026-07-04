import { mkdir, writeFile } from "node:fs/promises";
import fg from "fast-glob";
import { KNOWLEDGE_DIRS, resolveWorkspacePath, toPosixRelativePath } from "./paths.js";

const README = `# Knowledge Base

This directory is the human-readable fact source for agent memory.

- \`profile/\`: stable preferences and project rules.
- \`semantic/\`: business facts, concepts, system boundaries.
- \`episodic/\`: historical tasks, incidents, lessons.
- \`procedural/\`: reusable procedures and SOPs.
- \`sources/\`: source summaries and provenance.
- \`_inbox/\`: proposed memories awaiting review.
- \`_archive/\`: deprecated or rejected memories.
`;

export async function initKnowledgeWorkspace(rootDir: string): Promise<void> {
  for (const dir of KNOWLEDGE_DIRS) {
    await mkdir(resolveWorkspacePath(rootDir, dir), { recursive: true });
  }

  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "README.md"), README, "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_catalog.md"), "# Knowledge Catalog\n", "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_conflicts.md"), "# Knowledge Conflicts\n", "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_review_queue.md"), "# Review Queue\n", "utf8");
}

export async function discoverKnowledgeFiles(rootDir: string): Promise<string[]> {
  const entries = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: true,
    ignore: [
      "knowledge/README.md",
      "knowledge/_catalog.md",
      "knowledge/_conflicts.md",
      "knowledge/_review_queue.md"
    ]
  });

  return entries.sort().map((file) => toPosixRelativePath(rootDir, file));
}
