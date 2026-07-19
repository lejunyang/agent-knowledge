import { describe, expect, it } from "vitest";
import { calibrateRetrieval, type CalibrationCase } from "../src/retrieval/calibration.js";

const cases: CalibrationCase[] = [
  {
    id: "positive",
    expectedIds: ["k_good"],
    forbiddenIds: ["k_bad"],
    abstain: false,
    candidates: [
      { id: "k_good", baseScore: 0.6, rerankerScore: 0.9 },
      { id: "k_bad", baseScore: 0.8, rerankerScore: 0.2 }
    ]
  },
  {
    id: "abstain",
    expectedIds: [],
    forbiddenIds: ["k_noise"],
    abstain: true,
    candidates: [{ id: "k_noise", baseScore: 0.45, rerankerScore: 0.2 }]
  }
];

describe("retrieval calibration", () => {
  it("selects a deterministic configuration that avoids forbidden injection and preserves recall", () => {
    const result = calibrateRetrieval({
      cases,
      feedback: [{ memoryId: "k_bad", usefulness: "not_useful" }],
      grid: {
        minScores: [0.4, 0.55, 0.7],
        baseWeights: [0.3, 0.5],
        resultLimits: [1, 2]
      }
    });

    expect(result.dryRun).toBe(true);
    expect(result.suggestion.falseInjections).toBe(0);
    expect(result.suggestion.abstentionFailures).toBe(0);
    expect(result.suggestion.recall).toBe(1);
    expect(result.evaluatedConfigurations).toBe(12);
  });

  it("penalizes negative feedback and uses stable tie breaking", () => {
    const first = calibrateRetrieval({
      cases,
      feedback: [{ memoryId: "k_bad", usefulness: "not_useful" }],
      grid: {
        minScores: [0.55],
        baseWeights: [0.3, 0.5],
        resultLimits: [1]
      }
    });
    const second = calibrateRetrieval({
      cases,
      feedback: [{ memoryId: "k_bad", usefulness: "not_useful" }],
      grid: {
        minScores: [0.55],
        baseWeights: [0.3, 0.5],
        resultLimits: [1]
      }
    });

    expect(second.suggestion).toEqual(first.suggestion);
    expect(first.suggestion.negativeFeedbackHits).toBe(0);
  });
});
