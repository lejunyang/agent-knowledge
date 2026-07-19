/**
 * scoring 模块定义可插拔的本地评分边界。
 *
 * 默认实现不调用外部 embedding API，而是用确定性的词项向量近似语义相似度。
 * 这样 query 模块可以先稳定暴露 scorer / reranker 接口，后续替换为真正 embedding
 * 或更复杂的重排器时，不需要改动 CLI 输出协议。
 */
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory, SourceAuthority } from "../core/types.js";

export type ScoreFeatures = Omit<RankedMemory, "document" | "finalScore">;

export type EmbeddingScoreInput = {
  request: MemoryQueryRequest;
  document: KnowledgeDocument;
};

export type EmbeddingScorer = {
  name: string;
  score(input: EmbeddingScoreInput): number;
};

export type RerankInput = {
  request: MemoryQueryRequest;
  document: KnowledgeDocument;
  features: ScoreFeatures;
};

export type MemoryReranker = {
  name: string;
  rerank(input: RerankInput): number;
};

export const AUTHORITY_SCORE: Record<SourceAuthority, number> = {
  user_confirmed: 1,
  verified_task: 0.85,
  documented: 0.75,
  model_inferred: 0.45
};

export const DEFAULT_RERANK_WEIGHTS = {
  lexicalScore: 0.15,
  embeddingScore: 0.2,
  scenarioScore: 0.15,
  confidenceScore: 0.1,
  sourceAuthorityScore: 0.1,
  relationScore: 0.05,
  rrfScore: 0.25
} as const;

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function tokenizeForLocalEmbedding(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_/-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function toWeightedVector(weightedTexts: Array<{ text: string; weight: number }>): Map<string, number> {
  const vector = new Map<string, number>();

  for (const item of weightedTexts) {
    for (const token of tokenizeForLocalEmbedding(item.text)) {
      vector.set(token, (vector.get(token) ?? 0) + item.weight);
    }
  }

  return vector;
}

function cosineSimilarity(left: Map<string, number>, right: Map<string, number>): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) {
    leftNorm += value * value;
  }
  for (const value of right.values()) {
    rightNorm += value * value;
  }
  for (const [token, leftValue] of left) {
    dot += leftValue * (right.get(token) ?? 0);
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * 本地 deterministic embedding scorer。
 *
 * 它不是模型 embedding，而是一个可替换占位：把 task/domain/scenario 与知识的
 * title/metadata/body 转成加权词项向量后算 cosine，相同输入总是得到相同分数。
 */
export class DefaultLocalEmbeddingScorer implements EmbeddingScorer {
  readonly name = "default-local-token-cosine";

  score(input: EmbeddingScoreInput): number {
    const requestVector = toWeightedVector([
      { text: input.request.task, weight: 1 },
      { text: input.request.domains.join(" "), weight: 1.5 },
      { text: input.request.scenarios.join(" "), weight: 1.5 },
      { text: input.request.paths.join(" "), weight: 0.5 }
    ]);
    const documentVector = toWeightedVector([
      { text: input.document.frontmatter.title, weight: 2 },
      { text: input.document.frontmatter.aliases.join(" "), weight: 1.5 },
      { text: input.document.frontmatter.domain, weight: 1.5 },
      { text: input.document.frontmatter.related_domains.join(" "), weight: 1 },
      { text: input.document.frontmatter.scenario.join(" "), weight: 1.5 },
      { text: input.document.frontmatter.tags.join(" "), weight: 1 },
      { text: input.document.body, weight: 0.7 }
    ]);

    return clampScore(cosineSimilarity(requestVector, documentVector));
  }
}

export class DefaultMemoryReranker implements MemoryReranker {
  readonly name = "default-weighted-linear";

  rerank(input: RerankInput): number {
    const features = input.features;
    return clampScore(
      DEFAULT_RERANK_WEIGHTS.lexicalScore * features.lexicalScore +
        DEFAULT_RERANK_WEIGHTS.embeddingScore * features.embeddingScore +
        DEFAULT_RERANK_WEIGHTS.scenarioScore * features.scenarioScore +
        DEFAULT_RERANK_WEIGHTS.confidenceScore * features.confidenceScore +
        DEFAULT_RERANK_WEIGHTS.sourceAuthorityScore * features.sourceAuthorityScore +
        DEFAULT_RERANK_WEIGHTS.relationScore * features.relationScore +
        DEFAULT_RERANK_WEIGHTS.rrfScore * features.rrfScore
    );
  }
}

export const defaultEmbeddingScorer = new DefaultLocalEmbeddingScorer();
export const defaultMemoryReranker = new DefaultMemoryReranker();
