/**
 * 项目配置模块负责发现 Git 项目根，并把环境、用户、项目共享和项目本地配置合并为单一生效配置。
 *
 * 配置文件允许只写需要覆盖的字段；plain object 递归合并，数组和标量整体替换。最终统一通过
 * UserConfigSchema 补默认值和校验，避免各 CLI 命令对配置层级产生不同理解。
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import {
  getDefaultUserConfigPath,
  readUserConfigSource,
  resolveUserConfig,
  type UserConfig
} from "./config.js";

export const PROJECT_CONFIG_FILE = ".agent-knowledge.json";
export const PROJECT_LOCAL_CONFIG_FILE = ".agent-knowledge.local.json";

export type ConfigSourceStatus = {
  path: string;
  exists: boolean;
};

export type EffectiveConfigSources = {
  user: ConfigSourceStatus;
  project: ConfigSourceStatus | null;
  projectLocal: ConfigSourceStatus | null;
};

export type EffectiveConfigResult = {
  config: UserConfig;
  projectRoot: string | null;
  sources: EffectiveConfigSources;
};

/** 判断输入是否是可递归合并的 plain object；数组必须整体替换。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** 深度合并两个配置对象；高优先级数组、null 和标量整体覆盖低优先级值。 */
function deepMerge(
  lower: Record<string, unknown>,
  higher: Record<string, unknown>
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...lower };
  for (const [key, value] of Object.entries(higher)) {
    const previous = output[key];
    output[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? deepMerge(previous, value)
        : value;
  }
  return output;
}

/** 把未知配置来源规范化为 plain object；其他顶层形状直接拒绝。 */
function configObject(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error("Agent Knowledge config source must be a JSON object");
  }
  return value;
}

/** 执行只读 Git root 探测；非 Git 目录回退调用方 cwd。 */
function detectProjectRoot(cwd: string): string {
  try {
    const root = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trim();
    return realpathSync(root);
  } catch {
    return path.resolve(cwd);
  }
}

/**
 * 返回项目共享和 local 配置路径。
 *
 * `AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG=1` 供测试、迁移和故障诊断显式关闭自动发现，避免
 * 当前仓库的 local 配置污染需要隔离的命令。
 */
export function getProjectConfigPaths(
  cwd = process.cwd(),
  environment: NodeJS.ProcessEnv = process.env
): {
  root: string | null;
  project: string | null;
  projectLocal: string | null;
} {
  if (environment.AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG === "1") {
    return { root: null, project: null, projectLocal: null };
  }
  const root = detectProjectRoot(cwd);
  return {
    root,
    project: path.join(root, PROJECT_CONFIG_FILE),
    projectLocal: path.join(root, PROJECT_LOCAL_CONFIG_FILE)
  };
}

/** 把兼容环境变量转换为最低优先级的部分配置，并忽略无效 actor/capture 枚举。 */
export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (environment.AGENT_KNOWLEDGE_ROOT) {
    config.knowledgeRoot = environment.AGENT_KNOWLEDGE_ROOT;
  }
  const identity: Record<string, unknown> = {};
  if (
    environment.AGENT_KNOWLEDGE_ACTOR_TYPE === "owner" ||
    environment.AGENT_KNOWLEDGE_ACTOR_TYPE === "teammate" ||
    environment.AGENT_KNOWLEDGE_ACTOR_TYPE === "customer" ||
    environment.AGENT_KNOWLEDGE_ACTOR_TYPE === "agent"
  ) {
    identity.actorType = environment.AGENT_KNOWLEDGE_ACTOR_TYPE;
  }
  if (
    environment.AGENT_KNOWLEDGE_CAPTURE_MODE === "explicit_remember" ||
    environment.AGENT_KNOWLEDGE_CAPTURE_MODE === "verified_task" ||
    environment.AGENT_KNOWLEDGE_CAPTURE_MODE === "automated_session" ||
    environment.AGENT_KNOWLEDGE_CAPTURE_MODE === "direct_material"
  ) {
    identity.captureMode = environment.AGENT_KNOWLEDGE_CAPTURE_MODE;
  }
  if (environment.AGENT_KNOWLEDGE_VISIBILITY_SCOPES) {
    identity.visibilityScopes =
      environment.AGENT_KNOWLEDGE_VISIBILITY_SCOPES.split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  }
  if (environment.AGENT_KNOWLEDGE_SENSITIVITY_CLEARANCE) {
    identity.sensitivityClearance =
      environment.AGENT_KNOWLEDGE_SENSITIVITY_CLEARANCE;
  }
  if (Object.keys(identity).length > 0) {
    config.identity = identity;
  }
  return config;
}

/** 按环境、用户、项目共享、项目 local 的顺序递归合并部分配置。 */
export function mergeConfigSources(
  environmentConfig: unknown,
  userConfig: unknown,
  projectConfig: unknown,
  projectLocalConfig: unknown
): Record<string, unknown> {
  return [
    environmentConfig,
    userConfig,
    projectConfig,
    projectLocalConfig
  ].reduce<Record<string, unknown>>(
    (merged, source) => deepMerge(merged, configObject(source)),
    {}
  );
}

/**
 * 加载最终生效配置并返回所有来源状态。
 *
 * `projectRoot` 主要供测试和显式工具调用；正常 CLI 根据 cwd 自动发现 Git root。
 */
export function loadEffectiveConfig(options: {
  userConfigPath?: string;
  cwd?: string;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  includeProject?: boolean;
  includeProjectLocal?: boolean;
} = {}): EffectiveConfigResult {
  const environment = options.environment ?? process.env;
  const userPath = path.resolve(
    options.userConfigPath ?? getDefaultUserConfigPath(environment)
  );
  const discovered = options.projectRoot
    ? {
        root: path.resolve(options.projectRoot),
        project: path.join(
          path.resolve(options.projectRoot),
          PROJECT_CONFIG_FILE
        ),
        projectLocal: path.join(
          path.resolve(options.projectRoot),
          PROJECT_LOCAL_CONFIG_FILE
        )
      }
    : getProjectConfigPaths(options.cwd ?? process.cwd(), environment);
  const projectSource =
    options.includeProject === false || !discovered.project
      ? {}
      : readUserConfigSource(discovered.project);
  const projectLocalSource =
    options.includeProjectLocal === false || !discovered.projectLocal
      ? {}
      : readUserConfigSource(discovered.projectLocal);
  const merged = mergeConfigSources(
    configFromEnvironment(environment),
    readUserConfigSource(userPath),
    projectSource,
    projectLocalSource
  );
  return {
    config: resolveUserConfig(merged),
    projectRoot: discovered.root,
    sources: {
      user: { path: userPath, exists: existsSync(userPath) },
      project: discovered.project
        ? {
            path: discovered.project,
            exists: existsSync(discovered.project)
          }
        : null,
      projectLocal: discovered.projectLocal
        ? {
            path: discovered.projectLocal,
            exists: existsSync(discovered.projectLocal)
          }
        : null
    }
  };
}
