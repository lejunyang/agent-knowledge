/**
 * Calibration 只搜索刻意限制的小型配置网格，永不修改用户配置。
 *
 * 安全失败优先主导目标函数：先比较 forbidden injection 和 abstention 失败，再比较 recall/MRR；
 * not_useful 反馈提供额外惩罚。
 */
export type CalibrationCandidate = {
  id: string;
  baseScore: number;
  rerankerScore: number;
};

export type CalibrationCase = {
  id: string;
  expectedIds: string[];
  forbiddenIds: string[];
  abstain: boolean;
  candidates: CalibrationCandidate[];
};

export type CalibrationFeedback = {
  memoryId: string;
  usefulness: "useful" | "not_useful" | "neutral";
};

export type CalibrationSuggestion = {
  minScore: number;
  baseWeight: number;
  rerankerWeight: number;
  resultLimit: number;
  falseInjections: number;
  abstentionFailures: number;
  negativeFeedbackHits: number;
  recall: number;
  mrr: number;
};

/**
 * 在有限参数网格中评估阈值、基础权重和结果数量，并返回 dry-run 建议。
 *
 * 目标函数优先惩罚 forbidden injection、abstention 失败和 not_useful 反馈；本函数不自动改配置。
 */
export function calibrateRetrieval(options: {
  cases: CalibrationCase[];
  feedback: CalibrationFeedback[];
  grid: {
    minScores: number[];
    baseWeights: number[];
    resultLimits: number[];
  };
}): {
  dryRun: true;
  evaluatedConfigurations: number;
  suggestion: CalibrationSuggestion;
} {
  const negativeIds = new Set(
    options.feedback
      .filter((feedback) => feedback.usefulness === "not_useful")
      .map((feedback) => feedback.memoryId)
  );
  const suggestions: CalibrationSuggestion[] = [];

  for (const minScore of options.grid.minScores) {
    for (const baseWeight of options.grid.baseWeights) {
      for (const resultLimit of options.grid.resultLimits) {
        const rerankerWeight = 1 - baseWeight;
        let falseInjections = 0;
        let abstentionFailures = 0;
        let negativeFeedbackHits = 0;
        let expectedTotal = 0;
        let expectedMatched = 0;
        let reciprocalRankTotal = 0;
        let answerableCases = 0;

        for (const evalCase of options.cases) {
          const selected = evalCase.candidates
            .map((candidate) => ({
              ...candidate,
              finalScore:
                baseWeight * candidate.baseScore +
                rerankerWeight * candidate.rerankerScore
            }))
            .filter((candidate) => candidate.finalScore >= minScore)
            .sort(
              (left, right) =>
                right.finalScore - left.finalScore ||
                left.id.localeCompare(right.id)
            )
            .slice(0, resultLimit);
          const resultIds = selected.map((candidate) => candidate.id);
          falseInjections += evalCase.forbiddenIds.filter((id) => resultIds.includes(id)).length;
          negativeFeedbackHits += resultIds.filter((id) => negativeIds.has(id)).length;
          if (evalCase.abstain && resultIds.length > 0) {
            abstentionFailures += 1;
          }
          if (evalCase.expectedIds.length > 0) {
            answerableCases += 1;
            expectedTotal += evalCase.expectedIds.length;
            expectedMatched += evalCase.expectedIds.filter((id) => resultIds.includes(id)).length;
            const rank = resultIds.findIndex((id) => evalCase.expectedIds.includes(id));
            reciprocalRankTotal += rank === -1 ? 0 : 1 / (rank + 1);
          }
        }

        suggestions.push({
          minScore,
          baseWeight,
          rerankerWeight,
          resultLimit,
          falseInjections,
          abstentionFailures,
          negativeFeedbackHits,
          recall: expectedTotal === 0 ? 1 : expectedMatched / expectedTotal,
          mrr: answerableCases === 0 ? 1 : reciprocalRankTotal / answerableCases
        });
      }
    }
  }

  const suggestion = suggestions.sort(compareSuggestions)[0];
  if (!suggestion) {
    throw new Error("Calibration grid is empty");
  }
  return {
    dryRun: true,
    evaluatedConfigurations: suggestions.length,
    suggestion
  };
}

/** 按安全失败、反馈惩罚、MRR 和结果规模的优先级比较两个参数建议。 */
function compareSuggestions(
  left: CalibrationSuggestion,
  right: CalibrationSuggestion
): number {
  return (
    left.falseInjections - right.falseInjections ||
    left.abstentionFailures - right.abstentionFailures ||
    left.negativeFeedbackHits - right.negativeFeedbackHits ||
    right.recall - left.recall ||
    right.mrr - left.mrr ||
    right.minScore - left.minScore ||
    left.baseWeight - right.baseWeight ||
    left.resultLimit - right.resultLimit
  );
}
