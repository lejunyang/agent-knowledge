/**
 * embeddings 模块负责把 Markdown 知识转成可重建的本地向量缓存。
 *
 * 这里刻意把 provider、JSONL store 和 alias 建议拆在同一个小边界内：
 * - provider 可以替换为 Transformers.js 或测试用 deterministic local provider。
 * - `.memory/embeddings/index.jsonl` 是机器缓存，不是事实源。
 * - alias 建议只输出 dry-run JSON，避免模型或启发式逻辑直接改写 Markdown。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractSummary, parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { discoverKnowledgeFiles } from "./workspace.js";
import type { KnowledgeDocument } from "./types.js";

export type EmbeddingProvider = {
  name: string;
  model: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
};

export type EmbeddingJsonlRecord = {
  kind: "document";
  id: string;
  filePath: string;
  provider: string;
  model: string;
  dimensions: number;
  contentHash: string;
  embeddedAt: string;
  text: {
    title: string;
    aliases: string[];
    domain: string;
    scenarios: string[];
    tags: string[];
    summary: string;
  };
  vector: number[];
};

export type EmbedIndexOptions = {
  provider?: EmbeddingProvider;
};

export type EmbedIndexResult = {
  embeddingsPath: string;
  provider: string;
  model: string;
  indexed: number;
  dimensions: number;
  embedded: boolean;
  skippedReason?: "no_active_documents";
};

export type SuggestAliasesOptions = {
  provider?: EmbeddingProvider;
  maxSuggestionsPerMemory?: number;
  minScore?: number;
};

export type AliasSuggestion = {
  alias: string;
  score: number;
  reasons: string[];
};

export type MemoryAliasSuggestion = {
  id: string;
  title: string;
  filePath: string;
  existingAliases: string[];
  suggestions: AliasSuggestion[];
};

export type SuggestAliasesResult = {
  dryRun: true;
  embeddingsPath: string;
  provider: string;
  model: string;
  generatedAt: string;
  suggestions: MemoryAliasSuggestion[];
};

const DEFAULT_TRANSFORMERS_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDINGS_DIR = [".memory", "embeddings"] as const;
const EMBEDDINGS_FILE = "index.jsonl";

function tokenize(input: string): string[] {
  return [
    ...new Set(
      input
        .toLowerCase()
        .split(/[^\p{L}\p{N}_/-]+/u)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2 && token.length <= 48)
    )
  ];
}

function normalizeAlias(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function normalizeForCompare(input: string): string {
  return normalizeAlias(input).toLowerCase().replace(/[_\s]+/g, "-").replace(/-+/g, "-");
}

function l2Normalize(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector.map(() => 0);
  }
  return vector.map((value) => value / norm);
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

function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function documentEmbeddingText(document: KnowledgeDocument): string {
  const frontmatter = document.frontmatter;
  return [
    frontmatter.title,
    frontmatter.aliases.join(" "),
    frontmatter.domain,
    frontmatter.related_domains.join(" "),
    frontmatter.scenario.join(" "),
    frontmatter.tags.join(" "),
    extractSummary(document.body),
    document.body
  ]
    .filter(Boolean)
    .join("\n");
}

function toEmbeddingRecord(document: KnowledgeDocument, provider: EmbeddingProvider, vector: number[]): EmbeddingJsonlRecord {
  const frontmatter = document.frontmatter;
  const text = documentEmbeddingText(document);
  return {
    kind: "document",
    id: frontmatter.id,
    filePath: document.filePath,
    provider: provider.name,
    model: provider.model,
    dimensions: vector.length,
    contentHash: stableHash(text),
    embeddedAt: new Date().toISOString(),
    text: {
      title: frontmatter.title,
      aliases: frontmatter.aliases,
      domain: frontmatter.domain,
      scenarios: frontmatter.scenario,
      tags: frontmatter.tags,
      summary: extractSummary(document.body)
    },
    vector
  };
}

function parseJsonlRecords(text: string): EmbeddingJsonlRecord[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EmbeddingJsonlRecord)
    .filter((record) => record.kind === "document" && Array.isArray(record.vector));
}

async function loadActiveDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const files = await discoverKnowledgeFiles(rootDir);
  const documents: KnowledgeDocument[] = [];

  for (const filePath of files) {
    const document = parseKnowledgeMarkdown(filePath, await readFile(resolveWorkspacePath(rootDir, filePath), "utf8"));
    if (document.frontmatter.status === "active") {
      documents.push(document);
    }
  }

  return documents;
}

function extractLogTerms(rootDir: string): Map<string, Set<string>> {
  const logsDir = resolveWorkspacePath(rootDir, ".memory", "logs");
  const termsByMemory = new Map<string, Set<string>>();

  if (!existsSync(logsDir)) {
    return termsByMemory;
  }

  for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }

    const filePath = path.join(logsDir, entry.name);
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }

      const event = JSON.parse(line) as {
        event?: string;
        domains?: string[];
        scenarios?: string[];
        debug?: { resultIds?: string[] };
        memoryId?: string;
        usefulness?: string;
      };
      const ids =
        event.debug?.resultIds ??
        (typeof event.memoryId === "string" && event.usefulness === "useful" ? [event.memoryId] : []);
      const terms = [...(event.domains ?? []), ...(event.scenarios ?? [])].map(normalizeAlias).filter(Boolean);

      for (const id of ids) {
        const bucket = termsByMemory.get(id) ?? new Set<string>();
        for (const term of terms) {
          bucket.add(term);
        }
        termsByMemory.set(id, bucket);
      }
    }
  }

  return termsByMemory;
}

function candidateTermsForDocument(document: KnowledgeDocument, logTerms: Set<string> | undefined): Map<string, Set<string>> {
  const frontmatter = document.frontmatter;
  const candidates = new Map<string, Set<string>>();
  const add = (term: string, reason: string): void => {
    const alias = normalizeAlias(term);
    if (alias.length < 2 || alias.length > 64) {
      return;
    }
    const bucket = candidates.get(alias) ?? new Set<string>();
    bucket.add(reason);
    candidates.set(alias, bucket);
  };

  for (const term of logTerms ?? []) {
    add(term, "matched query log domain/scenario");
  }

  for (const term of [...frontmatter.tags, ...frontmatter.related_domains]) {
    add(term, "document metadata term");
  }

  const sourceTokens = tokenize([frontmatter.title, extractSummary(document.body), document.body].join(" "));
  for (const token of sourceTokens) {
    add(token, "document text token");
  }
  for (let index = 0; index < sourceTokens.length - 1; index += 1) {
    add(`${sourceTokens[index]} ${sourceTokens[index + 1]}`, "document text phrase");
  }

  return candidates;
}

function existingTerms(document: KnowledgeDocument): Set<string> {
  const frontmatter = document.frontmatter;
  return new Set(
    [
      frontmatter.title,
      ...frontmatter.aliases,
      frontmatter.domain,
      ...frontmatter.related_domains,
      ...frontmatter.scenario,
      ...frontmatter.tags
    ].map(normalizeForCompare)
  );
}

export function getEmbeddingsJsonlPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ...EMBEDDINGS_DIR, EMBEDDINGS_FILE);
}

export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic-local";
  readonly model = "token-hash-v1";

  constructor(readonly dimensions = 64) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array.from({ length: this.dimensions }, () => 0);
      for (const token of tokenize(text)) {
        const digest = createHash("sha256").update(token).digest();
        const index = digest.readUInt16BE(0) % this.dimensions;
        const sign = digest[2] % 2 === 0 ? 1 : -1;
        vector[index] += sign;
      }
      return l2Normalize(vector);
    });
  }
}

export class TransformersJsEmbeddingProvider implements EmbeddingProvider {
  readonly name = "transformers-js-feature-extraction";
  readonly dimensions = 0;
  private extractorPromise?: Promise<unknown>;

  constructor(
    readonly model = process.env.AGENT_KNOWLEDGE_EMBEDDING_MODEL ?? DEFAULT_TRANSFORMERS_MODEL,
    private readonly options: { localFilesOnly?: boolean; allowRemoteModels?: boolean } = {}
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const extractor = (await this.getExtractor()) as (texts: string[], options: Record<string, unknown>) => Promise<unknown>;
    const output = (await extractor(texts, { pooling: "mean", normalize: true })) as {
      data?: ArrayLike<number>;
      dims?: number[];
      tolist?: () => number[][] | number[];
    };

    if (typeof output.tolist === "function") {
      const listed = output.tolist();
      return Array.isArray(listed[0]) ? (listed as number[][]) : [listed as number[]];
    }

    if (!output.data || !output.dims || output.dims.length < 2) {
      throw new Error("Transformers.js feature-extraction returned an unsupported tensor shape");
    }

    const [rows, dimensions] = output.dims;
    const vectors: number[][] = [];
    for (let row = 0; row < rows; row += 1) {
      const vector: number[] = [];
      for (let column = 0; column < dimensions; column += 1) {
        vector.push(Number(output.data[row * dimensions + column] ?? 0));
      }
      vectors.push(vector);
    }
    return vectors;
  }

  private async getExtractor(): Promise<unknown> {
    this.extractorPromise ??= (async () => {
      const transformers = (await import("@huggingface/transformers")) as {
        env: { allowRemoteModels?: boolean; allowLocalModels?: boolean };
        pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
      };
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = this.options.allowRemoteModels ?? false;
      return transformers.pipeline("feature-extraction", this.model, {
        local_files_only: this.options.localFilesOnly ?? true
      });
    })();

    return this.extractorPromise;
  }
}

export function createEmbeddingProvider(options: {
  provider?: "transformers" | "local";
  model?: string;
  dimensions?: number;
  allowRemoteModels?: boolean;
}): EmbeddingProvider {
  if (options.provider === "local") {
    return new DeterministicLocalEmbeddingProvider(options.dimensions);
  }
  return new TransformersJsEmbeddingProvider(options.model, {
    localFilesOnly: !options.allowRemoteModels,
    allowRemoteModels: options.allowRemoteModels
  });
}

export async function embedKnowledgeIndex(rootDir: string, options: EmbedIndexOptions = {}): Promise<EmbedIndexResult> {
  const provider = options.provider ?? new TransformersJsEmbeddingProvider();
  const documents = await loadActiveDocuments(rootDir);
  if (documents.length === 0) {
    return {
      embeddingsPath: getEmbeddingsJsonlPath(rootDir),
      provider: provider.name,
      model: provider.model,
      indexed: 0,
      dimensions: provider.dimensions,
      embedded: false,
      skippedReason: "no_active_documents"
    };
  }
  const texts = documents.map(documentEmbeddingText);
  const vectors = await provider.embed(texts);
  const embeddingsPath = getEmbeddingsJsonlPath(rootDir);
  const embeddingsDir = resolveWorkspacePath(rootDir, ...EMBEDDINGS_DIR);
  mkdirSync(embeddingsDir, { recursive: true });

  const records = documents.map((document, index) => toEmbeddingRecord(document, provider, vectors[index] ?? []));
  const tempPath = `${embeddingsPath}.tmp`;
  writeFileSync(tempPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
  renameSync(tempPath, embeddingsPath);

  return {
    embeddingsPath,
    provider: provider.name,
    model: provider.model,
    indexed: records.length,
    dimensions: records[0]?.dimensions ?? provider.dimensions,
    embedded: true
  };
}

export function readEmbeddingRecords(rootDir: string): EmbeddingJsonlRecord[] {
  const embeddingsPath = getEmbeddingsJsonlPath(rootDir);
  if (!existsSync(embeddingsPath)) {
    return [];
  }
  return parseJsonlRecords(readFileSync(embeddingsPath, "utf8"));
}

export async function suggestAliases(rootDir: string, options: SuggestAliasesOptions = {}): Promise<SuggestAliasesResult> {
  const provider = options.provider ?? new DeterministicLocalEmbeddingProvider();
  const maxSuggestions = options.maxSuggestionsPerMemory ?? 5;
  const minScore = options.minScore ?? 0.35;
  const records = readEmbeddingRecords(rootDir);
  const documents = await loadActiveDocuments(rootDir);
  const documentsById = new Map(documents.map((document) => [document.frontmatter.id, document]));
  const logTermsByMemory = extractLogTerms(rootDir);
  const suggestions: MemoryAliasSuggestion[] = [];

  for (const record of records) {
    const document = documentsById.get(record.id);
    if (!document) {
      continue;
    }

    const existing = existingTerms(document);
    const candidateMap = candidateTermsForDocument(document, logTermsByMemory.get(record.id));
    const candidates = [...candidateMap.keys()].filter((candidate) => !existing.has(normalizeForCompare(candidate)));
    const candidateVectors = candidates.length > 0 ? await provider.embed(candidates) : [];
    const ranked = candidates
      .map((candidate, index) => {
        const reasons = [...(candidateMap.get(candidate) ?? [])].sort();
        const embeddingScore = Math.max(0, Math.min(1, cosineSimilarity(record.vector, candidateVectors[index] ?? [])));
        const score = reasons.some((reason) => reason.includes("query log")) ? Math.max(embeddingScore, 0.85) : embeddingScore;
        return {
          alias: candidate,
          score,
          reasons
        };
      })
      .filter((suggestion) => suggestion.score >= minScore)
      .sort((left, right) => right.score - left.score || left.alias.localeCompare(right.alias))
      .slice(0, maxSuggestions);

    suggestions.push({
      id: record.id,
      title: record.text.title,
      filePath: record.filePath,
      existingAliases: record.text.aliases,
      suggestions: ranked
    });
  }

  return {
    dryRun: true,
    embeddingsPath: getEmbeddingsJsonlPath(rootDir),
    provider: provider.name,
    model: provider.model,
    generatedAt: new Date().toISOString(),
    suggestions
  };
}
