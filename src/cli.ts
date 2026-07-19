#!/usr/bin/env node
/**
 * CLI 入口是其他 agent 最常接触的集成面。
 *
 * 设计意图：
 * - 对人类保持简单命令：init / index / query / write-candidate / list / organize-inbox / capture-material。
 * - 对 agent 保持稳定 JSON 输出，便于脚本解析和上下文注入。
 * - root 解析支持 `--root`、`AGENT_KNOWLEDGE_ROOT`、`~/.agent_knowledge` 三层 fallback，
 *   这样不同项目的 hooks 可以共享同一套默认知识库。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Command } from "commander";
import {
  MemoryQueryRequestSchema,
  acceptMaintenanceProposal,
  applyMaintenanceCleanup,
  appendJsonlLog,
  appendSubagentEvent,
  buildKnowledgeGraph,
  buildContextPacket,
  calibrateRetrieval,
  catalogKnowledge,
  captureMaterial,
  createEmbeddingProvider,
  createConfiguredSyncBackend,
  decideHookInjection,
  downloadRetrievalModel,
  extractMaintenanceObservations,
  getDefaultUserConfigPath,
  getRetrievalModelStatus,
  getObservationStatus,
  getSubagentLogStatus,
  installAcceptedSkillProposal,
  embedKnowledgeIndex,
  loadEvalSuite,
  loadEvalCorpus,
  materializeEvalCorpus,
  generateMaintenanceProposals,
  initKnowledgeWorkspace,
  listKnowledge,
  logMemoryFeedback,
  organizeInbox,
  planMaintenanceCleanup,
  queryKnowledgeGraph,
  queryMemoriesGraphWithDebug,
  queryMemories,
  queryMemoriesHybridWithDebug,
  queryMemoriesRerankedWithDebug,
  queryMemoriesWithDebug,
  rebuildIndex,
  runEvalSuite,
  runScheduledSync,
  readSubagentLogs,
  readMaintenanceProposals,
  readKnowledgeGraph,
  resolveRetrievalModelDescriptor,
  rejectMaintenanceProposal,
  readMaintenanceObservations,
  showMaintenanceProposal,
  exportKnowledgeGraph,
  S3HttpObjectClient,
  S3SyncBackend,
  TransformersBatchReranker,
  stageHookEvent,
  getStagingStatus,
  drainStagedEvents,
  suggestAliases,
  syncKnowledge,
  WebDavSyncBackend,
  doctorIntegration,
  detectProject,
  installIntegration,
  listIntegrationProducts,
  uninstallIntegration,
  writeCandidateMemory,
  type CandidateMemoryInput,
  type CalibrationCase,
  type CalibrationFeedback,
  type MaintenanceObservation,
  type UserConfig,
  resolveLocale,
  translate,
  type SupportedLocale
} from "./index.js";
import { getDefaultKnowledgeRoot } from "./core/paths.js";
import {
  loadEffectiveConfig,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCAL_CONFIG_FILE
} from "./core/projectConfig.js";
import { getGitRuntimeContext, type GitRuntimeContext } from "./hooks/gitContext.js";
import { hookContextJson } from "./hooks/hookOutput.js";
import {
  runConfigurationWizard,
  TerminalConfigurationPrompter
} from "./cli/configure.js";
import {
  formatIntegrationInstallResult,
  promptForIntegrationInstall,
  TerminalIntegrationPrompter
} from "./cli/integration.js";
import {
  promptForRetrievalModelKind,
  TerminalModelPrompter
} from "./cli/model.js";

/** 从启动参数读取 `--name=value` 或 `--name value`，供 Commander 初始化前解析全局配置。 */
function readArgValue(name: string): string | undefined {
  const direct = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (direct) {
    return direct.slice(name.length + 1);
  }
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const startupConfigPath = path.resolve(
  readArgValue("--config") ?? getDefaultUserConfigPath()
);
const startupEffectiveConfig = loadEffectiveConfig({
  userConfigPath: startupConfigPath
});
const startupConfig = startupEffectiveConfig.config;
const locale: SupportedLocale = resolveLocale({
  explicit: readArgValue("--locale"),
  configured: startupConfig.locale
});
const t = (chinese: string, english: string): string => translate(locale, chinese, english);

const program = new Command();

program
  .name("agent-knowledge")
  .description(t("本地、可读、可审计的 Agent 知识工具", "Local human-readable memory toolkit for agents"))
  .version("0.1.0")
  .option("--config <file>", t("用户配置文件；默认 ~/.config/agent-knowledge/config.json", "user config file; defaults to ~/.config/agent-knowledge/config.json"))
  .option("--locale <locale>", t("界面语言：auto、zh-CN 或 en", "UI language: auto, zh-CN, or en"))
  .option("--json", t("对支持的命令输出机器可读 JSON", "emit machine-readable JSON for commands that support human output"), false);

/** 返回进程启动时冻结的配置路径，避免运行中环境变化造成同一命令读取不同文件。 */
function resolveConfigPath(): string {
  return startupConfigPath;
}

/** 每次使用时重新加载用户配置，使同一长进程能读取刚由向导写入的设置。 */
function userConfig(): UserConfig {
  return loadEffectiveConfig({
    userConfigPath: resolveConfigPath()
  }).config;
}

/** 按显式参数和生效分层配置解析 workspace root。 */
function resolveCliRoot(root?: string): string {
  return root ?? userConfig().knowledgeRoot ?? getDefaultKnowledgeRoot();
}

/** 解析并校验 caller 可见范围，拒绝未知值进入后续权限判断。 */
function resolveVisibilityScopes(explicit?: string[]): Array<"private" | "project" | "team"> {
  const values =
    explicit ??
    userConfig().identity.visibilityScopes ??
    ["private", "project", "team"];
  const allowed = new Set(["private", "project", "team"]);
  if (values.some((scope) => !allowed.has(scope))) {
    throw new Error("visibility scopes must be private, project, or team");
  }
  return values as Array<"private" | "project" | "team">;
}

/** 解析 caller 最高敏感级别；未知值必须失败，不能默认为更高权限。 */
function resolveSensitivityClearance(
  explicit?: string
): "public" | "internal" | "confidential" | "secret" {
  const value =
    explicit ??
    userConfig().identity.sensitivityClearance ??
    "internal";
  if (value !== "public" && value !== "internal" && value !== "confidential" && value !== "secret") {
    throw new Error("sensitivity clearance must be public, internal, confidential, or secret");
  }
  return value;
}

/**
 * 解析普通 query 的项目作用域。
 *
 * 显式 `--project-id` 完全优先，便于跨项目诊断和自动化测试；未显式指定时才从当前 Git
 * 工作树注册稳定 project ID。Git 不可用或目录不在仓库中时回退空数组，保持全局知识查询兼容。
 */
async function resolveQueryProjectIds(
  rootDir: string,
  explicitProjectIds?: string[]
): Promise<string[]> {
  if (explicitProjectIds !== undefined) {
    return explicitProjectIds;
  }
  const runtimeContext = getGitRuntimeContext();
  if (!runtimeContext.isGit) {
    return [];
  }
  const detected = await detectProject(rootDir, runtimeContext.cwd).catch(
    () => undefined
  );
  return detected ? [detected.id] : [];
}

/**
 * 用配置或兼容环境变量覆盖 candidate 的 actor/capture policy。
 * 只接受 schema 支持值；无效环境变量会被忽略，避免绕过候选治理枚举。
 */
function applyCapturePolicyOverrides(input: CandidateMemoryInput): CandidateMemoryInput {
  const configuredIdentity = userConfig().identity;
  const actorType = configuredIdentity.actorType;
  const captureMode = configuredIdentity.captureMode;
  return {
    ...input,
    ...(actorType === "owner" ||
    actorType === "teammate" ||
    actorType === "customer" ||
    actorType === "agent"
      ? { actor_type: actorType }
      : {}),
    ...(captureMode === "explicit_remember" ||
    captureMode === "verified_task" ||
    captureMode === "automated_session" ||
    captureMode === "direct_material"
      ? { capture_mode: captureMode }
      : {})
  };
}

/** 向上查找包含 package 与模板的安装源根目录，兼容 src 和 dist 两种运行位置。 */
function findPackageRoot(startDir = dirname(fileURLToPath(import.meta.url))): string {
  let current = startDir;
  while (true) {
    if (existsSync(path.join(current, "package.json")) && existsSync(path.join(current, "templates", "trae"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate package root containing templates/trae");
    }
    current = parent;
  }
}

/** 完整读取 Hook stdin；宿主 payload 很小，集中解析可保持错误处理一致。 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** 把空 stdin 视为空对象，否则严格解析宿主 Hook JSON。 */
async function readHookInput(): Promise<Record<string, unknown>> {
  const text = await readStdin();
  if (text.trim().length === 0) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

program
  .command("configure")
  .description(t("交互式配置 Agent Knowledge 默认设置", "Interactively configure Agent Knowledge defaults"))
  .option(
    "--scope <scope>",
    t(
      "写入 user、project 或 project-local 配置",
      "write user, project, or project-local config"
    ),
    "user"
  )
  .action(async (options: { scope: string }) => {
    if (
      options.scope !== "user" &&
      options.scope !== "project" &&
      options.scope !== "project-local"
    ) {
      throw new Error(
        t(
          "--scope 必须是 user、project 或 project-local",
          "--scope must be user, project, or project-local"
        )
      );
    }
    const effective = loadEffectiveConfig({
      userConfigPath: resolveConfigPath(),
      includeProject: options.scope !== "user",
      includeProjectLocal: options.scope === "project-local"
    });
    const configPath =
      options.scope === "user"
        ? resolveConfigPath()
        : path.join(
            effective.projectRoot ?? process.cwd(),
            options.scope === "project"
              ? PROJECT_CONFIG_FILE
              : PROJECT_LOCAL_CONFIG_FILE
          );
    const prompter = new TerminalConfigurationPrompter();
    try {
      const configured = await runConfigurationWizard({
        configPath,
        prompter,
        current: effective.config,
        locale
      });
      console.log(t(`已保存 Agent Knowledge 配置：${configPath}`, `Saved Agent Knowledge configuration to ${configPath}`));
      console.log(
        t(
          `知识库：${configured.knowledgeRoot}；身份：${configured.identity.actorType}；同步：${configured.sync.provider}`,
          `Knowledge root: ${configured.knowledgeRoot}; actor: ${configured.identity.actorType}; sync: ${configured.sync.provider}`
        )
      );
    } finally {
      prompter.close();
    }
  });

const configCommand = program
  .command("config")
  .description(t("查看当前生效配置", "Inspect the active configuration"));

configCommand.command("path").action(() => {
  console.log(resolveConfigPath());
});

configCommand.command("show").action(() => {
  console.log(JSON.stringify(userConfig(), null, 2));
});

configCommand.command("sources").action(() => {
  console.log(
    JSON.stringify(
      loadEffectiveConfig({
        userConfigPath: resolveConfigPath()
      }).sources,
      null,
      2
    )
  );
});

const embeddingCommand = program
  .command("embedding")
  .description(t("检查和下载本地检索模型", "Inspect and download local retrieval models"));

embeddingCommand
  .command("status")
  .description(t("离线检查当前模型是否已完整缓存", "Check whether the configured model is fully cached"))
  .option("--kind <kind>", t("模型类型：embedding 或 reranker；TTY 缺省时交互选择", "model kind: embedding or reranker; prompts on TTY when omitted"))
  .option("--model <model>", t("临时覆盖模型 ID", "override the configured model ID"))
  .option("--cache-dir <dir>", t("临时覆盖模型缓存目录", "override the model cache directory"))
  .option("--json", t("输出完整 JSON", "emit full JSON"), false)
  .action(async (options: { kind?: string; model?: string; cacheDir?: string; json: boolean }) => {
    let kind = options.kind;
    if (!kind && process.stdin.isTTY) {
      const prompter = new TerminalModelPrompter();
      kind = await promptForRetrievalModelKind(prompter, locale);
    }
    kind ??= "embedding";
    if (kind !== "embedding" && kind !== "reranker") {
      throw new Error(t("--kind 必须是 embedding 或 reranker", "--kind must be embedding or reranker"));
    }
    const descriptor = resolveRetrievalModelDescriptor(userConfig().embeddings, kind);
    const status = await getRetrievalModelStatus({
      ...descriptor,
      model: options.model ?? descriptor.model,
      cacheDir: options.cacheDir ? path.resolve(options.cacheDir) : descriptor.cacheDir
    });
    const machineOutput = program.opts<{ json: boolean }>().json || options.json;
    if (machineOutput) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(
      t(
        `${status.kind === "embedding" ? "Embedding" : "Reranker"} 模型：${status.model}`,
        `${status.kind === "embedding" ? "Embedding" : "Reranker"} model: ${status.model}`
      )
    );
    console.log(t(`缓存目录：${status.cacheDir}`, `Cache directory: ${status.cacheDir}`));
    console.log(
      status.cached
        ? t("状态：已完整下载", "Status: fully cached")
        : t(
            `状态：未完整下载；缺失 ${status.missingFiles.length} 个文件`,
            `Status: incomplete; ${status.missingFiles.length} file(s) missing`
          )
    );
    for (const file of status.missingFiles) {
      console.log(`- ${file}`);
    }
  });

embeddingCommand
  .command("download")
  .description(t("显式下载当前配置的检索模型", "Explicitly download the configured retrieval model"))
  .option("--kind <kind>", t("模型类型：embedding 或 reranker；TTY 缺省时交互选择", "model kind: embedding or reranker; prompts on TTY when omitted"))
  .option("--model <model>", t("临时覆盖模型 ID", "override the configured model ID"))
  .option("--cache-dir <dir>", t("临时覆盖模型缓存目录", "override the model cache directory"))
  .option("--json", t("完成后输出完整 JSON", "emit full JSON after completion"), false)
  .action(async (options: { kind?: string; model?: string; cacheDir?: string; json: boolean }) => {
    let kind = options.kind;
    if (!kind && process.stdin.isTTY) {
      const prompter = new TerminalModelPrompter();
      kind = await promptForRetrievalModelKind(prompter, locale);
    }
    kind ??= "embedding";
    if (kind !== "embedding" && kind !== "reranker") {
      throw new Error(t("--kind 必须是 embedding 或 reranker", "--kind must be embedding or reranker"));
    }
    const descriptor = resolveRetrievalModelDescriptor(userConfig().embeddings, kind);
    const selected = {
      ...descriptor,
      model: options.model ?? descriptor.model,
      cacheDir: options.cacheDir ? path.resolve(options.cacheDir) : descriptor.cacheDir
    };
    console.log(t(`开始下载：${selected.model}`, `Downloading: ${selected.model}`));
    const status = await downloadRetrievalModel(selected, undefined, (event) => {
      if (event.file && typeof event.progress === "number") {
        console.log(`${event.file}: ${Math.round(event.progress)}%`);
      } else if (event.file) {
        console.log(`${event.status ?? "progress"}: ${event.file}`);
      }
    });
    const machineOutput = program.opts<{ json: boolean }>().json || options.json;
    console.log(
      machineOutput
        ? JSON.stringify(status, null, 2)
        : t(`下载完成：${status.model}`, `Download completed: ${status.model}`)
    );
  });

/** 只在存在额外上下文时输出 Hook envelope，空内容必须保持 stdout 静默。 */
function hookContext(hookEventName: "SessionStart" | "UserPromptSubmit", additionalContext: string): void {
  const output = hookContextJson(hookEventName, additionalContext);
  if (output) {
    console.log(JSON.stringify(output));
  }
}

/** 为 SessionStart 诊断上下文提供稳定、可读的 JSON 文本。 */
function formatRuntimeContext(context: GitRuntimeContext): string {
  return JSON.stringify(context, null, 2);
}

program
  .command("init")
  .description(t("初始化知识库目录", "Initialize a knowledge workspace"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    console.log(t(`已初始化知识库：${root}`, `Initialized knowledge workspace at ${root}`));
  });

program
  .command("index")
  .description(t("从 Markdown 重建检索索引", "Rebuild the retrieval index from Markdown"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action((options: { root?: string }) => {
    const result = rebuildIndex(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("embed-index")
  .description(t("为 active Markdown 构建本地 Embedding 缓存", "Build local embeddings for active Markdown knowledge"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--provider <provider>", t("transformers 或 local；默认读取用户配置", "transformers or local; defaults to user config"))
  .option("--profile <profile>", t("Embedding 配置：multilingual-e5-small 或 bge-small-zh-v1.5", "embedding profile: multilingual-e5-small or bge-small-zh-v1.5"))
  .option("--model <model>", t("Transformers.js 模型 ID 或本地路径", "Transformers.js model id or local model path"))
  .option("--allow-remote-models", t("允许 Transformers.js 下载远程模型；默认关闭", "allow Transformers.js to download remote models; disabled by default"), false)
  .action(async (options: {
    root?: string;
    provider?: string;
    profile?: string;
    model?: string;
    allowRemoteModels: boolean;
  }) => {
    const configuredEmbeddings = userConfig().embeddings;
    const providerName = options.provider ?? configuredEmbeddings.provider;
    if (providerName !== "transformers" && providerName !== "local") {
      throw new Error("--provider must be transformers or local");
    }
    const provider = createEmbeddingProvider({
      provider: providerName,
      profile:
        options.profile === "multilingual-e5-small" || options.profile === "bge-small-zh-v1.5"
          ? options.profile
          : configuredEmbeddings.profile,
      model: options.model ?? configuredEmbeddings.model ?? undefined,
      allowRemoteModels: options.allowRemoteModels || configuredEmbeddings.allowRemoteModels,
      cacheDir: configuredEmbeddings.cacheDir
    });
    const result = await embedKnowledgeIndex(resolveCliRoot(options.root), { provider });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("eval")
  .description(t("运行 YAML 检索评测集", "Run a retrieval eval suite from YAML"))
  .option("--input <file>", t("包含单个 case 或 cases 数组的评测 YAML", "eval YAML containing one case or a cases array"))
  .option("--fixture <file>", t("可选：包含文档和 cases 的完整评测 corpus YAML", "optional corpus YAML containing documents and cases"))
  .option("--pipeline <pipeline>", t("评测 pipeline：lexical、hybrid、reranked", "eval pipeline: lexical, hybrid, or reranked"), "lexical")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { input?: string; fixture?: string; pipeline: string; root?: string }) => {
    if (!options.input && !options.fixture) {
      throw new Error(t("必须提供 --input 或 --fixture", "Provide --input or --fixture"));
    }
    const root = resolveCliRoot(options.root);
    if (options.fixture) {
      await materializeEvalCorpus(root, await loadEvalCorpus(options.fixture));
    }
    rebuildIndex(root);
    const suite = options.fixture
      ? { cases: (await loadEvalCorpus(options.fixture)).cases }
      : await loadEvalSuite(options.input!);
    const configuredEmbeddings = userConfig().embeddings;
    if (options.pipeline === "lexical") {
      console.log(JSON.stringify(await runEvalSuite(root, suite, { pipeline: "lexical" }), null, 2));
      return;
    }
    const embeddingProvider = createEmbeddingProvider({
      provider: configuredEmbeddings.provider,
      profile: configuredEmbeddings.profile,
      model: configuredEmbeddings.model ?? undefined,
      allowRemoteModels: false,
      cacheDir: configuredEmbeddings.cacheDir
    });
    if (options.pipeline === "hybrid") {
      console.log(
        JSON.stringify(
          await runEvalSuite(root, suite, {
            pipeline: "hybrid",
            embeddingProvider,
            embeddingTopK: configuredEmbeddings.embeddingTopK
          }),
          null,
          2
        )
      );
      return;
    }
    if (options.pipeline === "reranked") {
      console.log(
        JSON.stringify(
          await runEvalSuite(root, suite, {
            pipeline: "reranked",
            embeddingProvider,
            batchReranker: new TransformersBatchReranker({
              model:
                configuredEmbeddings.rerankerModel ??
                "Xenova/bge-reranker-large",
              cacheDir: configuredEmbeddings.cacheDir,
              localFilesOnly: true
            }),
            embeddingTopK: configuredEmbeddings.embeddingTopK,
            candidateLimit: configuredEmbeddings.rerankerCandidateLimit,
            resultLimit: configuredEmbeddings.rerankerResultLimit,
            minScore: configuredEmbeddings.rerankerMinScore
          }),
          null,
          2
        )
      );
      return;
    }
    throw new Error(t("未知评测 pipeline", "Unknown eval pipeline"));
  });

program
  .command("eval-calibrate")
  .description(t("根据评测候选和反馈生成检索参数建议", "Suggest retrieval parameters from eval candidates and feedback"))
  .requiredOption("--input <file>", t("Calibration JSON 输入文件", "calibration JSON input file"))
  .action(async (options: { input: string }) => {
    const raw = JSON.parse(await readFile(options.input, "utf8")) as {
      cases: CalibrationCase[];
      feedback?: CalibrationFeedback[];
      grid?: {
        minScores?: number[];
        baseWeights?: number[];
        resultLimits?: number[];
      };
    };
    const result = calibrateRetrieval({
      cases: raw.cases,
      feedback: raw.feedback ?? [],
      grid: {
        minScores: raw.grid?.minScores ?? [0.45, 0.5, 0.55, 0.6, 0.65],
        baseWeights: raw.grid?.baseWeights ?? [0.2, 0.3, 0.4, 0.5],
        resultLimits: raw.grid?.resultLimits ?? [5, 8, 10]
      }
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("suggest-aliases")
  .description(t("根据 Embedding、日志和 Markdown 生成别名建议（dry-run）", "Dry-run alias suggestions using embeddings, logs, and Markdown docs"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--provider <provider>", t("transformers 或 local；默认读取用户配置", "transformers or local; defaults to user config"))
  .option("--model <model>", t("Transformers.js 模型 ID 或本地路径", "Transformers.js model id or local model path"))
  .option("--allow-remote-models", t("允许远程下载模型", "allow remote model downloads"), false)
  .option("--max <count>", t("每条知识的最大建议数", "max suggestions per memory"), "5")
  .option("--min-score <score>", t("最小 cosine 分数", "minimum cosine score"), "0.35")
  .action(
    async (options: {
      root?: string;
      provider?: string;
      model?: string;
      allowRemoteModels: boolean;
      max: string;
      minScore: string;
    }) => {
      const configuredEmbeddings = userConfig().embeddings;
      const providerName = options.provider ?? configuredEmbeddings.provider;
      if (providerName !== "transformers" && providerName !== "local") {
        throw new Error("--provider must be transformers or local");
      }
      const provider = createEmbeddingProvider({
        provider: providerName,
        profile: configuredEmbeddings.profile,
        model: options.model ?? configuredEmbeddings.model ?? undefined,
        allowRemoteModels: options.allowRemoteModels || configuredEmbeddings.allowRemoteModels,
        cacheDir: configuredEmbeddings.cacheDir
      });
      const result = await suggestAliases(resolveCliRoot(options.root), {
        provider,
        maxSuggestionsPerMemory: Number.parseInt(options.max, 10),
        minScore: Number.parseFloat(options.minScore)
      });
      console.log(JSON.stringify(result, null, 2));
    }
  );

program
  .command("query")
  .description(t("查询与当前任务相关的知识上下文", "Query knowledge relevant to the current task"))
  .requiredOption("--task <task>", t("当前任务文本", "task text"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--domain <domain...>", t("领域过滤", "domains"))
  .option("--scenario <scenario...>", t("场景过滤", "scenarios"))
  .option("--visibility <scope...>", t("允许的可见范围：private、project、team", "allowed visibility scopes: private, project, team"))
  .option("--sensitivity-clearance <level>", t("敏感级别权限：public、internal、confidential、secret", "public, internal, confidential, or secret"))
  .option("--project-id <id...>", t("允许的项目 ID", "allowed project IDs"))
  .option("--agent-role <role>", t("Agent 角色", "agent role"), "main")
  .option("--debug", t("在 JSON 中包含检索调试信息", "include retrieval debug details in JSON output"), false)
  .option("--retrieval <mode>", t("lexical、hybrid、graph 或 hybrid-graph；默认读取用户配置", "lexical, hybrid, graph, or hybrid-graph; defaults to user config"))
  .option("--provider <provider>", t("混合检索的 embedding provider", "embedding provider for hybrid retrieval"))
  .option("--profile <profile>", t("Embedding profile", "embedding profile"))
  .option("--model <model>", t("混合检索模型 ID 或本地路径", "model id or local path for hybrid retrieval"))
  .option("--embedding-top-k <count>", t("混合检索 embedding topK", "embedding topK for hybrid retrieval"))
  .option("--graph-depth <depth>", t("图遍历深度：1 或 2；默认读取用户配置", "graph traversal depth: 1 or 2; defaults to user config"))
  .option("--graph-decay <decay>", t("图检索每跳衰减系数：(0, 1]；默认读取用户配置", "graph score decay per hop: (0, 1]; defaults to user config"))
  .option("--rerank", t("使用本地 cross-encoder 批量重排", "use local cross-encoder batch reranking"), false)
  .option("--allow-remote-models", t("允许远程下载模型", "allow remote model downloads"), false)
  .action(async (options: {
    task: string;
    root?: string;
    domain?: string[];
    scenario?: string[];
    visibility?: string[];
    sensitivityClearance?: string;
    projectId?: string[];
    agentRole: string;
    debug: boolean;
    retrieval?: string;
    provider?: string;
    profile?: string;
    model?: string;
    embeddingTopK?: string;
    graphDepth?: string;
    graphDecay?: string;
    rerank: boolean;
    allowRemoteModels: boolean;
  }) => {
    const configuredEmbeddings = userConfig().embeddings;
    const retrievalMode = options.retrieval ?? configuredEmbeddings.retrieval;
    if (
      retrievalMode !== "lexical" &&
      retrievalMode !== "hybrid" &&
      retrievalMode !== "graph" &&
      retrievalMode !== "hybrid-graph"
    ) {
      throw new Error(
        "--retrieval must be lexical, hybrid, graph, or hybrid-graph"
      );
    }
    const providerName = options.provider ?? configuredEmbeddings.provider;
    if (providerName !== "transformers" && providerName !== "local") {
      throw new Error("--provider must be transformers or local");
    }
    const visibilityScopes = resolveVisibilityScopes(options.visibility);
    const sensitivityClearance = resolveSensitivityClearance(options.sensitivityClearance);
    const root = resolveCliRoot(options.root);
    const projectIds = await resolveQueryProjectIds(root, options.projectId);
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? [],
      visibilityScopes,
      sensitivityClearance,
      projectIds
    });
    const embeddingProvider = createEmbeddingProvider({
      provider: providerName,
      profile:
        options.profile === "multilingual-e5-small" ||
        options.profile === "bge-small-zh-v1.5"
          ? options.profile
          : configuredEmbeddings.profile,
      model: options.model ?? configuredEmbeddings.model ?? undefined,
      allowRemoteModels:
        options.allowRemoteModels || configuredEmbeddings.allowRemoteModels,
      cacheDir: configuredEmbeddings.cacheDir
    });
    const embeddingTopK = options.embeddingTopK
      ? Number.parseInt(options.embeddingTopK, 10)
      : configuredEmbeddings.embeddingTopK;
    const graphDepth = options.graphDepth
      ? Number.parseInt(options.graphDepth, 10)
      : configuredEmbeddings.graphDepth;
    const graphDecay = options.graphDecay
      ? Number.parseFloat(options.graphDecay)
      : configuredEmbeddings.graphDecay;
    if (!Number.isInteger(graphDepth) || graphDepth < 1 || graphDepth > 2) {
      throw new Error("--graph-depth must be 1 or 2");
    }
    if (!Number.isFinite(graphDecay) || graphDecay <= 0 || graphDecay > 1) {
      throw new Error("--graph-decay must be greater than 0 and no more than 1");
    }

    let baseResult;
    if (retrievalMode === "graph" || retrievalMode === "hybrid-graph") {
      baseResult = await queryMemoriesGraphWithDebug(root, request, {
        baseMode: retrievalMode === "hybrid-graph" ? "hybrid" : "lexical",
        depth: graphDepth,
        decay: graphDecay,
        embeddingProvider:
          retrievalMode === "hybrid-graph" ? embeddingProvider : undefined,
        embeddingTopK
      });
    } else if (retrievalMode === "hybrid") {
      baseResult = await queryMemoriesHybridWithDebug(root, request, {
        embeddingProvider,
        embeddingTopK
      });
    } else {
      baseResult = queryMemoriesWithDebug(root, request);
    }
    const { ranked, debug } = options.rerank
      ? await queryMemoriesRerankedWithDebug(root, request, {
          baseResult,
          batchReranker: new TransformersBatchReranker({
            model:
              configuredEmbeddings.rerankerModel ??
              "Xenova/bge-reranker-large",
            cacheDir: configuredEmbeddings.cacheDir,
            localFilesOnly: true
          }),
          candidateLimit: configuredEmbeddings.rerankerCandidateLimit,
          resultLimit: configuredEmbeddings.rerankerResultLimit,
          minScore: configuredEmbeddings.rerankerMinScore,
          baseWeight: configuredEmbeddings.rerankerBaseWeight,
          rerankerWeight: configuredEmbeddings.rerankerModelWeight
        })
      : baseResult;
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(options.debug ? { packet, debug } : packet, null, 2));
  });

program
  .command("feedback")
  .description(t("记录检索知识是否有用，不修改 Markdown 事实", "Log whether a retrieved memory was useful without modifying Markdown facts"))
  .requiredOption("--memory-id <id>", t("查询输出中的知识 ID", "knowledge id shown in query output"))
  .requiredOption("--usefulness <value>", t("useful、not_useful 或 neutral", "useful, not_useful, or neutral"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--query-run-id <id>", t("之前查询的 debug.queryRunId", "debug.queryRunId from a prior query"))
  .option("--task <task>", t("反馈关联的简短任务文本", "short task text associated with the feedback"))
  .option("--note <note>", t("可选备注，最多 500 字符", "optional feedback note, max 500 characters"))
  .action(
    (options: {
      memoryId: string;
      usefulness: string;
      root?: string;
      queryRunId?: string;
      task?: string;
      note?: string;
    }) => {
      const result = logMemoryFeedback(resolveCliRoot(options.root), {
        memoryId: options.memoryId,
        usefulness: options.usefulness,
        queryRunId: options.queryRunId,
        task: options.task,
        note: options.note
      });
      console.log(JSON.stringify(result, null, 2));
    }
  );

program
  .command("catalog")
  .description(t("生成知识目录并可选刷新 knowledge/_catalog.md", "Build a knowledge catalog and optionally refresh knowledge/_catalog.md"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--no-write", t("只输出 JSON，不重写 knowledge/_catalog.md", "print JSON without rewriting knowledge/_catalog.md"))
  .action(async (options: { root?: string; write: boolean }) => {
    const result = await catalogKnowledge(resolveCliRoot(options.root), { write: options.write });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", t("候选 JSON 文件", "candidate JSON file"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { input: string; root?: string }) => {
    const input = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput;
    const result = await writeCandidateMemory(resolveCliRoot(options.root), applyCapturePolicyOverrides(input));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list")
  .description(t("汇总知识文件、状态、领域和 inbox", "Summarize knowledge files, statuses, domains, and inbox items"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const result = await listKnowledge(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("organize-inbox")
  .description(t("预览或应用 inbox 知识晋升", "Plan or apply promotion of inbox Markdown into active directories"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--approve <id...>", t("只处理并明确批准指定知识 ID；可晋升已人工核验的自动/客户候选", "only process and explicitly approve selected knowledge IDs; permits reviewed automatic/customer candidates"))
  .option("--apply", t("移动并激活文件；默认 dry-run", "move and activate files; defaults to dry-run"), false)
  .option("--no-rebuild", t("应用后不重建索引", "skip index rebuild after applying changes"))
  .action(async (options: {
    root?: string;
    approve?: string[];
    apply: boolean;
    rebuild: boolean;
  }) => {
    const result = await organizeInbox(resolveCliRoot(options.root), {
      apply: options.apply,
      rebuild: options.rebuild,
      approvedIds: options.approve
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("capture-material")
  .description(t("把用户材料写入 active 知识或 inbox", "Write user-provided material into active knowledge or inbox"))
  .requiredOption("--input <file>", t("单个或多个候选对象的 JSON 文件", "JSON file containing one or more candidates"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--target <target>", t("active 或 inbox", "active or inbox"), "active")
  .option("--replace-source", t("仅刷新同 ID 的 active documented source 原始证据", "replace only active documented source evidence with the same ID"), false)
  .option("--no-rebuild", t("写入后不重建索引", "skip index rebuild after writing material"))
  .action(async (options: {
    input: string;
    root?: string;
    target: string;
    replaceSource: boolean;
    rebuild: boolean;
  }) => {
    if (options.target !== "active" && options.target !== "inbox") {
      throw new Error("--target must be either active or inbox");
    }
    const rawInput = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput | CandidateMemoryInput[];
    const inputs = (Array.isArray(rawInput) ? rawInput : [rawInput]).map(applyCapturePolicyOverrides);
    const result = await captureMaterial(resolveCliRoot(options.root), inputs, {
      target: options.target,
      rebuild: options.rebuild,
      replaceExistingSources: options.replaceSource
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("sync")
  .description(t("通过 WebDAV 或 S3 同步 Markdown 知识", "Synchronize Markdown knowledge with WebDAV or S3"));

const sync = program.commands.find((command) => command.name() === "sync")!;

/** 从同步配置提取上传权限边界，避免 backend 构造和 policy 解析相互耦合。 */
function configuredSyncPolicy(config: UserConfig["sync"]): {
  visibilityScopes: Array<"private" | "project" | "team">;
  sensitivityClearance: "public" | "internal" | "confidential" | "secret";
} {
  return {
    visibilityScopes: config.visibilityScopes,
    sensitivityClearance: config.sensitivityClearance
  };
}

sync
  .command("run")
  .description(t("按用户配置执行一次同步", "Run one synchronization using the user config"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--json", t("输出完整 JSON", "emit the full JSON result"), false)
  .action(async (options: { root?: string; json: boolean }) => {
    const configuredSync = userConfig().sync;
    const backend = createConfiguredSyncBackend(configuredSync);
    const result = await syncKnowledge(
      resolveCliRoot(options.root),
      backend,
      configuredSyncPolicy(configuredSync)
    );
    const machineOutput = program.opts<{ json: boolean }>().json || options.json;
    console.log(
      machineOutput
        ? JSON.stringify(result, null, 2)
        : t(
            `同步完成：推送 ${result.pushed.length}，拉取 ${result.pulled.length}，冲突 ${result.conflicts.length}。`,
            `Sync completed: ${result.pushed.length} pushed, ${result.pulled.length} pulled, ${result.conflicts.length} conflicts.`
          )
    );
  });

sync
  .command("watch")
  .description(t("立即同步并按配置间隔持续运行", "Run synchronization immediately and repeat at a configured interval"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--interval-minutes <minutes>", t("覆盖配置的同步间隔", "override the configured sync interval"))
  .action(async (options: { root?: string; intervalMinutes?: string }) => {
    const configuredSync = userConfig().sync;
    const intervalMinutes = options.intervalMinutes
      ? Number.parseInt(options.intervalMinutes, 10)
      : configuredSync.intervalMinutes;
    const root = resolveCliRoot(options.root);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    console.log(t(
      `开始定时 ${configuredSync.provider} 同步，每 ${intervalMinutes} 分钟执行一次。按 Ctrl+C 停止。`,
      `Starting scheduled ${configuredSync.provider} sync every ${intervalMinutes} minute(s). Press Ctrl+C to stop.`
    ));
    await runScheduledSync({
      intervalMinutes,
      signal: controller.signal,
      run: async () => {
        const result = await syncKnowledge(
          root,
          createConfiguredSyncBackend(configuredSync),
          configuredSyncPolicy(configuredSync)
        );
        console.log(
          `[${new Date().toISOString()}] Sync completed: ${result.pushed.length} pushed, ${result.pulled.length} pulled, ${result.conflicts.length} conflicts.`
        );
      },
      onError: (error) => {
        console.error(`[${new Date().toISOString()}] Sync failed: ${error.message}`);
      }
    });
  });

sync
  .command("webdav")
  .requiredOption("--url <url>", t("WebDAV 集合 URL", "WebDAV collection URL"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--username <username>", t("WebDAV 用户名", "WebDAV username"))
  .option("--password-env <name>", t("保存 WebDAV 密码的环境变量名", "environment variable containing WebDAV password"), "WEBDAV_PASSWORD")
  .option("--visibility <scope...>", t("同步可见范围", "visibility scopes to sync"), ["project", "team"])
  .option("--sensitivity-clearance <level>", t("同步最高敏感级别", "maximum sensitivity to sync"), "internal")
  .action(
    async (options: {
      url: string;
      root?: string;
      username?: string;
      passwordEnv: string;
      visibility: string[];
      sensitivityClearance: string;
    }) => {
      const backend = new WebDavSyncBackend({
        baseUrl: options.url,
        username: options.username ?? process.env.WEBDAV_USERNAME,
        password: process.env[options.passwordEnv]
      });
      console.log(
        JSON.stringify(
          await syncKnowledge(resolveCliRoot(options.root), backend, {
            visibilityScopes: resolveVisibilityScopes(options.visibility),
            sensitivityClearance: resolveSensitivityClearance(options.sensitivityClearance)
          }),
          null,
          2
        )
      );
    }
  );

sync
  .command("s3")
  .requiredOption("--bucket <bucket>", t("S3 bucket", "S3 bucket"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--region <region>", t("AWS region", "AWS region"), "us-east-1")
  .option("--prefix <prefix>", t("对象前缀", "object prefix"), "")
  .option("--endpoint <url>", t("S3 兼容 endpoint", "S3-compatible endpoint"))
  .option("--force-path-style", t("使用 path-style bucket 寻址", "use path-style bucket addressing"), false)
  .option("--visibility <scope...>", t("同步可见范围", "visibility scopes to sync"), ["project", "team"])
  .option("--sensitivity-clearance <level>", t("同步最高敏感级别", "maximum sensitivity to sync"), "internal")
  .action(
    async (options: {
      bucket: string;
      root?: string;
      region?: string;
      prefix: string;
      endpoint?: string;
      forcePathStyle: boolean;
      visibility: string[];
      sensitivityClearance: string;
    }) => {
      const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
      const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error("S3 sync requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY");
      }
      const region = options.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
      const client = new S3HttpObjectClient({
        bucket: options.bucket,
        region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        accessKeyId,
        secretAccessKey,
        sessionToken: process.env.AWS_SESSION_TOKEN
      });
      const backend = new S3SyncBackend({
        client,
        prefix: options.prefix,
        id: `s3:${options.endpoint ?? "aws"}:${region}:${options.bucket}:${options.prefix}`
      });
      console.log(
        JSON.stringify(
          await syncKnowledge(resolveCliRoot(options.root), backend, {
            visibilityScopes: resolveVisibilityScopes(options.visibility),
            sensitivityClearance: resolveSensitivityClearance(options.sensitivityClearance)
          }),
          null,
          2
        )
      );
    }
  );

program
  .command("staging")
  .description(t("查看和消费主动记忆 staging 事件", "Inspect and drain proactive-memory staging events"));

const staging = program.commands.find((command) => command.name() === "staging")!;

staging
  .command("status")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(JSON.stringify(await getStagingStatus(resolveCliRoot(options.root)), null, 2));
  });

staging
  .command("drain")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--limit <count>", t("最大消费事件数", "maximum events to consume"), "100")
  .action(async (options: { root?: string; limit: string }) => {
    console.log(
      JSON.stringify(
        await drainStagedEvents(resolveCliRoot(options.root), {
          limit: Number.parseInt(options.limit, 10)
        }),
        null,
        2
      )
    );
  });

const subagents = program
  .command("subagents")
  .description(t("查看详细 Subagent 运行日志", "Inspect detailed Subagent execution logs"));

subagents
  .command("status")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(await getSubagentLogStatus(resolveCliRoot(options.root)), null, 2)
    );
  });

subagents
  .command("logs")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--agent-type <type>", t("按 Subagent 类型过滤", "filter by Subagent type"))
  .option("--event <event>", t("subagent_start 或 subagent_stop", "subagent_start or subagent_stop"))
  .option("--limit <count>", t("最大日志条数", "maximum log records"), "100")
  .action(async (options: {
    root?: string;
    agentType?: string;
    event?: string;
    limit: string;
  }) => {
    if (
      options.event !== undefined &&
      options.event !== "subagent_start" &&
      options.event !== "subagent_stop"
    ) {
      throw new Error(t("未知 Subagent 事件", "Unknown Subagent event"));
    }
    console.log(
      JSON.stringify(
        await readSubagentLogs(resolveCliRoot(options.root), {
          agentType: options.agentType,
          event: options.event as "subagent_start" | "subagent_stop" | undefined,
          limit: Number.parseInt(options.limit, 10)
        }),
        null,
        2
      )
    );
  });

const maintenance = program
  .command("maintenance")
  .description(t("生成可审阅的知识维护 proposal", "Generate reviewable knowledge maintenance proposals"));

maintenance
  .command("extract")
  .description(t("从详细 Subagent 日志抽取 maintenance observations", "Extract maintenance observations from detailed Subagent logs"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await extractMaintenanceObservations(resolveCliRoot(options.root)),
        null,
        2
      )
    );
  });

maintenance
  .command("status")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(await getObservationStatus(resolveCliRoot(options.root)), null, 2)
    );
  });

maintenance
  .command("cleanup")
  .description(
    t(
      "预览或删除已消费的 Subagent 和 feedback 原始日志",
      "Preview or delete consumed Subagent and feedback source logs"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--apply",
    t("应用删除；默认 dry-run", "apply deletion; defaults to dry-run"),
    false
  )
  .action(async (options: { root?: string; apply: boolean }) => {
    const root = resolveCliRoot(options.root);
    console.log(
      JSON.stringify(
        options.apply
          ? await applyMaintenanceCleanup(root)
          : await planMaintenanceCleanup(root),
        null,
        2
      )
    );
  });

maintenance
  .command("list")
  .description(t("列出 maintenance proposals", "List maintenance proposals"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--status <status>", t("按 pending、accepted、rejected 过滤", "filter by pending, accepted, or rejected"))
  .action(async (options: { root?: string; status?: string }) => {
    const proposals = await readMaintenanceProposals(resolveCliRoot(options.root));
    console.log(
      JSON.stringify(
        options.status
          ? proposals.filter((proposal) => proposal.status === options.status)
          : proposals,
        null,
        2
      )
    );
  });

maintenance
  .command("show")
  .argument("<proposal-id>", t("Proposal ID", "Proposal ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (proposalId: string, options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await showMaintenanceProposal(resolveCliRoot(options.root), proposalId),
        null,
        2
      )
    );
  });

maintenance
  .command("accept")
  .argument("<proposal-id>", t("Proposal ID", "Proposal ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--skill-target <target>", t("Skill 目标：project 或 user；不传则进入 inbox", "Skill target: project or user; omit for inbox"))
  .option("--project-root <dir>", t("项目根目录覆盖", "project root override"))
  .action(async (
    proposalId: string,
    options: { root?: string; skillTarget?: string; projectRoot?: string }
  ) => {
    if (
      options.skillTarget !== undefined &&
      options.skillTarget !== "project" &&
      options.skillTarget !== "user"
    ) {
      throw new Error(t("未知 Skill 目标", "Unknown Skill target"));
    }
    console.log(
      JSON.stringify(
        await acceptMaintenanceProposal(resolveCliRoot(options.root), proposalId, {
          skillTarget: options.skillTarget as "project" | "user" | undefined,
          projectRoot: options.projectRoot,
          traeHome: process.env.TRAE_HOME
        }),
        null,
        2
      )
    );
  });

maintenance
  .command("install-skill")
  .description(
    t(
      "把已接受并审阅的 Skill proposal 安装到项目或用户目录",
      "Install an accepted and reviewed Skill proposal to a project or user directory"
    )
  )
  .argument("<proposal-id>", t("Proposal ID", "Proposal ID"))
  .requiredOption(
    "--skill-target <target>",
    t("Skill 目标：project 或 user", "Skill target: project or user")
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--project-root <dir>", t("项目根目录覆盖", "project root override"))
  .action(async (
    proposalId: string,
    options: {
      root?: string;
      skillTarget: string;
      projectRoot?: string;
    }
  ) => {
    if (options.skillTarget !== "project" && options.skillTarget !== "user") {
      throw new Error(t("未知 Skill 目标", "Unknown Skill target"));
    }
    console.log(
      JSON.stringify(
        await installAcceptedSkillProposal(
          resolveCliRoot(options.root),
          proposalId,
          {
            skillTarget: options.skillTarget,
            projectRoot: options.projectRoot,
            traeHome: process.env.TRAE_HOME
          }
        ),
        null,
        2
      )
    );
  });

maintenance
  .command("reject")
  .argument("<proposal-id>", t("Proposal ID", "Proposal ID"))
  .requiredOption("--reason <reason>", t("拒绝原因", "rejection reason"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (
    proposalId: string,
    options: { root?: string; reason: string }
  ) => {
    console.log(
      JSON.stringify(
        await rejectMaintenanceProposal(
          resolveCliRoot(options.root),
          proposalId,
          options.reason
        ),
        null,
        2
      )
    );
  });

maintenance
  .command("run")
  .description(t("自动抽取 observations 并生成 proposal", "Extract observations and generate proposals"))
  .option("--input <file>", t("高级用法：外部 Observation JSON 数组", "advanced: external observation JSON array"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--limit <count>", t("本次最多处理数量", "maximum observations to process"), "100")
  .action(async (options: { input?: string; root?: string; limit: string }) => {
    const root = resolveCliRoot(options.root);
    const observations = options.input
      ? (JSON.parse(await readFile(options.input, "utf8")) as MaintenanceObservation[])
      : (await extractMaintenanceObservations(root),
        await readMaintenanceObservations(root));
    const result = await generateMaintenanceProposals(root, observations, {
      limit: Number.parseInt(options.limit, 10)
    });
    console.log(JSON.stringify(result, null, 2));
  });

maintenance
  .command("watch")
  .description(t("定时抽取并处理 observations", "Periodically extract and process observations"))
  .option("--input <file>", t("高级用法：外部 Observation JSON 数组", "advanced: external observation JSON array"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--limit <count>", t("每批最多处理数量", "maximum observations per batch"), "100")
  .option("--interval-minutes <minutes>", t("运行间隔（分钟）", "run interval in minutes"), "30")
  .action(async (options: {
    input?: string;
    root?: string;
    limit: string;
    intervalMinutes: string;
  }) => {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runScheduledSync({
      intervalMinutes: Number.parseInt(options.intervalMinutes, 10),
      signal: controller.signal,
      run: async () => {
        const root = resolveCliRoot(options.root);
        const observations = options.input
          ? (JSON.parse(await readFile(options.input, "utf8")) as MaintenanceObservation[])
          : (await extractMaintenanceObservations(root),
            await readMaintenanceObservations(root));
        const result = await generateMaintenanceProposals(resolveCliRoot(options.root), observations, {
          limit: Number.parseInt(options.limit, 10)
        });
        console.log(JSON.stringify(result));
      },
      onError: (error) => {
        console.error(t(`Maintenance 失败：${error.message}`, `Maintenance failed: ${error.message}`));
      }
    });
  });

program
  .command("project")
  .description(t("检测并注册当前 Git 项目", "Detect and register the current Git project"));

const project = program.commands.find((command) => command.name() === "project")!;

project
  .command("detect")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--cwd <dir>", t("要检查的目录", "directory to inspect"), process.cwd())
  .action(async (options: { root?: string; cwd: string }) => {
    console.log(JSON.stringify(await detectProject(resolveCliRoot(options.root), options.cwd), null, 2));
  });

const graph = program
  .command("graph")
  .description(t("构建、查询和导出知识关系图", "Build, query, and export the knowledge graph"));

graph
  .command("build")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const built = await buildKnowledgeGraph(resolveCliRoot(options.root));
    console.log(
      JSON.stringify(
        {
          generatedAt: built.generatedAt,
          nodes: built.nodes.length,
          edges: built.edges.length
        },
        null,
        2
      )
    );
  });

graph
  .command("query")
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--text <text>", t("节点文本搜索", "node text search"))
  .option("--id <id>", t("节点或知识 ID", "node or knowledge ID"))
  .option("--depth <depth>", t("遍历深度，最大 2", "traversal depth, max 2"), "1")
  .action(async (options: { root?: string; text?: string; id?: string; depth: string }) => {
    if (!options.text && !options.id) {
      throw new Error(t("必须提供 --text 或 --id", "Provide --text or --id"));
    }
    console.log(
      JSON.stringify(
        await queryKnowledgeGraph(resolveCliRoot(options.root), {
          text: options.text,
          id: options.id,
          depth: Number.parseInt(options.depth, 10)
        }),
        null,
        2
      )
    );
  });

graph
  .command("export")
  .requiredOption("--format <format>", t("json、mermaid 或 html", "json, mermaid, or html"))
  .requiredOption("--output <file>", t("输出文件", "output file"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { format: string; output: string; root?: string }) => {
    if (
      options.format !== "json" &&
      options.format !== "mermaid" &&
      options.format !== "html"
    ) {
      throw new Error(t("未知 graph 导出格式", "Unknown graph export format"));
    }
    const root = resolveCliRoot(options.root);
    let current;
    try {
      current = readKnowledgeGraph(root);
    } catch {
      current = await buildKnowledgeGraph(root);
    }
    await exportKnowledgeGraph(current, {
      format: options.format,
      output: options.output
    });
    console.log(
      t(
        `已导出：${path.resolve(options.output)}`,
        `Exported: ${path.resolve(options.output)}`
      )
    );
  });

program
  .command("integration")
  .description(t("管理 Agent Knowledge 产品接入", "Manage Agent Knowledge integrations for supported products"));

const integration = program.commands.find((command) => command.name() === "integration")!;

integration
  .command("list")
  .description(t("列出支持的产品和可选组件", "List supported products and optional components"))
  .action(() => {
    console.log(JSON.stringify({ products: listIntegrationProducts() }, null, 2));
  });

integration
  .command("install")
  .option("--product <product>", t("trae、trae-cn 或 claude-code", "trae, trae-cn, or claude-code"))
  .option("--scope <scope>", t("user 或 project", "user or project"))
  .option("--components <components>", t("逗号分隔的 hooks,agents,skills,plugin-bundle", "comma-separated hooks,agents,skills,plugin-bundle"))
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .option("--mode <mode>", t("merge 或 overwrite", "merge or overwrite"))
  .option("--overwrite", t("覆盖目标文件和 symlink", "replace target files and symlinks"), false)
  .option("--debug", t("输出完整 JSON", "emit the full JSON result"), false)
  .action(
    async (options: {
      product?: string;
      scope?: string;
      components?: string;
      targetDir?: string;
      mode?: string;
      overwrite: boolean;
      debug: boolean;
    }) => {
      const configuredDefaults = userConfig().integration;
      const partial = {
        ...(options.product ? { product: options.product as "trae" | "trae-cn" | "claude-code" } : {}),
        ...(options.scope ? { scope: options.scope as "user" | "project" } : {}),
        ...(options.components
          ? {
              components: options.components
                .split(",")
                .map((component) => component.trim())
                .filter(Boolean) as Array<"hooks" | "agents" | "skills" | "plugin-bundle">
            }
          : {}),
        ...(options.targetDir ? { targetDir: options.targetDir } : {}),
        ...(options.overwrite
          ? { mode: "overwrite" as const }
          : options.mode
            ? { mode: options.mode as "merge" | "overwrite" }
            : {})
      };
      const shouldPrompt =
        process.stdin.isTTY &&
        (!options.product || !options.scope || !options.components || (!options.mode && !options.overwrite));
      let selected;
      if (shouldPrompt) {
        const prompter = new TerminalIntegrationPrompter();
        try {
          selected = await promptForIntegrationInstall({
            defaults: configuredDefaults,
            prompter,
            partial,
            locale
          });
        } finally {
          prompter.close();
        }
      } else {
        selected = {
          product: partial.product ?? configuredDefaults.product,
          scope: partial.scope ?? configuredDefaults.scope,
          components: partial.components ?? configuredDefaults.components,
          targetDir: partial.targetDir ?? configuredDefaults.targetDir ?? undefined,
          mode: partial.mode ?? configuredDefaults.mode
        };
      }
      if (
        selected.product !== "trae" &&
        selected.product !== "trae-cn" &&
        selected.product !== "claude-code"
      ) {
        throw new Error("--product must be trae, trae-cn, or claude-code");
      }
      if (selected.scope !== "user" && selected.scope !== "project") {
        throw new Error("--scope must be user or project");
      }
      if (selected.mode !== "merge" && selected.mode !== "overwrite") {
        throw new Error("--mode must be merge or overwrite");
      }
      const allowed = new Set(["hooks", "agents", "skills", "plugin-bundle"]);
      if (selected.components.some((component) => !allowed.has(component))) {
        throw new Error("--components contains an unsupported component");
      }
      const result = await installIntegration({
        packageRoot: findPackageRoot(),
        product: selected.product,
        scope: selected.scope,
        targetDir: selected.targetDir,
        components: selected.components,
        mode: selected.mode
      });
      const machineOutput = program.opts<{ json: boolean }>().json || options.debug;
      console.log(machineOutput ? JSON.stringify(result, null, 2) : formatIntegrationInstallResult(result, locale));
    }
  );

integration
  .command("uninstall")
  .requiredOption("--product <product>", t("trae、trae-cn 或 claude-code", "trae, trae-cn, or claude-code"))
  .option("--scope <scope>", t("user 或 project", "user or project"), "user")
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .action(async (options: { product: string; scope: string; targetDir?: string }) => {
    if (
      options.product !== "trae" &&
      options.product !== "trae-cn" &&
      options.product !== "claude-code"
    ) {
      throw new Error("--product must be trae, trae-cn, or claude-code");
    }
    if (options.scope !== "user" && options.scope !== "project") {
      throw new Error("--scope must be user or project");
    }
    console.log(
      JSON.stringify(
        await uninstallIntegration({
          product: options.product,
          scope: options.scope,
          targetDir: options.targetDir
        }),
        null,
        2
      )
    );
  });

integration
  .command("doctor")
  .requiredOption("--product <product>", t("trae、trae-cn 或 claude-code", "trae, trae-cn, or claude-code"))
  .option("--scope <scope>", t("user 或 project", "user or project"), "user")
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .action(async (options: { product: string; scope: string; targetDir?: string }) => {
    if (
      options.product !== "trae" &&
      options.product !== "trae-cn" &&
      options.product !== "claude-code"
    ) {
      throw new Error("--product must be trae, trae-cn, or claude-code");
    }
    if (options.scope !== "user" && options.scope !== "project") {
      throw new Error("--scope must be user or project");
    }
    console.log(
      JSON.stringify(
        await doctorIntegration({
          product: options.product,
          scope: options.scope,
          targetDir: options.targetDir
        }),
        null,
        2
      )
    );
  });

program
  .command("install-global")
  .description(t("构建并用 npm 全局安装当前包", "Build and install the local package globally with npm"))
  .option("--package-dir <dir>", t("本地包目录", "local package directory"), process.cwd())
  .option("--skip-build", t("全局安装前跳过构建", "skip build before global installation"), false)
  .action((options: { packageDir: string; skipBuild: boolean }) => {
    const packageDir = path.resolve(options.packageDir);
    if (!options.skipBuild) {
      execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
    }
    execFileSync("npm", ["install", "-g", packageDir], { stdio: "inherit" });
    console.log(t(`已从 ${packageDir} 全局安装命令`, `Installed global command from ${packageDir}`));
  });

const hook = program.command("hook").description(t("供 TRAE hooks.json 调用的内部命令", "Internal commands called by TRAE hooks.json"));

/**
 * 为当前 Hook 补充自动发现的 project ID，再写入脱敏 staging 和运行摘要。
 * Git 探测失败只降级为无 project，不得阻塞宿主 Agent 生命周期。
 */
async function stageCurrentHook(root: string): Promise<void> {
  const input = await readHookInput();
  const runtimeContext = getGitRuntimeContext(
    typeof input.cwd === "string" ? input.cwd : process.cwd()
  );
  const detectedProject = runtimeContext.isGit
    ? await detectProject(root, runtimeContext.cwd).catch(() => undefined)
    : undefined;
  const staged = await stageHookEvent(root, {
    ...input,
    project_id: detectedProject?.id
  });
  appendJsonlLog(root, {
    event: "hook.lifecycle_staged",
    hookEventName:
      typeof (input.hook_event_name ?? input.event_type) === "string"
        ? String(input.hook_event_name ?? input.event_type).slice(0, 80)
        : "unknown",
    agentType: typeof input.agent_type === "string" ? input.agent_type.slice(0, 80) : undefined,
    projectId: detectedProject?.id,
    stagingSequence: staged.sequence
  });
}

hook
  .command("stage-event")
  .description(t("记录有界、脱敏的生命周期事件", "Stage a bounded, redacted lifecycle event"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    await stageCurrentHook(root);
  });

hook
  .command("subagent-event")
  .description(
    t(
      "记录详细 Subagent 事件和 staging 信号",
      "Record a detailed Subagent event and staging signal"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    const input = await readHookInput();
    await appendSubagentEvent(root, input, {
      enabled: userConfig().hooks.detailedSubagentLogging
    });
    const runtimeContext = getGitRuntimeContext(
      typeof input.cwd === "string" ? input.cwd : process.cwd()
    );
    const detectedProject = runtimeContext.isGit
      ? await detectProject(root, runtimeContext.cwd).catch(() => undefined)
      : undefined;
    await stageHookEvent(root, {
      ...input,
      project_id: detectedProject?.id
    });
  });

hook
  .command("session-start")
  .description(t("初始化 TRAE 会话的知识库并提供启动上下文", "Initialize the TRAE session knowledge root"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    const runtimeContext = getGitRuntimeContext();
    await initKnowledgeWorkspace(root);
    const detectedProject = runtimeContext.isGit
      ? await detectProject(root, runtimeContext.cwd).catch(() => undefined)
      : undefined;
    if (process.env.TRAE_ENV_FILE) {
      await appendFile(process.env.TRAE_ENV_FILE, `AGENT_KNOWLEDGE_ROOT="${root}"\n`, "utf8");
    }
    appendJsonlLog(root, {
      event: "hook.session_start",
      root,
      runtimeContext,
      projectId: detectedProject?.id
    });
    hookContext(
      "SessionStart",
      t(
        `Agent Knowledge 已启用。知识库：${root}。${detectedProject ? `项目 ID：${detectedProject.id}。` : ""}\n\nHook 运行环境：\n${formatRuntimeContext(runtimeContext)}`,
        `Agent Knowledge is enabled. Knowledge root: ${root}. ${detectedProject ? `Project ID: ${detectedProject.id}.` : ""}\n\nHook runtime context:\n${formatRuntimeContext(runtimeContext)}`
      )
    );
  });

hook
  .command("doctor")
  .description(t("输出 Hook runtime 诊断", "Print hook runtime diagnostics"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action((options: { root?: string }) => {
    console.log(
      JSON.stringify(
        {
          knowledgeRoot: resolveCliRoot(options.root),
          runtimeContext: getGitRuntimeContext()
        },
        null,
        2
      )
    );
  });

hook
  .command("user-prompt-submit")
  .description(t("为提交的 prompt 查询相关知识上下文", "Query relevant knowledge for the submitted prompt"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    const startedAt = performance.now();
    const root = resolveCliRoot(options.root);
    const runtimeContext = getGitRuntimeContext();
    const detectedProject = runtimeContext.isGit
      ? await detectProject(root, runtimeContext.cwd).catch(() => undefined)
      : undefined;
    const input = await readHookInput();
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0) {
      appendJsonlLog(root, {
        event: "hook.user_prompt_submit",
        decision: "none",
        promptLength: 0,
        latencyMs: performance.now() - startedAt
      });
      return;
    }

    try {
      await initKnowledgeWorkspace(root);
      rebuildIndex(root);
      const catalog = await catalogKnowledge(root, { write: false });
      const hookConfig = userConfig().hooks;
      const request = MemoryQueryRequestSchema.parse({
        task: prompt,
        agentRole: "main",
        maxTokens: hookConfig.maxTokens,
        visibilityScopes: resolveVisibilityScopes(),
        sensitivityClearance: resolveSensitivityClearance(),
        projectIds: detectedProject ? [detectedProject.id] : []
      });
      const { ranked, debug } = queryMemoriesWithDebug(root, request);
      const packet = buildContextPacket({ request, ranked });
      const injection = decideHookInjection({
        prompt,
        ranked,
        packet,
        minScore: hookConfig.minScore,
        catalog,
        catalogMaxItems: hookConfig.catalogMaxItems
      });

      appendJsonlLog(root, {
        event: "hook.user_prompt_submit",
        decision: injection.decision,
        promptLength: prompt.length,
        resultIds: injection.resultIds,
        topScore: injection.score,
        packetTokens: injection.packetTokens,
        fallbackUsed: debug.fallbackUsed,
        fallbackSuppressedReason: debug.fallbackSuppressedReason,
        runtimeContext,
        projectId: detectedProject?.id,
        latencyMs: performance.now() - startedAt
      });

      hookContext("UserPromptSubmit", injection.additionalContext);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonlLog(root, {
        event: "hook.user_prompt_submit.error",
        decision: "error",
        promptLength: prompt.length,
        message,
        latencyMs: performance.now() - startedAt
      });
    }
  });

await program.parseAsync(process.argv);
