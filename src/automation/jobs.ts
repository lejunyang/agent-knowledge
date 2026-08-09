/**
 * Automation jobs 为外部 scheduler/Agent 提供幂等运行身份和最小状态。
 *
 * Job ID 由 profile + idempotency key 稳定生成；同一调度窗口重试不会创建重复任务或通知。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  AutomationJobSchema,
  type AutomationJob
} from "./types.js";

export type AutomationJobHandle = AutomationJob & { path: string };

/** 生成不泄露 idempotency key 的稳定 job ID。 */
function automationJobId(profileId: string, idempotencyKey: string): string {
  return `job_${createHash("sha256")
    .update(`${profileId}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 返回 job 文件路径；ID 先经过 schema 校验，防止目录穿越。 */
export function getAutomationJobPath(rootDir: string, jobId: string): string {
  const parsed = AutomationJobSchema.shape.id.parse(jobId);
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "automation",
    "jobs",
    `${parsed}.json`
  );
}

/** 原子持久化 job；状态属于本机运行产物，不进入 Git。 */
export async function writeAutomationJob(
  rootDir: string,
  rawJob: AutomationJob
): Promise<AutomationJobHandle> {
  const job = AutomationJobSchema.parse(rawJob);
  const target = getAutomationJobPath(rootDir, job.id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(job, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  return { ...job, path: target };
}

/** 读取单个 job；缺失返回 null，损坏状态直接暴露。 */
export async function readAutomationJob(
  rootDir: string,
  jobId: string
): Promise<AutomationJob | null> {
  const target = getAutomationJobPath(rootDir, jobId);
  if (!existsSync(target)) {
    return null;
  }
  return AutomationJobSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** 列出 automation jobs，按更新时间倒序，供 status/外部 Agent 恢复最近任务。 */
export async function listAutomationJobs(
  rootDir: string,
  options: { profileId?: string } = {}
): Promise<AutomationJob[]> {
  const directory = resolveWorkspacePath(
    rootDir,
    ".memory",
    "automation",
    "jobs"
  );
  if (!existsSync(directory)) {
    return [];
  }
  const jobs: AutomationJob[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const job = AutomationJobSchema.parse(
      JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
    );
    if (!options.profileId || job.profileId === options.profileId) {
      jobs.push(job);
    }
  }
  return jobs.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
  );
}

/** 创建幂等 pending job；已存在时返回原记录而不刷新时间。 */
export async function createAutomationJob(
  rootDir: string,
  input: {
    profileId: string;
    idempotencyKey: string;
    trigger: AutomationJob["trigger"];
    now?: Date;
  }
): Promise<AutomationJobHandle> {
  const id = automationJobId(input.profileId, input.idempotencyKey);
  const existing = await readAutomationJob(rootDir, id);
  if (existing) {
    return { ...existing, path: getAutomationJobPath(rootDir, id) };
  }
  const timestamp = (input.now ?? new Date()).toISOString();
  return writeAutomationJob(
    rootDir,
    AutomationJobSchema.parse({
      version: 1,
      id,
      profileId: input.profileId,
      idempotencyKey: input.idempotencyKey,
      trigger: input.trigger,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      artifacts: []
    })
  );
}
