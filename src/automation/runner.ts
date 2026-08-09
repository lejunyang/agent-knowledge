/**
 * Automation runner 按严格 profile 编排外部刷新和本地审计。
 *
 * Runner 只执行 allowlist 命令并写 `.memory` job/notification；它不调用 inbox approve、
 * maintenance accept、Skill install 或任何 active knowledge 写入命令。语义确认留给外部 Agent。
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { redactEvidenceText } from "../ingestion/redaction.js";
import {
  createAutomationJob,
  writeAutomationJob,
  type AutomationJobHandle
} from "./jobs.js";
import { enqueueNotification } from "./notifications.js";
import {
  AutomationJobSchema,
  AutomationProfileSchema,
  type AutomationJob,
  type AutomationProfile,
  type AutomationRetry
} from "./types.js";

const execFileAsync = promisify(execFile);

export type AutomationStepKind =
  | "lark_refresh"
  | "git_fetch"
  | "source_refresh"
  | "audit"
  | "maintenance"
  | "eval"
  | "sidecar_compare";

export type AutomationStep = {
  id: string;
  kind: AutomationStepKind;
  executable: string;
  args: string[];
  timeoutMs: number;
  retry: AutomationRetry;
};

export type AutomationPlan = {
  profileId: string;
  knowledgeRoot: string;
  networkAccess: "explicit-profile-only";
  maxRuntimeMinutes: number;
  steps: AutomationStep[];
};

export type AutomationRunResult = {
  jobId: string;
  status: "succeeded" | "failed" | "needs_confirmation";
  completedSteps: string[];
  failedStep?: string;
  notificationIds: string[];
};

type CommandResult = { stdout: string; stderr: string };
type CommandRunner = (
  executable: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number }
) => Promise<CommandResult>;

type AutomationDependencies = {
  command?: CommandRunner;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  idempotencyKey?: string;
  packageRoot?: string;
};

/** 默认命令执行器限制 buffer/timeout，并保持 stdout/stderr 供结构化解析。 */
async function defaultCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  const result = await execFileAsync(executable, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

/** 从持久化句柄移除 path，只把 schema 字段写回 job。 */
function jobRecord(handle: AutomationJobHandle): AutomationJob {
  const { path: _path, ...job } = handle;
  return AutomationJobSchema.parse(job);
}

/** 生成每步稳定 ID，便于 job/report 对比。 */
function stepId(kind: AutomationStepKind, suffix: string): string {
  return `${kind}:${suffix}`;
}

/** automation CLI 默认由已安装的 agent-knowledge 二进制执行。 */
function agentKnowledgeStep(
  kind: AutomationStepKind,
  suffix: string,
  args: string[],
  timeoutMs = 5 * 60_000
): AutomationStep {
  return {
    id: stepId(kind, suffix),
    kind,
    executable: "agent-knowledge",
    args,
    timeoutMs,
    retry: {
      maxAttempts: 1,
      baseDelayMs: 1_000,
      maxDelayMs: 1_000
    }
  };
}

/** 把 profile 展开为完全可审阅命令计划；inspect 不执行任何命令。 */
export async function inspectAutomation(
  rawProfile: AutomationProfile,
  dependencies: Pick<AutomationDependencies, "packageRoot" | "command"> = {}
): Promise<AutomationPlan> {
  const profile = AutomationProfileSchema.parse(rawProfile);
  const packageRoot = path.resolve(dependencies.packageRoot ?? process.cwd());
  const steps: AutomationStep[] = [];
  for (const source of profile.sources) {
    if (source.kind === "lark") {
      steps.push({
        id: stepId("lark_refresh", source.connectorId),
        kind: "lark_refresh",
        executable: process.execPath,
        args: [
          path.join(packageRoot, "scripts", "fetch-lark-corpus.mjs"),
          ...source.roots.flatMap((root) => ["--root-url", root]),
          "--output",
          source.exportDir,
          "--as",
          source.identity,
          "--max-documents",
          String(source.maxDocuments),
          "--retry-failures",
          "--refresh-existing",
          "--min-interval-ms",
          String(source.rateLimit.minIntervalMs),
          "--max-attempts",
          String(source.retry.maxAttempts),
          "--retry-base-delay-ms",
          String(source.retry.baseDelayMs),
          "--retry-max-delay-ms",
          String(source.retry.maxDelayMs)
        ],
        timeoutMs: profile.agent.maxRuntimeMinutes * 60_000,
        retry: source.retry
      });
      continue;
    }
    steps.push({
      id: stepId("git_fetch", source.connectorId),
      kind: "git_fetch",
      executable: "git",
      args: [
        "-C",
        source.repositoryDir,
        "fetch",
        "--no-tags",
        source.remote,
        ...source.refs
      ],
      timeoutMs: profile.agent.maxRuntimeMinutes * 60_000,
      retry: source.retry
    });
  }
  if (profile.tasks.refreshSources && profile.sources.length > 0) {
    steps.push(
      agentKnowledgeStep("source_refresh", "registered", [
        "source",
        "refresh",
        "--root",
        profile.knowledgeRoot,
        "--connector-id",
        ...profile.sources.map((source) => source.connectorId),
        "--fail-on-error"
      ])
    );
  }
  if (profile.tasks.audit) {
    steps.push(
      agentKnowledgeStep("audit", "knowledge", [
        "knowledge",
        "audit",
        "--root",
        profile.knowledgeRoot
      ])
    );
  }
  if (profile.tasks.maintenance) {
    steps.push(
      agentKnowledgeStep("maintenance", "run", [
        "maintenance",
        "run",
        "--root",
        profile.knowledgeRoot
      ])
    );
  }
  for (const evalFile of profile.tasks.evalFiles) {
    steps.push(
      agentKnowledgeStep("eval", path.basename(evalFile), [
        "eval",
        "--root",
        profile.knowledgeRoot,
        "--input",
        evalFile,
        "--pipeline",
        "lexical"
      ])
    );
  }
  for (const [index, comparison] of profile.tasks.sidecarComparisons.entries()) {
    steps.push(
      agentKnowledgeStep(
        "sidecar_compare",
        `${index + 1}:${path.basename(comparison.evalFile)}`,
        [
          "sidecar",
          "compare",
          "--root",
          profile.knowledgeRoot,
          "--config",
          ...comparison.configs,
          "--eval",
          comparison.evalFile,
          "--output",
          comparison.outputDir
        ],
        profile.agent.maxRuntimeMinutes * 60_000
      )
    );
  }
  return {
    profileId: profile.id,
    knowledgeRoot: profile.knowledgeRoot,
    networkAccess: "explicit-profile-only",
    maxRuntimeMinutes: profile.agent.maxRuntimeMinutes,
    steps
  };
}

/** 安全解析 CLI JSON；非 JSON 输出视为契约错误而不是猜测。 */
function parseCommandJson(result: CommandResult, step: AutomationStep): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`Automation step returned invalid JSON: ${step.id}`);
  }
}

/** 执行带指数退避的单步；错误在返回用户/日志前统一脱敏。 */
async function runStep(
  step: AutomationStep,
  dependencies: Required<Pick<AutomationDependencies, "command" | "sleep">>
): Promise<CommandResult> {
  let lastError = new Error(`Automation step failed: ${step.id}`);
  for (let attempt = 1; attempt <= step.retry.maxAttempts; attempt += 1) {
    try {
      return await dependencies.command(step.executable, step.args, {
        timeoutMs: step.timeoutMs
      });
    } catch (error) {
      const message = redactEvidenceText(
        error instanceof Error ? error.message : String(error),
        "secrets-only"
      ).text.slice(0, 500);
      lastError = new Error(message);
      if (attempt >= step.retry.maxAttempts) {
        break;
      }
      await dependencies.sleep(
        Math.min(
          step.retry.maxDelayMs,
          step.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1)
        )
      );
    }
  }
  throw lastError;
}

/** 根据 source refresh 结果生成可审阅更新通知。 */
async function notifySourceUpdates(
  profile: AutomationProfile,
  job: AutomationJobHandle,
  value: unknown
): Promise<string[]> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const raw = value as {
    summary?: { refreshed?: number; errors?: number };
    results?: Array<{
      before?: { updatesAvailable?: number; verificationRequired?: number };
    }>;
  };
  const updates = (raw.results ?? []).reduce(
    (sum, item) =>
      sum +
      (item.before?.updatesAvailable ?? 0) +
      (item.before?.verificationRequired ?? 0),
    0
  );
  if (updates <= 0) {
    return [];
  }
  const notification = await enqueueNotification(profile.knowledgeRoot, {
    type: "source_updates_found",
    severity: "info",
    title: "Agent Knowledge 来源已刷新",
    summary: `检测并处理了 ${updates} 个来源更新或待验证变化。`,
    dedupeKey: `${job.id}:source-updates`,
    details: {
      jobId: job.id,
      updates,
      refreshedConnectors: raw.summary?.refreshed ?? 0,
      errors: raw.summary?.errors ?? 0
    }
  });
  return [notification.id];
}

/** 根据 audit findings 暴露 incomplete inventory，不能为了自动化成功隐藏。 */
async function notifyAuditFindings(
  profile: AutomationProfile,
  job: AutomationJobHandle,
  value: unknown
): Promise<string[]> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const findings = (
    value as { findings?: Array<{ code?: string; severity?: string }> }
  ).findings ?? [];
  const incomplete = findings.filter(
    (finding) => finding.code === "source_inventory_incomplete"
  );
  if (incomplete.length === 0) {
    return [];
  }
  const notification = await enqueueNotification(profile.knowledgeRoot, {
    type: "inventory_incomplete",
    severity: "warning",
    title: "Agent Knowledge 来源清单不完整",
    summary: `质量审计发现 ${incomplete.length} 个不完整来源清单。`,
    dedupeKey: `${job.id}:inventory-incomplete`,
    details: { jobId: job.id, count: incomplete.length }
  });
  return [notification.id];
}

/** Maintenance 只通知 proposal 数量，原始 observation/proposal 留在本地审阅。 */
async function notifyMaintenance(
  profile: AutomationProfile,
  job: AutomationJobHandle,
  value: unknown
): Promise<string[]> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const generated = Number(
    (value as { generated?: unknown }).generated ?? 0
  );
  if (!Number.isFinite(generated) || generated <= 0) {
    return [];
  }
  const notification = await enqueueNotification(profile.knowledgeRoot, {
    type: "maintenance_proposals_ready",
    severity: "info",
    title: "Agent Knowledge 有新的维护提案",
    summary: `Maintenance 生成了 ${generated} 个待审阅提案。`,
    dedupeKey: `${job.id}:maintenance`,
    details: { jobId: job.id, generated }
  });
  return [notification.id];
}

/** Eval 回归是高优先级确认项；callback 只发送指标，不发送 query/知识正文。 */
async function notifyEvalRegression(
  profile: AutomationProfile,
  job: AutomationJobHandle,
  step: AutomationStep,
  value: unknown
): Promise<string[]> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const result = value as {
    total?: number;
    passed?: number;
    failed?: number;
    metrics?: { falseInjectionRate?: number };
  };
  if ((result.failed ?? 0) <= 0) {
    return [];
  }
  const notification = await enqueueNotification(profile.knowledgeRoot, {
    type: "eval_regression",
    severity: "warning",
    title: "Agent Knowledge 检索评测回归",
    summary: `${step.id} 有 ${result.failed ?? 0} 个失败 case。`,
    dedupeKey: `${job.id}:${step.id}:eval-regression`,
    details: {
      jobId: job.id,
      eval: step.id,
      total: result.total ?? 0,
      passed: result.passed ?? 0,
      failed: result.failed ?? 0,
      falseInjectionRate: result.metrics?.falseInjectionRate ?? 0
    }
  });
  return [notification.id];
}

/** Sidecar 低于 native 安全/通过率时创建 regression 通知。 */
async function notifySidecarRegression(
  profile: AutomationProfile,
  job: AutomationJobHandle,
  step: AutomationStep,
  value: unknown
): Promise<string[]> {
  if (!value || typeof value !== "object") {
    return [];
  }
  const providers = (value as { providers?: unknown }).providers;
  if (!providers || typeof providers !== "object") {
    return [];
  }
  const metrics = providers as Record<
    string,
    {
      passed?: number;
      falseInjectionRate?: number;
      abstentionFailureRate?: number;
    }
  >;
  const native = metrics.native;
  if (!native) {
    return [];
  }
  const regressions = Object.entries(metrics)
    .filter(([name]) => name !== "native")
    .filter(
      ([, current]) =>
        (current.passed ?? 0) < (native.passed ?? 0) ||
        (current.falseInjectionRate ?? 0) >
          (native.falseInjectionRate ?? 0) ||
        (current.abstentionFailureRate ?? 0) >
          (native.abstentionFailureRate ?? 0)
    )
    .map(([name, current]) => ({
      name,
      passed: current.passed ?? 0,
      falseInjectionRate: current.falseInjectionRate ?? 0,
      abstentionFailureRate: current.abstentionFailureRate ?? 0
    }));
  if (regressions.length === 0) {
    return [];
  }
  const notification = await enqueueNotification(profile.knowledgeRoot, {
    type: "sidecar_regression",
    severity: "warning",
    title: "External memory sidecar 低于 native baseline",
    summary: `${regressions.length} 个 sidecar 在通过率或安全指标上退化。`,
    dedupeKey: `${job.id}:${step.id}:sidecar-regression`,
    details: {
      jobId: job.id,
      comparison: step.id,
      native: {
        passed: native.passed ?? 0,
        falseInjectionRate: native.falseInjectionRate ?? 0,
        abstentionFailureRate: native.abstentionFailureRate ?? 0
      },
      regressions
    }
  });
  return [notification.id];
}

/** 执行 profile；任何用户判断都通过 outbox 暴露，不直接修改 active facts。 */
export async function runAutomation(
  rawProfile: AutomationProfile,
  dependencies: AutomationDependencies = {}
): Promise<AutomationRunResult> {
  const profile = AutomationProfileSchema.parse(rawProfile);
  const now = dependencies.now ?? (() => new Date());
  const command = dependencies.command ?? defaultCommand;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const idempotencyKey =
    dependencies.idempotencyKey ?? now().toISOString().slice(0, 13);
  let job = await createAutomationJob(profile.knowledgeRoot, {
    profileId: profile.id,
    idempotencyKey,
    trigger: "schedule",
    now: now()
  });
  const plan = await inspectAutomation(profile, {
    packageRoot: dependencies.packageRoot
  });
  job = await writeAutomationJob(profile.knowledgeRoot, {
    ...jobRecord(job),
    status: "running",
    startedAt: now().toISOString(),
    updatedAt: now().toISOString()
  });
  const completedSteps: string[] = [];
  const notificationIds: string[] = [];

  for (const step of plan.steps) {
    try {
      const result = await runStep(step, { command, sleep });
      completedSteps.push(step.id);
      const value =
        step.kind === "git_fetch" || step.kind === "lark_refresh"
          ? null
          : parseCommandJson(result, step);
      if (step.kind === "source_refresh") {
        notificationIds.push(
          ...(await notifySourceUpdates(profile, job, value))
        );
      } else if (step.kind === "audit") {
        notificationIds.push(...(await notifyAuditFindings(profile, job, value)));
      } else if (step.kind === "maintenance") {
        notificationIds.push(...(await notifyMaintenance(profile, job, value)));
      } else if (step.kind === "eval") {
        notificationIds.push(
          ...(await notifyEvalRegression(profile, job, step, value))
        );
      } else if (step.kind === "sidecar_compare") {
        notificationIds.push(
          ...(await notifySidecarRegression(profile, job, step, value))
        );
      }
    } catch (error) {
      const message = redactEvidenceText(
        error instanceof Error ? error.message : String(error),
        "secrets-only"
      ).text.slice(0, 500);
      const type =
        step.kind === "lark_refresh" ||
        step.kind === "git_fetch" ||
        step.kind === "source_refresh"
          ? "source_refresh_failed"
          : "automation_failed";
      const notification = await enqueueNotification(profile.knowledgeRoot, {
        type,
        severity: "error",
        title: "Agent Knowledge 后台任务失败",
        summary: `${step.id} 执行失败，需要检查。`,
        dedupeKey: `${job.id}:${step.id}:failed`,
        details: { jobId: job.id, stepId: step.id, error: message }
      });
      notificationIds.push(notification.id);
      job = await writeAutomationJob(profile.knowledgeRoot, {
        ...jobRecord(job),
        status: "failed",
        updatedAt: now().toISOString(),
        completedAt: now().toISOString(),
        summary: `${completedSteps.length}/${plan.steps.length} steps completed`,
        error: message
      });
      return {
        jobId: job.id,
        status: "failed",
        completedSteps,
        failedStep: step.id,
        notificationIds
      };
    }
  }

  const status =
    notificationIds.length > 0 ? "needs_confirmation" : "succeeded";
  job = await writeAutomationJob(profile.knowledgeRoot, {
    ...jobRecord(job),
    status,
    updatedAt: now().toISOString(),
    completedAt: now().toISOString(),
    summary: `${completedSteps.length}/${plan.steps.length} steps completed`
  });
  return { jobId: job.id, status, completedSteps, notificationIds };
}
