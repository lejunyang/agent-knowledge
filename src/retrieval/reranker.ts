/**
 * Batch reranking 会联合评估 query 与候选文本，不同于只看特征的线性 scorer。
 *
 * 本模块与 query 存储解耦，使确定性测试和本地/远程 cross-encoder 共享同一 top-N、阈值和
 * 最终数量策略。
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

/** 供测试使用的可注入确定性 batch reranker，同时暴露实际批次大小。 */
export class DeterministicBatchReranker implements BatchCandidateReranker {
  readonly name = "deterministic-batch-reranker";
  lastBatchSize = 0;

  /** 注入测试 scorer，使测试能精确控制每条候选的模型分。 */
  constructor(
    private readonly options: {
      score(input: BatchRerankerScoreInput): number;
    }
  ) {}

  /** 对完整批次运行确定性 scorer，并记录实际 batch size。 */
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

/** 使用本地 Transformers.js cross-encoder 成对打分；默认禁止远程模型下载。 */
export class TransformersBatchReranker implements BatchCandidateReranker {
  readonly name = "transformers-bge-reranker";
  private classifierPromise?: Promise<unknown>;

  /** 保存模型、缓存目录和 local-only 策略，pipeline 延迟到首次 score 加载。 */
  constructor(
    private readonly options: {
      model: string;
      cacheDir: string;
      localFilesOnly?: boolean;
    }
  ) {}

  /** 把 query 与每条候选成对送入 cross-encoder，并提取正类分数。 */
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

  /** 懒加载并缓存 text-classification pipeline；默认禁止远程模型。 */
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

/**
 * 只重排基础分最高的 candidate window，融合模型分后执行阈值和最终数量限制。
 *
 * 先限制窗口可控制 cross-encoder 成本；阈值先于 resultLimit，避免为了凑数量注入低质量知识。
 */
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

/** 把外部模型或自定义 scorer 的异常分数限制到稳定的 0-1 区间。 */
function clamp(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/** 从 Transformers.js 可能返回的多种 classification 形状中提取正类分数。 */
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
