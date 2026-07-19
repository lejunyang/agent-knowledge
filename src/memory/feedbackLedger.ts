/**
 * Feedback ledger 把可清理的运行日志事件固化为去重后的 usefulness 状态。
 *
 * Ledger 位于 `.memory/feedback/ledger.json`，不是知识事实，但 maintenance 依赖它长期计算
 * Skill 证据。原始 feedback 日志删除后，ledger 仍保留 `memoryId + queryRunId` 的最新决议。
 */
import { existsSync } from "node:fs";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";

export type FeedbackLedgerEntry = {
  key: string;
  memoryId: string;
  queryRunId?: string;
  usefulness: "useful" | "not_useful" | "neutral";
  timestamp: string;
};

export type FeedbackLedger = {
  version: 1;
  updatedAt: string;
  entries: Record<string, FeedbackLedgerEntry>;
};

type FeedbackLogEvent = {
  timestamp?: string;
  event?: string;
  eventId?: string;
  memoryId?: string;
  usefulness?: "useful" | "not_useful" | "neutral";
  queryRunId?: string;
};

/** 返回 feedback ledger 路径。 */
export function getFeedbackLedgerPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "feedback", "ledger.json");
}

/** 读取 ledger；缺失时返回空 ledger，损坏 JSON 会明确失败。 */
export function readFeedbackLedger(rootDir: string): FeedbackLedger {
  const target = getFeedbackLedgerPath(rootDir);
  if (!existsSync(target)) {
    return {
      version: 1,
      updatedAt: new Date(0).toISOString(),
      entries: {}
    };
  }
  const parsed = JSON.parse(readFileSync(target, "utf8")) as FeedbackLedger;
  if (
    parsed.version !== 1 ||
    !parsed.entries ||
    typeof parsed.entries !== "object"
  ) {
    throw new Error("Invalid feedback ledger");
  }
  return parsed;
}

/** 原子写入 ledger，避免清理日志后只留下半写状态。 */
function writeFeedbackLedger(rootDir: string, ledger: FeedbackLedger): void {
  const target = getFeedbackLedgerPath(rootDir);
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

/** 为 feedback 生成去重 key；无 queryRunId 时保留日志文件和行号作为独立人工事件。 */
function feedbackKey(
  event: FeedbackLogEvent,
  fileName: string,
  lineIndex: number
): string {
  return `${event.memoryId}\0${
    event.queryRunId ?? event.eventId ?? `${fileName}:${lineIndex}`
  }`;
}

/**
 * 把当前 `.memory/logs` 中的 feedback 事件吸收到 ledger。
 *
 * 同 key 只保留时间最新的事件；损坏行和非 feedback 行跳过，不阻断维护流程。
 */
export function refreshFeedbackLedger(rootDir: string): {
  ledger: FeedbackLedger;
  absorbedEvents: number;
} {
  const ledger = readFeedbackLedger(rootDir);
  const directory = resolveWorkspacePath(rootDir, ".memory", "logs");
  let absorbedEvents = 0;
  if (existsSync(directory)) {
    for (const entry of readdirSync(directory, {
      withFileTypes: true
    }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const lines = readFileSync(path.join(directory, entry.name), "utf8").split(
        "\n"
      );
      for (const [lineIndex, line] of lines.entries()) {
        if (!line.trim()) {
          continue;
        }
        let event: FeedbackLogEvent;
        try {
          event = JSON.parse(line) as FeedbackLogEvent;
        } catch {
          continue;
        }
        if (
          event.event !== "feedback.memory_usefulness" ||
          !event.memoryId ||
          !event.usefulness
        ) {
          continue;
        }
        const key = feedbackKey(event, entry.name, lineIndex);
        const timestamp =
          event.timestamp ?? `${entry.name}:${String(lineIndex).padStart(12, "0")}`;
        const previous = ledger.entries[key];
        if (!previous || previous.timestamp <= timestamp) {
          ledger.entries[key] = {
            key,
            memoryId: event.memoryId,
            queryRunId: event.queryRunId,
            usefulness: event.usefulness,
            timestamp
          };
        }
        absorbedEvents += 1;
      }
    }
  }
  ledger.updatedAt = new Date().toISOString();
  if (absorbedEvents > 0 || existsSync(getFeedbackLedgerPath(rootDir))) {
    writeFeedbackLedger(rootDir, ledger);
  }
  return { ledger, absorbedEvents };
}

/** 从 ledger 汇总每条知识的净 usefulness 分数。 */
export function readFeedbackScores(rootDir: string): Map<string, number> {
  const ledger = readFeedbackLedger(rootDir);
  const scores = new Map<string, number>();
  for (const entry of Object.values(ledger.entries)) {
    const score =
      entry.usefulness === "useful"
        ? 1
        : entry.usefulness === "not_useful"
          ? -1
          : 0;
    scores.set(entry.memoryId, (scores.get(entry.memoryId) ?? 0) + score);
  }
  return scores;
}

/** 统计日志中的 feedback 行，供 cleanup dry-run 展示。 */
export function countFeedbackLogEvents(rootDir: string): number {
  const directory = resolveWorkspacePath(rootDir, ".memory", "logs");
  if (!existsSync(directory)) {
    return 0;
  }
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    for (const line of readFileSync(path.join(directory, entry.name), "utf8").split(
      "\n"
    )) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as FeedbackLogEvent;
        if (event.event === "feedback.memory_usefulness") {
          count += 1;
        }
      } catch {
        // 损坏日志由 cleanup 原样保留，不计入可删除 feedback。
      }
    }
  }
  return count;
}
