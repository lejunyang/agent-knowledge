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
import { extractSummary, parseKnowledgeMarkdown } from "../storage/markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { discoverKnowledgeFiles } from "../storage/workspace.js";
import type { KnowledgeDocument } from "../core/types.js";

export type EmbeddingProvider = {
  name: string;
  model: string;
  dimensions: number;
  profile?: EmbeddingProfile;
  embed(texts: string[], purpose?: "query" | "document"): Promise<number[][]>;
};

export type EmbeddingProfile = {
  id: string;
  provider: string;
  model: string;
  revision: string;
  dtype: "fp32" | "fp16" | "q8" | "deterministic";
  dimensions: number;
  pooling: "mean" | "cls" | "last-token";
  queryPrefix: string;
  documentPrefix: string;
  maxLength: number;
  normalize: boolean;
};

export type EmbeddingManifest = {
  version: 1;
  profile: EmbeddingProfile;
  generatedAt: string;
  recordCount: number;
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
  manifestPath: string;
  provider: string;
  model: string;
  indexed: number;
  dimensions: number;
  embedded: boolean;
  generated: number;
  reused: number;
  removed: number;
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

export const EMBEDDING_PROFILES = {
  "multilingual-e5-small": {
    id: "multilingual-e5-small",
    provider: "transformers-js-feature-extraction",
    model: "Xenova/multilingual-e5-small",
    revision: "main",
    dtype: "q8",
    dimensions: 384,
    pooling: "mean",
    queryPrefix: "query: ",
    documentPrefix: "passage: ",
    maxLength: 512,
    normalize: true
  },
  "bge-small-zh-v1.5": {
    id: "bge-small-zh-v1.5",
    provider: "transformers-js-feature-extraction",
    model: "Xenova/bge-small-zh-v1.5",
    revision: "main",
    dtype: "q8",
    dimensions: 512,
    pooling: "cls",
    queryPrefix: "为这个句子生成表示以用于检索相关文章：",
    documentPrefix: "",
    maxLength: 512,
    normalize: true
  }
} as const satisfies Record<string, EmbeddingProfile>;

const DEFAULT_EMBEDDING_PROFILE = EMBEDDING_PROFILES["multilingual-e5-small"];
const EMBEDDINGS_DIR = [".memory", "embeddings"] as const;
const EMBEDDINGS_FILE = "index.jsonl";
const MANIFEST_FILE = "manifest.json";

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

export function getEmbeddingsManifestPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ...EMBEDDINGS_DIR, MANIFEST_FILE);
}

function profileForProvider(provider: EmbeddingProvider, dimensions = provider.dimensions): EmbeddingProfile {
  return {
    id: provider.profile?.id ?? `${provider.name}:${provider.model}`,
    provider: provider.name,
    model: provider.model,
    revision: provider.profile?.revision ?? "unknown",
    dtype: provider.profile?.dtype ?? (provider.name === "deterministic-local" ? "deterministic" : "fp32"),
    dimensions: dimensions || provider.profile?.dimensions || 0,
    pooling: provider.profile?.pooling ?? "mean",
    queryPrefix: provider.profile?.queryPrefix ?? "",
    documentPrefix: provider.profile?.documentPrefix ?? "",
    maxLength: provider.profile?.maxLength ?? 512,
    normalize: provider.profile?.normalize ?? true
  };
}

function compatibleProfiles(left: EmbeddingProfile, right: EmbeddingProfile): boolean {
  const dimensionsCompatible = left.dimensions === 0 || right.dimensions === 0 || left.dimensions === right.dimensions;
  return (
    left.provider === right.provider &&
    left.model === right.model &&
    left.revision === right.revision &&
    left.dtype === right.dtype &&
    dimensionsCompatible &&
    left.pooling === right.pooling &&
    left.queryPrefix === right.queryPrefix &&
    left.documentPrefix === right.documentPrefix &&
    left.maxLength === right.maxLength &&
    left.normalize === right.normalize
  );
}

export function readEmbeddingManifest(rootDir: string): EmbeddingManifest | null {
  const manifestPath = getEmbeddingsManifestPath(rootDir);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as EmbeddingManifest;
}

export function assertEmbeddingProviderCompatible(rootDir: string, provider: EmbeddingProvider): EmbeddingManifest {
  const manifest = readEmbeddingManifest(rootDir);
  if (!manifest) {
    throw new Error("Embedding profile mismatch: cache manifest is missing; rebuild with embed-index");
  }
  const providerProfile = profileForProvider(provider);
  if (!compatibleProfiles(manifest.profile, providerProfile)) {
    throw new Error(
      `Embedding profile mismatch: cache=${manifest.profile.id}/${manifest.profile.dimensions}, query=${providerProfile.id}/${providerProfile.dimensions}`
    );
  }
  return manifest;
}

export class DeterministicLocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = "deterministic-local";
  readonly model = "token-hash-v1";
  readonly profile: EmbeddingProfile;

  constructor(readonly dimensions = 64) {
    this.profile = {
      id: "deterministic-local",
      provider: this.name,
      model: this.model,
      revision: "1",
      dtype: "deterministic",
      dimensions,
      pooling: "mean",
      queryPrefix: "",
      documentPrefix: "",
      maxLength: 0,
      normalize: true
    };
  }

  async embed(texts: string[], _purpose: "query" | "document" = "document"): Promise<number[][]> {
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
  readonly dimensions: number;
  readonly model: string;
  readonly profile: EmbeddingProfile;
  private extractorPromise?: Promise<unknown>;

  constructor(
    model = process.env.AGENT_KNOWLEDGE_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_PROFILE.model,
    private readonly options: {
      localFilesOnly?: boolean;
      allowRemoteModels?: boolean;
      profile?: EmbeddingProfile;
    } = {}
  ) {
    const knownProfile = Object.values(EMBEDDING_PROFILES).find((profile) => profile.model === model);
    this.profile = options.profile ?? knownProfile ?? {
      ...DEFAULT_EMBEDDING_PROFILE,
      id: `custom:${model}`,
      model,
      dimensions: 0,
      dtype: "fp32",
      queryPrefix: "",
      documentPrefix: ""
    };
    this.model = model;
    this.dimensions = this.profile.dimensions;
  }

  async embed(texts: string[], purpose: "query" | "document" = "document"): Promise<number[][]> {
    const extractor = (await this.getExtractor()) as (texts: string[], options: Record<string, unknown>) => Promise<unknown>;
    const prefix = purpose === "query" ? this.profile.queryPrefix : this.profile.documentPrefix;
    const prefixedTexts = texts.map((text) => `${prefix}${text}`);
    const output = (await extractor(prefixedTexts, {
      pooling: this.profile.pooling,
      normalize: this.profile.normalize,
      truncation: true,
      max_length: this.profile.maxLength
    })) as {
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
        local_files_only: this.options.localFilesOnly ?? true,
        dtype: this.profile.dtype === "q8" ? "q8" : undefined,
        revision: this.profile.revision
      });
    })();

    return this.extractorPromise;
  }
}

export function createEmbeddingProvider(options: {
  provider?: "transformers" | "local";
  model?: string;
  profile?: keyof typeof EMBEDDING_PROFILES;
  dimensions?: number;
  allowRemoteModels?: boolean;
}): EmbeddingProvider {
  if (options.provider === "local") {
    return new DeterministicLocalEmbeddingProvider(options.dimensions);
  }
  const selectedProfile = options.profile ? EMBEDDING_PROFILES[options.profile] : undefined;
  return new TransformersJsEmbeddingProvider(options.model ?? selectedProfile?.model, {
    localFilesOnly: !options.allowRemoteModels,
    allowRemoteModels: options.allowRemoteModels,
    profile: selectedProfile
  });
}

export async function embedKnowledgeIndex(rootDir: string, options: EmbedIndexOptions = {}): Promise<EmbedIndexResult> {
  const provider = options.provider ?? new TransformersJsEmbeddingProvider();
  const documents = await loadActiveDocuments(rootDir);
  const embeddingsPath = getEmbeddingsJsonlPath(rootDir);
  const manifestPath = getEmbeddingsManifestPath(rootDir);
  if (documents.length === 0) {
    const previousRecords = readEmbeddingRecords(rootDir);
    if (previousRecords.length > 0 || readEmbeddingManifest(rootDir)) {
      const embeddingsDir = resolveWorkspacePath(rootDir, ...EMBEDDINGS_DIR);
      mkdirSync(embeddingsDir, { recursive: true });
      writeFileSync(embeddingsPath, "", "utf8");
      const emptyManifest: EmbeddingManifest = {
        version: 1,
        profile: profileForProvider(provider),
        generatedAt: new Date().toISOString(),
        recordCount: 0
      };
      writeFileSync(manifestPath, `${JSON.stringify(emptyManifest, null, 2)}\n`, "utf8");
    }
    return {
      embeddingsPath,
      manifestPath,
      provider: provider.name,
      model: provider.model,
      indexed: 0,
      dimensions: provider.dimensions,
      embedded: false,
      generated: 0,
      reused: 0,
      removed: previousRecords.length,
      skippedReason: "no_active_documents"
    };
  }

  const previousManifest = readEmbeddingManifest(rootDir);
  const providerProfile = profileForProvider(provider);
  const previousRecords =
    previousManifest && compatibleProfiles(previousManifest.profile, providerProfile) ? readEmbeddingRecords(rootDir) : [];
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));
  const recordsById = new Map<string, EmbeddingJsonlRecord>();
  const documentsToEmbed: KnowledgeDocument[] = [];

  for (const document of documents) {
    const textHash = stableHash(documentEmbeddingText(document));
    const previous = previousById.get(document.frontmatter.id);
    if (previous?.contentHash === textHash && previous.filePath === document.filePath) {
      recordsById.set(document.frontmatter.id, previous);
    } else {
      documentsToEmbed.push(document);
    }
  }

  const vectors =
    documentsToEmbed.length > 0
      ? await provider.embed(documentsToEmbed.map(documentEmbeddingText), "document")
      : [];
  if (vectors.length !== documentsToEmbed.length) {
    throw new Error(
      `Embedding provider returned ${vectors.length} vectors for ${documentsToEmbed.length} documents`
    );
  }
  const generatedDimensions = new Set(vectors.map((vector) => vector.length));
  if (generatedDimensions.has(0) || generatedDimensions.size > 1) {
    throw new Error("Embedding provider returned empty or inconsistent vector dimensions");
  }
  if (
    vectors.length > 0 &&
    provider.profile &&
    provider.profile.dimensions > 0 &&
    vectors[0]?.length !== provider.profile.dimensions
  ) {
    throw new Error(
      `Embedding provider dimension mismatch: profile=${provider.profile.dimensions}, actual=${vectors[0]?.length ?? 0}`
    );
  }
  for (const [index, document] of documentsToEmbed.entries()) {
    recordsById.set(document.frontmatter.id, toEmbeddingRecord(document, provider, vectors[index] ?? []));
  }

  const embeddingsDir = resolveWorkspacePath(rootDir, ...EMBEDDINGS_DIR);
  mkdirSync(embeddingsDir, { recursive: true });

  const records = documents
    .map((document) => recordsById.get(document.frontmatter.id))
    .filter((record): record is EmbeddingJsonlRecord => record !== undefined);
  const dimensions =
    records[0]?.dimensions ?? vectors[0]?.length ?? previousManifest?.profile.dimensions ?? provider.dimensions;
  const manifest: EmbeddingManifest = {
    version: 1,
    profile: profileForProvider(provider, dimensions),
    generatedAt: new Date().toISOString(),
    recordCount: records.length
  };
  const tempPath = `${embeddingsPath}.tmp`;
  const manifestTempPath = `${manifestPath}.tmp`;
  writeFileSync(tempPath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
  writeFileSync(manifestTempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tempPath, embeddingsPath);
  renameSync(manifestTempPath, manifestPath);

  return {
    embeddingsPath,
    manifestPath,
    provider: provider.name,
    model: provider.model,
    indexed: records.length,
    dimensions,
    embedded: true,
    generated: documentsToEmbed.length,
    reused: records.length - documentsToEmbed.length,
    removed: previousRecords.filter((record) => !recordsById.has(record.id)).length
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
  if (records.length > 0) {
    assertEmbeddingProviderCompatible(rootDir, provider);
  }
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
    const candidateVectors = candidates.length > 0 ? await provider.embed(candidates, "query") : [];
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
