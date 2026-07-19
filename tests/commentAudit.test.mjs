import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const checker = path.resolve("scripts/check-comments.mjs");

/** 在隔离源码上运行审计器，使脚本自测不依赖仓库现有注释欠账。 */
async function runChecker(source) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-knowledge-comment-audit-")
  );
  const target = path.join(directory, "fixture.ts");
  await writeFile(target, source, "utf8");
  try {
    return await execFileAsync("node", [checker, target], {
      cwd: process.cwd()
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("accepts exported functions with adjacent JSDoc", async () => {
  const result = await runChecker(`/** 说明公开操作的用途和边界。 */
export function documented(): void {}
`);

  assert.match(result.stdout, /注释审计通过/);
});

test("rejects undocumented exported and private named functions", async () => {
  await assert.rejects(
    runChecker(`function privateHelper(): void {}
export function undocumented(): void {}
`),
    (error) => {
      assert.match(error.stderr, /fixture\.ts:1 privateHelper/);
      assert.match(error.stderr, /fixture\.ts:2 undocumented/);
      return true;
    }
  );
});

test("rejects exported APIs whose adjacent JSDoc contains no Chinese", async () => {
  await assert.rejects(
    runChecker(`/** English-only public comment. */
export class EnglishOnly {}
`),
    (error) => {
      assert.match(error.stderr, /fixture\.ts:2 EnglishOnly/);
      return true;
    }
  );
});

test("rejects English-only comments on private implementation details", async () => {
  await assert.rejects(
    runChecker(`// English-only implementation explanation.
function privateHelper(): void {}
`),
    (error) => {
      assert.match(error.stderr, /源码注释包含英文-only 文案/);
      assert.match(error.stderr, /fixture\.ts:1/);
      return true;
    }
  );
});

test("rejects class methods without adjacent Chinese JSDoc", async () => {
  await assert.rejects(
    runChecker(`/** 测试类。 */
export class Example {
  run(): void {}
}
`),
    (error) => {
      assert.match(error.stderr, /fixture\.ts:3 run/);
      return true;
    }
  );
});

test("does not treat URL text inside strings as comments", async () => {
  const result = await runChecker(`const endpoint = "https://example.com";
/** 返回测试 endpoint。 */
export function getEndpoint(): string { return endpoint; }
`);

  assert.match(result.stdout, /注释审计通过/);
});
