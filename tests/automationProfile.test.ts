import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutomationProfileSchema,
  createAutomationJob,
  readAutomationJob,
  writeAutomationProfile
} from "../src/automation/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

/** 构造不含凭据原值的最小后台自动化配置。 */
function profile(root: string) {
  return {
    version: 1 as const,
    id: "business-refresh",
    knowledgeRoot: root,
    sources: [
      {
        kind: "lark" as const,
        connectorId: "lark-business",
        roots: ["https://example.larkoffice.com/wiki/token"],
        exportDir: path.join(root, "exports", "lark"),
        identity: "user" as const,
        maxDocuments: 50,
        rateLimit: { minIntervalMs: 250 },
        retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 5000 }
      },
      {
        kind: "git" as const,
        connectorId: "business-repo",
        repositoryDir: path.join(root, "repo"),
        remote: "origin",
        refs: ["main"],
        retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3000 }
      }
    ],
    tasks: {
      refreshSources: true,
      maintenance: true,
      audit: true,
      evalFiles: [path.join(root, "eval.yaml")]
    },
    agent: {
      maxRuntimeMinutes: 20,
      maxQuestions: 10,
      systemPrompt: path.join(root, "system-prompt.md")
    },
    callback: {
      url: "https://notify.example.com/agent-knowledge",
      tokenEnv: "AGENT_KNOWLEDGE_CALLBACK_TOKEN",
      timeoutMs: 5000,
      retry: { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 10000 }
    }
  };
}

describe("automation profile and jobs", () => {
  it("validates bounded sources and persists only environment variable names", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-profile-"));
    tempDirs.push(root);
    const parsed = AutomationProfileSchema.parse(profile(root));
    const target = path.join(root, "profile.json");

    await writeAutomationProfile(target, parsed);

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    const content = await readFile(target, "utf8");
    expect(content).toContain("AGENT_KNOWLEDGE_CALLBACK_TOKEN");
    expect(content).not.toContain("Bearer secret");
    const larkSource = parsed.sources[0];
    expect(larkSource?.kind).toBe("lark");
    if (larkSource?.kind !== "lark") {
      throw new Error("Expected the first automation source to be Lark");
    }
    expect(larkSource.rateLimit.minIntervalMs).toBe(250);
  });

  it("rejects embedded callback secrets and unbounded retry settings", () => {
    const root = path.join(tmpdir(), "ak-invalid-profile");
    expect(() =>
      AutomationProfileSchema.parse({
        ...profile(root),
        callback: {
          ...profile(root).callback,
          token: "raw-secret"
        }
      })
    ).toThrow();
    expect(() =>
      AutomationProfileSchema.parse({
        ...profile(root),
        sources: [
          {
            ...profile(root).sources[0],
            retry: { maxAttempts: 100, baseDelayMs: 1, maxDelayMs: 2 }
          }
        ]
      })
    ).toThrow();
  });

  it("creates stable idempotent jobs with owner-only state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-automation-job-"));
    tempDirs.push(root);
    const first = await createAutomationJob(root, {
      profileId: "business-refresh",
      idempotencyKey: "2026-08-09T12",
      trigger: "schedule"
    });
    const second = await createAutomationJob(root, {
      profileId: "business-refresh",
      idempotencyKey: "2026-08-09T12",
      trigger: "schedule"
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toBe(first.createdAt);
    expect((await stat(first.path)).mode & 0o777).toBe(0o600);
    await expect(readAutomationJob(root, first.id)).resolves.toMatchObject({
      status: "pending",
      profileId: "business-refresh"
    });
  });
});
