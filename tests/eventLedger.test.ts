import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendLifecycleEvent,
  exportEventPayload,
  getEventLedgerStatus,
  getEventTimeline,
  listEventStreams,
  showLifecycleEvent
} from "../src/events/ledger.js";
import {
  deleteVaultObject,
  getVaultObject
} from "../src/vault/core.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 25);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

describe("lifecycle event ledger", () => {
  it("stores support metadata as a hash chain and redacts complete payload before Vault", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-support-"));
    tempDirs.push(root);
    const payload = JSON.stringify({
      conversation: [
        {
          role: "customer",
          email: "owner@example.com",
          phone: "13800138000",
          text: "登录失败"
        },
        {
          role: "tool",
          authorization: "Bearer abcdefghijklmnopqrstuvwxyz"
        }
      ]
    });

    const first = await appendLifecycleEvent(
      root,
      {
        streamType: "support",
        streamId: "case_account_login_001",
        stage: "intake",
        eventType: "customer_question",
        summary:
          "客户 owner@example.com 反馈手机号 13800138000 登录失败。",
        payloadText: payload,
        payloadContentType: "application/json",
        projectKeys: ["github.com/example/support"],
        actorType: "customer",
        captureMode: "automated_session",
        idempotencyKey: "message-001"
      },
      { key, actor: "support-agent" }
    );
    const second = await appendLifecycleEvent(
      root,
      {
        streamType: "support",
        streamId: "case_account_login_001",
        stage: "query",
        eventType: "tool_query",
        summary: "查询登录态和账号组，尚未确认根因。",
        payloadText: JSON.stringify({
          tool: "account_lookup",
          result: "uid group mismatch"
        }),
        payloadContentType: "application/json",
        projectKeys: ["github.com/example/support"],
        actorType: "agent",
        captureMode: "automated_session",
        parentEventId: first.eventId,
        idempotencyKey: "query-001"
      },
      { key, actor: "support-agent" }
    );
    const timeline = await getEventTimeline(
      root,
      "support",
      "case_account_login_001"
    );
    const rawTimeline = await readFile(first.timelinePath, "utf8");
    const restored = await getVaultObject(root, first.payloadObject!, {
      key,
      actor: "test"
    });
    const restoredText = restored.bytes.toString("utf8");

    expect(timeline.events).toHaveLength(2);
    expect(timeline.integrity).toEqual({
      valid: true,
      events: 2
    });
    expect(timeline.events[0]).toMatchObject({
      event_id: first.eventId,
      previous_hash: null,
      stage: "intake"
    });
    expect(timeline.events[1]).toMatchObject({
      event_id: second.eventId,
      previous_hash: timeline.events[0]!.record_hash,
      parent_event_id: first.eventId,
      stage: "query"
    });
    expect(rawTimeline).not.toContain("owner@example.com");
    expect(rawTimeline).not.toContain("13800138000");
    expect(rawTimeline).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(rawTimeline).not.toContain('"conversation"');
    expect(timeline.events[0]?.summary).toContain("[REDACTED_EMAIL]");
    expect(timeline.events[0]?.summary).toContain("[REDACTED_PHONE]");
    expect(restoredText).toContain("[REDACTED_EMAIL]");
    expect(restoredText).toContain("[REDACTED_PHONE]");
    expect(restoredText).toContain("[REDACTED_SECRET]");
    expect(restoredText).not.toContain("owner@example.com");
    expect(restoredText).not.toContain("13800138000");
  });

  it("deduplicates retries and rejects idempotency key conflicts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-idempotency-"));
    tempDirs.push(root);
    const input = {
      streamType: "initiative" as const,
      streamId: "initiative_mobile_mvp",
      stage: "review" as const,
      eventType: "requirement_review",
      summary: "需求评审完成，确认一期范围。",
      payloadText: JSON.stringify({ decision: "phase one scope" }),
      payloadContentType: "application/json",
      projectKeys: ["github.com/example/business"],
      actorType: "owner" as const,
      captureMode: "direct_material" as const,
      idempotencyKey: "review-meeting-001"
    };

    const first = await appendLifecycleEvent(root, input, { key });
    const duplicate = await appendLifecycleEvent(root, input, { key });

    expect(duplicate).toMatchObject({
      eventId: first.eventId,
      deduplicated: true
    });
    expect(
      (await getEventTimeline(root, "initiative", input.streamId)).events
    ).toHaveLength(1);
    await expect(
      appendLifecycleEvent(
        root,
        { ...input, summary: "同一 key 但内容不同。" },
        { key }
      )
    ).rejects.toThrow(/idempotency key conflict/);
  });

  it("serializes concurrent appends and derives support and initiative status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-concurrent-"));
    tempDirs.push(root);
    const base = {
      streamType: "support" as const,
      streamId: "case_concurrent",
      eventType: "case_progress",
      projectKeys: ["github.com/example/support"],
      actorType: "agent" as const,
      captureMode: "automated_session" as const
    };

    const results = await Promise.all([
      appendLifecycleEvent(
        root,
        {
          ...base,
          stage: "root_cause",
          summary: "确认账号组不匹配。",
          idempotencyKey: "root-cause"
        },
        { key }
      ),
      appendLifecycleEvent(
        root,
        {
          ...base,
          stage: "action",
          summary: "执行重新授权。",
          idempotencyKey: "action"
        },
        { key }
      ),
      appendLifecycleEvent(
        root,
        {
          ...base,
          stage: "closure",
          summary: "客户确认恢复，关闭 case。",
          idempotencyKey: "closure"
        },
        { key }
      )
    ]);
    const support = await getEventTimeline(root, "support", base.streamId);
    await appendLifecycleEvent(
      root,
      {
        streamType: "initiative",
        streamId: "initiative_full_cycle",
        stage: "release",
        eventType: "production_release",
        summary: "版本已发布。",
        projectKeys: ["github.com/example/business"],
        actorType: "agent",
        captureMode: "verified_task",
        idempotencyKey: "release"
      },
      { key }
    );
    const initiative = await getEventTimeline(
      root,
      "initiative",
      "initiative_full_cycle"
    );

    expect(new Set(results.map((result) => result.eventId)).size).toBe(3);
    expect(support.integrity.valid).toBe(true);
    expect(support.status).toBe("closed");
    expect(initiative.status).toBe("active");
  });

  it("detects timeline tampering and refuses to return a valid chain", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-tamper-"));
    tempDirs.push(root);
    const event = await appendLifecycleEvent(
      root,
      {
        streamType: "initiative",
        streamId: "initiative_tamper",
        stage: "design",
        eventType: "design_decision",
        summary: "确定领域模型。",
        projectKeys: ["github.com/example/business"],
        actorType: "owner",
        captureMode: "direct_material",
        idempotencyKey: "design"
      },
      { key }
    );
    const raw = JSON.parse(
      (await readFile(event.timelinePath, "utf8")).trim()
    ) as Record<string, unknown>;
    raw.summary = "被篡改的摘要";
    await writeFile(
      event.timelinePath,
      `${JSON.stringify(raw)}\n`,
      "utf8"
    );

    await expect(
      getEventTimeline(root, "initiative", "initiative_tamper")
    ).rejects.toThrow(/integrity/);
  });

  it("exports payload outside the workspace with restricted permissions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-export-"));
    const outputDir = await mkdtemp(path.join(tmpdir(), "event-output-"));
    tempDirs.push(root, outputDir);
    const event = await appendLifecycleEvent(
      root,
      {
        streamType: "initiative",
        streamId: "initiative_export",
        stage: "testing",
        eventType: "test_report",
        summary: "回归测试通过。",
        payloadText: "complete test report",
        payloadContentType: "text/plain",
        projectKeys: ["github.com/example/business"],
        actorType: "agent",
        captureMode: "verified_task",
        idempotencyKey: "test-report"
      },
      { key }
    );
    const output = path.join(outputDir, "report.txt");
    const exported = await exportEventPayload(
      root,
      {
        eventId: event.eventId,
        outputPath: output
      },
      { key, actor: "owner" }
    );
    const shown = await showLifecycleEvent(root, event.eventId);

    expect(await readFile(output, "utf8")).toBe("complete test report");
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(exported)).not.toContain("complete test report");
    expect(shown.payloadAvailable).toBe(true);
    await expect(
      exportEventPayload(
        root,
        {
          eventId: event.eventId,
          outputPath: path.join(root, "events", "unsafe.txt")
        },
        { key }
      )
    ).rejects.toThrow(/outside the knowledge workspace/);
  });

  it("reports aggregate ledger status without payload or summaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-status-"));
    tempDirs.push(root);
    await appendLifecycleEvent(
      root,
      {
        streamType: "support",
        streamId: "case_status",
        stage: "intake",
        eventType: "customer_question",
        summary: "敏感客服问题。",
        projectKeys: ["github.com/example/support"],
        actorType: "customer",
        captureMode: "automated_session",
        idempotencyKey: "status-event"
      },
      { key }
    );

    const status = await getEventLedgerStatus(root);

    expect(status).toMatchObject({
      streams: 1,
      events: 1,
      byStreamType: { support: 1, initiative: 0 }
    });
    expect(JSON.stringify(status)).not.toContain("敏感客服问题");
  });

  it("lists stream summaries and reports payloads removed by retention", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-list-"));
    tempDirs.push(root);
    const event = await appendLifecycleEvent(
      root,
      {
        streamType: "initiative",
        streamId: "initiative_list",
        stage: "operations",
        eventType: "operations_check",
        summary: "上线后巡检完成。",
        payloadText: "complete operations evidence",
        payloadContentType: "text/plain",
        projectKeys: ["github.com/example/business"],
        actorType: "agent",
        captureMode: "verified_task",
        idempotencyKey: "operations"
      },
      { key }
    );
    const listed = await listEventStreams(root, {
      streamType: "initiative",
      status: "active",
      projectKeys: ["github.com/example/business"]
    });
    await deleteVaultObject(
      root,
      event.payloadObject!,
      { reason: "retention expired" },
      { key }
    );
    const shown = await showLifecycleEvent(root, event.eventId);
    const status = await getEventLedgerStatus(root);

    expect(listed).toEqual({
      total: 1,
      items: [
        {
          streamType: "initiative",
          streamId: "initiative_list",
          status: "active",
          events: 1,
          latestStage: "operations",
          latestTimestamp: expect.any(String),
          projectKeys: ["github.com/example/business"]
        }
      ]
    });
    expect(shown.payloadAvailable).toBe(false);
    expect(status.missingPayloads).toBe(1);
  });

  it("rejects invalid stream stages and non-canonical project keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "event-invalid-"));
    tempDirs.push(root);

    await expect(
      appendLifecycleEvent(
        root,
        {
          streamType: "support",
          streamId: "case_invalid",
          stage: "release" as never,
          eventType: "invalid",
          summary: "invalid",
          projectKeys: ["https://github.com/example/support.git"],
          actorType: "agent",
          captureMode: "automated_session"
        },
        { key }
      )
    ).rejects.toThrow();
    await expect(
      appendLifecycleEvent(
        root,
        {
          streamType: "support",
          streamId: "case_13800138000",
          stage: "intake",
          eventType: "customer_question",
          summary: "invalid",
          projectKeys: ["github.com/example/support"],
          actorType: "customer",
          captureMode: "automated_session"
        },
        { key }
      )
    ).rejects.toThrow(/secret or PII/);
  });
});
