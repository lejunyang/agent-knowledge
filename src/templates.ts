/**
 * templates 模块负责把仓库里的对外 TRAE 模板安装到真实 TRAE 配置目录。
 *
 * 模板源文件保留在 `templates/trae/`，真实使用时通过符号链接放到 `~/.trae-cn`。
 * 这样模板更新后无需复制多份文件，也避免仓库根目录直接出现 `.trae/` 造成误解。
 */
import { lstat, mkdir, readlink, readdir, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type LinkTraeTemplatesOptions = {
  packageRoot: string;
  targetDir?: string;
  force?: boolean;
  platform?: NodeJS.Platform;
};

export type LinkedTemplate = {
  source: string;
  target: string;
  status: "linked" | "already-linked";
};

export type LinkTraeTemplatesResult = {
  targetDir: string;
  linked: LinkedTemplate[];
};

export function getDefaultTraeConfigDir(): string {
  return path.join(homedir(), ".trae-cn");
}

function getHooksTemplateName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "hooks.windows.json" : "hooks.json";
}

async function linkFile(source: string, target: string, force: boolean): Promise<LinkedTemplate> {
  await mkdir(path.dirname(target), { recursive: true });

  if (existsSync(target)) {
    const stat = await lstat(target);
    if (stat.isSymbolicLink()) {
      const existing = await readlink(target);
      const resolvedExisting = path.resolve(path.dirname(target), existing);
      if (resolvedExisting === source) {
        return { source, target, status: "already-linked" };
      }
    }

    if (!force) {
      throw new Error(`Refusing to overwrite existing TRAE config: ${target}. Re-run with --force to replace it.`);
    }
    await rm(target, { recursive: true, force: true });
  }

  await symlink(source, target);
  return { source, target, status: "linked" };
}

export async function linkTraeTemplates(options: LinkTraeTemplatesOptions): Promise<LinkTraeTemplatesResult> {
  const targetDir = path.resolve(options.targetDir ?? getDefaultTraeConfigDir());
  const packageRoot = path.resolve(options.packageRoot);
  const templatesRoot = path.join(packageRoot, "templates", "trae");
  const templateAgentsRoot = path.join(templatesRoot, "agents");
  const projectSkillsRoot = path.join(packageRoot, ".trae", "skills");
  const force = options.force ?? false;
  const hooksTemplateName = getHooksTemplateName(options.platform ?? process.platform);

  const files: Array<{ source: string; target: string }> = [
    {
      source: path.join(templatesRoot, hooksTemplateName),
      target: path.join(targetDir, "hooks.json")
    }
  ];

  if (existsSync(templateAgentsRoot)) {
    const agentEntries = await readdir(templateAgentsRoot, { withFileTypes: true });
    for (const entry of agentEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({
          source: path.join(templateAgentsRoot, entry.name),
          target: path.join(targetDir, "agents", entry.name)
        });
      }
    }
  }

  if (existsSync(projectSkillsRoot)) {
    const skillEntries = await readdir(projectSkillsRoot, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (entry.isDirectory()) {
        files.push({
          source: path.join(projectSkillsRoot, entry.name),
          target: path.join(targetDir, "skills", entry.name)
        });
      }
    }
  }

  for (const file of files) {
    if (!existsSync(file.source)) {
      throw new Error(`TRAE template source does not exist: ${file.source}`);
    }
  }

  const linked: LinkedTemplate[] = [];
  for (const file of files) {
    linked.push(await linkFile(file.source, file.target, force));
  }

  return { targetDir, linked };
}
