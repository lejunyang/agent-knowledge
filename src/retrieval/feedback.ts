/**
 * feedback 模块只记录检索结果是否有用的用户反馈。
 *
 * 反馈写入 `.memory/logs/*.jsonl`，用于后续离线评估和调参；它不是事实源，
 * 也不会直接修改 Markdown 知识，避免把一次性偏好误写入长期记忆。
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { appendJsonlLog } from "../core/logging.js";

export const MemoryUsefulnessSchema = z.enum(["useful", "not_useful", "neutral"]);

export const FeedbackReasonSchema = z.enum([
  "relevant",
  "wrong_route",
  "missing_expected",
  "forbidden_injection",
  "should_abstain",
  "stale_source",
  "insufficient_detail",
  "conflicting_evidence",
  "reasoning_failure",
  "other"
]);

export const MemoryFeedbackInputSchema = z
  .object({
    memoryId: z.string().min(1).optional(),
    usefulness: MemoryUsefulnessSchema,
    reason: FeedbackReasonSchema.optional(),
    queryRunId: z.string().min(1).optional(),
    expectedMemoryIds: z.array(z.string().min(1)).max(100).default([]),
    forbiddenMemoryIds: z.array(z.string().min(1)).max(100).default([]),
    task: z.string().min(1).optional(),
    note: z.string().max(500).optional()
  })
  .superRefine((input, context) => {
    if (!input.memoryId && !input.queryRunId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["queryRunId"],
        message: "feedback requires memoryId or queryRunId"
      });
    }
    if (
      input.reason === "relevant" &&
      input.usefulness === "not_useful"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "relevant reason is incompatible with not_useful"
      });
    }
  });

export type MemoryUsefulness = z.infer<typeof MemoryUsefulnessSchema>;
export type FeedbackReason = z.infer<typeof FeedbackReasonSchema>;
export type MemoryFeedbackInput = z.infer<typeof MemoryFeedbackInputSchema>;

export type MemoryFeedbackResult = {
  status: "logged";
  logPath: string;
  memoryId?: string;
  usefulness: MemoryUsefulness;
};

/**
 * 记录某条检索知识的有用性反馈，不修改 Markdown 事实或即时影响排序。
 *
 * 日志供后续阈值校准和维护诊断使用，避免单次负反馈直接删除长期知识。
 */
export function logMemoryFeedback(rootDir: string, rawInput: unknown): MemoryFeedbackResult {
  const input = MemoryFeedbackInputSchema.parse(rawInput);
  const logPath = appendJsonlLog(rootDir, {
    event: "feedback.memory_usefulness",
    eventId: randomUUID(),
    memoryId: input.memoryId,
    usefulness: input.usefulness,
    reason: input.reason,
    queryRunId: input.queryRunId,
    expectedMemoryIds: input.expectedMemoryIds,
    forbiddenMemoryIds: input.forbiddenMemoryIds,
    taskLength: input.task?.length,
    note: input.note
  });

  return {
    status: "logged",
    logPath,
    memoryId: input.memoryId,
    usefulness: input.usefulness
  };
}
