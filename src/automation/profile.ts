/**
 * Automation profile 文件是外部 Agent CLI 与本项目之间的稳定授权契约。
 *
 * 文件可由用户保存在任意安全位置；写入时使用 0600，读取时严格拒绝未知字段和 secret 原值。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AutomationProfileSchema,
  type AutomationProfile
} from "./types.js";

/** 读取并严格校验 automation profile。 */
export async function readAutomationProfile(
  filePath: string
): Promise<AutomationProfile> {
  return AutomationProfileSchema.parse(
    JSON.parse(await readFile(path.resolve(filePath), "utf8"))
  );
}

/** 原子写 owner-only profile；配置只允许凭据环境变量名。 */
export async function writeAutomationProfile(
  filePath: string,
  rawProfile: AutomationProfile
): Promise<string> {
  const target = path.resolve(filePath);
  const profile = AutomationProfileSchema.parse(rawProfile);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(temporary, target);
  return target;
}
