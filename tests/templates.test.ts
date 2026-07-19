import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const skillTarget = path.join(targetDir, "skills", "knowledge-organizer");

    expect((await lstat(readerTarget)).isFile()).toBe(true);
    expect((await lstat(writerTarget)).isFile()).toBe(true);
    expect((await lstat(hooksTarget)).isFile()).toBe(true);
    expect((await lstat(skillTarget)).isDirectory()).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.managed.length).toBeGreaterThanOrEqual(4);
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
    await expect(
      readFile(path.join(windowsTarget, "plugins", "agent-knowledge", ".codex-plugin", "plugin.json"), "utf8")
    ).resolves.toContain('"name": "agent-knowledge"');
    await expect(
      readFile(path.join(windowsTarget, "plugins", "agent-knowledge", "hooks", "hooks.json"), "utf8")
    ).resolves.toContain("agent-knowledge.cmd hook");
    await expect(readFile(path.join(claudeTarget, "settings.json"), "utf8")).resolves.toContain(
      "agent-knowledge hook"
    );
    const doctor = await doctorIntegration({
      product: "trae",
      scope: "user",
      targetDir: windowsTarget
    });
    expect(doctor.healthy).toBe(true);
    expect(listIntegrationProducts().map((product) => product.id)).toEqual(["trae", "claude-code"]);
  });
});
