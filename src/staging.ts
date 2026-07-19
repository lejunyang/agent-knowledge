/**
 * staging 模块保存可供后续 memory-maintainer 审阅的脱敏事件摘要。
 *
 * 默认不保存 prompt、tool input/response、transcript 或 assistant 原文，只记录不可逆 hash、
 * 长度和粗粒度运行结果。水位与互斥锁防止多个后台整理进程重复消费。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./paths.js";

export type StagedEvent = {
  sequence: number;
  timestamp: string;
  event: string;
  sessionHash?: string;
  turnHash?: string;
  agentHash?: string;
  agentType?: string;
  projectId?: string;
  cwdHash?: string;
  reason?: string;
  promptLength?: number;
  responseLength?: number;
  toolResponseBytes?: number;
};

export type StageHookEventResult = {
  eventsPath: string;
  sequence: number;
};

export type StagingStatus = {
  total: number;
  watermark: number;
  pending: number;
};

export type DrainStagedEventsResult = {
  watermarkBefore: number;
  watermarkAfter: number;
  events: StagedEvent[];
};

const STAGING_DIR = [".memory", "staging"] as const;

function hashIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function stringLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function byteLength(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return undefined;
  }
}

function snakeEventName(input: unknown): string {
  if (typeof input !== "string" || input.length === 0) {
    return "unknown";
  }
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

export function getStagingEventsPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ...STAGING_DIR, "events.jsonl");
}

export function getStagingStatePath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ...STAGING_DIR, "state.json");
}

export function getStagingLockPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ...STAGING_DIR, "drain.lock");
}

async function readEvents(rootDir: string): Promise<StagedEvent[]> {
  const target = getStagingEventsPath(rootDir);
  if (!existsSync(target)) {
    return [];
  }
  return (await readFile(target, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StagedEvent);
}

async function readWatermark(rootDir: string): Promise<number> {
  const target = getStagingStatePath(rootDir);
  if (!existsSync(target)) {
    return 0;
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as { watermark?: unknown };
  return typeof parsed.watermark === "number" && Number.isInteger(parsed.watermark) ? parsed.watermark : 0;
}

async function writeWatermark(rootDir: string, watermark: number): Promise<void> {
  const target = getStagingStatePath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(
    target,
    `${JSON.stringify({ watermark, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8"
  );
}

export async function stageHookEvent(
  rootDir: string,
  payload: Record<string, unknown>
): Promise<StageHookEventResult> {
  const eventsPath = getStagingEventsPath(rootDir);
  await mkdir(path.dirname(eventsPath), { recursive: true });
  const sequence = Date.now();
  const event: StagedEvent = {
    sequence,
    timestamp: new Date().toISOString(),
    event: `hook.${snakeEventName(payload.hook_event_name ?? payload.event_type)}`,
    sessionHash: hashIdentifier(payload.session_id),
    turnHash: hashIdentifier(payload.turn_id),
    agentHash: hashIdentifier(payload.agent_id),
    agentType:
      typeof payload.agent_type === "string"
        ? payload.agent_type.slice(0, 80)
        : typeof payload.subagent_name === "string"
          ? payload.subagent_name.slice(0, 80)
          : undefined,
    projectId: typeof payload.project_id === "string" ? payload.project_id.slice(0, 80) : undefined,
    cwdHash: hashIdentifier(payload.cwd),
    reason: typeof payload.reason === "string" ? payload.reason.slice(0, 120) : undefined,
    promptLength: stringLength(payload.prompt),
    responseLength: stringLength(payload.last_assistant_message),
    toolResponseBytes: byteLength(payload.tool_response)
  };
  const compact = Object.fromEntries(Object.entries(event).filter(([, value]) => value !== undefined));
  await appendFile(eventsPath, `${JSON.stringify(compact)}\n`, "utf8");
  return { eventsPath, sequence };
}

export async function getStagingStatus(rootDir: string): Promise<StagingStatus> {
  const events = await readEvents(rootDir);
  const watermark = Math.min(await readWatermark(rootDir), events.length);
  return {
    total: events.length,
    watermark,
    pending: events.length - watermark
  };
}

async function acquireLock(rootDir: string, staleMs: number): Promise<() => Promise<void>> {
  const lockPath = getStagingLockPath(rootDir);
  await mkdir(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > staleMs) {
      await rm(lockPath, { force: true });
    } else {
      throw new Error("Staging drain is already in progress");
    }
  }

  try {
    const handle = await open(lockPath, "wx");
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
    await handle.close();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error("Staging drain is already in progress");
    }
    throw error;
  }

  return async () => {
    await rm(lockPath, { force: true });
  };
}

export async function drainStagedEvents(
  rootDir: string,
  options: { limit?: number; lockStaleMs?: number } = {}
): Promise<DrainStagedEventsResult> {
  const release = await acquireLock(rootDir, options.lockStaleMs ?? 10 * 60 * 1000);
  try {
    const events = await readEvents(rootDir);
    const watermarkBefore = Math.min(await readWatermark(rootDir), events.length);
    const limit = Math.max(0, options.limit ?? 100);
    const pending = events.slice(watermarkBefore, watermarkBefore + limit);
    const watermarkAfter = watermarkBefore + pending.length;
    await writeWatermark(rootDir, watermarkAfter);
    return {
      watermarkBefore,
      watermarkAfter,
      events: pending
    };
  } finally {
    await release();
  }
}
