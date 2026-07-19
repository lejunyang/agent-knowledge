/**
 * Integration CLI helper 将“如何选择”与“如何安装”分开。
 *
 * 核心 installer 保持非交互、可测试和可复用；只有 CLI helper 负责询问缺失参数及生成人类输出。
 * 这样自动化调用可以完整传参跳过交互，TUI 用户则能在每一步看到用途和默认值。
 */
import type { UserConfig } from "../core/config.js";
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
}): Promise<IntegrationInstallSelection> {
  const { defaults, prompter, partial = {} } = options;
  const product = (partial.product ??
    (await promptSelect(
      prompter,
      "Product",
      [
        {
          name: "TRAE",
          value: "trae",
          description: "Manage .trae/hooks.json and .trae/cli/hooks.json"
        },
        {
          name: "TRAE CN",
          value: "trae-cn",
          description: "Manage .trae-cn/hooks.json"
        },
        {
          name: "Claude Code",
          value: "claude-code",
          description: "Manage .claude/settings.json"
        }
      ],
      defaults.product
    ))) as IntegrationProductId;
  const scope = (partial.scope ??
    (await promptSelect(
      prompter,
      "Installation scope",
      [
        {
          name: "User",
          value: "user",
          description: "Install once for every project"
        },
        {
          name: "Project",
          value: "project",
          description: "Install only in the current repository"
        }
      ],
      defaults.scope
    ))) as IntegrationScope;
  const components =
    partial.components ??
    (await promptCheckbox(
      prompter,
      "Components (space to toggle, enter to confirm)",
      [
        { name: "Hooks", value: "hooks", description: "Automatic query and lifecycle staging" },
        { name: "Agents", value: "agents", description: "memory-reader and memory-writer" },
        { name: "Skills", value: "skills", description: "knowledge organizer and maintainer" },
        {
          name: "Plugin bundle",
          value: "plugin-bundle",
          description: "Install an optional TRAE plugin package"
        }
      ],
      defaults.components
    )) as IntegrationComponent[];
  const targetAnswer =
    partial.targetDir !== undefined
      ? partial.targetDir
      : await promptInput(
          prompter,
          "Target override (leave blank for the product default)",
          defaults.targetDir ?? ""
        );
  const targetDir = targetAnswer.trim() || undefined;
  const mode = (partial.mode ??
    (await promptSelect(
      prompter,
      "Write mode",
      [
        {
          name: "Merge (recommended)",
          value: "merge",
          description: "Preserve foreign configuration and only manage Agent Knowledge resources"
        },
        {
          name: "Overwrite",
          value: "overwrite",
          description: "Replace target files, directories, and symlinks"
        }
      ],
      defaults.mode
    ))) as IntegrationInstallMode;

  return { product, scope, components, targetDir, mode };
}

export function formatIntegrationInstallResult(result: InstallIntegrationResult): string {
  const productName =
    result.product === "trae" ? "TRAE" : result.product === "trae-cn" ? "TRAE CN" : "Claude Code";
  const installed = result.managed.filter((item) => item.status === "installed").length;
  const updated = result.managed.filter((item) => item.status === "updated").length;
  const unchanged = result.managed.filter((item) => item.status === "unchanged").length;
  const lines = [
    `Installed Agent Knowledge for ${productName} (${result.scope} scope).`,
    `Managed resources: ${installed} installed, ${updated} updated, ${unchanged} unchanged.`,
    ...result.managed.map((item) => `- ${item.status}: ${item.path}`)
  ];
  if (result.conflicts.length > 0) {
    lines.push("Conflicts were preserved:");
    lines.push(...result.conflicts.map((conflict) => `- ${conflict}`));
  }
  lines.push(`Ownership manifest: ${result.manifestPath}`);
  return lines.join("\n");
}
