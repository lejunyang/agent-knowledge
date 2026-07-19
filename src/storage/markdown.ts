/**
 * Markdown 模块负责维护“人类可读事实源”和“机器可解析对象”之间的边界。
 *
 * 设计原则：
 * - Markdown 原文保留给人类审阅。
 * - frontmatter 必须经过 schema 校验。
 * - 任何索引都可以从 Markdown 重新生成，所以这里不能引入不可逆转换。
 */
import matter from "gray-matter";
import yaml from "js-yaml";
import { KnowledgeDocumentSchema } from "../core/schema.js";
import type { KnowledgeDocument } from "../core/types.js";

function normalizeYamlDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeYamlDates(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeYamlDates(item)]));
  }

  return value;
}

/**
 * 将 Markdown 文件解析为 KnowledgeDocument。
 *
 * gray-matter/js-yaml 会把未加引号的 `2026-07-05` 解析成 Date，
 * 但 schema 需要稳定的 `YYYY-MM-DD` 字符串，因此这里做递归归一化。
 */
export function parseKnowledgeMarkdown(filePath: string, markdown: string): KnowledgeDocument {
  const parsed = matter(markdown);

  return KnowledgeDocumentSchema.parse({
    filePath,
    frontmatter: normalizeYamlDates(parsed.data),
    body: parsed.content.trimStart()
  });
}

/**
 * 将 KnowledgeDocument 写回 Markdown。
 *
 * 这里保持 frontmatter 字段顺序，目的是让 git diff 对人类友好。
 */
export function serializeKnowledgeMarkdown(document: KnowledgeDocument): string {
  const frontmatter = yaml.dump(document.frontmatter, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false
  });

  return `---\n${frontmatter}---\n\n${document.body.trimStart()}`;
}

/**
 * 从正文中抽取短摘要，用于 FTS 索引和 context packet。
 *
 * 这是确定性摘要，不调用 LLM；真正的语义压缩应由 writer subagent 或后续能力完成。
 */
export function extractSummary(body: string, maxLength = 500): string {
  const normalized = body
    .replace(/^# .+$/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}
