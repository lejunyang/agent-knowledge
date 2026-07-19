/**
 * templates 模块只保留旧 `linkTraeTemplates` TypeScript API 的兼容入口。
 *
 * 实际安装已经迁移到 integrations 模块：使用普通托管文件和结构化 hook merge，
 * 不再创建 symlink，也不覆盖其他工具或用户维护的配置。
 */
import { homedir } from "node:os";
import path from "node:path";
import { installIntegration } from "./integrations.js";

export type LinkTraeTemplatesOptions = {
  packageRoot: string;
  targetDir?: string;
  force?: boolean;
  platform?: NodeJS.Platform;
};

export type LinkedTemplate = {
  source: string;
  target: string;
  status: "installed" | "updated" | "unchanged";
};

export type LinkTraeTemplatesResult = {
  targetDir: string;
  linked: LinkedTemplate[];
};

export function getDefaultTraeConfigDir(): string {
  const traeHome = process.env.TRAE_HOME ?? path.join(homedir(), ".trae");
  return process.env.TRAECLI_HOME ?? path.join(traeHome, "cli");
}

export async function linkTraeTemplates(options: LinkTraeTemplatesOptions): Promise<LinkTraeTemplatesResult> {
  const targetDir = options.targetDir ? path.resolve(options.targetDir) : undefined;
  const packageRoot = path.resolve(options.packageRoot);
  const result = await installIntegration({
    packageRoot,
    product: "trae",
    scope: "user",
    targetDir,
    components: ["hooks", "agents", "skills"],
    platform: options.platform
  });

  if (result.conflicts.length > 0 && options.force) {
    throw new Error(
      `Managed integration does not overwrite unowned conflicts, even with force: ${result.conflicts.join(", ")}`
    );
  }

  return {
    targetDir: targetDir ?? result.roots.resources,
    linked: result.managed.map((item) => ({
      source: "managed-integration",
      target: item.path,
      status: item.status
    }))
  };
}
