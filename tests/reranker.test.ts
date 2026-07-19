import { describe, expect, it } from "vitest";
import {
  DeterministicBatchReranker,
  applyBatchRerank,
  type BatchCandidate
} from "../src/retrieval/reranker.js";

function candidates(count: number): BatchCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `k_${index + 1}`,
    text: index === 29 ? "target procedure for lint fallback" : `unrelated candidate ${index + 1}`,
    baseScore: 1 - index / 100
  }));
}

describe("batch reranking", () => {
  it("reranks only the configured candidate window, filters by threshold, and limits output", async () => {
    const reranker = new DeterministicBatchReranker({
      score: ({ document }) => (document.includes("target procedure") ? 1 : 0.4)
    });

    const result = await applyBatchRerank({
      query: "lint fallback procedure",
      candidates: candidates(40),
      reranker,
      candidateLimit: 30,
      resultLimit: 8,
      minScore: 0.55,
      baseWeight: 0.2,
      rerankerWeight: 0.8
    });

    expect(reranker.lastBatchSize).toBe(30);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "k_30",
      rerankerScore: 1
    });
  });

  it("uses deterministic ordering for equal scores", async () => {
    const reranker = new DeterministicBatchReranker({
      score: () => 0.8
    });

    const result = await applyBatchRerank({
      query: "same",
      candidates: [
        { id: "k_b", text: "b", baseScore: 0.5 },
        { id: "k_a", text: "a", baseScore: 0.5 }
      ],
      reranker,
      candidateLimit: 30,
      resultLimit: 8,
      minScore: 0,
      baseWeight: 0.5,
      rerankerWeight: 0.5
    });

    expect(result.map((item) => item.id)).toEqual(["k_a", "k_b"]);
  });
});
