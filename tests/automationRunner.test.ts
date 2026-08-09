import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AutomationProfileSchema,
  inspectAutomation,
  listNotifications,
  runAutomation
} from "../src/automation/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** 构造同时覆盖 Lark/Git、audit、maintenance 和 eval 的测试 profile。 */
function profile(root: string) {
  return AutomationProfileSchema.parse({
    version: 1,
    id: "scheduled-business-refresh",
    knowledgeRoot: root,
    sources: [
      {
        kind: "lark",
        connectorId: "lark-business",
        roots: ["https://example.larkoffice.com/wiki/root"],
        exportDir: path.join(root, "lark-export"),
        identity: "user",
        maxDocuments: 25,
        rateLimit: { minIntervalMs: 500 },
        retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }
      },
      {
        kind: "git",
        connectorId: "business-repo",
        repositoryDir: path.join(root, "repository"),
        remote: "origin",
        refs: ["main", "release"],
        retry: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000 }
      }
    ],
    tasks: {
      refreshSources: true,
      maintenance: true,
      audit: true,
      evalFiles: [path.join(root, "eval.yaml")],
      sidecarComparisons: [],
      deliverNotifications: false
    },
    agent: {
      maxRuntimeMinutes: 15,
      maxQuestions: 8,
      systemPrompt: path.join(root, "system-prompt.md")
    }
  });
}

describe("bounded automation runner", () => {
  it("builds an explicit plan without executing commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-inspect-"));
    tempDirs.push(root);
    const command = vi.fn();

    const result = await inspectAutomation(profile(root), { command });

    expect(command).not.toHaveBeenCalled();
    expect(result.networkAccess).toBe("explicit-profile-only");
    expect(result.steps.map((step) => step.kind)).toEqual([
      "lark_refresh",
      "git_fetch",
      "source_refresh",
      "audit",
      "maintenance",
      "eval"
    ]);
    expect(result.steps[0]?.args).toContain("--min-interval-ms");
    expect(result.steps[1]?.args).toEqual([
      "-C",
      path.join(root, "repository"),
      "fetch",
      "--no-tags",
      "origin",
      "main",
      "release"
    ]);
  });

  it("runs bounded commands, retries transient failures, and creates review notifications", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-run-"));
    tempDirs.push(root);
    await writeFile(path.join(root, "eval.yaml"), "cases: []\n", "utf8");
    const calls: Array<{ executable: string; args: string[] }> = [];
    let gitAttempts = 0;
    const command = vi.fn(
      async (executable: string, args: string[]) => {
        calls.push({ executable, args });
        if (executable === "git") {
          gitAttempts += 1;
          if (gitAttempts === 1) {
            throw new Error("temporary network failure token=secret-value");
          }
          return { stdout: "", stderr: "" };
        }
        if (args.includes("source") && args.includes("refresh")) {
          return {
            stdout: JSON.stringify({
              summary: { connectors: 2, refreshed: 1, unchanged: 1, errors: 0 },
              results: [
                {
                  connectorId: "lark-business",
                  action: "refreshed",
                  before: { updatesAvailable: 2, verificationRequired: 0 }
                }
              ]
            }),
            stderr: ""
          };
        }
        if (args.includes("knowledge") && args.includes("audit")) {
          return {
            stdout: JSON.stringify({
              summary: { incompleteSourceConnectors: 1 },
              findings: [
                {
                  code: "source_inventory_incomplete",
                  severity: "warning",
                  message: "2 unresolved"
                }
              ]
            }),
            stderr: ""
          };
        }
        if (args.includes("maintenance") && args.includes("run")) {
          return {
            stdout: JSON.stringify({ generated: 2, skipped: 0 }),
            stderr: ""
          };
        }
        if (args.includes("eval")) {
          return {
            stdout: JSON.stringify({
              total: 3,
              passed: 2,
              failed: 1,
              metrics: { falseInjectionRate: 0.333 }
            }),
            stderr: ""
          };
        }
        return { stdout: "{}", stderr: "" };
      }
    );

    const result = await runAutomation(profile(root), {
      command,
      sleep: async () => undefined,
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      idempotencyKey: "2026-08-09T12"
    });

    expect(result.status).toBe("needs_confirmation");
    expect(gitAttempts).toBe(2);
    expect(calls.some((call) => call.args.includes("--retry-failures"))).toBe(
      true
    );
    const notifications = await listNotifications(root);
    expect(notifications.map((item) => item.type).sort()).toEqual([
      "eval_regression",
      "inventory_incomplete",
      "maintenance_proposals_ready",
      "source_updates_found"
    ]);
    expect(JSON.stringify(notifications)).not.toContain("secret-value");
  });

  it("stops after a permanent source failure and never runs active promotion commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-failure-"));
    tempDirs.push(root);
    const command = vi.fn(
      async (_executable: string, _args: string[]) => {
        throw new Error("permission denied");
      }
    );

    const result = await runAutomation(profile(root), {
      command,
      sleep: async () => undefined,
      idempotencyKey: "failed-window"
    });

    expect(result.status).toBe("failed");
    const invoked = command.mock.calls
      .map(([, args]) => (args as string[]).join(" "))
      .join("\n");
    expect(invoked).not.toContain("organize-inbox");
    expect(invoked).not.toContain("maintenance accept");
    expect((await listNotifications(root))[0]?.type).toBe(
      "source_refresh_failed"
    );
  });

  it("does not execute a completed idempotent job twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-idempotent-"));
    tempDirs.push(root);
    const configured = AutomationProfileSchema.parse({
      ...profile(root),
      sources: [],
      tasks: {
        refreshSources: false,
        maintenance: false,
        audit: true,
        evalFiles: [],
        sidecarComparisons: [],
        deliverNotifications: false
      }
    });
    const command = vi.fn(async () => ({
      stdout: JSON.stringify({ summary: {}, findings: [] }),
      stderr: ""
    }));

    const first = await runAutomation(configured, {
      command,
      idempotencyKey: "same-window"
    });
    const second = await runAutomation(configured, {
      command,
      idempotencyKey: "same-window"
    });

    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("runs scheduled sidecar comparisons and notifies when a provider regresses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-sidecar-"));
    tempDirs.push(root);
    const raw = profile(root);
    const configured = AutomationProfileSchema.parse({
      ...raw,
      sources: [],
      tasks: {
        refreshSources: false,
        maintenance: false,
        audit: false,
        evalFiles: [],
        deliverNotifications: false,
        sidecarComparisons: [
          {
            configs: [path.join(root, "hindsight.json")],
            evalFile: path.join(root, "eval.yaml"),
            outputDir: path.join(root, "reports")
          }
        ]
      }
    });
    const command = vi.fn(
      async (_executable: string, _args: string[]) => ({
        stdout: JSON.stringify({
          providers: {
            native: {
              passed: 10,
              failed: 0,
              falseInjectionRate: 0,
              abstentionFailureRate: 0
            },
            hindsight: {
              passed: 8,
              failed: 2,
              falseInjectionRate: 0.1,
              abstentionFailureRate: 0.2
            }
          }
        }),
        stderr: ""
      })
    );

    const result = await runAutomation(configured, {
      command,
      idempotencyKey: "sidecar-window"
    });

    expect(result.status).toBe("needs_confirmation");
    expect(command).toHaveBeenCalledTimes(1);
    expect(
      (command.mock.calls[0]?.[1] as string[]).join(" ")
    ).toContain("sidecar compare");
    expect((await listNotifications(root))[0]?.type).toBe(
      "sidecar_regression"
    );
  });
});
