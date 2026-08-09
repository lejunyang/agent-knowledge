/**
 * Notification outbox 把“需要用户知道或确认”的事件与具体通知渠道解耦。
 *
 * 自动化先写 owner-only 本地记录，再由显式 callback delivery 重试。Envelope 永不包含 Vault
 * evidence、凭据或完整对话；外部通知失败不会丢失本地待办。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { redactEvidenceText } from "../ingestion/redaction.js";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  CallbackConfigSchema,
  NotificationInputSchema,
  NotificationSchema,
  type CallbackConfig,
  type CallbackConfigInput,
  type Notification,
  type NotificationInput
} from "./types.js";

export type NotificationHandle = Notification & { path: string };

type NotificationDeliveryDependencies = {
  fetch?: typeof fetch;
  environment?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
};

/** 从文件句柄中移除仅供调用方定位的 path，避免后续严格 schema 写回时污染记录。 */
function notificationFromHandle(handle: NotificationHandle): Notification {
  const { path: _path, ...notification } = handle;
  return NotificationSchema.parse(notification);
}

/** 由 type + dedupe key 生成稳定 ID，防止重复调度产生重复用户通知。 */
function notificationId(type: string, dedupeKey: string): string {
  return `notification_${createHash("sha256")
    .update(`${type}\0${dedupeKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 返回通知目录；outbox 只属于本地 `.memory`。 */
function notificationDirectory(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "notifications");
}

/** 返回单个通知路径。 */
export function getNotificationPath(
  rootDir: string,
  notificationIdValue: string
): string {
  const parsed = NotificationSchema.shape.id.parse(notificationIdValue);
  return path.join(notificationDirectory(rootDir), `${parsed}.json`);
}

/** 原子写通知记录并保持 0600。 */
async function writeNotification(
  rootDir: string,
  rawNotification: Notification
): Promise<NotificationHandle> {
  const notification = NotificationSchema.parse(rawNotification);
  const target = getNotificationPath(rootDir, notification.id);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(
    temporary,
    `${JSON.stringify(notification, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await rename(temporary, target);
  return { ...notification, path: target };
}

/** 读取通知；缺失返回 null。 */
export async function readNotification(
  rootDir: string,
  id: string
): Promise<Notification | null> {
  const target = getNotificationPath(rootDir, id);
  if (!existsSync(target)) {
    return null;
  }
  return NotificationSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** 列出全部通知并按创建时间排序。 */
export async function listNotifications(
  rootDir: string
): Promise<Notification[]> {
  const directory = notificationDirectory(rootDir);
  if (!existsSync(directory)) {
    return [];
  }
  const notifications: Notification[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    notifications.push(
      NotificationSchema.parse(
        JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
      )
    );
  }
  return notifications.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
  );
}

/** 写入去重通知；同 ID 的 pending/delivered 记录不会重复创建。 */
export async function enqueueNotification(
  rootDir: string,
  rawInput: NotificationInput,
  options: { now?: Date } = {}
): Promise<NotificationHandle> {
  const input = NotificationInputSchema.parse(rawInput);
  const serialized = JSON.stringify(input);
  if (
    redactEvidenceText(serialized, "secrets-only").text !== serialized
  ) {
    throw new Error("Notification input contains secret-like content");
  }
  const id = notificationId(input.type, input.dedupeKey);
  const existing = await readNotification(rootDir, id);
  if (existing) {
    return { ...existing, path: getNotificationPath(rootDir, id) };
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  return writeNotification(
    rootDir,
    NotificationSchema.parse({
      version: 1,
      id,
      type: input.type,
      severity: input.severity,
      title: input.title,
      summary: input.summary,
      dedupeKey: input.dedupeKey,
      details: input.details,
      status: "pending",
      attempts: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  );
}

/** 人工 ack 保留记录和 delivery 历史，只改变待办状态。 */
export async function ackNotification(
  rootDir: string,
  id: string,
  options: { now?: Date } = {}
): Promise<NotificationHandle> {
  const notification = await readNotification(rootDir, id);
  if (!notification) {
    throw new Error(`Notification not found: ${id}`);
  }
  const timestamp = (options.now ?? new Date()).toISOString();
  return writeNotification(rootDir, {
    ...notification,
    status: "acked",
    updatedAt: timestamp,
    ackedAt: timestamp
  });
}

/** Retry-After 支持秒数和 HTTP date；无效值回退指数退避。 */
function retryDelay(
  response: Response,
  attempt: number,
  config: CallbackConfig["retry"],
  now: Date
): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(config.maxDelayMs, seconds * 1_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(config.maxDelayMs, Math.max(0, date - now.getTime()));
    }
  }
  return Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  );
}

/** 408/429/5xx 视为可重试；其他 4xx 表示请求契约或权限错误。 */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** 写有界 delivery audit，不记录 Authorization header 或完整响应。 */
async function appendDeliveryAudit(
  rootDir: string,
  entry: Record<string, unknown>
): Promise<void> {
  const target = resolveWorkspacePath(
    rootDir,
    ".memory",
    "notifications",
    "deliveries",
    `${new Date().toISOString().slice(0, 10)}.jsonl`
  );
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await appendFile(target, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
}

/** 向 callback 投递全部待处理通知；单条失败保留在 outbox，后续运行可继续重试。 */
export async function deliverNotifications(
  rootDir: string,
  rawConfig: CallbackConfigInput,
  dependencies: NotificationDeliveryDependencies = {}
): Promise<{ attempted: number; delivered: number; failed: number }> {
  const config = CallbackConfigSchema.parse(rawConfig);
  const fetchImpl = dependencies.fetch ?? fetch;
  const environment = dependencies.environment ?? process.env;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const now = dependencies.now ?? (() => new Date());
  const notifications = (await listNotifications(rootDir)).filter(
    (notification) =>
      notification.status === "pending" || notification.status === "failed"
  );
  let delivered = 0;
  let failed = 0;

  for (const notification of notifications) {
    let current = notification;
    let success = false;
    for (
      let attempt = current.attempts + 1;
      attempt <= config.retry.maxAttempts;
      attempt += 1
    ) {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Idempotency-Key": current.id
      };
      if (config.tokenEnv) {
        const token = environment[config.tokenEnv];
        if (!token) {
          throw new Error(
            `Notification callback token environment variable is missing: ${config.tokenEnv}`
          );
        }
        headers[config.headerName] = `${config.headerPrefix}${token}`;
      }
      let response: Response | null = null;
      let message = "";
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.timeoutMs);
        try {
          response = await fetchImpl(config.url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              version: 1,
              notification: {
                id: current.id,
                type: current.type,
                severity: current.severity,
                title: current.title,
                summary: current.summary,
                details: current.details,
                createdAt: current.createdAt
              }
            }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timer);
        }
        if (response.ok) {
          const timestamp = now().toISOString();
          current = notificationFromHandle(
            await writeNotification(rootDir, {
              ...current,
              status: "delivered",
              attempts: attempt,
              updatedAt: timestamp,
              deliveredAt: timestamp,
              nextAttemptAt: undefined,
              lastError: undefined
            })
          );
          await appendDeliveryAudit(rootDir, {
            timestamp,
            notificationId: current.id,
            attempt,
            status: response.status,
            outcome: "delivered"
          });
          delivered += 1;
          success = true;
          break;
        }
        message = `callback_http_${response.status}`;
      } catch (error) {
        message =
          error instanceof Error ? error.message : String(error);
      }

      const safeMessage = redactEvidenceText(
        message,
        "secrets-only"
      ).text.slice(0, 500);
      const canRetry =
        response === null || retryableStatus(response.status);
      const delay = response
        ? retryDelay(response, attempt, config.retry, now())
        : Math.min(
            config.retry.maxDelayMs,
            config.retry.baseDelayMs * 2 ** Math.max(0, attempt - 1)
          );
      const exhausted =
        !canRetry || attempt >= config.retry.maxAttempts;
      const timestamp = now().toISOString();
      current = notificationFromHandle(
        await writeNotification(rootDir, {
          ...current,
          status: exhausted ? "failed" : "pending",
          attempts: attempt,
          updatedAt: timestamp,
          nextAttemptAt: exhausted
            ? undefined
            : new Date(now().getTime() + delay).toISOString(),
          lastError: safeMessage
        })
      );
      await appendDeliveryAudit(rootDir, {
        timestamp,
        notificationId: current.id,
        attempt,
        ...(response ? { status: response.status } : {}),
        outcome: exhausted ? "failed" : "retry",
        error: safeMessage
      });
      if (exhausted) {
        failed += 1;
        break;
      }
      await sleep(delay);
    }
    if (!success && current.status !== "failed") {
      failed += 1;
    }
  }
  return { attempted: notifications.length, delivered, failed };
}
