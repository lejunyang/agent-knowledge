/**
 * Integration CLI helper 将“如何选择”与“如何安装”分开。
 *
 * 核心 installer 保持非交互、可测试和可复用；只有 CLI helper 负责询问缺失参数及生成人类输出。
 * 这样自动化调用可以完整传参跳过交互，TUI 用户则能在每一步看到用途和默认值。
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { UserConfig } from "../core/config.js";
import type {
  InstallIntegrationResult,
  IntegrationComponent,
  IntegrationInstallMode,
  IntegrationProductId,
  IntegrationScope
} from "../integration/manager.js";

export type IntegrationPrompter = {
  ask(question: string): Promise<string>;
};

export class TerminalIntegrationPrompter implements IntegrationPrompter {
  private readonly readline = createInterface({ input: stdin, output: stdout });

  async ask(question: string): Promise<string> {
    return this.readline.question(question);
  }

  close(): void {
    this.readline.close();
  }
}

export type IntegrationInstallSelection = {
  product: IntegrationProductId;
  scope: IntegrationScope;
  components: IntegrationComponent[];
  targetDir?: string;
  mode: IntegrationInstallMode;
};

function answerOrDefault(answer: string, defaultValue: string): string {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export async function promptForIntegrationInstall(options: {
  defaults: UserConfig["integration"];
  prompter: IntegrationPrompter;
  partial?: Partial<IntegrationInstallSelection>;
}): Promise<IntegrationInstallSelection> {
  const { defaults, prompter, partial = {} } = options;
  const product = (partial.product ??
    answerOrDefault(
      await prompter.ask(
        `Product — trae manages .trae and .trae/cli hooks; trae-cn uses .trae-cn; claude-code uses .claude [${defaults.product}]: `
      ),
      defaults.product
    )) as IntegrationProductId;
  const scope = (partial.scope ??
    answerOrDefault(
      await prompter.ask(
        `Scope — user installs for all projects; project installs in the current repository [${defaults.scope}]: `
      ),
      defaults.scope
    )) as IntegrationScope;
  const components =
    partial.components ??
    answerOrDefault(
      await prompter.ask(
        `Components — comma separated hooks,agents,skills,plugin-bundle [${defaults.components.join(",")}]: `
      ),
      defaults.components.join(",")
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean) as IntegrationComponent[];
  const targetAnswer =
    partial.targetDir !== undefined
      ? partial.targetDir
      : await prompter.ask(
          `Target override — blank uses the selected product and scope default [${defaults.targetDir ?? ""}]: `
        );
  const targetDir = answerOrDefault(targetAnswer, defaults.targetDir ?? "") || undefined;
  const mode = (partial.mode ??
    answerOrDefault(
      await prompter.ask(
        `Write mode — merge preserves foreign configuration; overwrite replaces target files and symlinks [${defaults.mode}]: `
      ),
      defaults.mode
    )) as IntegrationInstallMode;

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
