/**
 * Observation extraction turns detailed SubagentStop evidence into stable maintenance inputs.
 *
 * Source logs remain intact for debugging. A separate source watermark makes extraction idempotent,
 * while append-only observations let proposal generation replay independently.
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

/** Extracts newly appended SubagentStop events and advances the source watermark. */
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

/** Reads all extracted observations in append order. */
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

/** Reports source-log and observation watermarks for operators. */
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
 * Prefers structured result fields and then common text fallbacks.
 * Events without reusable text are skipped instead of creating noisy long-term observations.
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

/** Appends one observation; the source watermark prevents duplicate extraction. */
async function appendObservation(
  rootDir: string,
  observation: ExtractedMaintenanceObservation
): Promise<void> {
  const target = observationPath(rootDir);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(observation)}\n`, "utf8");
}

/** Resolves the append-only observation log path. */
function observationPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "observations", "events.jsonl");
}

/** Reads the SubagentStop extraction watermark. */
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

/** Persists extraction state only after the complete source batch has been examined. */
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

/** Returns a plain object while rejecting arrays and null. */
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Returns a non-empty string. */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Reads one string field from an optional object. */
function stringField(
  object: Record<string, unknown> | null,
  field: string
): string | undefined {
  return object ? stringValue(object[field]) : undefined;
}

/** Restricts untrusted authority strings to supported values. */
function normalizeAuthority(
  value: string | undefined
): MaintenanceObservation["sourceAuthority"] {
  return value === "user_confirmed" ||
    value === "documented" ||
    value === "verified_task"
    ? value
    : "model_inferred";
}

/** Restricts untrusted memory type strings to supported proposal values. */
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

/** Produces a stable short identifier for observation and episode records. */
function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 20);
}
