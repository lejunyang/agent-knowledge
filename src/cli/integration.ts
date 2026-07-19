/**
 * Integration CLI helper 将“如何选择”与“如何安装”分开。
 *
 * 核心 installer 保持非交互、可测试和可复用；只有 CLI helper 负责询问缺失参数及生成人类输出。
 * 这样自动化调用可以完整传参跳过交互，TUI 用户则能在每一步看到用途和默认值。
 */
import type { UserConfig } from "../core/config.js";
import { translate, type SupportedLocale } from "../i18n/locale.js";
import type {
  InstallIntegrationResult,
  IntegrationComponent,
  IntegrationInstallMode,
  IntegrationProductId,
  IntegrationScope
} from "../integration/manager.js";
import {
  InquirerPrompter,
  promptCheckbox,
  promptInput,
  promptSelect,
  type InteractivePrompter
} from "./prompts.js";

export type IntegrationPrompter = InteractivePrompter;
export class TerminalIntegrationPrompter extends InquirerPrompter {}

export type IntegrationInstallSelection = {
  product: IntegrationProductId;
  scope: IntegrationScope;
  components: IntegrationComponent[];
  targetDir?: string;
  mode: IntegrationInstallMode;
};

export async function promptForIntegrationInstall(options: {
  defaults: UserConfig["integration"];
  prompter: IntegrationPrompter;
  partial?: Partial<IntegrationInstallSelection>;
  locale?: SupportedLocale;
}): Promise<IntegrationInstallSelection> {
  const { defaults, prompter, partial = {} } = options;
  const locale = options.locale ?? "zh-CN";
  const t = (chinese: string, english: string): string => translate(locale, chinese, english);
  const product = (partial.product ??
    (await promptSelect(
      prompter,
      t("产品", "Product"),
      [
        {
          name: "TRAE",
          value: "trae",
          description: t("管理 .trae/hooks.json 和 .trae/cli/hooks.json", "Manage .trae/hooks.json and .trae/cli/hooks.json")
        },
        {
          name: "TRAE CN",
          value: "trae-cn",
          description: t("管理 .trae-cn/hooks.json", "Manage .trae-cn/hooks.json")
        },
        {
          name: "Claude Code",
          value: "claude-code",
          description: t("管理 .claude/settings.json", "Manage .claude/settings.json")
        }
      ],
      defaults.product
    ))) as IntegrationProductId;
  const scope = (partial.scope ??
    (await promptSelect(
      prompter,
      t("安装范围", "Installation scope"),
      [
        {
          name: t("用户级", "User"),
          value: "user",
          description: t("安装一次，所有项目可用", "Install once for every project")
        },
        {
          name: t("项目级", "Project"),
          value: "project",
          description: t("只安装到当前仓库", "Install only in the current repository")
        }
      ],
      defaults.scope
    ))) as IntegrationScope;
  const components =
    partial.components ??
    (await promptCheckbox(
      prompter,
      t("组件（空格切换，回车确认）", "Components (space to toggle, enter to confirm)"),
      [
        { name: "Hooks", value: "hooks", description: t("自动检索和生命周期 staging", "Automatic query and lifecycle staging") },
        { name: "Agents", value: "agents", description: "memory-reader / memory-writer" },
        { name: "Skills", value: "skills", description: t("知识整理与维护", "knowledge organizer and maintainer") },
        {
          name: t("插件包", "Plugin bundle"),
          value: "plugin-bundle",
          description: t("安装可选 TRAE 插件包", "Install an optional TRAE plugin package")
        }
      ],
      defaults.components
    )) as IntegrationComponent[];
  const targetAnswer =
    partial.targetDir !== undefined
      ? partial.targetDir
      : await promptInput(
          prompter,
          t("目标位置覆盖（留空使用产品默认位置）", "Target override (leave blank for the product default)"),
          defaults.targetDir ?? ""
        );
  const targetDir = targetAnswer.trim() || undefined;
  const mode = (partial.mode ??
    (await promptSelect(
      prompter,
      t("写入模式", "Write mode"),
      [
        {
          name: t("合并（推荐）", "Merge (recommended)"),
          value: "merge",
          description: t("保留外部配置，只管理 Agent Knowledge 资源", "Preserve foreign configuration and only manage Agent Knowledge resources")
        },
        {
          name: t("覆盖", "Overwrite"),
          value: "overwrite",
          description: t("替换目标文件、目录和 symlink", "Replace target files, directories, and symlinks")
        }
      ],
      defaults.mode
    ))) as IntegrationInstallMode;

  return { product, scope, components, targetDir, mode };
}

export function formatIntegrationInstallResult(
  result: InstallIntegrationResult,
  locale: SupportedLocale = "zh-CN"
): string {
  const t = (chinese: string, english: string): string => translate(locale, chinese, english);
  const productName =
    result.product === "trae" ? "TRAE" : result.product === "trae-cn" ? "TRAE CN" : "Claude Code";
  const installed = result.managed.filter((item) => item.status === "installed").length;
  const updated = result.managed.filter((item) => item.status === "updated").length;
  const unchanged = result.managed.filter((item) => item.status === "unchanged").length;
  const lines = [
    t(
      `已为 ${productName} 安装 Agent Knowledge（${result.scope === "user" ? "用户级" : "项目级"}）。`,
      `Installed Agent Knowledge for ${productName} (${result.scope} scope).`
    ),
    t(
      `托管资源：新安装 ${installed}，已更新 ${updated}，未变化 ${unchanged}。`,
      `Managed resources: ${installed} installed, ${updated} updated, ${unchanged} unchanged.`
    ),
    ...result.managed.map((item) =>
      t(
        `- ${item.status === "installed" ? "已安装" : item.status === "updated" ? "已更新" : "未变化"}：${item.path}`,
        `- ${item.status}: ${item.path}`
      )
    )
  ];
  if (result.conflicts.length > 0) {
    lines.push(t("已保留冲突文件：", "Conflicts were preserved:"));
    lines.push(...result.conflicts.map((conflict) => `- ${conflict}`));
  }
  lines.push(t(`所有权清单：${result.manifestPath}`, `Ownership manifest: ${result.manifestPath}`));
  return lines.join("\n");
}
