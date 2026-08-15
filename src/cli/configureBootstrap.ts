/**
 * Configure bootstrap 把配置问答、Git workspace 初始化和配置提交编排成一个安全事务。
 *
 * 向导本身只收集答案；默认先在最终 knowledgeRoot 完成幂等 private-data-safe Git 初始化，
 * 成功后才持久化配置。这样路径非法或 Git 初始化失败时，旧配置仍保持可用。该模块不添加
 * remote、不 commit、不 push、不安装 integration，也不下载模型。
 */
import type { UserConfig } from "../core/config.js";
import { writeUserConfig } from "../core/config.js";
import { initializeKnowledgeGitWorkspace } from "../storage/gitWorkspace.js";
import {
  runConfigurationWizard,
  type ConfigurationPrompter
} from "./configure.js";

export type ConfigureBootstrapDependencies = {
  collectConfiguration: typeof runConfigurationWizard;
  initializeGitWorkspace: typeof initializeKnowledgeGitWorkspace;
  persistConfiguration: typeof writeUserConfig;
};

export type ConfigureBootstrapResult = {
  configured: UserConfig;
  knowledgeRoot: string;
  gitInitialized: boolean;
};

const DEFAULT_DEPENDENCIES: ConfigureBootstrapDependencies = {
  collectConfiguration: runConfigurationWizard,
  initializeGitWorkspace: initializeKnowledgeGitWorkspace,
  persistConfiguration: writeUserConfig
};

/**
 * 收集并提交完整首次配置。
 *
 * `initializeGit=false` 是显式逃生口，供已有特殊 workspace 或外部 Git 管理使用；默认路径
 * 必须经过 Git workspace 安全检查。配置写入永远位于最后，避免产生“配置已指向失败目录”的
 * 半完成状态。
 */
export async function configureKnowledgeWorkspace(
  input: {
    configPath: string;
    prompter: ConfigurationPrompter;
    current: UserConfig;
    locale?: "zh-CN" | "en";
    initializeGit: boolean;
  },
  dependencies: Partial<ConfigureBootstrapDependencies> = {}
): Promise<ConfigureBootstrapResult> {
  const resolvedDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...dependencies
  };
  const configured = await resolvedDependencies.collectConfiguration({
    configPath: input.configPath,
    prompter: input.prompter,
    current: input.current,
    locale: input.locale,
    write: false
  });
  if (input.initializeGit) {
    await resolvedDependencies.initializeGitWorkspace(
      configured.knowledgeRoot
    );
  }
  resolvedDependencies.persistConfiguration(input.configPath, configured);
  return {
    configured,
    knowledgeRoot: configured.knowledgeRoot,
    gitInitialized: input.initializeGit
  };
}
