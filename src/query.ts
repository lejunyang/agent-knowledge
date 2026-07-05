/**
 * query 模块负责把当前任务映射到相关知识。
 *
 * 检索策略故意采用“metadata 硬过滤 + FTS/BM25 + 一跳关系扩展”：
 * - 硬过滤减少“语义相似但业务无关”的结果。
 * - FTS/BM25 擅长路径、术语、错误码、API 名称。
 * - 一跳关系扩展补充 depends_on / often_used_with 等强相关知识。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { MemoryQueryRequestSchema } from "./schema.js";
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory, SourceAuthority } from "./types.js";
import { getIndexDbPath } from "./indexer.js";

const require = createRequire(import.meta.url);
// 与 indexer 保持一致，使用 Node 内置 sqlite 读取 FTS5 索引。
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type MemoryRow = {
  id: string;
  file_path: string;
  type: string;
  title: string;
  domain: string;
  related_domains: string;
  scenario: string;
  status: string;
  confidence: number;
  source_authority: SourceAuthority;
  rank_score?: number;
};

const AUTHORITY_SCORE: Record<SourceAuthority, number> = {
  user_confirmed: 1,
  verified_task: 0.85,
  documented: 0.75,
  model_inferred: 0.45
};

// 只有这些关系允许自动扩展。冲突和替代关系只应进入 warnings，不能当作普通上下文注入。
const RELATION_EXPANSION = new Set(["depends_on", "refines", "supports", "often_used_with"]);

/**
 * 将自然语言任务切成 FTS 查询 token。
 *
 * 这里保留 `/` 和 `-`，因为领域名和场景名经常包含这些字符，例如 `frontend/lint`。
 */
function tokenize(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .split(/[^\p{L}\p{N}_/-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  ].slice(0, 12);
}

/**
 * 给 FTS token 加引号，避免 `frontend/lint` 或 `lint-migration` 触发 MATCH 语法错误。
 */
function toFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

/**
 * 从 SQLite JSON 字段恢复数组。
 *
 * 索引层用 JSON 字符串保存数组，查询层统一在这里做防御性解析。
 */
function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function loadDocument(rootDir: string, filePath: string): KnowledgeDocument {
  return parseKnowledgeMarkdown(filePath, readFileSync(resolveWorkspacePath(rootDir, filePath), "utf8"));
}

function intersects(left: string[], right: string[]): boolean {
  return left.some((item) => right.includes(item));
}

/**
 * metadata 硬过滤。
 *
 * 这一步先于排序，确保非 active、领域不匹配、场景不匹配或类型不允许的知识不会注入。
 */
function rowMatchesRequest(row: MemoryRow, request: MemoryQueryRequest): boolean {
  const relatedDomains = parseJsonArray(row.related_domains);
  const scenarios = parseJsonArray(row.scenario);
  const domainPool = [row.domain, ...relatedDomains];
  const domainOk = request.domains.length === 0 || intersects(domainPool, request.domains);
  const scenarioOk = request.scenarios.length === 0 || intersects(scenarios, request.scenarios);
  const typeOk = request.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number]);

  return row.status === "active" && domainOk && scenarioOk && typeOk;
}

/**
 * MVP 的确定性重排序公式。
 *
 * embedding 和 graph 暂未实现，因此当前分数偏重 lexical、scenario、confidence 和 source authority。
 */
function scoreRow(row: MemoryRow, request: MemoryQueryRequest, relationScore: number): Omit<RankedMemory, "document"> {
  const scenarios = parseJsonArray(row.scenario);
  const scenarioScore = request.scenarios.length > 0 && intersects(scenarios, request.scenarios) ? 1 : 0.3;
  const lexicalScore = Math.max(0, Math.min(1, 1 - Math.abs(row.rank_score ?? 0) / 20));
  const confidenceScore = row.confidence;
  const sourceAuthorityScore = AUTHORITY_SCORE[row.source_authority] ?? 0.4;
  const finalScore =
    0.3 * lexicalScore +
    0.15 * scenarioScore +
    0.1 * confidenceScore +
    0.1 * sourceAuthorityScore +
    0.05 * relationScore;

  return {
    lexicalScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore,
    finalScore
  };
}

/**
 * 先跑 FTS；如果没有命中则回退到全表 metadata 过滤。
 *
 * 回退是为了支持用户只传 domain/scenario、不传有效关键词的情况。
 */
function selectCandidateRows(rootDir: string, request: MemoryQueryRequest): MemoryRow[] {
  const db = new DatabaseSync(getIndexDbPath(rootDir), { readOnly: true });
  const query = toFtsQuery(tokenize([request.task, ...request.domains, ...request.scenarios, ...request.paths].join(" ")));

  try {
    if (query.length === 0) {
      return db.prepare("SELECT memories.*, 0 AS rank_score FROM memories").all() as MemoryRow[];
    }

    const ftsRows = db
      .prepare(
        `SELECT memories.*, bm25(memory_fts) AS rank_score
         FROM memory_fts JOIN memories ON memory_fts.id = memories.id
         WHERE memory_fts MATCH ?`
      )
      .all(query) as MemoryRow[];

    if (ftsRows.length > 0) {
      return ftsRows;
    }

    return db.prepare("SELECT memories.*, 0 AS rank_score FROM memories").all() as MemoryRow[];
  } finally {
    db.close();
  }
}

/**
 * 按 ID 查询一跳关联知识。
 */
function selectRowsByIds(rootDir: string, ids: string[]): MemoryRow[] {
  if (ids.length === 0) {
    return [];
  }

  const db = new DatabaseSync(getIndexDbPath(rootDir), { readOnly: true });
  try {
    return db
      .prepare(`SELECT memories.*, 0 AS rank_score FROM memories WHERE id IN (${ids.map(() => "?").join(",")})`)
      .all(...ids) as MemoryRow[];
  } finally {
    db.close();
  }
}

/**
 * 查询入口：返回已排序的知识文档。
 *
 * 调用方通常不直接使用这些结果，而是交给 `buildContextPacket` 分区组装。
 */
export function queryMemories(rootDir: string, rawRequest: unknown): RankedMemory[] {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const directRows = selectCandidateRows(rootDir, request).filter((row) => rowMatchesRequest(row, request));
  const directIds = new Set(directRows.map((row) => row.id));
  const relatedIds = new Set<string>();

  for (const row of directRows) {
    const document = loadDocument(rootDir, row.file_path);
    for (const relation of document.frontmatter.related_knowledge) {
      if (RELATION_EXPANSION.has(relation.relation)) {
        relatedIds.add(relation.id);
      }
    }
  }

  const relatedRows = selectRowsByIds(rootDir, [...relatedIds]).filter(
    (row) =>
      row.status === "active" &&
      !directIds.has(row.id) &&
      request.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number])
  );

  return [...directRows.map((row) => ({ row, relationScore: 0 })), ...relatedRows.map((row) => ({ row, relationScore: 1 }))]
    .map(({ row, relationScore }) => ({
      document: loadDocument(rootDir, row.file_path),
      ...scoreRow(row, request, relationScore)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}
