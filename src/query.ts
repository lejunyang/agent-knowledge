/**
 * query 模块负责把当前任务映射到相关知识。
 *
 * 检索策略故意采用“metadata 硬过滤 + FTS/BM25 + 一跳关系扩展”：
 * - 硬过滤减少“语义相似但业务无关”的结果。
 * - FTS/BM25 擅长路径、术语、错误码、API 名称。
 * - 一跳关系扩展补充 depends_on / often_used_with 等强相关知识。
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { MemoryQueryRequestSchema } from "./schema.js";
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory, SourceAuthority } from "./types.js";
import { getIndexDbPath } from "./indexer.js";
import { appendJsonlLog } from "./logging.js";
import { readEmbeddingRecords, type EmbeddingProvider } from "./embeddings.js";
import {
  AUTHORITY_SCORE,
  defaultEmbeddingScorer,
  defaultMemoryReranker,
  type EmbeddingScorer,
  type MemoryReranker,
  type ScoreFeatures
} from "./scoring.js";

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
  tags: string;
  summary: string;
  body: string;
  rank_score?: number;
};

export type QueryDebugInfo = {
  queryRunId: string;
  tokens: string[];
  ftsQuery: string;
  ftsCandidateCount: number;
  fallbackUsed: boolean;
  fallbackReason: "empty_fts_query" | "no_fts_matches" | null;
  fallbackSuppressedReason: "missing_domain_or_scenario" | null;
  retrievalMode: "lexical" | "hybrid";
  embeddingRecordCount: number;
  embeddingCandidateIds: string[];
  candidateRowCount: number;
  directMatchCount: number;
  relatedCandidateIds: string[];
  relatedMatchCount: number;
  resultIds: string[];
  scoring: {
    embeddingScorer: string;
    reranker: string;
  };
  resultScores: Array<{
    id: string;
    lexicalScore: number;
    embeddingScore: number;
    scenarioScore: number;
    confidenceScore: number;
    sourceAuthorityScore: number;
    relationScore: number;
    finalScore: number;
  }>;
};

export type QueryMemoriesDebugResult = {
  ranked: RankedMemory[];
  debug: QueryDebugInfo;
};

export type QueryScoringOptions = {
  embeddingScorer?: EmbeddingScorer;
  reranker?: MemoryReranker;
};

export type QueryHybridOptions = QueryScoringOptions & {
  embeddingProvider: EmbeddingProvider;
  embeddingTopK?: number;
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

function domainLabelMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeLabel(left);
  const normalizedRight = normalizeLabel(right);

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

function fuzzyIntersects(left: string[], right: string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => fuzzyLabelMatches(leftItem, rightItem)));
}

function domainIntersects(left: string[], right: string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => domainLabelMatches(leftItem, rightItem)));
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * aliases 是人类常用别名，不替代 domain/scenario；查询时用它把输入别名扩展成规范元数据。
 */
function expandRequestWithAliases(request: MemoryQueryRequest, rows: MemoryRow[]): MemoryQueryRequest {
  const domains = new Set(request.domains);
  const scenarios = new Set(request.scenarios);

  for (const row of rows) {
    const rowAliases = parseJsonArray(row.aliases);
    const rowDomains = [row.domain, ...parseJsonArray(row.related_domains)];
    const rowScenarios = parseJsonArray(row.scenario);
    const rowTerms = [...rowDomains, ...rowScenarios, ...rowAliases];

    const domainMatched =
      request.domains.length > 0 &&
      request.domains.some(
        (domain) =>
          rowDomains.some((term) => domainLabelMatches(term, domain)) ||
          rowAliases.some((alias) => fuzzyLabelMatches(alias, domain))
      );
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
  const domainPool = [row.domain, ...relatedDomains];
  const scenarioPool = [...scenarios, ...aliases];
  const domainOk =
    request.domains.length === 0 ||
    domainIntersects(domainPool, request.domains) ||
    fuzzyIntersects(aliases, request.domains);
  const scenarioOk = request.scenarios.length === 0 || fuzzyIntersects(scenarioPool, request.scenarios);
  const typeOk = request.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number]);

  return row.status === "active" && domainOk && scenarioOk && typeOk;
}

/**
 * 生成默认重排器所需的分项特征。
 *
 * embeddingScore 由可插拔 scorer 给出；默认 scorer 是本地 deterministic 词项向量，
 * 不依赖任何外部 API。
 */
function scoreRow(
  row: MemoryRow,
  document: KnowledgeDocument,
  request: MemoryQueryRequest,
  relationScore: number,
  embeddingScorer: EmbeddingScorer,
  reranker: MemoryReranker
): Omit<RankedMemory, "document"> {
  const scenarios = parseJsonArray(row.scenario);
  const scenarioScore = request.scenarios.length > 0 && fuzzyIntersects(scenarios, request.scenarios) ? 1 : 0.3;
  const lexicalScore = Math.max(0, Math.min(1, 1 - Math.abs(row.rank_score ?? 0) / 20));
  const confidenceScore = row.confidence;
  const sourceAuthorityScore = AUTHORITY_SCORE[row.source_authority] ?? 0.4;
  const embeddingScore = Math.max(0, Math.min(1, embeddingScorer.score({ request, document })));
  const features: ScoreFeatures = {
    lexicalScore,
    embeddingScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore
  };
  const finalScore = Math.max(0, Math.min(1, reranker.rerank({ request, document, features })));

  return {
    lexicalScore,
    embeddingScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore,
    finalScore
  };
}

type CandidateSelection = {
  rows: MemoryRow[];
  debug: Omit<
    QueryDebugInfo,
    | "queryRunId"
    | "directMatchCount"
    | "relatedCandidateIds"
    | "relatedMatchCount"
    | "resultIds"
    | "scoring"
    | "resultScores"
  >;
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
    retrievalMode: "lexical",
    embeddingRecordCount: 0,
    embeddingCandidateIds: [],
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

async function selectEmbeddingRows(
  rootDir: string,
  request: MemoryQueryRequest,
  provider: EmbeddingProvider,
  topK: number
): Promise<{ rows: MemoryRow[]; ids: string[]; recordCount: number }> {
  const records = readEmbeddingRecords(rootDir);
  if (records.length === 0 || topK <= 0) {
    return { rows: [], ids: [], recordCount: records.length };
  }

  const queryText = [request.task, ...request.domains, ...request.scenarios, ...request.paths].join("\n");
  const [queryVector] = await provider.embed([queryText]);
  if (!queryVector || queryVector.length === 0) {
    return { rows: [], ids: [], recordCount: records.length };
  }

  const ids = records
    .map((record) => ({ id: record.id, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
    .map((item) => item.id);

  return { rows: selectRowsByIds(rootDir, ids), ids, recordCount: records.length };
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

function rankSelectedRows(
  rootDir: string,
  request: MemoryQueryRequest,
  selection: CandidateSelection,
  scoringOptions: QueryScoringOptions = {}
): QueryMemoriesDebugResult {
  const queryRunId = randomUUID();
  const embeddingScorer = scoringOptions.embeddingScorer ?? defaultEmbeddingScorer;
  const reranker = scoringOptions.reranker ?? defaultMemoryReranker;
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
    .map(({ row, relationScore }) => {
      const document = loadDocument(rootDir, row.file_path);
      return {
        document,
        ...scoreRow(row, document, expandedRequest, relationScore, embeddingScorer, reranker)
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
  const debug: QueryDebugInfo = {
    ...selection.debug,
    queryRunId,
    directMatchCount: directRows.length,
    relatedCandidateIds,
    relatedMatchCount: relatedRows.length,
    resultIds: ranked.map((item) => item.document.frontmatter.id),
    scoring: {
      embeddingScorer: embeddingScorer.name,
      reranker: reranker.name
    },
    resultScores: ranked.map((item) => ({
      id: item.document.frontmatter.id,
      lexicalScore: item.lexicalScore,
      embeddingScore: item.embeddingScore,
      scenarioScore: item.scenarioScore,
      confidenceScore: item.confidenceScore,
      sourceAuthorityScore: item.sourceAuthorityScore,
      relationScore: item.relationScore,
      finalScore: item.finalScore
    }))
  };

  return { ranked, debug };
}

/**
 * 查询入口：返回已排序的知识文档。
 *
 * 调用方通常不直接使用这些结果，而是交给 `buildContextPacket` 分区组装。
 */
export function queryMemoriesWithDebug(
  rootDir: string,
  rawRequest: unknown,
  scoringOptions: QueryScoringOptions = {}
): QueryMemoriesDebugResult {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const selection = selectCandidateRows(rootDir, request);
  const result = rankSelectedRows(rootDir, request, selection, scoringOptions);

  appendJsonlLog(rootDir, {
    event: "query",
    queryRunId: result.debug.queryRunId,
    taskLength: request.task.length,
    domains: request.domains,
    scenarios: request.scenarios,
    debug: result.debug
  });

  return result;
}

export async function queryMemoriesHybridWithDebug(
  rootDir: string,
  rawRequest: unknown,
  options: QueryHybridOptions
): Promise<QueryMemoriesDebugResult> {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const lexicalSelection = selectCandidateRows(rootDir, request);
  const embeddingSelection = await selectEmbeddingRows(rootDir, request, options.embeddingProvider, options.embeddingTopK ?? 20);
  const rowsById = new Map<string, MemoryRow>();

  for (const row of lexicalSelection.rows) {
    rowsById.set(row.id, row);
  }
  for (const row of embeddingSelection.rows) {
    rowsById.set(row.id, rowsById.get(row.id) ?? { ...row, rank_score: 0 });
  }

  const embeddingCandidateIds = embeddingSelection.ids;
  const selection: CandidateSelection = {
    rows: [...rowsById.values()],
    debug: {
      ...lexicalSelection.debug,
      retrievalMode: "hybrid",
      embeddingRecordCount: embeddingSelection.recordCount,
      embeddingCandidateIds,
      candidateRowCount: rowsById.size
    }
  };
  const result = rankSelectedRows(rootDir, request, selection, options);

  appendJsonlLog(rootDir, {
    event: "query",
    queryRunId: result.debug.queryRunId,
    taskLength: MemoryQueryRequestSchema.parse(rawRequest).task.length,
    domains: MemoryQueryRequestSchema.parse(rawRequest).domains,
    scenarios: MemoryQueryRequestSchema.parse(rawRequest).scenarios,
    debug: result.debug
  });

  return result;
}

export function queryMemories(rootDir: string, rawRequest: unknown, scoringOptions: QueryScoringOptions = {}): RankedMemory[] {
  return queryMemoriesWithDebug(rootDir, rawRequest, scoringOptions).ranked;
}
