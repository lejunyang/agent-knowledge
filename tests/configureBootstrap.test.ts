import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureKnowledgeWorkspace,
  type ConfigureBootstrapDependencies
} from "../src/cli/configureBootstrap.js";
import {
  DEFAULT_USER_CONFIG,
  resolveUserConfig
} from "../src/core/config.js";
import type { ConfigurationPrompter } from "../src/cli/configure.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

/** Bootstrap 测试不关心问答细节，禁止意外调用真实 prompt。 */
const prompter: ConfigurationPrompter = {
  async ask() {
    throw new Error("bootstrap test should use the injected collector");
  }
};

/** 注入固定配置，同时保留真实 Git 初始化和配置持久化实现。 */
function dependenciesFor(
  knowledgeRoot: string
): Partial<ConfigureBootstrapDependencies> {
  return {
    collectConfiguration: vi.fn(async () =>
      resolveUserConfig({
        ...DEFAULT_USER_CONFIG,
        knowledgeRoot
      })
    )
  };
}

describe("configure workspace bootstrap", () => {
  it("initializes the selected knowledge root as a safe Git workspace before saving configuration", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-configure-bootstrap-")
    );
    tempDirs.push(root);
    const knowledgeRoot = path.join(root, "knowledge-data");
    const configPath = path.join(root, "config.json");

    const result = await configureKnowledgeWorkspace(
      {
        configPath,
        prompter,
        current: DEFAULT_USER_CONFIG,
        initializeGit: true
      },
      dependenciesFor(knowledgeRoot)
    );
    const configured = JSON.parse(
      await readFile(configPath, "utf8")
    ) as { knowledgeRoot: string };
    const git = await execFileAsync(
      "git",
      ["-C", knowledgeRoot, "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8" }
    );

    expect(result).toMatchObject({
      gitInitialized: true,
      knowledgeRoot
    });
    expect(configured.knowledgeRoot).toBe(knowledgeRoot);
    expect(git.stdout.trim()).toBe("true");
    await expect(
      stat(path.join(knowledgeRoot, "knowledge"))
    ).resolves.toBeDefined();
    await expect(
      readFile(path.join(knowledgeRoot, ".gitignore"), "utf8")
    ).resolves.toContain(".vault/");
    await expect(
      readFile(path.join(knowledgeRoot, "SECURITY.md"), "utf8")
    ).resolves.toContain("Knowledge Data Security");
  });

  it("does not replace an existing configuration when Git workspace initialization fails", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-configure-atomic-")
    );
    tempDirs.push(root);
    const repository = path.join(root, "code-repository");
    const nestedKnowledge = path.join(repository, "private-knowledge");
    const configPath = path.join(root, "config.json");
    const previous = '{"version":1,"knowledgeRoot":"/previous"}\n';
    await execFileAsync("git", ["init", repository]);
    await writeFile(configPath, previous, "utf8");

    await expect(
      configureKnowledgeWorkspace(
        {
          configPath,
          prompter,
          current: DEFAULT_USER_CONFIG,
          initializeGit: true
        },
        dependenciesFor(nestedKnowledge)
      )
    ).rejects.toThrow(/separate directory/i);

    expect(await readFile(configPath, "utf8")).toBe(previous);
  });

  it("can explicitly skip Git initialization while still saving configuration", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-configure-no-git-")
    );
    tempDirs.push(root);
    const knowledgeRoot = path.join(root, "managed-elsewhere");
    const configPath = path.join(root, "config.json");

    const result = await configureKnowledgeWorkspace(
      {
        configPath,
        prompter,
        current: DEFAULT_USER_CONFIG,
        initializeGit: false
      },
      dependenciesFor(knowledgeRoot)
    );

    expect(result).toMatchObject({
      gitInitialized: false,
      knowledgeRoot
    });
    expect(
      (JSON.parse(await readFile(configPath, "utf8")) as {
        knowledgeRoot: string;
      }).knowledgeRoot
    ).toBe(knowledgeRoot);
    await expect(stat(path.join(knowledgeRoot, ".git"))).rejects.toThrow();
    await expect(
      stat(path.join(knowledgeRoot, "SECURITY.md"))
    ).rejects.toThrow();
  });
});
