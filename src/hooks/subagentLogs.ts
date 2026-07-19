/**
 * Detailed Subagent logs preserve local debugging evidence that redacted staging intentionally drops.
 *
 * These files are never a knowledge source, never synced, and never injected into model context.
 * Start/stop pairing is best-effort because host payloads can be incomplete or interrupted.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";

export type SubagentLogRecord = {
  timestamp: string;
  event: "subagent_start" | "subagent_stop";
  sessionId?: string;
  turnId?: string;
  agentId?: string;
  agentType?: string;
  threadName?: string;
  model?: string;
  permissionMode?: string;
  cwd?: string;
  transcriptPath?: string | null;
  paired: boolean;
  durationMs?: number;
  payload: Record<string, unknown>;
};

export type SubagentLogStatus = {
  totalEvents: number;
  starts: number;
  stops: number;
  pairedStops: number;
  unmatchedStarts: number;
  unmatchedStops: number;
};

type SubagentPairState = {
  starts: Record<string, { timestamp: string; agentType?: string }>;
};

/**
 * Appends one raw Subagent event and updates pairing state.
 *
 * `enabled=false` is a future removal switch: templates can remain installed while detailed writes
 * are disabled after the Subagent workflow becomes stable.
 */
export async function appendSubagentEvent(
  rootDir: string,
  payload: Record<string, unknown>,
  options: { enabled?: boolean; now?: string } = {}
): Promise<{ written: boolean; record?: SubagentLogRecord }> {
  if (options.enabled === false) {
    return { written: false };
  }

  const timestamp = options.now ?? new Date().toISOString();
  const event = normalizeSubagentEvent(payload);
  if (!event) {
    throw new Error("Expected SubagentStart or SubagentStop payload");
  }
  const state = await readPairState(rootDir);
  const pairKey = pairingKey(payload);
  let paired = false;
  let durationMs: number | undefined;

  if (event === "subagent_start" && pairKey) {
    state.starts[pairKey] = {
      timestamp,
      agentType: stringValue(payload.agent_type)
    };
  } else if (event === "subagent_stop" && pairKey) {
    const start = state.starts[pairKey];
    if (start) {
      paired = true;
      durationMs = Math.max(
        0,
        new Date(timestamp).getTime() - new Date(start.timestamp).getTime()
      );
      delete state.starts[pairKey];
    }
  }

  const record: SubagentLogRecord = {
    timestamp,
    event,
    sessionId: stringValue(payload.session_id),
    turnId: stringValue(payload.turn_id),
    agentId: stringValue(payload.agent_id),
    agentType:
      stringValue(payload.agent_type) ??
      nestedString(payload, "subagent_stop", "subagent_name"),
    threadName:
      stringValue(payload.thread_name) ?? stringValue(payload.session_name),
    model: stringValue(payload.model),
    permissionMode: stringValue(payload.permission_mode),
    cwd: stringValue(payload.cwd),
    transcriptPath:
      typeof payload.transcript_path === "string" || payload.transcript_path === null
        ? payload.transcript_path
        : undefined,
    paired,
    durationMs,
    payload
  };

  const logPath = getSubagentLogPath(rootDir, new Date(timestamp));
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  await writePairState(rootDir, state);
  return { written: true, record };
}

/** Returns detailed logs across all daily files with optional agent/event filters. */
export async function readSubagentLogs(
  rootDir: string,
  options: {
    agentType?: string;
    event?: "subagent_start" | "subagent_stop";
    limit?: number;
  }
): Promise<SubagentLogRecord[]> {
  const directory = resolveWorkspacePath(rootDir, ".memory", "subagents");
  if (!existsSync(directory)) {
    return [];
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const records: SubagentLogRecord[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const lines = (await readFile(path.join(directory, entry.name), "utf8"))
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      const record = JSON.parse(line) as SubagentLogRecord;
      if (options.agentType && record.agentType !== options.agentType) {
        continue;
      }
      if (options.event && record.event !== options.event) {
        continue;
      }
      records.push(record);
    }
  }
  return records
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .slice(-(options.limit ?? 100));
}

/** Summarizes pairing health without exposing payload contents in the status output. */
export async function getSubagentLogStatus(rootDir: string): Promise<SubagentLogStatus> {
  const records = await readSubagentLogs(rootDir, { limit: Number.MAX_SAFE_INTEGER });
  const starts = records.filter((record) => record.event === "subagent_start").length;
  const stops = records.filter((record) => record.event === "subagent_stop").length;
  const pairedStops = records.filter(
    (record) => record.event === "subagent_stop" && record.paired
  ).length;
  const state = await readPairState(rootDir);
  return {
    totalEvents: records.length,
    starts,
    stops,
    pairedStops,
    unmatchedStarts: Object.keys(state.starts).length,
    unmatchedStops: stops - pairedStops
  };
}

/** Resolves the daily append-only detailed log path. */
export function getSubagentLogPath(rootDir: string, date = new Date()): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "subagents",
    `${date.toISOString().slice(0, 10)}.jsonl`
  );
}

/** Distinguishes current and compatibility event field names. */
function normalizeSubagentEvent(
  payload: Record<string, unknown>
): "subagent_start" | "subagent_stop" | null {
  const raw = String(payload.hook_event_name ?? payload.event_type ?? "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase();
  if (raw === "subagent_start") {
    return "subagent_start";
  }
  if (raw === "subagent_stop") {
    return "subagent_stop";
  }
  return null;
}

/**
 * Builds a stable pairing key. Agent ID is authoritative; session+type is only a compatibility
 * fallback and can pair incorrectly if the host runs multiple same-type Subagents concurrently.
 */
function pairingKey(payload: Record<string, unknown>): string | null {
  const agentId = stringValue(payload.agent_id);
  if (agentId) {
    return `agent:${agentId}`;
  }
  const sessionId = stringValue(payload.session_id);
  const agentType =
    stringValue(payload.agent_type) ??
    nestedString(payload, "subagent_stop", "subagent_name");
  return sessionId && agentType ? `session:${sessionId}:${agentType}` : null;
}

/** Reads persisted unmatched starts used for cross-process pairing. */
async function readPairState(rootDir: string): Promise<SubagentPairState> {
  const target = resolveWorkspacePath(rootDir, ".memory", "subagents", "state.json");
  if (!existsSync(target)) {
    return { starts: {} };
  }
  const parsed = JSON.parse(await readFile(target, "utf8")) as Partial<SubagentPairState>;
  return {
    starts: parsed.starts && typeof parsed.starts === "object" ? parsed.starts : {}
  };
}

/** Persists pairing state separately so daily log rotation does not lose open Subagents. */
async function writePairState(rootDir: string, state: SubagentPairState): Promise<void> {
  const target = resolveWorkspacePath(rootDir, ".memory", "subagents", "state.json");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Returns a non-empty string payload field. */
function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a nested compatibility string without trusting arbitrary object shapes. */
function nestedString(
  payload: Record<string, unknown>,
  parent: string,
  child: string
): string | undefined {
  const value = payload[parent];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return stringValue((value as Record<string, unknown>)[child]);
}
