import { spawn } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function runHook(root: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "node",
      [
        "--import",
        "tsx",
        "src/cli.ts",
        "--config",
        path.join(root, "missing-config.json"),
        "hook",
        "user-prompt-submit",
        "--root",
        root
      ],
      {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LANG: "zh_CN.UTF-8"
      }
      }
    );
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(output.trim());
      } else {
        reject(new Error(`Hook CLI exited with ${code}: ${errorOutput}`));
      }
    });
    child.stdin.end(JSON.stringify({ prompt, cwd: root }));
  });
}

describe("UserPromptSubmit CLI", () => {
  it("emits no stdout for an unrelated no-hit prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-hook-silent-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    expect(await runHook(root, "写一首关于海边日落的诗")).toBe("");
  });

  it("injects only a context packet for a relevant prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-hook-context-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const output = JSON.parse(
      await runHook(root, "审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback")
    ) as {
      hookSpecificOutput: {
        additionalContext: string;
      };
    };

    expect(output.hookSpecificOutput.additionalContext).toContain("context_packet");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("runtimeContext");
    expect(output.hookSpecificOutput.additionalContext).not.toContain("knowledge_catalog");
  });
});
