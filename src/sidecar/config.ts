/** Sidecar 配置使用 owner-only JSON，便于一键生成后人工固定上游版本与 endpoint。 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SidecarConfigSchema,
  type SidecarConfig,
  type SidecarConfigInput
} from "./types.js";

/** 严格读取 sidecar 配置。 */
export async function readSidecarConfig(filePath: string): Promise<SidecarConfig> {
  return SidecarConfigSchema.parse(
    JSON.parse(await readFile(path.resolve(filePath), "utf8"))
  );
}

/** 原子写 0600 sidecar 配置；只允许 auth 环境变量名。 */
export async function writeSidecarConfig(
  filePath: string,
  input: SidecarConfigInput
): Promise<string> {
  const target = path.resolve(filePath);
  const config = SidecarConfigSchema.parse(input);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  return target;
}
