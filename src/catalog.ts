/**
 * catalog 模块生成面向人类和 agent 的知识清单。
 *
 * `list` 偏运行时摘要，`catalog` 则提供稳定 API/CLI，并可刷新 `knowledge/_catalog.md`。
 */
import { readFile, writeFile } from "node:fs/promises";
import { extractSummary, parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import type { KnowledgeDocument, MemoryStatus, MemoryType } from "./types.js";
import { discoverKnowledgeFiles, initKnowledgeWorkspace } from "./workspace.js";
import { appendJsonlLog } from "./logging.js";

export type CatalogItem = {
  id: string;
  title: string;
  type: MemoryType;
  status: MemoryStatus;
  domain: string;
  scenarios: string[];
  tags: string[];
  confidence: number;
  sourceAuthority: string;
  updatedAt: string;
  filePath: string;
  summary: string;
};

export type KnowledgeCatalog = {
  rootDir: string;
  generatedAt: string;
  catalogPath: string;
  written: boolean;
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byDomain: Record<string, number>;
  items: CatalogItem[];
};

export type CatalogOptions = {
  write?: boolean;
};

async function loadDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const files = await discoverKnowledgeFiles(rootDir);
  const documents: KnowledgeDocument[] = [];

  for (const filePath of files) {
    documents.push(parseKnowledgeMarkdown(filePath, await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")));
  }

  return documents;
}

function countBy<T extends string>(items: CatalogItem[], selector: (item: CatalogItem) => T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function renderCatalogMarkdown(catalog: KnowledgeCatalog): string {
  const lines = [
    "# Knowledge Catalog",
    "",
    `Generated at: ${catalog.generatedAt}`,
    "",
    `Total: ${catalog.total}`,
    "",
    "## By Status",
    "",
    ...Object.entries(catalog.byStatus)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `- ${status}: ${count}`),
    "",
    "## By Type",
    "",
    ...Object.entries(catalog.byType)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Items",
    ""
  ];

  for (const item of catalog.items) {
    lines.push(
      `### ${item.title}`,
      "",
      `- id: ${item.id}`,
      `- type/status: ${item.type}/${item.status}`,
      `- domain: ${item.domain}`,
      `- scenarios: ${item.scenarios.join(", ")}`,
      `- tags: ${item.tags.join(", ")}`,
      `- confidence: ${item.confidence}`,
      `- source_authority: ${item.sourceAuthority}`,
      `- updated_at: ${item.updatedAt}`,
      `- file: ${item.filePath}`,
      "",
      item.summary,
      ""
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export async function catalogKnowledge(rootDir: string, options: CatalogOptions = {}): Promise<KnowledgeCatalog> {
  await initKnowledgeWorkspace(rootDir);
  const generatedAt = new Date().toISOString();
  const documents = await loadDocuments(rootDir);
  const items = documents
    .map((document) => ({
      id: document.frontmatter.id,
      title: document.frontmatter.title,
      type: document.frontmatter.type,
      status: document.frontmatter.status,
      domain: document.frontmatter.domain,
      scenarios: document.frontmatter.scenario,
      tags: document.frontmatter.tags,
      confidence: document.frontmatter.confidence,
      sourceAuthority: document.frontmatter.source_authority,
      updatedAt: document.frontmatter.updated_at,
      filePath: document.filePath,
      summary: extractSummary(document.body)
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const catalogPath = resolveWorkspacePath(rootDir, "knowledge", "_catalog.md");
  const catalog: KnowledgeCatalog = {
    rootDir,
    generatedAt,
    catalogPath,
    written: options.write ?? true,
    total: items.length,
    byStatus: countBy(items, (item) => item.status),
    byType: countBy(items, (item) => item.type),
    byDomain: countBy(items, (item) => item.domain),
    items
  };

  if (catalog.written) {
    await writeFile(catalogPath, renderCatalogMarkdown(catalog), "utf8");
  }

  appendJsonlLog(rootDir, {
    event: "catalog",
    written: catalog.written,
    total: catalog.total,
    catalogPath: "knowledge/_catalog.md"
  });

  return catalog;
}
