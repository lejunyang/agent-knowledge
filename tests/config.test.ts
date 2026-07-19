import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_USER_CONFIG,
  getDefaultUserConfigPath,
  loadUserConfig,
  resolveUserConfig,
  writeUserConfig
} from "../src/core/config.js";
import { runConfigurationWizard, type ConfigurationPrompter } from "../src/cli/configure.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

class AnswerPrompter implements ConfigurationPrompter {
  private index = 0;

  constructor(private readonly answers: string[]) {}

  async ask(): Promise<string> {
    const answer = this.answers[this.index];
    this.index += 1;
    if (answer === undefined) {
      throw new Error("Missing test answer");
    }
    return answer;
  }
}

describe("user configuration", () => {
  it("uses the XDG-style user config path by default", () => {
    expect(getDefaultUserConfigPath({})).toBe(path.join(homedir(), ".config", "agent-knowledge", "config.json"));
    expect(getDefaultUserConfigPath({ XDG_CONFIG_HOME: "/tmp/config" })).toBe(
      "/tmp/config/agent-knowledge/config.json"
    );
    expect(getDefaultUserConfigPath({ AGENT_KNOWLEDGE_CONFIG: "/tmp/custom.json" })).toBe("/tmp/custom.json");
  });

  it("merges partial files with documented defaults", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.json");
    await writeUserConfig(
      configPath,
      resolveUserConfig({
        knowledgeRoot: "/tmp/knowledge",
        identity: {
          actorType: "customer"
        },
        embeddings: {
          provider: "local"
        }
      })
    );

    const loaded = loadUserConfig(configPath);

    expect(loaded.knowledgeRoot).toBe("/tmp/knowledge");
    expect(loaded.identity.actorType).toBe("customer");
    expect(loaded.identity.captureMode).toBe(DEFAULT_USER_CONFIG.identity.captureMode);
    expect(loaded.embeddings.provider).toBe("local");
    expect(loaded.embeddings.profile).toBe(DEFAULT_USER_CONFIG.embeddings.profile);
    expect(loaded.sync.provider).toBe("none");
    expect(loaded.locale).toBe("auto");
  });

  it("normalizes legacy system actor configuration to agent", () => {
    const configured = resolveUserConfig({
      identity: {
        actorType: "system"
      }
    });

    expect(configured.identity.actorType).toBe("agent");
    expect(JSON.stringify(configured)).not.toContain('"system"');
  });

  it("runs the full wizard and stores credential environment variable names only", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-wizard-"));
    tempDirs.push(root);
    const configPath = path.join(root, "config.json");
    const prompter = new AnswerPrompter([
      "auto",
      "/tmp/shared-knowledge",
      "customer",
      "automated_session",
      "project,team",
      "internal",
      "transformers",
      "bge-small-zh-v1.5",
      "",
      "no",
      "hybrid",
      "30",
      "trae",
      "user",
      "hooks,agents,skills",
      "",
      "overwrite",
      "webdav",
      "https://dav.example.com/memory",
      "support-bot",
      "BOT_WEBDAV_PASSWORD",
      "15",
      "project,team",
      "internal"
    ]);

    const configured = await runConfigurationWizard({
      configPath,
      prompter,
      current: DEFAULT_USER_CONFIG
    });
    const raw = await readFile(configPath, "utf8");

    expect(configured.knowledgeRoot).toBe("/tmp/shared-knowledge");
    expect(configured.locale).toBe("auto");
    expect(configured.identity).toMatchObject({
      actorType: "customer",
      captureMode: "automated_session"
    });
    expect(configured.embeddings).toMatchObject({
      provider: "transformers",
      profile: "bge-small-zh-v1.5",
      retrieval: "hybrid",
      embeddingTopK: 30
    });
    expect(configured.integration.mode).toBe("overwrite");
    expect(configured.sync).toMatchObject({
      provider: "webdav",
      intervalMinutes: 15,
      webdav: {
        url: "https://dav.example.com/memory",
        username: "support-bot",
        passwordEnv: "BOT_WEBDAV_PASSWORD"
      }
    });
    expect(raw).toContain("BOT_WEBDAV_PASSWORD");
    expect(raw).not.toContain("actual-password-value");
    expect(raw).not.toContain("actual-access-key-value");
  });
});
