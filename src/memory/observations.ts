/**
 * Observation extraction 把详细 SubagentStop 证据转换为稳定 maintenance 输入。
 *
 * 源日志保留用于调试；独立 source watermark 保证抽取幂等，append-only observation 允许 proposal
 * 生成独立重放。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";
import type { EpisodeProvenance } from "../core/types.js";
import { readSubagentLogs, type SubagentLogRecord } from "../hooks/subagentLogs.js";
import type { MaintenanceObservation } from "./maintenance.js";

export type ExtractedMaintenanceObservation = MaintenanceObservation & {
  episode: EpisodeProvenance;
};

type ObservationExtractionState = {
  sourceWatermark: number;
  updatedAt: string;
};

/** 抽取新追加的 SubagentStop，并在完整扫描后推进 source watermark。 */
export async function extractMaintenanceObservations(rootDir: string): Promise<{
  extracted: number;
  skipped: number;
  sourceWatermarkBefore: number;
  sourceWatermarkAfter: number;
}> {
  const logs = await readSubagentLogs(rootDir, { limit: Number.MAX_SAFE_INTEGER });
  const stops = logs.filter((record) => record.event === "subagent_stop");
  const state = await readExtractionState(rootDir);
  const sourceWatermarkBefore = Math.min(state.sourceWatermark, stops.length);
  const pending = stops.slice(sourceWatermarkBefore);
  let extracted = 0;
  let skipped = 0;

  for (const record of pending) {
    const observation = observationFromSubagentStop(record);
    if (!observation) {
      skipped += 1;
      continue;
    }
    await appendObservation(rootDir, observation);
    extracted += 1;
  }

  const sourceWatermarkAfter = stops.length;
  await writeExtractionState(rootDir, {
    sourceWatermark: sourceWatermarkAfter,
    updatedAt: new Date().toISOString()
  });
  return { extracted, skipped, sourceWatermarkBefore, sourceWatermarkAfter };
}

/** 按追加顺序读取全部 observation，供 proposal worker 使用自己的独立水位消费。 */
export async function readMaintenanceObservations(
  rootDir: string
): Promise<ExtractedMaintenanceObservation[]> {
  const target = observationPath(rootDir);
  if (!existsSync(target)) {
    return [];
  }
  return (await readFile(target, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExtractedMaintenanceObservation);
}

/** 向运维者汇报源事件、水位、待抽取数量和 observation 总数。 */
export async function getObservationStatus(rootDir: string): Promise<{
  sourceEvents: number;
  sourceWatermark: number;
  pendingSourceEvents: number;
  observations: number;
}> {
  const logs = await readSubagentLogs(rootDir, { limit: Number.MAX_SAFE_INTEGER });
  const sourceEvents = logs.filter((record) => record.event === "subagent_stop").length;
  const state = await readExtractionState(rootDir);
  const observations = await readMaintenanceObservations(rootDir);
  return {
    sourceEvents,
    sourceWatermark: state.sourceWatermark,
    pendingSourceEvents: Math.max(0, sourceEvents - state.sourceWatermark),
    observations: observations.length
  };
}

/**
 * 优先读取结构化 result 字段，再回退常见文本字段。
 * 没有可复用文本的事件直接跳过，避免制造噪声 observation。
 */
function observationFromSubagentStop(
  record: SubagentLogRecord
): ExtractedMaintenanceObservation | null {
  const payload = record.payload;
  const structured = objectValue(payload.result) ?? objectValue(payload.output);
  const nestedStop = objectValue(payload.subagent_stop);
  const summary =
    stringField(structured, "summary") ??
    stringValue(payload.result) ??
    stringValue(payload.output) ??
    stringValue(payload.last_assistant_message) ??
    stringField(nestedStop, "result") ??
    stringField(nestedStop, "output");
  if (!summary || summary.length < 8) {
    return null;
  }
  const task =
    stringValue(payload.task) ??
    stringValue(payload.prompt) ??
    stringField(structured, "title") ??
    record.agentType ??
    "Subagent observation";
  const projectId =
    stringValue(payload.project_id) ?? stringField(structured, "project_id");
  const episode: EpisodeProvenance = {
    episode_id: `episode_${hash({
      timestamp: record.timestamp,
      sessionId: record.sessionId,
      turnId: record.turnId,
      agentId: record.agentId
    })}`,
    session_hash: record.sessionId ?? "unknown-session",
    turn_hash: record.turnId,
    project_id: projectId,
    observed_at: record.timestamp,
    evidence_refs: [
      `subagent:${record.agentType ?? "unknown"}`,
      ...(record.transcriptPath ? [`transcript:${record.transcriptPath}`] : [])
    ]
  };
  return {
    id: `observation_${hash({ episode: episode.episode_id, summary })}`,
    title:
      stringField(structured, "title") ??
      task.trim().replace(/\s+/g, " ").slice(0, 120),
    domain:
      stringField(structured, "domain") ??
      (projectId ? `project/${projectId}` : `agent/${record.agentType ?? "unknown"}`),
    summary,
    sessionHash: episode.session_hash,
    sourceAuthority: normalizeAuthority(
      stringField(structured, "source_authority")
    ),
    memoryType: normalizeMemoryType(stringField(structured, "memory_type")),
    episode
  };
}

/** 追加单个 observation；source watermark 防止同一 Stop 被重复抽取。 */
async function appendObservation(
  rootDir: string,
  observation: ExtractedMaintenanceObservation
): Promise<void> {
  const target = observationPath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(observation)}\n`, "utf8");
}

/** 返回 append-only observation 日志路径。 */
function observationPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "observations", "events.jsonl");
}

/** 读取 SubagentStop 抽取水位。 */
async function readExtractionState(rootDir: string): Promise<ObservationExtractionState> {
  const target = resolveWorkspacePath(
    rootDir,
    ".memory",
    "observations",
    "state.json"
  );
  if (!existsSync(target)) {
    return { sourceWatermark: 0, updatedAt: new Date(0).toISOString() };
  }
  const parsed = JSON.parse(
    await readFile(target, "utf8")
  ) as Partial<ObservationExtractionState>;
  return {
    sourceWatermark:
      typeof parsed.sourceWatermark === "number" &&
      Number.isInteger(parsed.sourceWatermark)
        ? parsed.sourceWatermark
        : 0,
    updatedAt:
      typeof parsed.updatedAt === "string"
        ? parsed.updatedAt
        : new Date(0).toISOString()
  };
}

/** 仅在完整检查源批次后持久化抽取水位，避免中途失败丢事件。 */
async function writeExtractionState(
  rootDir: string,
  state: ObservationExtractionState
): Promise<void> {
  const target = resolveWorkspacePath(
    rootDir,
    ".memory",
    "observations",
    "state.json"
  );
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** 清理全部已消费 Subagent 日志后把 source watermark 重置为零。 */
export async function resetObservationSourceWatermark(
  rootDir: string
): Promise<void> {
  await writeExtractionState(rootDir, {
    sourceWatermark: 0,
    updatedAt: new Date().toISOString()
  });
}

/** 只接受普通对象，拒绝数组和 null。 */
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 只返回 trim 后非空的字符串。 */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** 从可选对象读取单个非空字符串字段。 */
function stringField(
  object: Record<string, unknown> | null,
  field: string
): string | undefined {
  return object ? stringValue(object[field]) : undefined;
}

/** 把不可信 authority 字符串限制到受支持集合，未知值降级为 model_inferred。 */
function normalizeAuthority(
  value: string | undefined
): MaintenanceObservation["sourceAuthority"] {
  return value === "user_confirmed" ||
    value === "documented" ||
    value === "verified_task"
    ? value
    : "model_inferred";
}

/** 把不可信 memory type 字符串限制到 proposal 支持的类型集合。 */
function normalizeMemoryType(
  value: string | undefined
): MaintenanceObservation["memoryType"] {
  return value === "profile" ||
    value === "semantic" ||
    value === "episodic" ||
    value === "procedural"
    ? value
    : undefined;
}

/** 为 observation 和 episode 记录生成稳定短标识。 */
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 20);
}
