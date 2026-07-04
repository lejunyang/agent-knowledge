import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { MemoryQueryRequestSchema } from "./schema.js";
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory, SourceAuthority } from "./types.js";
import { getIndexDbPath } from "./indexer.js";

const require = createRequire(import.meta.url);
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

const RELATION_EXPANSION = new Set(["depends_on", "refines", "supports", "often_used_with"]);

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

function toFtsQuery(tokens: string[]): string {
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}

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

function rowMatchesRequest(row: MemoryRow, request: MemoryQueryRequest): boolean {
  const relatedDomains = parseJsonArray(row.related_domains);
  const scenarios = parseJsonArray(row.scenario);
  const domainPool = [row.domain, ...relatedDomains];
  const domainOk = request.domains.length === 0 || intersects(domainPool, request.domains);
  const scenarioOk = request.scenarios.length === 0 || intersects(scenarios, request.scenarios);
  const typeOk = request.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number]);

  return row.status === "active" && domainOk && scenarioOk && typeOk;
}

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
    (row) => row.status === "active" && !directIds.has(row.id)
  );

  return [...directRows.map((row) => ({ row, relationScore: 0 })), ...relatedRows.map((row) => ({ row, relationScore: 1 }))]
    .map(({ row, relationScore }) => ({
      document: loadDocument(rootDir, row.file_path),
      ...scoreRow(row, request, relationScore)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}
