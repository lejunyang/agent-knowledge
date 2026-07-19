import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  getProjectConfigPaths,
  loadEffectiveConfig,
  mergeConfigSources
} from "../src/core/projectConfig.js";

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
    expect(loaded.embeddings.cacheDir).toContain("agent-knowledge");
    expect(loaded.embeddings.retrieval).toBe("lexical");
    expect(loaded.embeddings.graphDepth).toBe(1);
    expect(loaded.embeddings.graphDecay).toBe(0.6);
    expect(loaded.embeddings.rerankerProfile).toBe("bge-reranker-large");
    expect(loaded.sync.provider).toBe("none");
    expect(loaded.locale).toBe("auto");
  });

  it("rejects the removed system actor configuration", () => {
    expect(() =>
      resolveUserConfig({
        identity: {
          actorType: "system"
        }
      })
    ).toThrow();
  });

  it("deep-merges user, project, and project-local config while replacing arrays", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-project-config-"));
    tempDirs.push(root);
    const userPath = path.join(root, "user.json");
    const projectRoot = path.join(root, "repo");
    await writeUserConfig(
      userPath,
      resolveUserConfig({
        knowledgeRoot: "/global/knowledge",
        identity: {
          actorType: "owner",
          visibilityScopes: ["private", "project", "team"]
        },
        embeddings: {
          retrieval: "hybrid",
          cacheDir: "/global/model-cache"
        }
      })
    );
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project/knowledge",
        identity: {
          actorType: "agent",
          visibilityScopes: ["project", "team"]
        },
        embeddings: {
          graphDepth: 2
        }
      })}\n`,
      { encoding: "utf8", flag: "w" }
    ).catch(async () => {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(projectRoot, { recursive: true });
      await writeFile(
        path.join(projectRoot, ".agent-knowledge.json"),
        `${JSON.stringify({
          knowledgeRoot: "/project/knowledge",
          identity: {
            actorType: "agent",
            visibilityScopes: ["project", "team"]
          },
          embeddings: {
            graphDepth: 2
          }
        })}\n`,
        "utf8"
      );
    });
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.local.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project/local-knowledge",
        embeddings: {
          retrieval: "hybrid-graph",
          allowRemoteModels: false
        }
      })}\n`,
      "utf8"
    );

    const loaded = loadEffectiveConfig({
      userConfigPath: userPath,
      projectRoot,
      environment: {
        AGENT_KNOWLEDGE_ROOT: "/environment/knowledge",
        AGENT_KNOWLEDGE_ACTOR_TYPE: "customer"
      }
    });

    expect(loaded.config).toMatchObject({
      knowledgeRoot: "/project/local-knowledge",
      identity: {
        actorType: "agent",
        visibilityScopes: ["project", "team"]
      },
      embeddings: {
        retrieval: "hybrid-graph",
        graphDepth: 2,
        cacheDir: "/global/model-cache",
        allowRemoteModels: false
      }
    });
    expect(loaded.sources.project).not.toBeNull();
    expect(loaded.sources.projectLocal).not.toBeNull();
    expect(loaded.sources.project!.path).toBe(
      path.join(projectRoot, ".agent-knowledge.json")
    );
    expect(loaded.sources.projectLocal!.path).toBe(
      path.join(projectRoot, ".agent-knowledge.local.json")
    );
    expect(loaded.sources.project!.exists).toBe(true);
    expect(loaded.sources.projectLocal!.exists).toBe(true);

    const projectEditorDefaults = loadEffectiveConfig({
      userConfigPath: userPath,
      projectRoot,
      includeProjectLocal: false
    });
    expect(projectEditorDefaults.config.knowledgeRoot).toBe(
      "/project/knowledge"
    );
    expect(projectEditorDefaults.config.embeddings.retrieval).toBe("hybrid");
  });

  it("uses environment below config files and can disable project discovery", () => {
    expect(
      mergeConfigSources(
        { knowledgeRoot: "/environment", identity: { actorType: "customer" } },
        { knowledgeRoot: "/user", identity: { captureMode: "verified_task" } },
        { identity: { actorType: "agent" } },
        { knowledgeRoot: "/local" }
      )
    ).toEqual({
      knowledgeRoot: "/local",
      identity: {
        actorType: "agent",
        captureMode: "verified_task"
      }
    });

    const sources = getProjectConfigPaths(process.cwd(), {
      AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "1"
    });
    expect(sources.root).toBeNull();
    expect(sources.project).toBeNull();
    expect(sources.projectLocal).toBeNull();
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
      "/tmp/agent-model-cache",
      "no",
      "hybrid",
      "2",
      "0.7",
      "30",
      "",
      "40",
      "10",
      "0.6",
      "0.4",
      "0.6",
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
      "internal",
      "0.65",
      "900",
      "4",
      "yes"
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
      cacheDir: "/tmp/agent-model-cache",
      retrieval: "hybrid",
      graphDepth: 2,
      graphDecay: 0.7,
      embeddingTopK: 30,
      rerankerCandidateLimit: 40,
      rerankerResultLimit: 10,
      rerankerMinScore: 0.6,
      rerankerBaseWeight: 0.4,
      rerankerModelWeight: 0.6
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
    expect(configured.hooks).toEqual({
      minScore: 0.65,
      maxTokens: 900,
      catalogMaxItems: 4,
      detailedSubagentLogging: true
    });
    expect(raw).toContain("BOT_WEBDAV_PASSWORD");
    expect(raw).not.toContain("actual-password-value");
    expect(raw).not.toContain("actual-access-key-value");
  });
});
