/**
 * Maintenance cleanup 删除已经固化到 observation/feedback ledger 的原始运行日志。
 *
 * 删除是显式 `--apply` 行为。SubagentStop 仍有待抽取时必须拒绝；feedback 先刷新 ledger，
 * 再从 daily JSONL 中移除对应事件，query/catalog/Hook 日志原样保留。
 */
import { existsSync } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  countFeedbackLogEvents,
  refreshFeedbackLedger
} from "./feedbackLedger.js";
import { getSubagentLogStatus } from "../hooks/subagentLogs.js";
import {
  getObservationStatus,
  resetObservationSourceWatermark
} from "./observations.js";

export type MaintenanceCleanupPlan = {
  applied: boolean;
  pendingSourceEvents: number;
  unmatchedStarts: number;
  subagentLogFiles: string[];
  feedbackEvents: number;
};

export type MaintenanceCleanupResult = MaintenanceCleanupPlan & {
  deletedSubagentLogFiles: string[];
  removedFeedbackEvents: number;
};

/** 列出可删除的 Subagent daily JSONL；pair state 不属于已消费事件，必须保留。 */
async function listSubagentLogFiles(rootDir: string): Promise<string[]> {
  const directory = resolveWorkspacePath(rootDir, ".memory", "subagents");
  if (!existsSync(directory)) {
    return [];
  }
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(directory, entry.name))
    .sort();
}

/** 生成只读 cleanup 计划，不创建 ledger 或修改任何文件。 */
export async function planMaintenanceCleanup(
  rootDir: string
): Promise<MaintenanceCleanupPlan> {
  const status = await getObservationStatus(rootDir);
  const subagentStatus = await getSubagentLogStatus(rootDir);
  return {
    applied: false,
    pendingSourceEvents: status.pendingSourceEvents,
    unmatchedStarts: subagentStatus.unmatchedStarts,
    subagentLogFiles: await listSubagentLogFiles(rootDir),
    feedbackEvents: countFeedbackLogEvents(rootDir)
  };
}

/** 原子重写 daily log，只移除 feedback 事件；空文件直接删除。 */
async function removeFeedbackLogEvents(rootDir: string): Promise<number> {
  const directory = resolveWorkspacePath(rootDir, ".memory", "logs");
  if (!existsSync(directory)) {
    return 0;
  }
  let removed = 0;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const target = path.join(directory, entry.name);
    const kept: string[] = [];
    for (const line of (await readFile(target, "utf8")).split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = JSON.parse(line) as { event?: string };
        if (event.event === "feedback.memory_usefulness") {
          removed += 1;
          continue;
        }
      } catch {
        // 损坏行不是安全可识别的 feedback，必须原样保留供人工诊断。
      }
      kept.push(line);
    }
    if (kept.length === 0) {
      await rm(target, { force: true });
      continue;
    }
    const temporary = `${target}.cleanup.tmp`;
    await writeFile(temporary, `${kept.join("\n")}\n`, "utf8");
    await rename(temporary, target);
  }
  return removed;
}

/**
 * 应用 cleanup：先校验所有 Stop 已抽取，再刷新 ledger，最后删除原始日志。
 *
 * 任一前置失败都不会删除文件；observations、proposals 和 pair state 始终保留。
 */
export async function applyMaintenanceCleanup(
  rootDir: string
): Promise<MaintenanceCleanupResult> {
  const plan = await planMaintenanceCleanup(rootDir);
  if (plan.pendingSourceEvents > 0) {
    throw new Error(
      `Refusing cleanup with ${plan.pendingSourceEvents} pending SubagentStop event(s)`
    );
  }
  if (plan.unmatchedStarts > 0) {
    throw new Error(
      `Refusing cleanup with ${plan.unmatchedStarts} unmatched SubagentStart event(s)`
    );
  }
  refreshFeedbackLedger(rootDir);
  const removedFeedbackEvents = await removeFeedbackLogEvents(rootDir);
  const deletedSubagentLogFiles: string[] = [];
  for (const filePath of plan.subagentLogFiles) {
    await rm(filePath, { force: true });
    deletedSubagentLogFiles.push(filePath);
  }
  if (deletedSubagentLogFiles.length > 0) {
    await resetObservationSourceWatermark(rootDir);
  }
  return {
    ...plan,
    applied: true,
    deletedSubagentLogFiles,
    removedFeedbackEvents,
    feedbackEvents: plan.feedbackEvents
  };
}
