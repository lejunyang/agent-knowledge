import matter from "gray-matter";
import yaml from "js-yaml";
import { KnowledgeDocumentSchema } from "./schema.js";
import type { KnowledgeDocument } from "./types.js";

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

export function parseKnowledgeMarkdown(filePath: string, markdown: string): KnowledgeDocument {
  const parsed = matter(markdown);

  return KnowledgeDocumentSchema.parse({
    filePath,
    frontmatter: normalizeYamlDates(parsed.data),
    body: parsed.content.trimStart()
  });
}

export function serializeKnowledgeMarkdown(document: KnowledgeDocument): string {
  const frontmatter = yaml.dump(document.frontmatter, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false
  });

  return `---\n${frontmatter}---\n\n${document.body.trimStart()}`;
}

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
