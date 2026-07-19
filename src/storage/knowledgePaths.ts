/**
 * knowledge 路径策略统一定义哪些 Markdown 属于正式知识，哪些只是生成或审阅产物。
 *
 * `knowledge/_inbox-skills/<proposal>/SKILL.md` 虽然位于 knowledge 目录并使用 Markdown，但它遵循
 * Skill frontmatter，不是 KnowledgeDocument；所有事实读取链都必须在解析前排除它。
 */
export const GENERATED_KNOWLEDGE_FILES = new Set([
  "knowledge/README.md",
  "knowledge/_catalog.md",
  "knowledge/_conflicts.md",
  "knowledge/_review_queue.md"
]);

const KNOWLEDGE_REVIEW_PREFIXES = [
  "knowledge/_inbox/",
  "knowledge/_archive/",
  "knowledge/_inbox-skills/"
] as const;

/** 统一 Windows/POSIX 分隔符，保证路径策略跨平台一致。 */
export function normalizeKnowledgePath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

/** 判断路径是否是 catalog、冲突列表等生成式 Markdown。 */
export function isGeneratedKnowledgeFile(filePath: string): boolean {
  return GENERATED_KNOWLEDGE_FILES.has(normalizeKnowledgePath(filePath));
}

/** 判断路径是否位于候选、归档或 Skill 草稿等非正式审阅目录。 */
export function isKnowledgeReviewArtifact(filePath: string): boolean {
  const normalized = normalizeKnowledgePath(filePath);
  return KNOWLEDGE_REVIEW_PREFIXES.some((prefix) =>
    normalized.startsWith(prefix)
  );
}

/** 判断路径是否是 Skill proposal 草稿；organizer 也不能把它当 KnowledgeDocument 解析。 */
export function isSkillReviewDraft(filePath: string): boolean {
  return normalizeKnowledgePath(filePath).startsWith(
    "knowledge/_inbox-skills/"
  );
}

/** 判断 Markdown 是否可进入 index、embedding、catalog、graph 或同步事实链。 */
export function isDiscoverableKnowledgeFile(filePath: string): boolean {
  const normalized = normalizeKnowledgePath(filePath);
  return (
    normalized.startsWith("knowledge/") &&
    normalized.endsWith(".md") &&
    !isGeneratedKnowledgeFile(normalized) &&
    !isKnowledgeReviewArtifact(normalized)
  );
}
