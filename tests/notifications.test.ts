import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ackNotification,
  deliverNotifications,
  enqueueNotification,
  listNotifications
} from "../src/automation/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("automation notification outbox", () => {
  it("deduplicates pending confirmations and persists owner-only records", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-notification-"));
    tempDirs.push(root);
    const input = {
      type: "confirmation_required" as const,
      severity: "warning" as const,
      title: "需要确认飞书术语",
      summary: "发现两个含义不明确的术语。",
      dedupeKey: "lark-terms-20260809",
      details: { questionCount: 2 }
    };

    const first = await enqueueNotification(root, input);
    const second = await enqueueNotification(root, input);

    expect(second.id).toBe(first.id);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    expect(await listNotifications(root)).toHaveLength(1);
  });

  it("delivers callbacks with idempotency and retries 429 without exposing tokens", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-notification-delivery-"));
    tempDirs.push(root);
    const queued = await enqueueNotification(root, {
      type: "source_updates_found",
      severity: "info",
      title: "来源有更新",
      summary: "检测到 3 个更新。",
      dedupeKey: "updates-run-1",
      details: { updates: 3 }
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" }
        })
      )
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    const result = await deliverNotifications(
      root,
      {
        url: "https://notify.example.com/hook",
        tokenEnv: "CALLBACK_TOKEN",
        timeoutMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      },
      {
        fetch: fetchMock,
        environment: { CALLBACK_TOKEN: "top-secret" },
        sleep: async () => undefined
      }
    );

    expect(result.delivered).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer top-secret"
    );
    expect(
      (request.headers as Record<string, string>)["Idempotency-Key"]
    ).toBe(queued.id);
    expect(JSON.stringify(request.body)).not.toContain("top-secret");
    expect((await listNotifications(root))[0]?.status).toBe("delivered");
  });

  it("does not retry non-retryable 4xx and supports explicit acknowledgement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-notification-ack-"));
    tempDirs.push(root);
    const queued = await enqueueNotification(root, {
      type: "automation_failed",
      severity: "error",
      title: "自动化失败",
      summary: "配置错误。",
      dedupeKey: "failure-1",
      details: {}
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("bad request", { status: 400 })
    );

    const result = await deliverNotifications(
      root,
      {
        url: "https://notify.example.com/hook",
        timeoutMs: 1000,
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
      },
      { fetch: fetchMock, sleep: async () => undefined }
    );

    expect(result.failed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await ackNotification(root, queued.id);
    expect((await listNotifications(root))[0]?.status).toBe("acked");
  });

  it("rejects secret-like notification details before writing the outbox", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-notification-secret-"));
    tempDirs.push(root);

    await expect(
      enqueueNotification(root, {
        type: "confirmation_required",
        severity: "warning",
        title: "需要确认",
        summary: "发现敏感配置。",
        dedupeKey: "secret-input",
        details: { token: "sk-abcdefghijklmnopqrstuvwxyz" }
      })
    ).rejects.toThrow("secret-like");
    expect(await listNotifications(root)).toEqual([]);
  });

  it("does not retry exhausted failed notifications on later delivery runs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-notification-exhausted-"));
    tempDirs.push(root);
    await enqueueNotification(root, {
      type: "automation_failed",
      severity: "error",
      title: "失败",
      summary: "永久错误。",
      dedupeKey: "permanent",
      details: {}
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    const config = {
      url: "https://notify.example.com/hook",
      timeoutMs: 1000,
      retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }
    };

    await deliverNotifications(root, config, { fetch: fetchMock });
    const second = await deliverNotifications(root, config, { fetch: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ attempted: 0, delivered: 0, failed: 0 });
  });
});
