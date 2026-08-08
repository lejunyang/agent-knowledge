/**
 * Lifecycle event ledger 为客服 case 和需求 initiative 提供 append-only 时间线。
 *
 * Git 只保存经过 secret/PII 治理的摘要、scope、hash chain 和 Vault handle；完整 payload
 * 在写入前治理后进入加密 Vault。Event 记录“发生了什么”，不能直接晋升为长期业务事实。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  readdir,
  rm,
  stat
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ActorTypeSchema,
  CaptureModeSchema,
  ProjectKeySchema
} from "../core/knowledgeV2.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { redactEvidenceText } from "../ingestion/redaction.js";
import {
  getVaultObjectPath,
  putVaultObject,
  vaultObjectId,
  writeVaultObjectToFile,
  type VaultOptions
} from "../vault/core.js";

export const EventStreamTypeSchema = z.enum(["support", "initiative"]);
export const SupportEventStageSchema = z.enum([
  "intake",
  "triage",
  "query",
  "hypothesis",
  "root_cause",
  "action",
  "verification",
  "escalation",
  "closure",
  "recurrence"
]);
export const InitiativeEventStageSchema = z.enum([
  "discovery",
  "review",
  "design",
  "development",
  "testing",
  "release",
  "operations",
  "incident",
  "retrospective",
  "cancelled"
]);

const StreamIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,127}$/);
const EventIdSchema = z.string().regex(/^evt_[a-f0-9-]{36}$/);
const EventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9._-]{1,127}$/);
const Sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const VaultObjectIdSchema = z
  .string()
  .regex(/^vault_sha256_[a-f0-9]{64}$/);

const EventRecordWithoutHashSchema = z.object({
  version: z.literal(1),
  event_id: EventIdSchema,
  stream_type: EventStreamTypeSchema,
  stream_id: StreamIdSchema,
  sequence: z.number().int().positive(),
  timestamp: z.string().datetime(),
  stage: z.string().min(1),
  event_type: EventTypeSchema,
  summary: z.string().min(1).max(2000),
  project_keys: z.array(ProjectKeySchema),
  actor_type: ActorTypeSchema,
  capture_mode: CaptureModeSchema,
  parent_event_id: EventIdSchema.optional(),
  idempotency_key_hash: Sha256Schema.optional(),
  input_hash: Sha256Schema,
  payload_object: VaultObjectIdSchema.optional(),
  payload_content_type: z.string().min(1).optional(),
  redactions: z.record(z.string(), z.number().int().positive()),
  previous_hash: Sha256Schema.nullable()
});

export const LifecycleEventRecordSchema =
  EventRecordWithoutHashSchema.extend({
    record_hash: Sha256Schema
  });

export type EventStreamType = z.output<typeof EventStreamTypeSchema>;
export type SupportEventStage = z.output<typeof SupportEventStageSchema>;
export type InitiativeEventStage = z.output<
  typeof InitiativeEventStageSchema
>;
export type LifecycleEventRecord = z.output<
  typeof LifecycleEventRecordSchema
>;

type CommonAppendInput = {
  streamId: string;
  eventType: string;
  summary: string;
  payloadText?: string;
  payloadContentType?: string;
  projectKeys: string[];
  actorType: z.input<typeof ActorTypeSchema>;
  captureMode: z.input<typeof CaptureModeSchema>;
  parentEventId?: string;
  idempotencyKey?: string;
};

export type AppendLifecycleEventInput =
  | (CommonAppendInput & {
      streamType: "support";
      stage: SupportEventStage;
    })
  | (CommonAppendInput & {
      streamType: "initiative";
      stage: InitiativeEventStage;
    });

export type AppendLifecycleEventResult = {
  eventId: string;
  streamType: EventStreamType;
  streamId: string;
  sequence: number;
  recordHash: string;
  payloadObject?: string;
  timelinePath: string;
  deduplicated: boolean;
};

export type EventTimeline = {
  streamType: EventStreamType;
  streamId: string;
  status: "active" | "closed" | "completed" | "cancelled";
  latestStage: string | null;
  integrity: {
    valid: true;
    events: number;
  };
  events: LifecycleEventRecord[];
};

export type EventLedgerStatus = {
  streams: number;
  events: number;
  payloadBackedEvents: number;
  missingPayloads: number;
  byStreamType: {
    support: number;
    initiative: number;
  };
  byStatus: Record<string, number>;
};

export type EventStreamSummary = {
  streamType: EventStreamType;
  streamId: string;
  status: EventTimeline["status"];
  events: number;
  latestStage: string | null;
  latestTimestamp: string | null;
  projectKeys: string[];
};

export type EventStreamList = {
  total: number;
  items: EventStreamSummary[];
};

/** 计算统一 SHA-256 字段。 */
function sha256(value: Buffer | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** support/initiative 使用独立 Git 目录，避免 event 类型混淆。 */
function streamDirectory(streamType: EventStreamType): string {
  return streamType === "support" ? "support" : "projects";
}

/** 返回单个 append-only timeline 路径。 */
export function getEventTimelinePath(
  rootDir: string,
  streamType: EventStreamType,
  streamId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    "events",
    streamDirectory(EventStreamTypeSchema.parse(streamType)),
    `${StreamIdSchema.parse(streamId)}.jsonl`
  );
}

/** 返回每个 stream 的本机互斥锁路径；锁不进入 Git。 */
function getEventLockPath(
  rootDir: string,
  streamType: EventStreamType,
  streamId: string
): string {
  const key = `${streamType}:${streamId}`;
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "events",
    "locks",
    `${createHash("sha256").update(key).digest("hex").slice(0, 24)}.lock`
  );
}

/** 检查锁 owner PID；权限错误也视为活跃，不能冒险抢锁。 */
function processIsAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EPERM"
    );
  }
}

/** 短暂等待活跃 writer；同进程/跨进程并发 append 都应串行而不是随机失败。 */
async function waitForEventLock(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** 获取 stream append 锁；死 PID 锁可恢复，活跃 writer 在有界超时内排队。 */
async function acquireEventLock(
  rootDir: string,
  streamType: EventStreamType,
  streamId: string
): Promise<() => Promise<void>> {
  const lockPath = getEventLockPath(rootDir, streamType, streamId);
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 10_000;
  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      const token = randomUUID();
      await handle.writeFile(
        `${JSON.stringify({
          version: 1,
          pid: process.pid,
          token,
          createdAt: new Date().toISOString()
        })}\n`,
        "utf8"
      );
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(
            await readFile(lockPath, "utf8")
          ) as { token?: unknown };
          if (current.token === token) {
            await rm(lockPath, { force: true });
          }
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      let owner: { pid?: unknown } = {};
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
        };
      } catch {
        throw new Error(`Event stream is already locked: ${streamId}`);
      }
      if (typeof owner.pid !== "number") {
        throw new Error(`Event stream is already locked: ${streamId}`);
      }
      if (processIsAlive(owner.pid)) {
        await waitForEventLock();
        continue;
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error(`Timed out waiting for event stream lock: ${streamId}`);
}

/** 校验 stream type 对应 stage，禁止 support/initiative 阶段串用。 */
function validateStage(
  streamType: EventStreamType,
  stage: string
): string {
  return streamType === "support"
    ? SupportEventStageSchema.parse(stage)
    : InitiativeEventStageSchema.parse(stage);
}

/** 合并 summary/payload 脱敏计数，保留来源前缀但不保存原值。 */
function mergedRedactions(
  summary: Record<string, number>,
  payload: Record<string, number>
): Record<string, number> {
  return Object.fromEntries([
    ...Object.entries(summary).map(([kind, count]) => [
      `summary.${kind}`,
      count
    ]),
    ...Object.entries(payload).map(([kind, count]) => [
      `payload.${kind}`,
      count
    ])
  ]);
}

/** 按 schema 固定字段顺序重建 hash 输入，避免对象插入顺序造成假篡改。 */
function recordHash(
  record: z.output<typeof EventRecordWithoutHashSchema>
): string {
  return sha256(
    JSON.stringify(EventRecordWithoutHashSchema.parse(record))
  );
}

/** 读取 timeline，并对每条 hash、sequence、parent 和 previous hash 做完整验证。 */
async function readAndVerifyTimeline(
  rootDir: string,
  streamType: EventStreamType,
  streamId: string
): Promise<LifecycleEventRecord[]> {
  const target = getEventTimelinePath(rootDir, streamType, streamId);
  if (!existsSync(target)) {
    return [];
  }
  const records: LifecycleEventRecord[] = [];
  const seen = new Set<string>();
  for (const [index, line] of (await readFile(target, "utf8"))
    .split("\n")
    .filter(Boolean)
    .entries()) {
    let record: LifecycleEventRecord;
    try {
      record = LifecycleEventRecordSchema.parse(JSON.parse(line));
    } catch {
      throw new Error(
        `Event timeline integrity check failed at line ${index + 1}: ${streamId}`
      );
    }
    const base = EventRecordWithoutHashSchema.parse(record);
    const expectedPrevious =
      records.at(-1)?.record_hash ?? null;
    if (
      record.stream_type !== streamType ||
      record.stream_id !== streamId ||
      record.sequence !== index + 1 ||
      record.previous_hash !== expectedPrevious ||
      record.record_hash !== recordHash(base) ||
      seen.has(record.event_id) ||
      (record.parent_event_id !== undefined &&
        !seen.has(record.parent_event_id))
    ) {
      throw new Error(
        `Event timeline integrity check failed at line ${index + 1}: ${streamId}`
      );
    }
    validateStage(record.stream_type, record.stage);
    records.push(record);
    seen.add(record.event_id);
  }
  return records;
}

/** 根据 append-only stages 派生当前状态，不把状态作为可覆盖字段单独持久化。 */
function timelineStatus(
  streamType: EventStreamType,
  records: LifecycleEventRecord[]
): EventTimeline["status"] {
  const stages = new Set(records.map((record) => record.stage));
  if (streamType === "support") {
    return stages.has("closure") ? "closed" : "active";
  }
  if (stages.has("cancelled")) {
    return "cancelled";
  }
  return stages.has("retrospective") ? "completed" : "active";
}

/** 生成 idempotency input hash；timestamp/event ID 不参与，重试才能命中相同事件。 */
function eventInputHash(input: {
  streamType: EventStreamType;
  streamId: string;
  stage: string;
  eventType: string;
  summary: string;
  projectKeys: string[];
  actorType: string;
  captureMode: string;
  parentEventId?: string;
  payloadObject?: string;
  payloadContentType?: string;
}): string {
  return sha256(
    JSON.stringify({
      stream_type: input.streamType,
      stream_id: input.streamId,
      stage: input.stage,
      event_type: input.eventType,
      summary: input.summary,
      project_keys: [...input.projectKeys].sort(),
      actor_type: input.actorType,
      capture_mode: input.captureMode,
      parent_event_id: input.parentEventId ?? null,
      payload_object: input.payloadObject ?? null,
      payload_content_type: input.payloadContentType ?? null
    })
  );
}

/** 追加一条事件；同 idempotency key 的相同输入幂等，不同输入冲突失败。 */
export async function appendLifecycleEvent(
  rootDir: string,
  input: AppendLifecycleEventInput,
  options: VaultOptions
): Promise<AppendLifecycleEventResult> {
  const streamType = EventStreamTypeSchema.parse(input.streamType);
  const streamId = StreamIdSchema.parse(input.streamId);
  if (
    redactEvidenceText(streamId, "secrets-and-pii").text !== streamId
  ) {
    throw new Error("Event stream ID contains secret or PII");
  }
  const stage = validateStage(streamType, input.stage);
  const eventType = EventTypeSchema.parse(input.eventType);
  const projectKeys = input.projectKeys.map((projectKey) =>
    ProjectKeySchema.parse(projectKey)
  );
  const actorType = ActorTypeSchema.parse(input.actorType);
  const captureMode = CaptureModeSchema.parse(input.captureMode);
  const parentEventId = input.parentEventId
    ? EventIdSchema.parse(input.parentEventId)
    : undefined;
  const summary = redactEvidenceText(
    input.summary,
    "secrets-and-pii"
  );
  const payload = input.payloadText === undefined
    ? null
    : redactEvidenceText(input.payloadText, "secrets-and-pii");
  if (
    (input.payloadText === undefined) !==
    (input.payloadContentType === undefined)
  ) {
    throw new Error(
      "Event payloadText and payloadContentType must be provided together"
    );
  }
  const payloadBytes = payload
    ? Buffer.from(payload.text, "utf8")
    : undefined;
  const predictedPayloadObject = payloadBytes
    ? vaultObjectId(payloadBytes)
    : undefined;
  const idempotencyKeyHash = input.idempotencyKey
    ? sha256(input.idempotencyKey)
    : undefined;
  const inputHash = eventInputHash({
    streamType,
    streamId,
    stage,
    eventType,
    summary: summary.text,
    projectKeys,
    actorType,
    captureMode,
    parentEventId,
    payloadObject: predictedPayloadObject,
    payloadContentType: input.payloadContentType
  });
  const release = await acquireEventLock(
    rootDir,
    streamType,
    streamId
  );
  try {
    const records = await readAndVerifyTimeline(
      rootDir,
      streamType,
      streamId
    );
    if (idempotencyKeyHash) {
      const existing = records.find(
        (record) =>
          record.idempotency_key_hash === idempotencyKeyHash
      );
      if (existing) {
        if (existing.input_hash !== inputHash) {
          throw new Error(
            `Event idempotency key conflict: ${streamId}`
          );
        }
        return {
          eventId: existing.event_id,
          streamType,
          streamId,
          sequence: existing.sequence,
          recordHash: existing.record_hash,
          ...(existing.payload_object
            ? { payloadObject: existing.payload_object }
            : {}),
          timelinePath: getEventTimelinePath(
            rootDir,
            streamType,
            streamId
          ),
          deduplicated: true
        };
      }
    }
    if (
      parentEventId !== undefined &&
      !records.some((record) => record.event_id === parentEventId)
    ) {
      throw new Error(
        `Parent event does not exist in stream: ${parentEventId}`
      );
    }
    let payloadObject: string | undefined;
    if (payloadBytes && input.payloadContentType) {
      const stored = await putVaultObject(
        rootDir,
        {
          bytes: payloadBytes,
          contentType: input.payloadContentType
        },
        options
      );
      payloadObject = stored.id;
    }
    const timestamp = (options.now?.() ?? new Date()).toISOString();
    const base = EventRecordWithoutHashSchema.parse({
      version: 1,
      event_id: `evt_${randomUUID()}`,
      stream_type: streamType,
      stream_id: streamId,
      sequence: records.length + 1,
      timestamp,
      stage,
      event_type: eventType,
      summary: summary.text,
      project_keys: projectKeys,
      actor_type: actorType,
      capture_mode: captureMode,
      ...(parentEventId ? { parent_event_id: parentEventId } : {}),
      ...(idempotencyKeyHash
        ? { idempotency_key_hash: idempotencyKeyHash }
        : {}),
      input_hash: inputHash,
      ...(payloadObject ? { payload_object: payloadObject } : {}),
      ...(input.payloadContentType
        ? { payload_content_type: input.payloadContentType }
        : {}),
      redactions: mergedRedactions(
        summary.counts,
        payload?.counts ?? {}
      ),
      previous_hash: records.at(-1)?.record_hash ?? null
    });
    const record = LifecycleEventRecordSchema.parse({
      ...base,
      record_hash: recordHash(base)
    });
    const timelinePath = getEventTimelinePath(
      rootDir,
      streamType,
      streamId
    );
    await mkdir(path.dirname(timelinePath), { recursive: true });
    await appendFile(
      timelinePath,
      `${JSON.stringify(record)}\n`,
      { encoding: "utf8", mode: 0o644 }
    );
    await chmod(timelinePath, 0o644);
    return {
      eventId: record.event_id,
      streamType,
      streamId,
      sequence: record.sequence,
      recordHash: record.record_hash,
      ...(record.payload_object
        ? { payloadObject: record.payload_object }
        : {}),
      timelinePath,
      deduplicated: false
    };
  } finally {
    await release();
  }
}

/** 返回单个 stream 的完整脱敏 timeline，并在返回前验证 hash chain。 */
export async function getEventTimeline(
  rootDir: string,
  streamTypeInput: string,
  streamIdInput: string
): Promise<EventTimeline> {
  const streamType = EventStreamTypeSchema.parse(streamTypeInput);
  const streamId = StreamIdSchema.parse(streamIdInput);
  const events = await readAndVerifyTimeline(
    rootDir,
    streamType,
    streamId
  );
  return {
    streamType,
    streamId,
    status: timelineStatus(streamType, events),
    latestStage: events.at(-1)?.stage ?? null,
    integrity: {
      valid: true,
      events: events.length
    },
    events
  };
}

/** 跨全部 timeline 定位 event；任何损坏 timeline 都明确失败，不能跳过审计。 */
async function findEvent(
  rootDir: string,
  eventIdInput: string
): Promise<LifecycleEventRecord> {
  const eventId = EventIdSchema.parse(eventIdInput);
  for (const streamType of EventStreamTypeSchema.options) {
    const directory = resolveWorkspacePath(
      rootDir,
      "events",
      streamDirectory(streamType)
    );
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of (await readdir(directory, {
      withFileTypes: true
    })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const streamId = entry.name.slice(0, -".jsonl".length);
      const records = await readAndVerifyTimeline(
        rootDir,
        streamType,
        streamId
      );
      const match = records.find(
        (record) => record.event_id === eventId
      );
      if (match) {
        return match;
      }
    }
  }
  throw new Error(`Lifecycle event not found: ${eventId}`);
}

/** 显示事件 metadata 与 payload handle，不读取完整 payload。 */
export async function showLifecycleEvent(
  rootDir: string,
  eventId: string
): Promise<
  LifecycleEventRecord & {
    payloadAvailable: boolean;
  }
> {
  const event = await findEvent(rootDir, eventId);
  return {
    ...event,
    payloadAvailable:
      event.payload_object !== undefined &&
      existsSync(getVaultObjectPath(rootDir, event.payload_object))
  };
}

/** 确保解密 event payload 不会落入 knowledge workspace 或 symlink 回指 workspace。 */
async function assertOutsideWorkspace(
  rootDir: string,
  outputPath: string
): Promise<void> {
  const workspace = await realpath(path.resolve(rootDir)).catch(() =>
    path.resolve(rootDir)
  );
  const output = path.resolve(outputPath);
  const lexical = path.relative(path.resolve(rootDir), output);
  if (
    lexical === "" ||
    (!lexical.startsWith("..") && !path.isAbsolute(lexical))
  ) {
    throw new Error(
      "Event payload output must be outside the knowledge workspace"
    );
  }
  const missing: string[] = [];
  let ancestor = output;
  while (!existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      break;
    }
    missing.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const realAncestor = await realpath(ancestor);
  const realTarget = path.resolve(realAncestor, ...missing);
  const relative = path.relative(workspace, realTarget);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    throw new Error(
      "Event payload output must be outside the knowledge workspace"
    );
  }
}

/** 把完整 event payload 解密到 workspace 外显式 0600 文件，不向 stdout 返回内容。 */
export async function exportEventPayload(
  rootDir: string,
  input: {
    eventId: string;
    outputPath: string;
    overwrite?: boolean;
  },
  options: VaultOptions
): Promise<{
  eventId: string;
  outputPath: string;
  bytes: number;
  contentType: string;
}> {
  const event = await findEvent(rootDir, input.eventId);
  if (!event.payload_object) {
    throw new Error(`Lifecycle event has no payload: ${event.event_id}`);
  }
  await assertOutsideWorkspace(rootDir, input.outputPath);
  const exported = await writeVaultObjectToFile(
    rootDir,
    {
      id: event.payload_object,
      outputPath: input.outputPath,
      overwrite: input.overwrite
    },
    options
  );
  return {
    eventId: event.event_id,
    outputPath: exported.outputPath,
    bytes: exported.bytes,
    contentType: exported.contentType
  };
}

/** 聚合事件数、stream 数和状态，不返回摘要、payload handle 或 stream ID。 */
export async function getEventLedgerStatus(
  rootDir: string
): Promise<EventLedgerStatus> {
  const byStreamType = { support: 0, initiative: 0 };
  const byStatus: Record<string, number> = {};
  let events = 0;
  let payloadBackedEvents = 0;
  let missingPayloads = 0;
  for (const streamType of EventStreamTypeSchema.options) {
    const directory = resolveWorkspacePath(
      rootDir,
      "events",
      streamDirectory(streamType)
    );
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of await readdir(directory, {
      withFileTypes: true
    })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const streamId = entry.name.slice(0, -".jsonl".length);
      const timeline = await getEventTimeline(
        rootDir,
        streamType,
        streamId
      );
      byStreamType[streamType] += 1;
      byStatus[timeline.status] =
        (byStatus[timeline.status] ?? 0) + 1;
      events += timeline.events.length;
      payloadBackedEvents += timeline.events.filter(
        (event) => event.payload_object !== undefined
      ).length;
      missingPayloads += timeline.events.filter(
        (event) =>
          event.payload_object !== undefined &&
          !existsSync(getVaultObjectPath(rootDir, event.payload_object))
      ).length;
    }
  }
  return {
    streams: byStreamType.support + byStreamType.initiative,
    events,
    payloadBackedEvents,
    missingPayloads,
    byStreamType,
    byStatus
  };
}

/** 列出 stream 级时间线摘要，不返回事件 summary、payload handle 或 idempotency hash。 */
export async function listEventStreams(
  rootDir: string,
  options: {
    streamType?: string;
    status?: string;
    projectKeys?: string[];
  } = {}
): Promise<EventStreamList> {
  const requestedType = options.streamType
    ? EventStreamTypeSchema.parse(options.streamType)
    : undefined;
  const requestedProjects = new Set(
    (options.projectKeys ?? []).map((projectKey) =>
      ProjectKeySchema.parse(projectKey)
    )
  );
  const items: EventStreamSummary[] = [];
  for (const streamType of EventStreamTypeSchema.options) {
    if (requestedType && streamType !== requestedType) {
      continue;
    }
    const directory = resolveWorkspacePath(
      rootDir,
      "events",
      streamDirectory(streamType)
    );
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of (await readdir(directory, {
      withFileTypes: true
    })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const streamId = entry.name.slice(0, -".jsonl".length);
      const timeline = await getEventTimeline(
        rootDir,
        streamType,
        streamId
      );
      if (options.status && timeline.status !== options.status) {
        continue;
      }
      const projectKeys = [
        ...new Set(
          timeline.events.flatMap((event) => event.project_keys)
        )
      ].sort();
      if (
        requestedProjects.size > 0 &&
        !projectKeys.some((projectKey) =>
          requestedProjects.has(projectKey)
        )
      ) {
        continue;
      }
      items.push({
        streamType,
        streamId,
        status: timeline.status,
        events: timeline.events.length,
        latestStage: timeline.latestStage,
        latestTimestamp: timeline.events.at(-1)?.timestamp ?? null,
        projectKeys
      });
    }
  }
  return {
    total: items.length,
    items: items.sort(
      (left, right) =>
        (right.latestTimestamp ?? "").localeCompare(
          left.latestTimestamp ?? ""
        ) ||
        left.streamType.localeCompare(right.streamType) ||
        left.streamId.localeCompare(right.streamId)
    )
  };
}
