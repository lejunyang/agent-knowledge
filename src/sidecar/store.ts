/** Sidecar store 保存有界 shadow artifact 与 hash，绝不写入 knowledge Markdown。 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  SidecarRunSchema,
  type SidecarProvider,
  type SidecarRun
} from "./types.js";

/** 稳定限制 artifact JSON 大小，防止外部服务返回超大 payload 填满本地磁盘。 */
function boundedArtifact(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  if (Buffer.byteLength(serialized, "utf8") > 512_000) {
    throw new Error("Sidecar artifact exceeds 512KB");
  }
  return `${serialized}\n`;
}

/** 写 artifact 和 run metadata；返回可供 compare/status 使用的记录。 */
export async function writeSidecarRun(
  rootDir: string,
  input: {
    sidecarId: string;
    provider: SidecarProvider | "comparison";
    operation: SidecarRun["operation"];
    status: SidecarRun["status"];
    startedAt: string;
    completedAt: string;
    latencyMs: number;
    artifact: unknown;
    error?: string;
  }
): Promise<SidecarRun> {
  const id = `sidecar_run_${createHash("sha256")
    .update(
      `${input.sidecarId}\0${input.operation}\0${input.startedAt}\0${randomUUID()}`
    )
    .digest("hex")
    .slice(0, 24)}`;
  const artifactContent = boundedArtifact(input.artifact);
  const artifactPath = resolveWorkspacePath(
    rootDir,
    ".memory",
    "sidecars",
    "artifacts",
    `${id}.json`
  );
  const runPath = resolveWorkspacePath(
    rootDir,
    ".memory",
    "sidecars",
    "runs",
    `${id}.json`
  );
  await mkdir(path.dirname(artifactPath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(runPath), { recursive: true, mode: 0o700 });
  await writeFile(artifactPath, artifactContent, {
    encoding: "utf8",
    mode: 0o600
  });
  const run = SidecarRunSchema.parse({
    version: 1,
    id,
    sidecarId: input.sidecarId,
    provider: input.provider,
    operation: input.operation,
    status: input.status,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    latencyMs: input.latencyMs,
    artifactPath,
    contentHash: `sha256:${createHash("sha256")
      .update(artifactContent)
      .digest("hex")}`,
    ...(input.error ? { error: input.error.slice(0, 500) } : {})
  });
  const temporary = `${runPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, runPath);
  return run;
}

/** 列出全部 sidecar run，按开始时间排序。 */
export async function listSidecarRuns(rootDir: string): Promise<SidecarRun[]> {
  const directory = resolveWorkspacePath(
    rootDir,
    ".memory",
    "sidecars",
    "runs"
  );
  if (!existsSync(directory)) {
    return [];
  }
  const runs: SidecarRun[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    runs.push(
      SidecarRunSchema.parse(
        JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
      )
    );
  }
  return runs.sort(
    (left, right) =>
      left.startedAt.localeCompare(right.startedAt) ||
      left.id.localeCompare(right.id)
  );
}
