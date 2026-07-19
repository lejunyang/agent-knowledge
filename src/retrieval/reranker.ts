/**
 * Batch reranking evaluates a query and candidate text together, unlike the existing feature-only
 * linear scorer. The module is independent from query storage so deterministic tests and remote/local
 * cross-encoders can share the same top-N, threshold, and final-limit policy.
 */
export type BatchCandidate = {
  id: string;
  text: string;
  baseScore: number;
};

export type BatchRerankerScoreInput = {
  query: string;
  document: string;
  id: string;
};

export type BatchCandidateReranker = {
  name: string;
  score(query: string, candidates: BatchCandidate[]): Promise<Map<string, number>>;
};

export type BatchRerankResult = BatchCandidate & {
  rerankerScore: number;
  finalScore: number;
};

export class DeterministicBatchReranker implements BatchCandidateReranker {
  readonly name = "deterministic-batch-reranker";
  lastBatchSize = 0;

  constructor(
    private readonly options: {
      score(input: BatchRerankerScoreInput): number;
    }
  ) {}

  async score(query: string, candidates: BatchCandidate[]): Promise<Map<string, number>> {
    this.lastBatchSize = candidates.length;
    return new Map(
      candidates.map((candidate) => [
        candidate.id,
        clamp(this.options.score({ query, document: candidate.text, id: candidate.id }))
      ])
    );
  }
}

export class TransformersBatchReranker implements BatchCandidateReranker {
  readonly name = "transformers-bge-reranker";
  private classifierPromise?: Promise<unknown>;

  constructor(
    private readonly options: {
      model: string;
      cacheDir: string;
      localFilesOnly?: boolean;
    }
  ) {}

  async score(query: string, candidates: BatchCandidate[]): Promise<Map<string, number>> {
    const classifier = (await this.getClassifier()) as (
      inputs: Array<{ text: string; text_pair: string }>,
      options?: Record<string, unknown>
    ) => Promise<unknown>;
    const output = await classifier(
      candidates.map((candidate) => ({
        text: query,
        text_pair: candidate.text
      })),
      { top_k: null }
    );
    const rows = Array.isArray(output) ? output : [output];
    return new Map(
      candidates.map((candidate, index) => [
        candidate.id,
        extractPositiveScore(rows[index])
      ])
    );
  }

  private async getClassifier(): Promise<unknown> {
    this.classifierPromise ??= (async () => {
      const transformers = (await import("@huggingface/transformers")) as {
        env: {
          allowRemoteModels?: boolean;
          allowLocalModels?: boolean;
          cacheDir?: string;
        };
        pipeline(task: string, model: string, options: Record<string, unknown>): Promise<unknown>;
      };
      transformers.env.allowLocalModels = true;
      transformers.env.allowRemoteModels = !(this.options.localFilesOnly ?? true);
      transformers.env.cacheDir = this.options.cacheDir;
      return transformers.pipeline("text-classification", this.options.model, {
        cache_dir: this.options.cacheDir,
        local_files_only: this.options.localFilesOnly ?? true,
        dtype: "q8"
      });
    })();
    return this.classifierPromise;
  }
}

export async function applyBatchRerank(options: {
  query: string;
  candidates: BatchCandidate[];
  reranker: BatchCandidateReranker;
  candidateLimit: number;
  resultLimit: number;
  minScore: number;
  baseWeight: number;
  rerankerWeight: number;
}): Promise<BatchRerankResult[]> {
  const selected = options.candidates
    .slice()
    .sort((left, right) => right.baseScore - left.baseScore || left.id.localeCompare(right.id))
    .slice(0, options.candidateLimit);
  const rerankerScores = await options.reranker.score(options.query, selected);

  return selected
    .map((candidate) => {
      const rerankerScore = clamp(rerankerScores.get(candidate.id) ?? 0);
      const finalScore = clamp(
        options.baseWeight * candidate.baseScore +
          options.rerankerWeight * rerankerScore
      );
      return { ...candidate, rerankerScore, finalScore };
    })
    .filter((candidate) => candidate.finalScore >= options.minScore)
    .sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        right.rerankerScore - left.rerankerScore ||
        left.id.localeCompare(right.id)
    )
    .slice(0, options.resultLimit);
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function extractPositiveScore(row: unknown): number {
  if (Array.isArray(row)) {
    const scored = row
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        label: typeof item.label === "string" ? item.label.toLowerCase() : "",
        score: typeof item.score === "number" ? item.score : 0
      }));
    const positive = scored.find((item) =>
      ["label_1", "positive", "relevant", "1"].includes(item.label)
    );
    return clamp(positive?.score ?? Math.max(0, ...scored.map((item) => item.score)));
  }
  if (row && typeof row === "object") {
    const score = (row as Record<string, unknown>).score;
    return typeof score === "number" ? clamp(score) : 0;
  }
  return 0;
}
