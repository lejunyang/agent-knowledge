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
import { appendJsonlLog } from "./logging.js";

const require = createRequire(import.meta.url);
// 与 indexer 保持一致，使用 Node 内置 sqlite 读取 FTS5 索引。
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

type MemoryRow = {
  id: string;
  file_path: string;
  type: string;
  title: string;
  aliases: string;
  domain: string;
  related_domains: string;
  scenario: string;
  status: string;
  confidence: number;
  source_authority: SourceAuthority;
  rank_score?: number;
};

export type QueryDebugInfo = {
  tokens: string[];
  ftsQuery: string;
  ftsCandidateCount: number;
  fallbackUsed: boolean;
  fallbackReason: "empty_fts_query" | "no_fts_matches" | null;
  fallbackSuppressedReason: "missing_domain_or_scenario" | null;
  candidateRowCount: number;
  directMatchCount: number;
  relatedCandidateIds: string[];
  relatedMatchCount: number;
  resultIds: string[];
};

export type QueryMemoriesDebugResult = {
  ranked: RankedMemory[];
  debug: QueryDebugInfo;
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

function normalizeLabel(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
}

function labelSegments(input: string): string[] {
  return normalizeLabel(input)
    .split(/[/-]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function fuzzyLabelMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeLabel(left);
  const normalizedRight = normalizeLabel(right);

  if (normalizedLeft === normalizedRight) {
    return true;
  }

  if (normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`)) {
    return true;
  }

  const leftSegments = labelSegments(left);
  const rightSegments = labelSegments(right);
  if (leftSegments.length === 0 || rightSegments.length === 0) {
    return false;
  }

  const [shorter, longer] =
    leftSegments.length <= rightSegments.length ? [leftSegments, rightSegments] : [rightSegments, leftSegments];
  return shorter.every((segment) => longer.includes(segment));
}

function fuzzyIntersects(left: string[], right: string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => fuzzyLabelMatches(leftItem, rightItem)));
}

/**
 * aliases 是人类常用别名，不替代 domain/scenario；查询时用它把输入别名扩展成规范元数据。
 */
function expandRequestWithAliases(request: MemoryQueryRequest, rows: MemoryRow[]): MemoryQueryRequest {
  const domains = new Set(request.domains);
  const scenarios = new Set(request.scenarios);

  for (const row of rows) {
    const rowAliases = parseJsonArray(row.aliases);
    const rowScenarios = parseJsonArray(row.scenario);
    const rowTerms = [row.domain, ...parseJsonArray(row.related_domains), ...rowScenarios, ...rowAliases];

    const domainMatched =
      request.domains.length > 0 && request.domains.some((domain) => rowTerms.some((term) => fuzzyLabelMatches(term, domain)));
    const scenarioMatched =
      request.scenarios.length > 0 &&
      request.scenarios.some((scenario) => rowTerms.some((term) => fuzzyLabelMatches(term, scenario)));

    if (domainMatched) {
      domains.add(row.domain);
    }

    if (scenarioMatched) {
      for (const scenario of rowScenarios) {
        scenarios.add(scenario);
      }
    }
  }

  return {
    ...request,
    domains: [...domains],
    scenarios: [...scenarios]
  };
}

/**
 * metadata 硬过滤。
 *
 * 这一步先于排序，确保非 active、领域不匹配、场景不匹配或类型不允许的知识不会注入。
 */
function rowMatchesRequest(row: MemoryRow, request: MemoryQueryRequest): boolean {
  const relatedDomains = parseJsonArray(row.related_domains);
  const scenarios = parseJsonArray(row.scenario);
  const aliases = parseJsonArray(row.aliases);
  const domainPool = [row.domain, ...relatedDomains, ...aliases];
  const scenarioPool = [...scenarios, ...aliases];
  const domainOk = request.domains.length === 0 || fuzzyIntersects(domainPool, request.domains);
  const scenarioOk = request.scenarios.length === 0 || fuzzyIntersects(scenarioPool, request.scenarios);
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
  const scenarioScore = request.scenarios.length > 0 && fuzzyIntersects(scenarios, request.scenarios) ? 1 : 0.3;
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

type CandidateSelection = {
  rows: MemoryRow[];
  debug: Omit<QueryDebugInfo, "directMatchCount" | "relatedCandidateIds" | "relatedMatchCount" | "resultIds">;
};

/**
 * 先跑 FTS；只有带 domain/scenario 约束时才允许回退到全表 metadata 过滤。
 *
 * 这保留了“只传 domain/scenario 也能召回”的能力，同时避免无约束查询扫出整库。
 */
function selectCandidateRows(rootDir: string, request: MemoryQueryRequest): CandidateSelection {
  const db = new DatabaseSync(getIndexDbPath(rootDir), { readOnly: true });
  const tokens = tokenize([request.task, ...request.domains, ...request.scenarios, ...request.paths].join(" "));
  const query = toFtsQuery(tokens);
  const canFallbackToMetadata = request.domains.length > 0 || request.scenarios.length > 0;
  const baseDebug = {
    tokens,
    ftsQuery: query,
    ftsCandidateCount: 0,
    fallbackUsed: false,
    fallbackReason: null,
    fallbackSuppressedReason: null,
    candidateRowCount: 0
  } satisfies CandidateSelection["debug"];

  try {
    if (query.length === 0) {
      if (!canFallbackToMetadata) {
        return {
          rows: [],
          debug: {
            ...baseDebug,
            fallbackReason: "empty_fts_query",
            fallbackSuppressedReason: "missing_domain_or_scenario"
          }
        };
      }

      const rows = db.prepare("SELECT memories.*, 0 AS rank_score FROM memories").all() as MemoryRow[];
      return {
        rows,
        debug: { ...baseDebug, fallbackUsed: true, fallbackReason: "empty_fts_query", candidateRowCount: rows.length }
      };
    }

    const ftsRows = db
      .prepare(
        `SELECT memories.*, bm25(memory_fts) AS rank_score
         FROM memory_fts JOIN memories ON memory_fts.id = memories.id
         WHERE memory_fts MATCH ?`
      )
      .all(query) as MemoryRow[];

    if (ftsRows.length > 0) {
      return {
        rows: ftsRows,
        debug: {
          ...baseDebug,
          ftsCandidateCount: ftsRows.length,
          candidateRowCount: ftsRows.length
        }
      };
    }

    if (!canFallbackToMetadata) {
      return {
        rows: [],
        debug: {
          ...baseDebug,
          fallbackReason: "no_fts_matches",
          fallbackSuppressedReason: "missing_domain_or_scenario"
        }
      };
    }

    const rows = db.prepare("SELECT memories.*, 0 AS rank_score FROM memories").all() as MemoryRow[];
    return {
      rows,
      debug: {
        ...baseDebug,
        fallbackUsed: true,
        fallbackReason: "no_fts_matches",
        candidateRowCount: rows.length
      }
    };
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
export function queryMemoriesWithDebug(rootDir: string, rawRequest: unknown): QueryMemoriesDebugResult {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const selection = selectCandidateRows(rootDir, request);
  const expandedRequest = expandRequestWithAliases(request, selection.rows);
  const directRows = selection.rows.filter((row) => rowMatchesRequest(row, expandedRequest));
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

  const relatedCandidateIds = [...relatedIds].sort();
  const relatedRows = selectRowsByIds(rootDir, relatedCandidateIds).filter(
    (row) =>
      row.status === "active" &&
      !directIds.has(row.id) &&
      expandedRequest.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number])
  );

  const ranked = [...directRows.map((row) => ({ row, relationScore: 0 })), ...relatedRows.map((row) => ({ row, relationScore: 1 }))]
    .map(({ row, relationScore }) => ({
      document: loadDocument(rootDir, row.file_path),
      ...scoreRow(row, expandedRequest, relationScore)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
  const debug: QueryDebugInfo = {
    ...selection.debug,
    directMatchCount: directRows.length,
    relatedCandidateIds,
    relatedMatchCount: relatedRows.length,
    resultIds: ranked.map((item) => item.document.frontmatter.id)
  };

  appendJsonlLog(rootDir, {
    event: "query",
    taskLength: request.task.length,
    domains: expandedRequest.domains,
    scenarios: expandedRequest.scenarios,
    debug
  });

  return { ranked, debug };
}

export function queryMemories(rootDir: string, rawRequest: unknown): RankedMemory[] {
  return queryMemoriesWithDebug(rootDir, rawRequest).ranked;
}
