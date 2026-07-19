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
import { parseKnowledgeMarkdown } from "../storage/markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { MemoryQueryRequestSchema } from "../core/schema.js";
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory, SourceAuthority } from "../core/types.js";
import { getIndexDbPath } from "../storage/indexer.js";
import { appendJsonlLog } from "../core/logging.js";
import {
  assertEmbeddingProviderCompatible,
  readEmbeddingRecords,
  type EmbeddingProvider
} from "./embeddings.js";
import { cjkNgrams } from "./cjk.js";
import {
  AUTHORITY_SCORE,
  defaultEmbeddingScorer,
  defaultMemoryReranker,
  type EmbeddingScorer,
  type MemoryReranker,
  type ScoreFeatures
} from "./scoring.js";
import {
  applyBatchRerank,
  type BatchCandidateReranker
} from "./reranker.js";

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
  visibility: string;
  sensitivity: string;
  project_ids: string;
  valid_from: string;
  valid_until: string | null;
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
  retrievalMode: "lexical" | "hybrid" | "graph" | "hybrid-graph";
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
  batchReranker?: {
    name: string;
    candidateLimit: number;
    resultLimit: number;
    minScore: number;
  };
  graphExpansion?: Array<{
    id: string;
    depth: number;
    graphScore: number;
    relation: string;
  }>;
  resultScores: Array<{
    id: string;
    lexicalScore: number;
    embeddingScore: number;
    scenarioScore: number;
    confidenceScore: number;
    sourceAuthorityScore: number;
    relationScore: number;
    rrfScore: number;
    rerankerScore?: number;
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

export type QueryBatchRerankOptions = QueryScoringOptions & {
  baseResult?: QueryMemoriesDebugResult;
  batchReranker: BatchCandidateReranker;
  candidateLimit?: number;
  resultLimit?: number;
  minScore?: number;
  baseWeight?: number;
  rerankerWeight?: number;
};

// 只有这些关系允许自动扩展。冲突和替代关系只应进入 warnings，不能当作普通上下文注入。
const RELATION_EXPANSION = new Set(["depends_on", "refines", "supports", "often_used_with"]);

/**
 * 将自然语言任务切成 FTS 查询 token。
 *
 * 这里保留 `/` 和 `-`，因为领域名和场景名经常包含这些字符，例如 `frontend/lint`。
 */
function tokenize(input: string): string[] {
  const nonCjkTokens = input
    .toLowerCase()
    .replace(/\p{Script=Han}+/gu, " ")
    .split(/[^\p{L}\p{N}_/-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return [...new Set([...nonCjkTokens, ...cjkNgrams(input)])].slice(0, 48);
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

/** 从索引记录的相对路径重新读取 Markdown，保证最终内容始终来自事实源。 */
function loadDocument(rootDir: string, filePath: string): KnowledgeDocument {
  return parseKnowledgeMarkdown(filePath, readFileSync(resolveWorkspacePath(rootDir, filePath), "utf8"));
}

/** 统一 domain/scenario/alias 标签中的大小写、空格和下划线差异。 */
function normalizeLabel(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/-+/g, "-");
}

/** 把层级标签拆成路径片段，供非 domain 的模糊场景匹配使用。 */
function labelSegments(input: string): string[] {
  return normalizeLabel(input)
    .split(/[/-]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 比较场景/别名标签，允许层级包含或片段集合匹配。
 * Domain 不使用该宽松策略，避免无关领域因共享一个短片段被放行。
 */
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

/** Domain 只允许相等或明确的父子层级关系，保持硬过滤边界。 */
function domainLabelMatches(left: string, right: string): boolean {
  const normalizedLeft = normalizeLabel(left);
  const normalizedRight = normalizeLabel(right);

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

/** 判断两组场景/别名是否存在宽松匹配。 */
function fuzzyIntersects(left: string[], right: string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => fuzzyLabelMatches(leftItem, rightItem)));
}

/** 判断两组 domain 是否存在严格层级匹配。 */
function domainIntersects(left: string[], right: string[]): boolean {
  return left.some((leftItem) => right.some((rightItem) => domainLabelMatches(leftItem, rightItem)));
}

/** 给 metadata exact-match 通道计算离散分数，随后仅用于生成 rank。 */
function metadataMatchScore(row: MemoryRow, request: MemoryQueryRequest): number {
  const domains = [row.domain, ...parseJsonArray(row.related_domains)];
  const scenarios = parseJsonArray(row.scenario);
  const aliases = parseJsonArray(row.aliases);
  let score = 0;

  if (
    request.domains.some((requested) =>
      domains.some((domain) => normalizeLabel(domain) === normalizeLabel(requested))
    )
  ) {
    score += 2;
  }
  if (request.scenarios.length > 0 && fuzzyIntersects(scenarios, request.scenarios)) {
    score += 2;
  }
  if (hasExactAliasInTask(aliases, request.task)) {
    score += 1;
  }
  return score;
}

const SENSITIVITY_LEVEL = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3
} as const;

/**
 * 执行所有不可由排序绕过的访问控制。
 *
 * 该函数被 direct、related 和 graph 扩展共同复用，保证关系边只能发现候选，不能授予权限。
 */
function rowIsAccessible(row: MemoryRow, request: MemoryQueryRequest): boolean {
  const projectIds = parseJsonArray(row.project_ids);
  const visibilityOk = request.visibilityScopes.includes(
    row.visibility as MemoryQueryRequest["visibilityScopes"][number]
  );
  const sensitivityOk =
    (SENSITIVITY_LEVEL[row.sensitivity as keyof typeof SENSITIVITY_LEVEL] ?? Number.POSITIVE_INFINITY) <=
    SENSITIVITY_LEVEL[request.sensitivityClearance];
  const validFromOk = row.valid_from <= request.now;
  const validUntilOk = row.valid_until === null || row.valid_until >= request.now;
  const projectOk =
    row.visibility !== "project" ||
    projectIds.length === 0 ||
    projectIds.some((projectId) => request.projectIds.includes(projectId));

  return row.status === "active" && visibilityOk && sensitivityOk && validFromOk && validUntilOk && projectOk;
}

/** 计算等维向量 cosine；零向量返回 0，避免 NaN 进入排序。 */
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

  return rowIsAccessible(row, request) && domainOk && scenarioOk && typeOk;
}

/** 检查任务文本是否直接包含完整 alias，用于提高 metadata rank 而不是绕过 domain 过滤。 */
function hasExactAliasInTask(aliases: string[], task: string): boolean {
  const normalizedTask = task.toLowerCase();
  return aliases.some((alias) => alias.trim().length > 0 && normalizedTask.includes(alias.toLowerCase()));
}

/**
 * 过滤只有 CJK n-gram 偶然重合、但缺少 metadata 或完整词项证据的 FTS 候选。
 * 这道门控用于降低短中文片段造成的误召回。
 */
function hasSufficientLexicalEvidence(
  row: MemoryRow,
  request: MemoryQueryRequest,
  taskTokens: string[]
): boolean {
  if (request.domains.length > 0 || request.scenarios.length > 0 || taskTokens.length <= 4) {
    return true;
  }
  if (hasExactAliasInTask(parseJsonArray(row.aliases), request.task)) {
    return true;
  }
  const haystack = [
    row.title,
    ...parseJsonArray(row.aliases),
    row.domain,
    ...parseJsonArray(row.related_domains),
    ...parseJsonArray(row.scenario),
    ...parseJsonArray(row.tags),
    row.summary,
    row.body
  ]
    .join("\n")
    .toLowerCase();
  const matchedTerms = taskTokens.filter((token) => haystack.includes(token));
  return new Set(matchedTerms).size >= 2;
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
  normalizedLexicalScore: number,
  relationScore: number,
  denseScore: number | undefined,
  rrfScore: number,
  embeddingScorer: EmbeddingScorer,
  reranker: MemoryReranker
): Omit<RankedMemory, "document"> {
  const scenarios = parseJsonArray(row.scenario);
  const aliases = parseJsonArray(row.aliases);
  const scenarioScore = request.scenarios.length > 0 && fuzzyIntersects(scenarios, request.scenarios) ? 1 : 0.3;
  const lexicalScore = Math.max(
    hasExactAliasInTask(aliases, request.task) ? 1 : 0,
    normalizedLexicalScore
  );
  const confidenceScore = row.confidence;
  const sourceAuthorityScore = AUTHORITY_SCORE[row.source_authority] ?? 0.4;
  const embeddingScore = Math.max(
    0,
    Math.min(1, denseScore ?? embeddingScorer.score({ request, document }))
  );
  const features: ScoreFeatures = {
    lexicalScore,
    embeddingScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore,
    rrfScore
  };
  const finalScore = Math.max(0, Math.min(1, reranker.rerank({ request, document, features })));

  return {
    lexicalScore,
    embeddingScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore,
    rrfScore,
    finalScore
  };
}

type CandidateSelection = {
  rows: MemoryRow[];
  lexicalRanks: Map<string, number>;
  lexicalScores: Map<string, number>;
  denseRanks: Map<string, number>;
  denseScores: Map<string, number>;
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

/** 把有序候选转换成从 1 开始的 rank map，供跨通道 RRF 使用。 */
function rankMap(rows: MemoryRow[]): Map<string, number> {
  return new Map(rows.map((row, index) => [row.id, index + 1]));
}

/**
 * 把当前查询内的 BM25 分数归一化到 0-1。
 *
 * SQLite FTS5 的 BM25 越小越相关，且绝对值会随 query token 数和语料变化，不能用固定常数缩放。
 * 这里先按 BM25 升序，再用最相关候选的 relevance 作为分母；关系或 dense-only 候选不在该 map 中，
 * 因而不会获得虚假的 lexical 分数。
 */
function normalizedLexicalScores(rows: MemoryRow[]): Map<string, number> {
  if (rows.length === 0) {
    return new Map();
  }
  const relevance = rows.map((row) => ({
    id: row.id,
    value: Math.max(0, -(row.rank_score ?? 0))
  }));
  const best = Math.max(...relevance.map((item) => item.value));
  if (best <= 0) {
    return new Map();
  }
  return new Map(
    relevance.map((item) => [item.id, Math.max(0, Math.min(1, item.value / best))])
  );
}

/**
 * 先跑 FTS；只有带 domain/scenario 约束时才允许回退到全表 metadata 过滤。
 *
 * 这保留了“只传 domain/scenario 也能召回”的能力，同时避免无约束查询扫出整库。
 */
function selectCandidateRows(rootDir: string, request: MemoryQueryRequest): CandidateSelection {
  const db = new DatabaseSync(getIndexDbPath(rootDir), { readOnly: true });
  const taskTokens = tokenize(request.task);
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
      // 没有 query token 且没有 metadata 约束时禁止全表扫描，否则任意短 prompt 都会注入整库。
      if (!canFallbackToMetadata) {
        return {
          rows: [],
          lexicalRanks: new Map(),
          lexicalScores: new Map(),
          denseRanks: new Map(),
          denseScores: new Map(),
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
        lexicalRanks: new Map(),
        lexicalScores: new Map(),
        denseRanks: new Map(),
        denseScores: new Map(),
        debug: { ...baseDebug, fallbackUsed: true, fallbackReason: "empty_fts_query", candidateRowCount: rows.length }
      };
    }

    const rawFtsRows = db
      .prepare(
        `SELECT memories.*, bm25(memory_fts) AS rank_score
         FROM memory_fts JOIN memories ON memory_fts.id = memories.id
         WHERE memory_fts MATCH ?`
      )
      .all(query) as MemoryRow[];
    const ftsRows = rawFtsRows.filter((row) => hasSufficientLexicalEvidence(row, request, taskTokens));

    if (ftsRows.length > 0) {
      // FTS5 不保证未写 ORDER BY 时的返回顺序，必须显式按 BM25 升序生成 lexical rank。
      const rankedFtsRows = [...ftsRows].sort(
        (left, right) =>
          (left.rank_score ?? 0) - (right.rank_score ?? 0) ||
          left.id.localeCompare(right.id)
      );
      return {
        rows: rankedFtsRows,
        lexicalRanks: rankMap(rankedFtsRows),
        lexicalScores: normalizedLexicalScores(rankedFtsRows),
        denseRanks: new Map(),
        denseScores: new Map(),
        debug: {
          ...baseDebug,
          ftsCandidateCount: rawFtsRows.length,
          candidateRowCount: ftsRows.length
        }
      };
    }

    if (!canFallbackToMetadata) {
      // FTS 无命中时仍坚持 abstain；只有显式 domain/scenario 才能把全表作为 metadata 候选池。
      return {
        rows: [],
        lexicalRanks: new Map(),
        lexicalScores: new Map(),
        denseRanks: new Map(),
        denseScores: new Map(),
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
      lexicalRanks: new Map(),
      lexicalScores: new Map(),
      denseRanks: new Map(),
      denseScores: new Map(),
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
 * 从兼容 embedding 缓存中选择 dense topK，并保留真实 cosine 分数。
 * Manifest 和每条记录的维度都会校验，防止混用不同向量空间。
 */
async function selectEmbeddingRows(
  rootDir: string,
  request: MemoryQueryRequest,
  provider: EmbeddingProvider,
  topK: number
): Promise<{ rows: MemoryRow[]; ids: string[]; recordCount: number; scores: Map<string, number> }> {
  const records = readEmbeddingRecords(rootDir);
  if (records.length === 0 || topK <= 0) {
    return { rows: [], ids: [], recordCount: records.length, scores: new Map() };
  }

  const manifest = assertEmbeddingProviderCompatible(rootDir, provider);
  const queryText = [request.task, ...request.domains, ...request.scenarios, ...request.paths].join("\n");
  const [queryVector] = await provider.embed([queryText], "query");
  if (!queryVector || queryVector.length === 0) {
    return { rows: [], ids: [], recordCount: records.length, scores: new Map() };
  }
  if (queryVector.length !== manifest.profile.dimensions) {
    throw new Error(
      `Embedding query dimension mismatch: manifest=${manifest.profile.dimensions}, query=${queryVector.length}`
    );
  }
  for (const record of records) {
    if (
      record.dimensions !== manifest.profile.dimensions ||
      record.vector.length !== manifest.profile.dimensions
    ) {
      throw new Error(`Embedding cache record dimension mismatch: ${record.id}`);
    }
  }

  const scored = records
    .map((record) => ({ id: record.id, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);
  const ids = scored.map((item) => item.id);

  return {
    rows: selectRowsByIds(rootDir, ids),
    ids,
    recordCount: records.length,
    scores: new Map(scored.map((item) => [item.id, item.score]))
  };
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
 * 对统一候选集执行访问过滤、受控一跳关系扩展、RRF 和最终 feature rerank。
 * Query run ID 与完整分项分数在这里生成，保证所有检索模式共享一致 debug 契约。
 */
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
      // 显式关系允许跨 domain/scenario，但绝不能绕过访问控制或 includeTypes。
      rowIsAccessible(row, expandedRequest) &&
      !directIds.has(row.id) &&
      expandedRequest.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number])
  );

  const metadataRanks = new Map(
    directRows
      .map((row) => ({ row, score: metadataMatchScore(row, expandedRequest) }))
      // 0 分表示没有 metadata 证据，不能仅因进入候选池就获得 RRF 通道排名。
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.row.id.localeCompare(right.row.id)
      )
      .map((item, index) => [item.row.id, index + 1])
  );
  const rrfFor = (id: string): number => {
    const ranks = [
      selection.lexicalRanks.get(id),
      selection.denseRanks.get(id),
      metadataRanks.get(id)
    ].filter((rank): rank is number => rank !== undefined);
    if (ranks.length === 0) {
      return 0;
    }
    // 常数 60 降低单个通道第一名的支配力；按三个可能通道的理论最大值归一化到 0-1。
    return Math.min(1, ranks.reduce((sum, rank) => sum + 1 / (60 + rank), 0) / (3 / 61));
  };
  const ranked = [
    ...directRows.map((row) => ({ row, relationScore: 0 })),
    ...relatedRows.map((row) => ({ row, relationScore: 1 }))
  ]
    .map(({ row, relationScore }) => {
      const document = loadDocument(rootDir, row.file_path);
      return {
        document,
        ...scoreRow(
          row,
          document,
          expandedRequest,
          selection.lexicalScores.get(row.id) ?? 0,
          relationScore,
          selection.denseScores.get(row.id),
          rrfFor(row.id),
          embeddingScorer,
          reranker
        )
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
      rrfScore: item.rrfScore,
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

/**
 * 融合 lexical、真实 dense embedding 和 metadata rank，并返回完整 debug。
 * Dense 只补候选和分数，最终仍复用统一访问过滤与排序边界。
 */
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
    lexicalRanks: lexicalSelection.lexicalRanks,
    lexicalScores: lexicalSelection.lexicalScores,
    denseRanks: new Map(embeddingCandidateIds.map((id, index) => [id, index + 1])),
    denseScores: embeddingSelection.scores,
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

/** 提供不含 debug envelope 的同步 lexical 查询便利入口。 */
export function queryMemories(rootDir: string, rawRequest: unknown, scoringOptions: QueryScoringOptions = {}): RankedMemory[] {
  return queryMemoriesWithDebug(rootDir, rawRequest, scoringOptions).ranked;
}

/**
 * 让 graph 选中的 memory ID 重新通过与直接检索相同的 metadata 和安全策略。
 *
 * Graph traversal 只能发现 ID，不能授予访问权。这里刻意重跑 validity、visibility、sensitivity、
 * project 和 include-type；不重复 domain/scenario，因为显式可信关系允许跨越直接查询过滤。
 */
export function loadAccessibleMemoriesByIds(
  rootDir: string,
  rawRequest: unknown,
  ids: string[],
  scoringOptions: QueryScoringOptions = {}
): RankedMemory[] {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const embeddingScorer = scoringOptions.embeddingScorer ?? defaultEmbeddingScorer;
  const reranker = scoringOptions.reranker ?? defaultMemoryReranker;
  return selectRowsByIds(rootDir, ids)
    .filter(
      (row) =>
        rowIsAccessible(row, request) &&
        request.includeTypes.includes(
          row.type as MemoryQueryRequest["includeTypes"][number]
        )
    )
    .map((row) => {
      const document = loadDocument(rootDir, row.file_path);
      return {
        document,
        ...scoreRow(
          row,
          document,
          request,
          0,
          0,
          undefined,
          0,
          embeddingScorer,
          reranker
        )
      };
    });
}

/**
 * 在已有 lexical/hybrid/graph 结果上运行有界 batch cross-encoder rerank。
 * 候选窗口、阈值和最终数量都显式进入 debug，便于评测和调参复现。
 */
export async function queryMemoriesRerankedWithDebug(
  rootDir: string,
  rawRequest: unknown,
  options: QueryBatchRerankOptions
): Promise<QueryMemoriesDebugResult> {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const base = options.baseResult ?? queryMemoriesWithDebug(rootDir, request, options);
  const candidateLimit = options.candidateLimit ?? 30;
  const resultLimit = options.resultLimit ?? 8;
  const minScore = options.minScore ?? 0.55;
  const reranked = await applyBatchRerank({
    query: request.task,
    candidates: base.ranked.map((memory) => ({
      id: memory.document.frontmatter.id,
      text: [
        memory.document.frontmatter.title,
        memory.document.frontmatter.aliases.join(" "),
        memory.document.body
      ].join("\n"),
      baseScore: memory.finalScore
    })),
    reranker: options.batchReranker,
    candidateLimit,
    resultLimit,
    minScore,
    baseWeight: options.baseWeight ?? 0.3,
    rerankerWeight: options.rerankerWeight ?? 0.7
  });
  const resultById = new Map(reranked.map((item) => [item.id, item]));
  const ranked = reranked
    .map((item) => {
      const memory = base.ranked.find(
        (candidate) => candidate.document.frontmatter.id === item.id
      );
      return memory
        ? {
            ...memory,
            finalScore: item.finalScore
          }
        : null;
    })
    .filter((memory): memory is RankedMemory => memory !== null);
  const scoresById = new Map(base.debug.resultScores.map((item) => [item.id, item]));
  return {
    ranked,
    debug: {
      ...base.debug,
      batchReranker: {
        name: options.batchReranker.name,
        candidateLimit,
        resultLimit,
        minScore
      },
      resultIds: ranked.map((memory) => memory.document.frontmatter.id),
      resultScores: ranked.map((memory) => {
        const id = memory.document.frontmatter.id;
        const original = scoresById.get(id)!;
        const result = resultById.get(id)!;
        return {
          ...original,
          rerankerScore: result.rerankerScore,
          finalScore: result.finalScore
        };
      })
    }
  };
}
