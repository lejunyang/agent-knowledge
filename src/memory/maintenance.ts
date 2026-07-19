/**
 * maintenance worker 把有界 observation 转换成可审阅 proposal。
 *
 * 本模块保持确定性，刻意不调用 LLM，也不修改 active Markdown。语义提取可以发生在该边界之前；
 * 进入本模块后，每个动作都必须落为可审计 JSON。
 */
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    if (selected.length === 0) {
      return {
        processed: 0,
        watermarkBefore,
        watermarkAfter: watermarkBefore,
        proposalIds: []
      };
    }

    const catalog = await catalogKnowledge(rootDir, { write: false });
    const proposals: MaintenanceProposal[] = [];
    for (const observation of selected) {
      const target = findRelatedMemory(catalog.items, observation);
      const proposal = proposalForObservation(observation, target);
      proposals.push(proposal);
      await writeMaintenanceProposal(rootDir, proposal);
    }

    const watermarkAfter = watermarkBefore + selected.length;
    // Skill 需要跨历史 observation 判断独立 session，不能只检查本批新增事件。
    for (const skillProposal of skillProposalsForObservations(
      observations.slice(0, watermarkAfter)
    )) {
      proposals.push(skillProposal);
      await writeMaintenanceProposal(rootDir, skillProposal);
    }

    await writeState(rootDir, {
      watermark: watermarkAfter,
      updatedAt: new Date().toISOString()
    });
    return {
      processed: selected.length,
      watermarkBefore,
      watermarkAfter,
      proposalIds: proposals.map((proposal) => proposal.id)
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
  observations: MaintenanceObservation[]
): MaintenanceProposal[] {
  const groups = new Map<string, MaintenanceObservation[]>();
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
    const positiveFeedback = group.every(
      (observation) => (observation.usefulFeedback ?? 0) > 0
    );
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
