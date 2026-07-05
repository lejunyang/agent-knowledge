/**
 * indexer 模块负责把 Markdown 事实源重建为 SQLite/FTS5 索引。
 *
 * 重要边界：
 * - Markdown 是事实源，`.memory/index.sqlite` 只是缓存。
 * - 索引可以随时删除并重建。
 * - 只有 `status: active` 的知识进入索引，避免 `_inbox` 候选污染主 agent 注入。
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { extractSummary, parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import type { KnowledgeDocument } from "./types.js";

const require = createRequire(import.meta.url);
// 当前运行环境可用 Node 内置 `node:sqlite`，避免 native binding 依赖带来的安装失败。
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseConnection = InstanceType<typeof DatabaseSync>;

export type RebuildIndexResult = {
  dbPath: string;
  indexed: number;
};

const GENERATED_KNOWLEDGE_FILES = new Set([
  "knowledge/README.md",
  "knowledge/_catalog.md",
  "knowledge/_conflicts.md",
  "knowledge/_review_queue.md"
]);

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * 同步发现知识文件，供同步 SQLite rebuild 流程使用。
 *
 * 这里没有复用 async `discoverKnowledgeFiles`，是为了让 rebuildIndex 保持简单的同步事务模型。
 */
function discoverKnowledgeFilesSync(rootDir: string): string[] {
  const knowledgeDir = resolveWorkspacePath(rootDir, "knowledge");
  const files: string[] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const relativePath = toPosixPath(path.relative(rootDir, absolutePath));
      if (!GENERATED_KNOWLEDGE_FILES.has(relativePath) && !relativePath.startsWith("knowledge/_archive/")) {
        files.push(relativePath);
      }
    }
  }

  walk(knowledgeDir);
  return files.sort();
}

/**
 * 打开并重置索引数据库。
 *
 * 每次 rebuild 都 drop/recreate，牺牲增量性能换取 MVP 的确定性和可调试性。
 */
function openIndexDatabase(rootDir: string): DatabaseConnection {
  const memoryDir = resolveWorkspacePath(rootDir, ".memory");
  mkdirSync(memoryDir, { recursive: true });

  const db = new DatabaseSync(getIndexDbPath(rootDir));
  db.exec(`
    DROP TABLE IF EXISTS memory_fts;
    DROP TABLE IF EXISTS memories;

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      related_domains TEXT NOT NULL,
      scenario TEXT NOT NULL,
      tags TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_authority TEXT NOT NULL,
      source TEXT NOT NULL,
      related_knowledge TEXT NOT NULL,
      supersedes TEXT NOT NULL,
      conflicts_with TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      valid_until TEXT,
      summary TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE memory_fts USING fts5(
      id UNINDEXED,
      title,
      domain,
      scenario,
      tags,
      summary,
      body
    );
  `);

  return db;
}

/**
 * 将一条知识写入 metadata 表和 FTS 表。
 *
 * 数组和关系字段以 JSON 字符串保存，方便查询阶段重新解析，同时保持 SQLite schema 简单。
 */
function insertDocument(db: DatabaseConnection, document: KnowledgeDocument): void {
  const frontmatter = document.frontmatter;
  const summary = extractSummary(document.body);

  db.prepare(`
    INSERT INTO memories (
      id, file_path, type, title, domain, related_domains, scenario, tags, status,
      confidence, source_authority, source, related_knowledge, supersedes,
      conflicts_with, visibility, sensitivity, updated_at, valid_until, summary, body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    frontmatter.id,
    document.filePath,
    frontmatter.type,
    frontmatter.title,
    frontmatter.domain,
    JSON.stringify(frontmatter.related_domains),
    JSON.stringify(frontmatter.scenario),
    JSON.stringify(frontmatter.tags),
    frontmatter.status,
    frontmatter.confidence,
    frontmatter.source_authority,
    JSON.stringify(frontmatter.source),
    JSON.stringify(frontmatter.related_knowledge),
    JSON.stringify(frontmatter.supersedes),
    JSON.stringify(frontmatter.conflicts_with),
    frontmatter.visibility,
    frontmatter.sensitivity,
    frontmatter.updated_at,
    frontmatter.valid_until,
    summary,
    document.body
  );

  db.prepare(`
    INSERT INTO memory_fts (id, title, domain, scenario, tags, summary, body)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    frontmatter.id,
    frontmatter.title,
    frontmatter.domain,
    frontmatter.scenario.join(" "),
    frontmatter.tags.join(" "),
    summary,
    document.body
  );
}

/**
 * 返回索引数据库位置。其他模块通过这个函数共享路径约定。
 */
export function getIndexDbPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "index.sqlite");
}

/**
 * 从 Markdown 事实源重建索引。
 *
 * 调用方应在 query 前执行该命令，或者在知识库文件发生变化后执行。
 */
export function rebuildIndex(rootDir: string): RebuildIndexResult {
  const db = openIndexDatabase(rootDir);
  let indexed = 0;

  try {
    const files = discoverKnowledgeFilesSync(rootDir);

    db.exec("BEGIN");
    try {
      for (const filePath of files) {
        const absolutePath = resolveWorkspacePath(rootDir, filePath);
        const document = parseKnowledgeMarkdown(filePath, readFileSync(absolutePath, "utf8"));

        if (document.frontmatter.status !== "active") {
          continue;
        }

        insertDocument(db, document);
        indexed += 1;
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }

  return { dbPath: getIndexDbPath(rootDir), indexed };
}
