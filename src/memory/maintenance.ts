/**
 * maintenance worker 把有界 observation 转换成可审阅 proposal。
 *
 * 本模块保持确定性，刻意不调用 LLM，也不修改 active Markdown。语义提取可以发生在该边界之前；
 * 进入本模块后，每个动作都必须落为可审计 JSON。
 */
import { existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../core/paths.js";
import type { EpisodeProvenance } from "../core/types.js";
import { catalogKnowledge } from "../storage/catalog.js";
import {
  maintenanceProposalId,
  readMaintenanceProposals,
  writeMaintenanceProposal,
  type MaintenanceProposal
} from "./proposals.js";

export type MaintenanceObservation = {
  id: string;
  title: string;
  domain: string;
  summary: string;
  sessionHash: string;
  sourceAuthority: "user_confirmed" | "model_inferred" | "documented" | "verified_task";
  supersedes?: string;
  conflictsWith?: string;
  memoryType?: "profile" | "semantic" | "episodic" | "procedural";
  usefulFeedback?: number;
  episode?: EpisodeProvenance;
};

type FeedbackEnrichedObservation = MaintenanceObservation & {
  feedbackMemoryId?: string;
};

export type MaintenanceResult = {
  processed: number;
  watermarkBefore: number;
  watermarkAfter: number;
  proposalIds: string[];
};

type MaintenanceState = {
  watermark: number;
  updatedAt: string;
};

type FeedbackLogEvent = {
  timestamp?: string;
  event?: string;
  memoryId?: string;
  usefulness?: "useful" | "not_useful" | "neutral";
  queryRunId?: string;
};

/**
 * 在互斥锁保护下，从当前水位开始有界生成 maintenance proposal。
 *
 * 只有整批 proposal 成功写入后才推进水位；进程中途失败会保留原水位，允许下次安全重放。
 */
export async function generateMaintenanceProposals(
  rootDir: string,
  observations: MaintenanceObservation[],
  options: { limit: number; lockStaleMs?: number }
): Promise<MaintenanceResult> {
  const release = await acquireMaintenanceLock(
    rootDir,
    options.lockStaleMs ?? 10 * 60 * 1000
  );
  try {
    const state = await readState(rootDir);
    // observation 日志可能被人工修复或截短，水位必须收敛到当前长度，不能永久越界。
    const watermarkBefore = Math.min(state.watermark, observations.length);
    const selected = observations.slice(
      watermarkBefore,
      watermarkBefore + Math.max(0, options.limit)
    );
    const catalog = await catalogKnowledge(rootDir, { write: false });
    const feedbackScores = await readUsefulFeedbackScores(rootDir);
    const existingById = new Map(
      (await readMaintenanceProposals(rootDir)).map((proposal) => [
        proposal.id,
        proposal
      ])
    );
    const proposalIds: string[] = [];

    /** 只写新 proposal，人工已接受/拒绝或仍待审的同 ID proposal 都保持原样。 */
    const writeIfNew = async (
      proposal: MaintenanceProposal
    ): Promise<void> => {
      if (existingById.has(proposal.id)) {
        return;
      }
      await writeMaintenanceProposal(rootDir, proposal);
      existingById.set(proposal.id, proposal);
      proposalIds.push(proposal.id);
    };

    for (const observation of selected) {
      const target = findRelatedMemory(catalog.items, observation);
      const proposal = proposalForObservation(observation, target);
      await writeIfNew(proposal);
    }

    const watermarkAfter = watermarkBefore + selected.length;
    const historicalObservations = attachUsefulFeedback(
      observations.slice(0, watermarkAfter),
      catalog.items,
      feedbackScores
    );
    // Skill 需要跨历史 observation 判断独立 session；即使本批无新事件，也要重查后来到达的 feedback。
    for (const skillProposal of skillProposalsForObservations(
      historicalObservations
    )) {
      await writeIfNew(skillProposal);
    }

    if (watermarkAfter !== watermarkBefore) {
      await writeState(rootDir, {
        watermark: watermarkAfter,
        updatedAt: new Date().toISOString()
      });
    }
    return {
      processed: selected.length,
      watermarkBefore,
      watermarkAfter,
      proposalIds
    };
  } finally {
    await release();
  }
}

export { readMaintenanceProposals };

/** 返回 maintenance 跨进程互斥锁路径。 */
export function getMaintenanceLockPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "maintenance.lock");
}

/**
 * 按显式 temporal/conflict 信号优先分类 observation，再回退 duplicate/consolidation。
 *
 * `supersedes` 和 `conflictsWith` 会改变后续治理行为，因此优先级必须高于标题相似判断。
 */
function proposalForObservation(
  observation: MaintenanceObservation,
  relatedMemory:
    | Awaited<ReturnType<typeof catalogKnowledge>>["items"][number]
    | undefined
): MaintenanceProposal {
  let type: MaintenanceProposal["type"] = "consolidation";
  let reason = relatedMemory
    ? "Observation overlaps an existing memory and should be reviewed for consolidation."
    : "Observation is reusable but has no exact active target; review before creating a candidate.";
  const targetMemoryIds = relatedMemory ? [relatedMemory.id] : [];

  if (observation.supersedes) {
    type = "update";
    reason = "Observation explicitly proposes replacing an existing memory.";
    targetMemoryIds.splice(0, targetMemoryIds.length, observation.supersedes);
  } else if (observation.conflictsWith) {
    type = "conflict";
    reason = "Observation explicitly conflicts with an existing memory.";
    targetMemoryIds.splice(0, targetMemoryIds.length, observation.conflictsWith);
  } else if (relatedMemory) {
    const observationSummary = normalize(observation.summary);
    const memorySummary = normalize(relatedMemory.summary);
    type =
      observationSummary === memorySummary ||
      memorySummary.includes(observationSummary) ||
      observationSummary.includes(memorySummary)
        ? "duplicate"
        : "consolidation";
    if (type === "duplicate") {
      reason = "Observation matches an existing memory title and summary.";
    }
  }

  const id = maintenanceProposalId({
    type,
    domain: observation.domain,
    observationIds: [observation.id],
    targetMemoryIds
  });
  return {
    version: 1,
    id,
    type,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    domain: observation.domain,
    title: observation.title,
    observationIds: [observation.id],
    targetMemoryIds,
    reason,
    proposedSummary: observation.summary
  };
}

/** 只用 active、同 domain、同标题/别名知识作为确定性关联目标，避免模糊匹配误合并。 */
function findRelatedMemory(
  items: Awaited<ReturnType<typeof catalogKnowledge>>["items"],
  observation: MaintenanceObservation
): (typeof items)[number] | undefined {
  const normalizedTitle = normalize(observation.title);
  return items.find(
    (item) =>
      item.status === "active" &&
      item.domain === observation.domain &&
      (normalize(item.title) === normalizedTitle ||
        item.aliases.some((alias) => normalize(alias) === normalizedTitle))
  );
}

/**
 * 把 observation 关联到 active memory 的净 usefulness score。
 *
 * 外部导入显式提供的 usefulFeedback 优先；自动日志只在同 domain 且标题/alias 精确匹配时附加，
 * 避免把近主题知识的反馈错误转移到另一条流程。
 */
function attachUsefulFeedback(
  observations: MaintenanceObservation[],
  items: Awaited<ReturnType<typeof catalogKnowledge>>["items"],
  scores: Map<string, number>
): FeedbackEnrichedObservation[] {
  return observations.map((observation) => {
    if (observation.usefulFeedback !== undefined) {
      return observation;
    }
    const target = findRelatedMemory(items, observation);
    const usefulFeedback = target
      ? scores.get(target.id)
      : undefined;
    return usefulFeedback === undefined
      ? observation
      : {
          ...observation,
          usefulFeedback,
          feedbackMemoryId: target?.id
        };
  });
}

/** 为标题和摘要比较生成稳定的小写空白归一化文本。 */
function normalize(input: string): string {
  return input.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 从重复验证的 procedural observation 生成 Skill proposal。
 *
 * 三个独立 session、受信来源、全部正反馈且无冲突是硬门槛；事件数量本身不能替代独立证据。
 */
function skillProposalsForObservations(
  observations: FeedbackEnrichedObservation[]
): MaintenanceProposal[] {
  const groups = new Map<string, FeedbackEnrichedObservation[]>();
  for (const observation of observations) {
    if (observation.memoryType !== "procedural") {
      continue;
    }
    const key = [
      normalize(observation.domain),
      normalize(observation.title),
      normalize(observation.summary)
    ].join("\u0000");
    const bucket = groups.get(key) ?? [];
    bucket.push(observation);
    groups.set(key, bucket);
  }

  const proposals: MaintenanceProposal[] = [];
  for (const group of groups.values()) {
    const sessions = new Set(group.map((observation) => observation.sessionHash));
    const trusted = group.every(
      (observation) =>
        observation.sourceAuthority === "verified_task" ||
        observation.sourceAuthority === "user_confirmed"
    );
    // 同一 active memory 的净反馈即使关联多个 observation，也只在 Skill 分组中累计一次。
    const logFeedback = new Map<string, number>();
    let importedFeedback = 0;
    for (const observation of group) {
      if (
        observation.feedbackMemoryId &&
        observation.usefulFeedback !== undefined
      ) {
        logFeedback.set(
          observation.feedbackMemoryId,
          observation.usefulFeedback
        );
      } else {
        importedFeedback += observation.usefulFeedback ?? 0;
      }
    }
    const positiveFeedback =
      importedFeedback +
        [...logFeedback.values()].reduce((sum, score) => sum + score, 0) >=
      sessions.size;
    const hasConflict = group.some((observation) => Boolean(observation.conflictsWith));
    // 任一门槛失败都宁可不提案，避免一次错误流程被自动固化为 Agent 能力。
    if (sessions.size < 3 || !trusted || !positiveFeedback || hasConflict) {
      continue;
    }
    const first = group[0]!;
    const observationIds = group.map((observation) => observation.id).sort();
    const id = maintenanceProposalId({
      type: "skill",
      domain: first.domain,
      observationIds,
      targetMemoryIds: []
    });
    proposals.push({
      version: 1,
      id,
      type: "skill",
      status: "pending",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      domain: first.domain,
      title: first.title,
      observationIds,
      targetMemoryIds: [],
      reason:
        "The procedure succeeded in at least three independent sessions with trusted evidence and positive feedback.",
      proposedSummary: first.summary,
      skillDraft: renderSkillDraft(first)
    });
  }
  return proposals;
}

/**
 * 从运行日志读取并汇总每条知识的净 usefulness。
 *
 * 同一 `memoryId + queryRunId` 只采用时间最新的一条，避免重试或重复上报放大票数；没有
 * queryRunId 的事件按日志位置视为独立人工反馈。损坏 JSONL 行会跳过，不能阻断维护 worker。
 */
async function readUsefulFeedbackScores(
  rootDir: string
): Promise<Map<string, number>> {
  const directory = resolveWorkspacePath(rootDir, ".memory", "logs");
  if (!existsSync(directory)) {
    return new Map();
  }
  const latestByKey = new Map<
    string,
    { timestamp: string; memoryId: string; score: number }
  >();
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name)
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const lines = (await readFile(
      resolveWorkspacePath(rootDir, ".memory", "logs", entry.name),
      "utf8"
    )).split("\n");
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
      const timestamp = event.timestamp ?? `${entry.name}:${lineIndex}`;
      const key = `${event.memoryId}\0${
        event.queryRunId ?? `${entry.name}:${lineIndex}`
      }`;
      const previous = latestByKey.get(key);
      if (previous && previous.timestamp > timestamp) {
        continue;
      }
      latestByKey.set(key, {
        timestamp,
        memoryId: event.memoryId,
        score:
          event.usefulness === "useful"
            ? 1
            : event.usefulness === "not_useful"
              ? -1
              : 0
      });
    }
  }
  const scores = new Map<string, number>();
  for (const feedback of latestByKey.values()) {
    scores.set(
      feedback.memoryId,
      (scores.get(feedback.memoryId) ?? 0) + feedback.score
    );
  }
  return scores;
}

/** 生成最小可审阅 Skill 草稿；丰富工具流程应在人工审阅阶段完成。 */
function renderSkillDraft(observation: MaintenanceObservation): string {
  const name = observation.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "proposed-procedure";
  return `---
name: ${name}
description: ${observation.summary}
---

# ${observation.title}

${observation.summary}
`;
}

/** 读取 proposal 消费水位；缺失或损坏字段回退到零，保证可重放。 */
async function readState(rootDir: string): Promise<MaintenanceState> {
  const target = resolveWorkspacePath(rootDir, ".memory", "maintenance-state.json");
  if (!existsSync(target)) {
    return { watermark: 0, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<MaintenanceState>;
  return {
    watermark:
      typeof parsed.watermark === "number" && Number.isInteger(parsed.watermark)
        ? parsed.watermark
        : 0,
    updatedAt:
      typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
  };
}

/** 在 proposal 全部持久化后写入新的消费水位。 */
async function writeState(rootDir: string, state: MaintenanceState): Promise<void> {
  const target = resolveWorkspacePath(rootDir, ".memory", "maintenance-state.json");
  await mkdir(resolveWorkspacePath(rootDir, ".memory"), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 获取 maintenance 跨进程锁，并允许清理超过 staleMs 的崩溃遗留锁。
 *
 * 未过期锁必须报错，不能让两个 worker 同时写 proposal 或推进同一水位。
 */
async function acquireMaintenanceLock(
  rootDir: string,
  staleMs: number
): Promise<() => Promise<void>> {
  const target = getMaintenanceLockPath(rootDir);
  await mkdir(resolveWorkspacePath(rootDir, ".memory"), { recursive: true });
  if (existsSync(target)) {
    const lockStat = await stat(target);
    if (Date.now() - lockStat.mtimeMs > staleMs) {
      await rm(target, { force: true });
    } else {
      throw new Error("Maintenance is already in progress");
    }
  }
  try {
    const handle = await open(target, "wx");
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    await handle.close();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Maintenance is already in progress");
    }
    throw error;
  }
  return async () => {
    await rm(target, { force: true });
  };
}
