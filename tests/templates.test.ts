import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  doctorIntegration,
  installIntegration,
  listIntegrationProducts,
  uninstallIntegration
} from "../src/integration/manager.js";

let tempDirs: string[] = [];

/** 判断测试目标是否仍存在。 */
async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** 计算 integration manifest 使用的文本 hash。 */
function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 递归列出 Skill 内的相对文件路径，确保安装模板不会漏掉 reference 或 UI metadata。 */
async function listRelativeFiles(
  root: string,
  current = root
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(root, target)));
    } else if (entry.isFile()) {
      files.push(path.relative(root, target));
    }
  }
  return files.sort();
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("managed integrations", () => {
  it("keeps every plugin-bundle Skill identical to the canonical project Skills", async () => {
    for (const skillName of [
      "knowledge-organizer",
      "memory-maintainer",
      "source-distiller",
      "lifecycle-recorder",
      "agent-knowledge-guide",
      "knowledge-automation-operator",
      "memory-use-policy-maintainer"
    ]) {
      const canonicalRoot = path.join(".trae", "skills", skillName);
      const canonicalFiles = await listRelativeFiles(canonicalRoot);
      const bundleRoots = [
        path.join("templates", "trae", "plugin", "skills", skillName),
        path.join(
          "templates",
          "codex",
          "marketplace",
          "plugins",
          "agent-knowledge",
          "skills",
          skillName
        )
      ];

      for (const bundledRoot of bundleRoots) {
        expect(
          await listRelativeFiles(bundledRoot),
          `${skillName} plugin file set drifted`
        ).toEqual(canonicalFiles);
        for (const relativePath of canonicalFiles) {
          const canonical = await readFile(
            path.join(canonicalRoot, relativePath),
            "utf8"
          );
          const bundled = await readFile(
            path.join(bundledRoot, relativePath),
            "utf8"
          );

          expect(
            bundled,
            `${skillName}/${relativePath} plugin content drifted`
          ).toBe(canonical);
        }
      }
    }
  });

  it("keeps the complete guide Skill bundle identical and documents every operating loop", async () => {
    const canonicalRoot = path.join(
      ".trae",
      "skills",
      "agent-knowledge-guide"
    );
    const bundledRoots = [
      path.join(
        "templates",
        "trae",
        "plugin",
        "skills",
        "agent-knowledge-guide"
      ),
      path.join(
        "templates",
        "codex",
        "marketplace",
        "plugins",
        "agent-knowledge",
        "skills",
        "agent-knowledge-guide"
      )
    ];
    const canonicalFiles = await listRelativeFiles(canonicalRoot);

    expect(canonicalFiles).toEqual([
      "SKILL.md",
      path.join("agents", "openai.yaml"),
      path.join("references", "diagnostics.md"),
      path.join("references", "workflows.md")
    ]);
    for (const bundledRoot of bundledRoots) {
      expect(await listRelativeFiles(bundledRoot)).toEqual(canonicalFiles);
      for (const relativePath of canonicalFiles) {
        await expect(
          readFile(path.join(bundledRoot, relativePath), "utf8")
        ).resolves.toBe(
          await readFile(path.join(canonicalRoot, relativePath), "utf8")
        );
      }
    }

    const guide = await readFile(
      path.join(canonicalRoot, "SKILL.md"),
      "utf8"
    );
    for (const requiredTopic of [
      "source refresh",
      "knowledge evidence",
      "event append",
      "maintenance run",
      "knowledge audit",
      "feedback",
      "integration doctor",
      "不自动批准"
    ]) {
      expect(guide).toContain(requiredTopic);
    }
  });

  it("defines a bounded background operator Skill and reusable system prompt", async () => {
    const skillRoot = path.join(
      ".trae",
      "skills",
      "knowledge-automation-operator"
    );
    expect(await listRelativeFiles(skillRoot)).toEqual([
      "SKILL.md",
      path.join("agents", "openai.yaml"),
      path.join("references", "profile-schema.md"),
      path.join("references", "question-policy.md")
    ]);
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    const prompt = await readFile(
      path.join(
        "templates",
        "automation",
        "knowledge-automation-system-prompt.md"
      ),
      "utf8"
    );
    for (const required of [
      "automation validate",
      "automation inspect",
      "automation run",
      "notifications list",
      "一次汇总",
      "不修改 active knowledge",
      "maxQuestions",
      "callback"
    ]) {
      expect(skill).toContain(required);
      expect(prompt).toContain(required);
    }
    expect(prompt).toContain("FINAL_REPORT_JSON");
    expect(prompt).toContain("confirmation_required");
  });

  it("defines a shadow-only memory-use policy maintainer Skill", async () => {
    const skillRoot = path.join(
      ".trae",
      "skills",
      "memory-use-policy-maintainer"
    );
    expect(await listRelativeFiles(skillRoot)).toEqual([
      "SKILL.md",
      path.join("agents", "openai.yaml"),
      path.join("references", "activation-readiness.md")
    ]);
    const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
    for (const required of [
      "policy mine",
      "policy proposals",
      "policy accept",
      "policy simulate",
      "policy history",
      "policy deprecate",
      "不自动执行 `policy accept`",
      "2–4 周",
      "30 个独立真实 query run"
    ]) {
      expect(skill).toContain(required);
    }
  });

  it("installs TRAE hooks, agents, and skills as regular managed files", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-target-"));
    tempDirs.push(targetDir);

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["hooks", "agents", "skills"]
    });

    const readerTarget = path.join(
      targetDir,
      "agents",
      "agent-knowledge-reader.md"
    );
    const writerTarget = path.join(
      targetDir,
      "agents",
      "agent-knowledge-writer.md"
    );
    const hooksTarget = path.join(targetDir, "hooks.json");
    const cliHooksTarget = path.join(targetDir, "cli", "hooks.json");
    const skillTarget = path.join(targetDir, "skills", "knowledge-organizer");
    const maintainerTarget = path.join(
      targetDir,
      "skills",
      "memory-maintainer",
      "SKILL.md"
    );
    const distillerTarget = path.join(
      targetDir,
      "skills",
      "source-distiller",
      "SKILL.md"
    );
    const lifecycleTarget = path.join(
      targetDir,
      "skills",
      "lifecycle-recorder",
      "SKILL.md"
    );
    const policyMaintainerTarget = path.join(
      targetDir,
      "skills",
      "memory-use-policy-maintainer",
      "SKILL.md"
    );

    expect((await lstat(readerTarget)).isFile()).toBe(true);
    expect((await lstat(writerTarget)).isFile()).toBe(true);
    expect(await exists(path.join(targetDir, "agents", "memory-reader.md"))).toBe(
      false
    );
    expect(await exists(path.join(targetDir, "agents", "memory-writer.md"))).toBe(
      false
    );
    expect((await lstat(hooksTarget)).isFile()).toBe(true);
    expect((await lstat(cliHooksTarget)).isFile()).toBe(true);
    expect((await lstat(skillTarget)).isDirectory()).toBe(true);
    expect((await lstat(policyMaintainerTarget)).isFile()).toBe(true);
    await expect(readFile(readerTarget, "utf8")).resolves.toContain(
      "hybrid-graph"
    );
    await expect(readFile(writerTarget, "utf8")).resolves.toContain(
      "organize-inbox --approve"
    );
    await expect(readFile(writerTarget, "utf8")).resolves.toContain(
      "layer: evidence"
    );
    await expect(readFile(maintainerTarget, "utf8")).resolves.toContain(
      "maintenance install-skill"
    );
    await expect(readFile(maintainerTarget, "utf8")).resolves.toContain(
      "maintenance cleanup --apply"
    );
    await expect(readFile(maintainerTarget, "utf8")).resolves.toContain(
      "用户明确决定"
    );
    await expect(readFile(distillerTarget, "utf8")).resolves.toContain(
      "source list --needs-review"
    );
    await expect(readFile(distillerTarget, "utf8")).resolves.toContain(
      "source check"
    );
    await expect(readFile(distillerTarget, "utf8")).resolves.toContain(
      "source refresh"
    );
    await expect(readFile(distillerTarget, "utf8")).resolves.toContain(
      "offline export"
    );
    await expect(readFile(distillerTarget, "utf8")).resolves.toContain(
      "expectedFingerprint"
    );
    await expect(readFile(lifecycleTarget, "utf8")).resolves.toContain(
      "event append"
    );
    await expect(readFile(lifecycleTarget, "utf8")).resolves.toContain(
      "root_cause"
    );
    const organizer = await readFile(
      path.join(skillTarget, "SKILL.md"),
      "utf8"
    );
    expect(organizer).toContain("source refresh");
    expect(organizer).toContain("垂直领域确认门禁");
    expect(organizer).toContain("意义不明");
    expect(organizer).toContain("疑似错误");
    expect(organizer).toContain("一次汇总");
    expect(organizer).toContain("确认前不得写入 active 或 inbox");
    expect(result.conflicts).toEqual([]);
    expect(result.managed.length).toBeGreaterThanOrEqual(4);
  });

  it("installs TRAE CN resources under a .trae-cn-style root", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-cn-"));
    tempDirs.push(targetDir);

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae-cn",
      scope: "project",
      targetDir,
      components: ["hooks", "agents"]
    });

    expect(result.product).toBe("trae-cn");
    await expect(readFile(path.join(targetDir, "hooks.json"), "utf8")).resolves.toContain(
      "agent-knowledge hook"
    );
    await expect(
      readFile(
        path.join(targetDir, "agents", "agent-knowledge-reader.md"),
        "utf8"
      )
    ).resolves.toContain(
      "agent-knowledge-reader"
    );
    expect(result.managed.map((item) => item.path)).not.toContain(path.join(targetDir, "cli", "hooks.json"));
  });

  it("structurally merges hooks and preserves foreign handlers and top-level fields", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-merge-"));
    tempDirs.push(targetDir);
    await writeFile(
      path.join(targetDir, "hooks.json"),
      JSON.stringify(
        {
          version: 1,
          description: "keep me",
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: "foreign-hook", timeout: 7 },
                  { type: "command", command: "agent-knowledge hook obsolete", timeout: 1 }
                ]
              }
            ],
            Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }]
          }
        },
        null,
        2
      ),
      "utf8"
    );

    await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["hooks"]
    });
    const merged = JSON.parse(await readFile(path.join(targetDir, "hooks.json"), "utf8")) as {
      description: string;
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    };
    const allCommands = Object.values(merged.hooks).flatMap((groups) =>
      groups.flatMap((group) => group.hooks.map((handler) => handler.command))
    );

    expect(merged.description).toBe("keep me");
    expect(allCommands).toContain("foreign-hook");
    expect(allCommands).toContain("foreign-stop");
    expect(allCommands).not.toContain("agent-knowledge hook obsolete");
    expect(allCommands.filter((command) => command.includes("agent-knowledge hook user-prompt-submit"))).toHaveLength(1);
  });

  it("is idempotent and uninstalls only owned resources", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-idempotent-"));
    tempDirs.push(targetDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    await writeFile(path.join(targetDir, "agents", "custom.md"), "custom", "utf8");

    const options = {
      packageRoot: process.cwd(),
      product: "trae" as const,
      scope: "user" as const,
      targetDir,
      components: ["hooks", "agents"] as const
    };
    await installIntegration(options);
    const second = await installIntegration(options);
    const removed = await uninstallIntegration({
      product: "trae",
      scope: "user",
      targetDir
    });

    expect(second.managed.every((item) => item.status === "unchanged")).toBe(true);
    expect(
      removed.removed.some((item) =>
        item.endsWith("agent-knowledge-reader.md")
      )
    ).toBe(true);
    await expect(readFile(path.join(targetDir, "agents", "custom.md"), "utf8")).resolves.toBe("custom");
    const hooks = await readFile(path.join(targetDir, "hooks.json"), "utf8");
    expect(hooks).not.toContain("agent-knowledge hook");
  });

  it("reports conflicts for same-name files it does not own", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-existing-"));
    tempDirs.push(targetDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    await writeFile(
      path.join(targetDir, "agents", "agent-knowledge-reader.md"),
      "foreign",
      "utf8"
    );

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["agents"]
    });

    expect(result.conflicts).toContain(
      path.join(targetDir, "agents", "agent-knowledge-reader.md")
    );
    await expect(
      readFile(
        path.join(targetDir, "agents", "agent-knowledge-reader.md"),
        "utf8"
      )
    ).resolves.toBe("foreign");
  });

  it("retires unchanged legacy agent templates managed by the previous manifest", async () => {
    const targetDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-trae-legacy-managed-")
    );
    tempDirs.push(targetDir);
    const agentsDir = path.join(targetDir, "agents");
    const oldReader = path.join(agentsDir, "memory-reader.md");
    const oldWriter = path.join(agentsDir, "memory-writer.md");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(oldReader, "legacy-reader\n", "utf8");
    await writeFile(oldWriter, "legacy-writer\n", "utf8");
    await writeFile(
      path.join(targetDir, ".agent-knowledge-integration.json"),
      `${JSON.stringify(
        {
          version: 1,
          product: "trae",
          scope: "user",
          installedAt: "2026-07-19T00:00:00.000Z",
          components: ["agents"],
          resources: [
            {
              path: oldReader,
              kind: "file",
              hash: hashText("legacy-reader\n")
            },
            {
              path: oldWriter,
              kind: "file",
              hash: hashText("legacy-writer\n")
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["agents"]
    });

    expect(await exists(oldReader)).toBe(false);
    expect(await exists(oldWriter)).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(
      result.managed.map((item) => path.basename(item.path)).sort()
    ).toEqual([
      "agent-knowledge-reader.md",
      "agent-knowledge-writer.md"
    ]);
    const manifest = JSON.parse(
      await readFile(
        path.join(targetDir, ".agent-knowledge-integration.json"),
        "utf8"
      )
    ) as { resources: Array<{ path: string }> };
    expect(manifest.resources.map((item) => item.path)).not.toContain(oldReader);
    expect(manifest.resources.map((item) => item.path)).not.toContain(oldWriter);
  });

  it("preserves modified legacy agent templates during the rename migration", async () => {
    const targetDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-trae-legacy-modified-")
    );
    tempDirs.push(targetDir);
    const agentsDir = path.join(targetDir, "agents");
    const oldReader = path.join(agentsDir, "memory-reader.md");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(oldReader, "user-modified-reader\n", "utf8");
    await writeFile(
      path.join(targetDir, ".agent-knowledge-integration.json"),
      `${JSON.stringify(
        {
          version: 1,
          product: "trae",
          scope: "user",
          installedAt: "2026-07-19T00:00:00.000Z",
          components: ["agents"],
          resources: [
            {
              path: oldReader,
              kind: "file",
              hash: hashText("legacy-original-reader\n")
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["agents"]
    });

    await expect(readFile(oldReader, "utf8")).resolves.toBe(
      "user-modified-reader\n"
    );
    expect(result.conflicts).toContain(oldReader);
    await expect(
      readFile(
        path.join(agentsDir, "agent-knowledge-reader.md"),
        "utf8"
      )
    ).resolves.toContain("agent-knowledge-reader");
  });

  it("overwrites target resources and replaces symlinks when explicitly requested", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-overwrite-"));
    const externalDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-external-"));
    tempDirs.push(targetDir, externalDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    const externalFile = path.join(externalDir, "agent-knowledge-reader.md");
    await writeFile(externalFile, "external", "utf8");
    await symlink(
      externalFile,
      path.join(targetDir, "agents", "agent-knowledge-reader.md")
    );
    await writeFile(path.join(targetDir, "hooks.json"), '{"foreign":true}\n', "utf8");

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "project",
      targetDir,
      components: ["hooks", "agents"],
      mode: "overwrite"
    });

    expect(result.conflicts).toEqual([]);
    expect(
      (
        await lstat(
          path.join(targetDir, "agents", "agent-knowledge-reader.md")
        )
      ).isSymbolicLink()
    ).toBe(false);
    await expect(
      readFile(
        path.join(targetDir, "agents", "agent-knowledge-reader.md"),
        "utf8"
      )
    ).resolves.toContain(
      "agent-knowledge-reader"
    );
    await expect(readFile(path.join(targetDir, "hooks.json"), "utf8")).resolves.not.toContain('"foreign"');
    await expect(readFile(externalFile, "utf8")).resolves.toBe("external");
  });

  it("supports Windows TRAE hooks, Claude Code, plugin bundles, and doctor", async () => {
    const windowsTarget = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-windows-"));
    const claudeTarget = await mkdtemp(path.join(tmpdir(), "agent-knowledge-claude-"));
    tempDirs.push(windowsTarget, claudeTarget);

    await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir: windowsTarget,
      components: ["hooks", "plugin-bundle"],
      platform: "win32"
    });
    await installIntegration({
      packageRoot: process.cwd(),
      product: "claude-code",
      scope: "project",
      targetDir: claudeTarget,
      components: ["hooks", "agents"]
    });

    await expect(readFile(path.join(windowsTarget, "hooks.json"), "utf8")).resolves.toContain(
      "agent-knowledge.cmd hook"
    );
    await expect(readFile(path.join(windowsTarget, "hooks.json"), "utf8")).resolves.toContain(
      "agent-knowledge.cmd hook subagent-event"
    );
    await expect(
      readFile(path.join(windowsTarget, "plugins", "agent-knowledge", ".codex-plugin", "plugin.json"), "utf8")
    ).resolves.toContain('"name": "agent-knowledge"');
    await expect(
      readFile(path.join(windowsTarget, "plugins", "agent-knowledge", "hooks", "hooks.json"), "utf8")
    ).resolves.toContain("agent-knowledge.cmd hook");
    await expect(
      readFile(
        path.join(
          windowsTarget,
          "plugins",
          "agent-knowledge",
          "agents",
          "agent-knowledge-reader.md"
        ),
        "utf8"
      )
    ).resolves.toContain("hybrid-graph");
    await expect(
      readFile(
        path.join(
          windowsTarget,
          "plugins",
          "agent-knowledge",
          "skills",
          "memory-maintainer",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("maintenance install-skill");
    await expect(
      readFile(
        path.join(
          windowsTarget,
          "plugins",
          "agent-knowledge",
          "skills",
          "memory-maintainer",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("maintenance cleanup --apply");
    await expect(
      readFile(
        path.join(
          windowsTarget,
          "plugins",
          "agent-knowledge",
          "skills",
          "knowledge-organizer",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("垂直领域确认门禁");
    await expect(readFile(path.join(claudeTarget, "settings.json"), "utf8")).resolves.toContain(
      "agent-knowledge hook"
    );
    await expect(
      readFile(
        path.join(claudeTarget, "agents", "agent-knowledge-reader.md"),
        "utf8"
      )
    ).resolves.toContain("--retrieval graph");
    const doctor = await doctorIntegration({
      product: "trae",
      scope: "user",
      targetDir: windowsTarget
    });
    expect(doctor.healthy).toBe(true);
    expect(listIntegrationProducts().map((product) => product.id)).toEqual([
      "trae",
      "trae-cn",
      "claude-code",
      "codex"
    ]);
  });

  it("installs Codex hooks, standalone Skills, and a valid local marketplace without fake agents", async () => {
    const targetDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-codex-")
    );
    tempDirs.push(targetDir);
    await writeFile(
      path.join(targetDir, "hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "foreign-codex-stop",
                    timeout: 5
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const options = {
      packageRoot: process.cwd(),
      product: "codex" as const,
      scope: "project" as const,
      targetDir,
      components: ["hooks", "skills", "plugin-bundle"] as const
    };
    const first = await installIntegration(options);
    const second = await installIntegration(options);

    const hooks = await readFile(path.join(targetDir, "hooks.json"), "utf8");
    const marketplaceRoot = path.join(
      targetDir,
      "agent-knowledge-marketplace"
    );
    const marketplace = JSON.parse(
      await readFile(
        path.join(marketplaceRoot, ".agents", "plugins", "marketplace.json"),
        "utf8"
      )
    ) as {
      plugins: Array<{
        name: string;
        source: { source: string; path: string };
      }>;
    };
    const pluginRoot = path.join(
      marketplaceRoot,
      "plugins",
      "agent-knowledge"
    );

    expect(hooks).toContain("foreign-codex-stop");
    expect(hooks).toContain("agent-knowledge hook user-prompt-submit");
    expect(hooks).toContain("agent-knowledge hook subagent-event");
    expect(hooks).not.toContain("SubagentStart");
    expect(hooks).not.toContain("SessionEnd");
    await expect(
      readFile(
        path.join(
          targetDir,
          "skills",
          "agent-knowledge-guide",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("Agent Knowledge 使用向导");
    await expect(
      readFile(
        path.join(
          targetDir,
          "skills",
          "memory-use-policy-maintainer",
          "SKILL.md"
        ),
        "utf8"
      )
    ).resolves.toContain("Policy Maintainer");
    expect(await exists(path.join(targetDir, "agents"))).toBe(false);
    expect(marketplace.plugins).toEqual([
      {
        name: "agent-knowledge",
        source: {
          source: "local",
          path: "./plugins/agent-knowledge"
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL"
        },
        category: "Productivity"
      }
    ]);
    await expect(
      readFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        "utf8"
      )
    ).resolves.toContain('"hooks": "./hooks.json"');
    await expect(
      readFile(path.join(pluginRoot, "hooks.json"), "utf8")
    ).resolves.toContain("agent-knowledge hook user-prompt-submit");
    await expect(
      readFile(
        path.join(
          pluginRoot,
          "skills",
          "agent-knowledge-guide",
          "references",
          "diagnostics.md"
        ),
        "utf8"
      )
    ).resolves.toContain("检索是否会用记忆");
    await expect(
      readFile(
        path.join(
          pluginRoot,
          "skills",
          "memory-use-policy-maintainer",
          "references",
          "activation-readiness.md"
        ),
        "utf8"
      )
    ).resolves.toContain("P3 Runtime Enforcement");
    expect(first.conflicts).toEqual([]);
    expect(second.managed.every((item) => item.status === "unchanged")).toBe(
      true
    );

    const doctor = await doctorIntegration({
      product: "codex",
      scope: "project",
      targetDir
    });
    expect(doctor.healthy).toBe(true);

    await expect(
      installIntegration({
        packageRoot: process.cwd(),
        product: "codex",
        scope: "project",
        targetDir,
        components: ["agents"]
      })
    ).rejects.toThrow("codex does not support component: agents");

    const removed = await uninstallIntegration({
      product: "codex",
      scope: "project",
      targetDir
    });
    expect(removed.preserved).toEqual([]);
    expect(removed.removed).toContain(path.join(targetDir, "hooks.json"));
    await expect(readFile(path.join(targetDir, "hooks.json"), "utf8")).resolves.toContain(
      "foreign-codex-stop"
    );
    expect(await exists(path.join(targetDir, "skills", "agent-knowledge-guide"))).toBe(false);
    expect(await exists(marketplaceRoot)).toBe(false);
  });

  it("uses Windows command shims in standalone and plugin Codex Hooks", async () => {
    const targetDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-codex-windows-")
    );
    tempDirs.push(targetDir);

    await installIntegration({
      packageRoot: process.cwd(),
      product: "codex",
      scope: "project",
      targetDir,
      components: ["hooks", "plugin-bundle"],
      platform: "win32"
    });

    await expect(
      readFile(path.join(targetDir, "hooks.json"), "utf8")
    ).resolves.toContain("agent-knowledge.cmd hook user-prompt-submit");
    await expect(
      readFile(
        path.join(
          targetDir,
          "agent-knowledge-marketplace",
          "plugins",
          "agent-knowledge",
          "hooks.json"
        ),
        "utf8"
      )
    ).resolves.toContain("agent-knowledge.cmd hook user-prompt-submit");
  });
});
