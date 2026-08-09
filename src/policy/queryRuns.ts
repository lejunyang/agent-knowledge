/**
 * Query-run ledger 保存“记忆如何被检索和注入”的隐私安全证据。
 *
 * Ledger 位于 `.memory/query-runs`，不是事实源，也不参与同步。它只保存 task hash/长度、
 * scope、候选 ID 和注入 ID；禁止在此处保存 prompt、知识正文或结果文本。
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";
import { redactEvidenceText } from "../ingestion/redaction.js";
import { putVaultObject, type VaultOptions } from "../vault/core.js";

const HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);

const QueryRunScoreSchema = z
  .object({
    id: z.string().min(1),
    finalScore: z.number(),
    queryCoverageScore: z.number()
  })
  .strict();

const QueryRunEventSchema = z.discriminatedUnion("phase", [
  z
    .object({
      version: z.literal(1),
      phase: z.literal("retrieval"),
      queryRunId: z.string().min(1),
      timestamp: z.string().datetime(),
      taskHash: HashSchema,
      taskLength: z.number().int().nonnegative(),
      taskVaultId: z.string().min(1).optional(),
      domains: z.array(z.string()),
      scenarios: z.array(z.string()),
      projectKeys: z.array(z.string()),
      retrievalMode: z.string().min(1),
      candidateIds: z.array(z.string()),
      resultScores: z.array(QueryRunScoreSchema)
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      phase: z.literal("packet"),
      queryRunId: z.string().min(1),
      timestamp: z.string().datetime(),
      injectedIds: z.array(z.string()),
      abstained: z.boolean()
    })
    .strict()
]);

export const QueryRunSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    timestamp: z.string().datetime(),
    taskHash: HashSchema,
    taskLength: z.number().int().nonnegative(),
    taskVaultId: z.string().min(1).optional(),
    domains: z.array(z.string()),
    scenarios: z.array(z.string()),
    projectKeys: z.array(z.string()),
    retrievalMode: z.string().min(1),
    candidateIds: z.array(z.string()),
    injectedIds: z.array(z.string()),
    abstained: z.boolean(),
    resultScores: z.array(QueryRunScoreSchema)
  })
  .strict();

export type QueryRun = z.output<typeof QueryRunSchema>;
type QueryRunEvent = z.output<typeof QueryRunEventSchema>;

export type RetainedQueryTaskEvidence = {
  vaultId: string;
  bytes: number;
  redactionCounts: Record<string, number>;
};

/** 返回按日分片的 query-run ledger 路径。 */
export function getQueryRunLedgerPath(
  rootDir: string,
  date = new Date()
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "query-runs",
    `${date.toISOString().slice(0, 10)}.jsonl`
  );
}

/** 计算 task 的不可逆 hash；hash 只用于关联，不用于恢复原文。 */
function taskHash(task: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(task).digest("hex")}`;
}

/** 追加 owner-only 事件；默认 best-effort，日志故障不能中断正常 query。 */
function appendQueryRunEvent(rootDir: string, event: QueryRunEvent): void {
  try {
    const target = getQueryRunLedgerPath(rootDir, new Date(event.timestamp));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    appendFileSync(target, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    chmodSync(target, 0o600);
  } catch {
    // Query 热路径优先可用；policy doctor 可通过缺失 run 发现审计证据不完整。
  }
}

/** 记录最终 retrieval 结果；内部 base pipeline 必须关闭日志避免重复。 */
export function recordQueryRetrieval(
  rootDir: string,
  input: {
    queryRunId: string;
    task: string;
    taskVaultId?: string;
    domains: string[];
    scenarios: string[];
    projectKeys: string[];
    retrievalMode: string;
    candidateIds: string[];
    resultScores: Array<{
      id: string;
      finalScore: number;
      queryCoverageScore: number;
    }>;
    now?: Date;
  }
): void {
  appendQueryRunEvent(
    rootDir,
    QueryRunEventSchema.parse({
      version: 1,
      phase: "retrieval",
      queryRunId: input.queryRunId,
      timestamp: (input.now ?? new Date()).toISOString(),
      taskHash: taskHash(input.task),
      taskLength: input.task.length,
      taskVaultId: input.taskVaultId,
      domains: input.domains,
      scenarios: input.scenarios,
      projectKeys: input.projectKeys,
      retrievalMode: input.retrievalMode,
      candidateIds: input.candidateIds,
      resultScores: input.resultScores
    })
  );
}

/** 记录 token budget 后真正进入 Context Packet 的 ID 和 abstention 决策。 */
export function recordQueryPacket(
  rootDir: string,
  input: {
    queryRunId: string;
    injectedIds: string[];
    now?: Date;
  }
): void {
  appendQueryRunEvent(
    rootDir,
    QueryRunEventSchema.parse({
      version: 1,
      phase: "packet",
      queryRunId: input.queryRunId,
      timestamp: (input.now ?? new Date()).toISOString(),
      injectedIds: input.injectedIds,
      abstained: input.injectedIds.length === 0
    })
  );
}

/** 显式把经 secrets-and-pii 脱敏的 task 加密进 Vault；普通 query 永远不会自动调用。 */
export async function retainQueryTaskEvidence(
  rootDir: string,
  task: string,
  options: VaultOptions
): Promise<RetainedQueryTaskEvidence> {
  const redacted = redactEvidenceText(task, "secrets-and-pii");
  const bytes = Buffer.from(redacted.text, "utf8");
  const stored = await putVaultObject(
    rootDir,
    {
      bytes,
      contentType: "text/plain; charset=utf-8"
    },
    { ...options, actor: options.actor ?? "policy-query-task" }
  );
  return {
    vaultId: stored.id,
    bytes: stored.bytes,
    redactionCounts: redacted.counts
  };
}

/** 读取全部合法 ledger 事件；损坏行跳过，避免单行破坏长期诊断。 */
function readQueryRunEvents(rootDir: string): QueryRunEvent[] {
  const directory = resolveWorkspacePath(rootDir, ".memory", "query-runs");
  if (!existsSync(directory)) {
    return [];
  }
  const events: QueryRunEvent[] = [];
  for (const entry of readdirSync(directory, {
    withFileTypes: true
  }).sort((left, right) => left.name.localeCompare(right.name))) {
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
        const parsed = QueryRunEventSchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          events.push(parsed.data);
        }
      } catch {
        // 损坏或半写行只影响自身，其他 run 仍可用于 policy mining。
      }
    }
  }
  return events;
}

/** 合并 retrieval/packet 两阶段事件；未完成 packet 的 run 仍保留空注入集合。 */
export async function listQueryRuns(rootDir: string): Promise<QueryRun[]> {
  const runs = new Map<string, Partial<QueryRun>>();
  for (const event of readQueryRunEvents(rootDir)) {
    const current = runs.get(event.queryRunId) ?? {
      version: 1,
      id: event.queryRunId,
      injectedIds: [],
      abstained: false
    };
    if (event.phase === "retrieval") {
      Object.assign(current, {
        timestamp: event.timestamp,
        taskHash: event.taskHash,
        taskLength: event.taskLength,
        taskVaultId: event.taskVaultId,
        domains: event.domains,
        scenarios: event.scenarios,
        projectKeys: event.projectKeys,
        retrievalMode: event.retrievalMode,
        candidateIds: event.candidateIds,
        resultScores: event.resultScores
      });
    } else {
      current.injectedIds = event.injectedIds;
      current.abstained = event.abstained;
    }
    runs.set(event.queryRunId, current);
  }
  return [...runs.values()]
    .flatMap((run) => {
      const parsed = QueryRunSchema.safeParse(run);
      return parsed.success ? [parsed.data] : [];
    })
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.id.localeCompare(right.id)
    );
}

/** 按 ID 返回单次 query run；缺失或只有损坏事件时返回 null。 */
export async function readQueryRun(
  rootDir: string,
  queryRunId: string
): Promise<QueryRun | null> {
  return (
    (await listQueryRuns(rootDir)).find((run) => run.id === queryRunId) ?? null
  );
}
