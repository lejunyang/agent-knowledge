/**
 * catalog 模块生成面向人类和 agent 的知识清单。
 *
 * `list` 偏运行时摘要，`catalog` 则提供稳定 API/CLI，并可刷新 `knowledge/_catalog.md`。
 */
import { readFile, writeFile } from "node:fs/promises";
import { extractSummary, parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import type { KnowledgeDocument, MemoryStatus, MemoryType } from "../core/types.js";
import { discoverKnowledgeFiles, initKnowledgeWorkspace } from "./workspace.js";
import { appendJsonlLog } from "../core/logging.js";

export type CatalogItem = {
  id: string;
  title: string;
  aliases: string[];
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
  byScenario: Record<string, number>;
  byAlias: Record<string, number>;
  registry: {
    domains: string[];
    scenarios: string[];
    aliases: string[];
  };
  items: CatalogItem[];
};

export type CatalogOptions = {
  write?: boolean;
};

/** 从 Markdown 事实源读取 catalog 文档，排除生成文件和非正式目录。 */
async function loadDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const files = await discoverKnowledgeFiles(rootDir);
  const documents: KnowledgeDocument[] = [];

  for (const filePath of files) {
    documents.push(parseKnowledgeMarkdown(filePath, await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")));
  }

  return documents;
}

/** 按 selector 返回的单值维度统计 catalog 频次。 */
function countBy<T extends string>(items: CatalogItem[], selector: (item: CatalogItem) => T): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** 按 selector 返回的多值维度展开并统计 catalog 频次。 */
function countMany(items: CatalogItem[], selector: (item: CatalogItem) => string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const key of selector(item)) {
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/** 返回按字典序排序的统计键，保证 catalog 输出可复现。 */
function sortedKeys(counts: Record<string, number>): string[] {
  return Object.keys(counts).sort((left, right) => left.localeCompare(right));
}

/** 把机器 catalog 渲染为人类可浏览的 `_catalog.md`，不改变任何知识事实。 */
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
    "## Registry",
    "",
    `- domains: ${catalog.registry.domains.join(", ")}`,
    `- scenarios: ${catalog.registry.scenarios.join(", ")}`,
    `- aliases: ${catalog.registry.aliases.join(", ")}`,
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
      `- aliases: ${item.aliases.join(", ")}`,
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

/**
 * 从 Markdown 事实源生成可查询 catalog，并可选择刷新人类可读 `_catalog.md`。
 *
 * catalog 是导航与诊断视图，不参与事实权威性判断；自动 Hook 只能使用经过相关性裁剪的子集。
 */
export async function catalogKnowledge(rootDir: string, options: CatalogOptions = {}): Promise<KnowledgeCatalog> {
  await initKnowledgeWorkspace(rootDir);
  const generatedAt = new Date().toISOString();
  const documents = await loadDocuments(rootDir);
  const items = documents
    .map((document) => ({
      id: document.frontmatter.id,
      title: document.frontmatter.title,
      aliases: document.frontmatter.aliases,
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
  const byStatus = countBy(items, (item) => item.status);
  const byType = countBy(items, (item) => item.type);
  const byDomain = countBy(items, (item) => item.domain);
  const byScenario = countMany(items, (item) => item.scenarios);
  const byAlias = countMany(items, (item) => item.aliases);
  const catalogPath = resolveWorkspacePath(rootDir, "knowledge", "_catalog.md");
  const catalog: KnowledgeCatalog = {
    rootDir,
    generatedAt,
    catalogPath,
    written: options.write ?? true,
    total: items.length,
    byStatus,
    byType,
    byDomain,
    byScenario,
    byAlias,
    registry: {
      domains: sortedKeys(byDomain),
      scenarios: sortedKeys(byScenario),
      aliases: sortedKeys(byAlias)
    },
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
