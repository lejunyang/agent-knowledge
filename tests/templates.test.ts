import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("managed integrations", () => {
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

    const readerTarget = path.join(targetDir, "agents", "memory-reader.md");
    const writerTarget = path.join(targetDir, "agents", "memory-writer.md");
    const hooksTarget = path.join(targetDir, "hooks.json");
    const cliHooksTarget = path.join(targetDir, "cli", "hooks.json");
    const skillTarget = path.join(targetDir, "skills", "knowledge-organizer");
    const maintainerTarget = path.join(
      targetDir,
      "skills",
      "memory-maintainer",
      "SKILL.md"
    );

    expect((await lstat(readerTarget)).isFile()).toBe(true);
    expect((await lstat(writerTarget)).isFile()).toBe(true);
    expect((await lstat(hooksTarget)).isFile()).toBe(true);
    expect((await lstat(cliHooksTarget)).isFile()).toBe(true);
    expect((await lstat(skillTarget)).isDirectory()).toBe(true);
    await expect(readFile(readerTarget, "utf8")).resolves.toContain(
      "hybrid-graph"
    );
    await expect(readFile(writerTarget, "utf8")).resolves.toContain(
      "organize-inbox --approve"
    );
    await expect(readFile(writerTarget, "utf8")).resolves.toContain(
      "type=source"
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
    await expect(readFile(path.join(targetDir, "agents", "memory-reader.md"), "utf8")).resolves.toContain(
      "memory-reader"
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
    expect(removed.removed.some((item) => item.endsWith("memory-reader.md"))).toBe(true);
    await expect(readFile(path.join(targetDir, "agents", "custom.md"), "utf8")).resolves.toBe("custom");
    const hooks = await readFile(path.join(targetDir, "hooks.json"), "utf8");
    expect(hooks).not.toContain("agent-knowledge hook");
  });

  it("reports conflicts for same-name files it does not own", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-existing-"));
    tempDirs.push(targetDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    await writeFile(path.join(targetDir, "agents", "memory-reader.md"), "foreign", "utf8");

    const result = await installIntegration({
      packageRoot: process.cwd(),
      product: "trae",
      scope: "user",
      targetDir,
      components: ["agents"]
    });

    expect(result.conflicts).toContain(path.join(targetDir, "agents", "memory-reader.md"));
    await expect(readFile(path.join(targetDir, "agents", "memory-reader.md"), "utf8")).resolves.toBe("foreign");
  });

  it("overwrites target resources and replaces symlinks when explicitly requested", async () => {
    const targetDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-overwrite-"));
    const externalDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-trae-external-"));
    tempDirs.push(targetDir, externalDir);
    await mkdir(path.join(targetDir, "agents"), { recursive: true });
    const externalFile = path.join(externalDir, "memory-reader.md");
    await writeFile(externalFile, "external", "utf8");
    await symlink(externalFile, path.join(targetDir, "agents", "memory-reader.md"));
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
    expect((await lstat(path.join(targetDir, "agents", "memory-reader.md"))).isSymbolicLink()).toBe(false);
    await expect(readFile(path.join(targetDir, "agents", "memory-reader.md"), "utf8")).resolves.toContain(
      "memory-reader"
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
          "memory-reader.md"
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
    await expect(readFile(path.join(claudeTarget, "settings.json"), "utf8")).resolves.toContain(
      "agent-knowledge hook"
    );
    await expect(
      readFile(path.join(claudeTarget, "agents", "memory-reader.md"), "utf8")
    ).resolves.toContain("--retrieval graph");
    const doctor = await doctorIntegration({
      product: "trae",
      scope: "user",
      targetDir: windowsTarget
    });
    expect(doctor.healthy).toBe(true);
    expect(listIntegrationProducts().map((product) => product.id)).toEqual(["trae", "trae-cn", "claude-code"]);
  });
});
