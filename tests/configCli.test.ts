import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveUserConfig, writeUserConfig } from "../src/core/config.js";

const execFileAsync = promisify(execFile);
const tsxLoader = path.resolve("node_modules", "tsx", "dist", "loader.mjs");
let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function runCli(args: string[], environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const result = await execFileAsync("node", ["--import", tsxLoader, path.resolve("src/cli.ts"), ...args], {
    cwd: environment.TEST_CWD ?? process.cwd(),
    env: {
      ...process.env,
      AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "1",
      ...environment,
      TEST_CWD: undefined
    }
  });
  return result.stdout.trim();
}

describe("CLI user configuration", () => {
  it("prefers explicit root, then user config, then legacy environment", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-cli-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "config.json");
    const configuredRoot = path.join(temp, "configured-root");
    const explicitRoot = path.join(temp, "explicit-root");
    const environmentRoot = path.join(temp, "environment-root");
    writeUserConfig(configPath, resolveUserConfig({ knowledgeRoot: configuredRoot }));

    const configuredOutput = await runCli(["--config", configPath, "init"], {
      AGENT_KNOWLEDGE_ROOT: environmentRoot
    });
    const explicitOutput = await runCli(["--config", configPath, "init", "--root", explicitRoot], {
      AGENT_KNOWLEDGE_ROOT: environmentRoot
    });

    expect(configuredOutput).toContain(configuredRoot);
    expect(explicitOutput).toContain(explicitRoot);
  });

  it("prints the selected config path and fully resolved configuration", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-config-show-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "config.json");
    writeUserConfig(
      configPath,
      resolveUserConfig({
        knowledgeRoot: path.join(temp, "knowledge"),
        integration: { product: "trae-cn" }
      })
    );

    const printedPath = await runCli(["--config", configPath, "config", "path"]);
    const printedConfig = JSON.parse(
      await runCli(["--config", configPath, "config", "show"])
    ) as { integration: { product: string } };

    expect(printedPath).toBe(configPath);
    expect(printedConfig.integration.product).toBe("trae-cn");
  });

  it("loads project shared and local config above the selected user config", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "agent-knowledge-project-config-cli-"));
    tempDirs.push(temp);
    const configPath = path.join(temp, "user.json");
    const projectRoot = path.join(temp, "repo");
    const nested = path.join(projectRoot, "nested");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    await execFileAsync("git", ["init"], { cwd: projectRoot });
    writeUserConfig(
      configPath,
      resolveUserConfig({
        knowledgeRoot: "/global",
        embeddings: { retrieval: "lexical" }
      })
    );
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project",
        embeddings: { retrieval: "hybrid" }
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(projectRoot, ".agent-knowledge.local.json"),
      `${JSON.stringify({
        knowledgeRoot: "/project-local",
        embeddings: { graphDepth: 2 }
      })}\n`,
      "utf8"
    );

    const printedConfig = JSON.parse(
      await runCli(["--config", configPath, "config", "show"], {
        AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "0",
        TEST_CWD: nested
      })
    ) as {
      knowledgeRoot: string;
      embeddings: { retrieval: string; graphDepth: number };
    };
    const sources = JSON.parse(
      await runCli(["--config", configPath, "config", "sources"], {
        AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG: "0",
        TEST_CWD: nested
      })
    ) as {
      project: { path: string; exists: boolean };
      projectLocal: { path: string; exists: boolean };
    };

    expect(printedConfig.knowledgeRoot).toBe("/project-local");
    expect(printedConfig.embeddings).toMatchObject({
      retrieval: "hybrid",
      graphDepth: 2
    });
    expect(sources.project).toEqual({
      path: path.join(realpathSync(projectRoot), ".agent-knowledge.json"),
      exists: true
    });
    expect(sources.projectLocal).toEqual({
      path: path.join(
        realpathSync(projectRoot),
        ".agent-knowledge.local.json"
      ),
      exists: true
    });
  });

  it("renders Chinese help by default and English help with a manual override", async () => {
    const chinese = await runCli(["--help"], {
      LANG: "fr_FR.UTF-8",
      LC_ALL: "",
      LC_MESSAGES: ""
    });
    const english = await runCli(["--locale", "en", "--help"], {
      LANG: "zh_CN.UTF-8"
    });

    expect(chinese).toContain("本地、可读、可审计的 Agent 知识工具");
    expect(chinese).toContain("交互式配置");
    expect(english).toContain("Local human-readable memory toolkit for agents");
    expect(english).toContain("Interactively configure");
  });

  it("documents graph retrieval modes and traversal controls in query help", async () => {
    const chinese = await runCli(["query", "--help"]);

    expect(chinese).toContain("lexical、hybrid、graph 或 hybrid-graph");
    expect(chinese).toContain("--graph-depth");
    expect(chinese).toContain("--graph-decay");
  });
});
