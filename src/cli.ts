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
  ackNotification,
  appendLifecycleEvent,
  applyMaintenanceCleanup,
  appendJsonlLog,
  appendSubagentEvent,
  buildKnowledgeGraph,
  buildContextPacket,
  auditKnowledgeQuality,
  calibrateRetrieval,
  catalogKnowledge,
  captureMaterial,
  connectorRegistrationInput,
  createEmbeddingProvider,
  createConnectorFromRegistration,
  createTranscriptConnector,
  createConfiguredSyncBackend,
  checkConnectorSourceUpdates,
  decideHookInjection,
  deliverNotifications,
  downloadRetrievalModel,
  extractMaintenanceObservations,
  getDefaultUserConfigPath,
  getKnowledgeGitStatus,
  getVaultStatus,
  FileSystemConnector,
  GitRepositoryConnector,
  LarkExportConnector,
  getRetrievalModelStatus,
  getObservationStatus,
  getSubagentLogStatus,
  installAcceptedSkillProposal,
  embedKnowledgeIndex,
  loadEvalSuite,
  loadEvalCorpus,
  materializeEvalCorpus,
  generateMaintenanceProposals,
  getEventLedgerStatus,
  getEventTimeline,
  initKnowledgeWorkspace,
  inspectAutomation,
  enqueueNotification,
  listEventStreams,
  listConnectorRegistrations,
  listAutomationJobs,
  listKnowledge,
  listNotifications,
  readSidecarComparisonHistory,
  retainQueryTaskEvidence,
  listSources,
  logMemoryFeedback,
  markSourceReviewed,
  organizeInbox,
  planMaintenanceCleanup,
  putVaultObject,
  queryKnowledgeGraph,
  queryMemoriesGraphWithDebug,
  queryMemories,
  queryMemoriesHybridWithDebug,
  queryMemoriesRerankedWithDebug,
  queryMemoriesWithDebug,
  rebuildIndex,
  runConnectorIngestion,
  runAutomation,
  registerConnector,
  runEvalSuite,
  runScheduledSync,
  readSubagentLogs,
  readAutomationJob,
  readAutomationProfile,
  readMaintenanceProposals,
  readKnowledgeGraph,
  resolveRetrievalModelDescriptor,
  rejectMaintenanceProposal,
  readMaintenanceObservations,
  readNotification,
  renderAutomationService,
  readConnectorRegistration,
  showMaintenanceProposal,
  showLifecycleEvent,
  showSource,
  exportKnowledgeGraph,
  exportEventPayload,
  expandEvidence,
  expandKnowledge,
  S3HttpObjectClient,
  S3SyncBackend,
  SidecarProviderSchema,
  TransformersBatchReranker,
  stageHookEvent,
  scaffoldSidecar,
  searchSidecar,
  getStagingStatus,
  getIntegrationProduct,
  drainStagedEvents,
  suggestAliases,
  compareSidecars,
  createSidecarPreset,
  doctorSidecar,
  ingestSidecarItems,
  syncKnowledge,
  WebDavSyncBackend,
  doctorIntegration,
  detectProject,
  installIntegration,
  initializeKnowledgeGitWorkspace,
  initializeVault,
  listIntegrationProducts,
  readSidecarConfig,
  uninstallIntegration,
  writeSidecarConfig,
  vaultKeyFromEnvironment,
  writeVaultObjectToFile,
  exportSourceEvidence,
  deleteVaultObject,
  writeCandidateMemory,
  redactIngestionError,
  type CandidateMemoryInput,
  type CalibrationCase,
  type CalibrationFeedback,
  type ConnectorRegistrationInput,
  type KnowledgeConnector,
  type MaintenanceObservation,
  type AutomationJob,
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

/**
 * 只从首个子命令之前读取 `--name=value` 或 `--name value`。
 *
 * sidecar 也有业务 `--config`；限制全局选项位置可避免把 sidecar.json 当成用户配置，
 * 并与 Commander positional options 的解析语义保持一致。
 */
function readGlobalArgValue(name: string): string | undefined {
  const argumentsBeforeCommand: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]!;
    if (!argument.startsWith("-")) {
      break;
    }
    argumentsBeforeCommand.push(argument);
    if (
      (argument === "--config" || argument === "--locale") &&
      process.argv[index + 1] !== undefined
    ) {
      argumentsBeforeCommand.push(process.argv[index + 1]!);
      index += 1;
    }
  }
  const direct = argumentsBeforeCommand.find((argument) =>
    argument.startsWith(`${name}=`)
  );
  if (direct) {
    return direct.slice(name.length + 1);
  }
  const index = argumentsBeforeCommand.indexOf(name);
  return index >= 0 ? argumentsBeforeCommand[index + 1] : undefined;
}

const startupConfigPath = path.resolve(
  readGlobalArgValue("--config") ?? getDefaultUserConfigPath()
);
const startupEffectiveConfig = loadEffectiveConfig({
  userConfigPath: startupConfigPath
});
const startupConfig = startupEffectiveConfig.config;
const locale: SupportedLocale = resolveLocale({
  explicit: readGlobalArgValue("--locale"),
  configured: startupConfig.locale
});
const t = (chinese: string, english: string): string => translate(locale, chinese, english);

const program = new Command();

program
  .name("agent-knowledge")
  .description(t("本地、可读、可审计的 Agent 知识工具", "Local human-readable memory toolkit for agents"))
  .version("0.1.0")
  .enablePositionalOptions()
  .option("--config <file>", t("用户配置文件；默认 ~/.config/agent-knowledge/config.json", "user config file; defaults to ~/.config/agent-knowledge/config.json"))
  .option("--locale <locale>", t("界面语言：auto、zh-CN 或 en", "UI language: auto, zh-CN, or en"))
  .option("--json", t("对支持的命令输出机器可读 JSON", "emit machine-readable JSON for commands that support human output"), false);

program.addHelpText(
  "after",
  t(
    `
常用流程：
  首次配置      agent-knowledge configure
  导入文档      agent-knowledge ingest files --connector-id docs --base-dir ./docs --pattern '**/*.md'
  日常增量      agent-knowledge source refresh
  审阅来源      agent-knowledge source list --needs-review
  查询知识      agent-knowledge query --task "当前问题"
  质量检查      agent-knowledge knowledge audit

提示：完整流程和安全边界见 README.md；所有命令都支持 --help。
全局 --config/--locale/--json 必须放在子命令之前；sidecar 的 --config 放在 sidecar 子命令之后。`,
    `
Common workflows:
  First-time setup   agent-knowledge configure
  Ingest documents  agent-knowledge ingest files --connector-id docs --base-dir ./docs --pattern '**/*.md'
  Daily refresh     agent-knowledge source refresh
  Review sources    agent-knowledge source list --needs-review
  Query knowledge   agent-knowledge query --task "current question"
  Quality audit     agent-knowledge knowledge audit

Tip: see README.md for complete workflows and safety boundaries; every command supports --help.
Place global --config/--locale/--json before the subcommand; place sidecar --config after the sidecar subcommand.`
  )
);

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
 * 显式 `--project` 完全优先；未显式指定时从当前 Git remote 自动发现规范 project key。
 * Git 不可用、无 remote 或探测失败时回退空数组，避免路径/hash 被静默写入知识作用域。
 */
async function resolveQueryProjectKeys(
  rootDir: string,
  explicitProjectKeys?: string[]
): Promise<string[]> {
  if (explicitProjectKeys !== undefined) {
    return explicitProjectKeys;
  }
  const runtimeContext = getGitRuntimeContext();
  if (!runtimeContext.isGit) {
    return [];
  }
  const detected = await detectProject(rootDir, runtimeContext.cwd).catch(
    () => undefined
  );
  return detected ? [detected.key] : [];
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

/** 读取 sidecar shadow ingest 的 JSON 数组或 JSONL；正文只发送到显式配置的外部后端。 */
async function readSidecarItems(filePath: string): Promise<
  Array<{ id: string; text: string; metadata: Record<string, unknown> }>
> {
  const text = await readFile(path.resolve(filePath), "utf8");
  const raw = text.trim().startsWith("[")
    ? (JSON.parse(text) as unknown[])
    : text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  return raw.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Sidecar input item ${index} must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      !record.id ||
      typeof record.text !== "string" ||
      !record.text.trim()
    ) {
      throw new Error(`Sidecar input item ${index} requires id and text`);
    }
    return {
      id: record.id,
      text: record.text,
      metadata:
        record.metadata &&
        typeof record.metadata === "object" &&
        !Array.isArray(record.metadata)
          ? (record.metadata as Record<string, unknown>)
          : {}
    };
  });
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

configCommand
  .command("path")
  .description(t("显示用户配置文件路径", "Show the user configuration file path"))
  .action(() => {
    console.log(resolveConfigPath());
  });

configCommand
  .command("show")
  .description(t("显示分层合并后的生效配置", "Show the merged effective configuration"))
  .action(() => {
    console.log(JSON.stringify(userConfig(), null, 2));
  });

configCommand
  .command("sources")
  .description(t("显示用户、项目共享和项目 local 配置来源", "Show user, shared-project, and project-local configuration sources"))
  .action(() => {
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

const workspace = program
  .command("workspace")
  .description(
    t(
      "初始化和检查独立知识数据工作区",
      "Initialize and inspect a separate knowledge data workspace"
    )
  );

workspace
  .command("git-init")
  .description(
    t(
      "在独立目录初始化 private-data-safe Git 知识库",
      "Initialize a private-data-safe Git knowledge repository in a separate directory"
    )
  )
  .requiredOption("--root <dir>", t("独立知识数据目录", "separate knowledge data directory"))
  .action(async (options: { root: string }) => {
    console.log(
      JSON.stringify(
        await initializeKnowledgeGitWorkspace(options.root),
        null,
        2
      )
    );
  });

workspace
  .command("git-status")
  .description(
    t(
      "检查知识数据仓库 Git 状态",
      "Inspect knowledge data repository Git status"
    )
  )
  .requiredOption("--root <dir>", t("知识数据目录", "knowledge data directory"))
  .action(async (options: { root: string }) => {
    console.log(
      JSON.stringify(await getKnowledgeGitStatus(options.root), null, 2)
    );
  });

/** 从生效配置指向的环境变量加载 Vault key，避免真实密钥出现在 CLI 参数。 */
function configuredVaultKey(): Buffer {
  return vaultKeyFromEnvironment(userConfig().vault.keyEnv);
}

const vault = program
  .command("vault")
  .description(
    t(
      "管理本地客户端加密 Evidence Vault",
      "Manage the local client-encrypted Evidence Vault"
    )
  );

vault
  .command("init")
  .description(t("初始化 Vault 目录并验证环境密钥", "Initialize Vault directories and validate the environment key"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await initializeVault(resolveCliRoot(options.root), {
          key: configuredVaultKey(),
          actor: "cli"
        }),
        null,
        2
      )
    );
  });

vault
  .command("status")
  .description(t("查看不含正文的 Vault 健康摘要", "Show Vault health without evidence content"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    let key: Buffer | undefined;
    try {
      key = configuredVaultKey();
    } catch {
      key = undefined;
    }
    console.log(
      JSON.stringify(
        await getVaultStatus(resolveCliRoot(options.root), { key }),
        null,
        2
      )
    );
  });

vault
  .command("put")
  .description(t("加密写入完整 evidence", "Encrypt and store complete evidence"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--input <file>", t("要写入的本地文件", "local file to store"))
  .option("--text <text>", t("受控自动化使用的 UTF-8 文本；推荐文件输入", "UTF-8 text for controlled automation; file input is preferred"))
  .option("--content-type <type>", t("MIME 类型", "MIME content type"), "application/octet-stream")
  .option("--actor <actor>", t("访问审计 actor", "access audit actor"), "cli")
  .action(async (options: {
    root?: string;
    input?: string;
    text?: string;
    contentType: string;
    actor: string;
  }) => {
    if (Boolean(options.input) === Boolean(options.text)) {
      throw new Error("vault put requires exactly one of --input or --text");
    }
    const bytes = options.input
      ? await readFile(path.resolve(options.input))
      : Buffer.from(options.text ?? "", "utf8");
    console.log(
      JSON.stringify(
        await putVaultObject(
          resolveCliRoot(options.root),
          { bytes, contentType: options.contentType },
          { key: configuredVaultKey(), actor: options.actor }
        ),
        null,
        2
      )
    );
  });

vault
  .command("get")
  .description(t("解密对象到显式本地文件；不向 stdout 输出正文", "Decrypt an object to an explicit local file without printing content"))
  .argument("<object-id>", t("Vault object ID", "Vault object ID"))
  .requiredOption("--output <file>", t("解密输出文件", "decrypted output file"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--overwrite", t("允许覆盖已有输出文件", "allow overwriting the output file"), false)
  .option("--actor <actor>", t("访问审计 actor", "access audit actor"), "cli")
  .action(async (
    objectId: string,
    options: {
      root?: string;
      output: string;
      overwrite: boolean;
      actor: string;
    }
  ) => {
    console.log(
      JSON.stringify(
        await writeVaultObjectToFile(
          resolveCliRoot(options.root),
          {
            id: objectId,
            outputPath: options.output,
            overwrite: options.overwrite
          },
          { key: configuredVaultKey(), actor: options.actor }
        ),
        null,
        2
      )
    );
  });

vault
  .command("delete")
  .description(t("物理删除密文并写 tombstone", "Physically delete ciphertext and write a tombstone"))
  .argument("<object-id>", t("Vault object ID", "Vault object ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--reason <reason>", t("删除原因；Vault 只保存 hash", "deletion reason; Vault stores only its hash"))
  .option("--actor <actor>", t("访问审计 actor", "access audit actor"), "cli")
  .action(async (
    objectId: string,
    options: { root?: string; reason?: string; actor: string }
  ) => {
    console.log(
      JSON.stringify(
        await deleteVaultObject(
          resolveCliRoot(options.root),
          objectId,
          { reason: options.reason },
          { key: configuredVaultKey(), actor: options.actor }
        ),
        null,
        2
      )
    );
  });

const ingest = program
  .command("ingest")
  .description(
    t(
      "从 Connector 增量摄入版本化 evidence",
      "Incrementally ingest versioned evidence from connectors"
    )
  );

/** 解析可重复 `--project-key`，空数组表示未绑定项目而不是自动探测。 */
function collectProjectKey(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** 校验 ingestion 数量上限，拒绝 NaN 或负数造成意外全量抓取。 */
function parseIngestionLimit(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(
      t(
        "ingest limit 必须是非负整数",
        "ingest limit must be a non-negative integer"
      )
    );
  }
  return parsed;
}

/**
 * 先登记可重跑 Connector，再执行现有 ingestion。
 *
 * complete inventory 的 identity 必须在写登记前由 Connector 自身校验；输出只返回 workspace
 * 相对登记路径，不暴露本机 source 目录。登记成功不绕过后续 Vault/manifest/checkpoint 边界。
 */
async function runRegisteredConnectorIngestion(
  rootDir: string,
  connector: KnowledgeConnector,
  registration: ConnectorRegistrationInput,
  options: Parameters<typeof runConnectorIngestion>[2]
) {
  const rawInventoryIdentity = await connector.inventoryIdentity?.();
  const registered = await registerConnector(
    rootDir,
    registration,
    rawInventoryIdentity
      ? { inventoryIdentity: rawInventoryIdentity }
      : {}
  );
  const result = await runConnectorIngestion(rootDir, connector, options);
  return {
    ...result,
    registration: {
      connectorId: registered.record.connectorId,
      kind: registered.record.kind,
      path: path
        .relative(path.resolve(rootDir), registered.path)
        .split(path.sep)
        .join("/")
    }
  };
}

/** 为登记类型生成可审计 Vault actor，不把本地路径或 source identity 写入访问日志。 */
function refreshVaultActor(
  kind: ConnectorRegistrationInput["kind"]
): string {
  return `source-refresh-${kind}`;
}

/** 把 refresh 的 ingestion 结果压缩为人和脚本都易读的计数，不重复输出数百条 job。 */
function summarizeRefreshIngestion(
  result: Awaited<ReturnType<typeof runConnectorIngestion>>
): {
  connectorId: string;
  inventory: typeof result.inventory;
  discovered: number;
  completed: number;
  skipped: number;
  failed: number;
  unresolvedFailures: number;
  classifications: Record<string, number>;
} {
  const classifications: Record<string, number> = {};
  for (const job of result.jobs) {
    const classification = job.classification ?? job.status;
    classifications[classification] =
      (classifications[classification] ?? 0) + 1;
  }
  return {
    connectorId: result.connectorId,
    inventory: result.inventory,
    discovered: result.discovered,
    completed: result.completed,
    skipped: result.skipped,
    failed: result.failed,
    unresolvedFailures: result.unresolvedFailures,
    classifications
  };
}

/** refresh 默认只返回检查摘要；逐 source 状态由 `source check` 单独提供。 */
function summarizeRefreshCheck(
  report: Awaited<ReturnType<typeof checkConnectorSourceUpdates>>
): {
  checkedAt: string;
  freshnessBoundary: typeof report.freshnessBoundary;
  inventory: typeof report.inventory;
  summary: typeof report.summary;
} {
  return {
    checkedAt: report.checkedAt,
    freshnessBoundary: report.freshnessBoundary,
    inventory: report.inventory,
    summary: report.summary
  };
}

ingest
  .command("files")
  .description(
    t(
      "摄入显式目录内的 UTF-8 文档；不跟随符号链接",
      "Ingest UTF-8 documents inside an explicit directory without following symlinks"
    )
  )
  .requiredOption("--connector-id <id>", t("稳定 Connector ID", "stable connector ID"))
  .requiredOption("--base-dir <dir>", t("只读来源目录", "read-only source directory"))
  .requiredOption(
    "--pattern <glob...>",
    t("相对 base dir 的一个或多个 glob", "one or more globs relative to base dir")
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--artifact-kind <kind>",
    t(
      "document、tool_trace 或 repository",
      "document, tool_trace, or repository"
    ),
    "document"
  )
  .option("--content-type <type>", t("覆盖 MIME 类型", "override MIME content type"))
  .option(
    "--project-key <key>",
    t("绑定规范项目 key，可重复", "canonical project key; repeatable"),
    collectProjectKey,
    []
  )
  .option(
    "--redaction <policy>",
    t(
      "secrets-only 或 secrets-and-pii",
      "secrets-only or secrets-and-pii"
    ),
    "secrets-only"
  )
  .option("--limit <count>", t("本次最多处理 source 数", "maximum sources in this run"))
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge ingest files --connector-id business-docs --base-dir /secure/docs --pattern '**/*.md' --project-key github.com/example/business

边界：只读取 base-dir 内的 UTF-8 普通文件，不跟随 symlink。含个人信息时使用 --redaction secrets-and-pii。
首次摄入后，日常可用 agent-knowledge source refresh --connector-id business-docs。`,
      `
Examples:
  agent-knowledge ingest files --connector-id business-docs --base-dir /secure/docs --pattern '**/*.md' --project-key github.com/example/business

Boundary: reads UTF-8 regular files under base-dir only and does not follow symlinks. Use --redaction secrets-and-pii for personal data.
After first ingestion, use agent-knowledge source refresh --connector-id business-docs for daily updates.`
    )
  )
  .action(async (options: {
    connectorId: string;
    baseDir: string;
    pattern: string[];
    root?: string;
    artifactKind: string;
    contentType?: string;
    projectKey: string[];
    redaction: string;
    limit?: string;
  }) => {
    if (
      options.artifactKind !== "document" &&
      options.artifactKind !== "tool_trace" &&
      options.artifactKind !== "repository"
    ) {
      throw new Error(
        t(
          "ingest files artifact kind 必须是 document、tool_trace 或 repository",
          "ingest files artifact kind must be document, tool_trace, or repository"
        )
      );
    }
    if (
      options.redaction !== "secrets-only" &&
      options.redaction !== "secrets-and-pii"
    ) {
      throw new Error(
        t(
          "ingest redaction 必须是 secrets-only 或 secrets-and-pii",
          "ingest redaction must be secrets-only or secrets-and-pii"
        )
      );
    }
    if (
      options.artifactKind === "tool_trace" &&
      options.redaction !== "secrets-and-pii"
    ) {
      throw new Error(
        t(
          "ingest files 的 tool_trace 必须使用 secrets-and-pii 脱敏",
          "ingest files tool_trace requires secrets-and-pii redaction"
        )
      );
    }
    const connector = new FileSystemConnector({
      id: options.connectorId,
      baseDir: options.baseDir,
      patterns: options.pattern,
      artifactKind: options.artifactKind,
      projectKeys: options.projectKey,
      contentType: options.contentType
    });
    const root = resolveCliRoot(options.root);
    console.log(
      JSON.stringify(
        await runRegisteredConnectorIngestion(
          root,
          connector,
          {
            kind: "files",
            connectorId: options.connectorId,
            redactionPolicy: options.redaction,
            options: {
              baseDir: path.resolve(options.baseDir),
              patterns: options.pattern,
              artifactKind: options.artifactKind,
              projectKeys: options.projectKey,
              ...(options.contentType
                ? { contentType: options.contentType }
                : {})
            }
          },
          {
            vault: { key: configuredVaultKey(), actor: "ingest-files" },
            redactionPolicy: options.redaction,
            ...(options.limit === undefined
              ? {}
              : { limit: parseIngestionLimit(options.limit) })
          }
        ),
        null,
        2
      )
    );
  });

ingest
  .command("transcripts")
  .description(
    t(
      "摄入完整 Agent 会话 JSONL，并在入 Vault 前强制遮蔽 secret 与 PII",
      "Ingest complete Agent transcript JSONL with mandatory secret and PII redaction before Vault storage"
    )
  )
  .requiredOption("--connector-id <id>", t("稳定 Connector ID", "stable connector ID"))
  .requiredOption("--base-dir <dir>", t("只读 transcript 目录", "read-only transcript directory"))
  .option(
    "--pattern <glob...>",
    t("相对 base dir 的 glob", "globs relative to base dir"),
    ["**/*.jsonl"]
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--project-key <key>",
    t("绑定规范项目 key，可重复", "canonical project key; repeatable"),
    collectProjectKey,
    []
  )
  .option("--limit <count>", t("本次最多处理 source 数", "maximum sources in this run"))
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge ingest transcripts --connector-id trae-sessions --base-dir /secure/sessions --project-key github.com/example/business

边界：强制执行 secrets-and-pii 脱敏；完整会话只进入加密 Vault，不进入普通查询。`,
      `
Example:
  agent-knowledge ingest transcripts --connector-id trae-sessions --base-dir /secure/sessions --project-key github.com/example/business

Boundary: secrets-and-pii redaction is mandatory; complete sessions go to encrypted Vault and never enter ordinary queries.`
    )
  )
  .action(async (options: {
    connectorId: string;
    baseDir: string;
    pattern: string[];
    root?: string;
    projectKey: string[];
    limit?: string;
  }) => {
    const connector = createTranscriptConnector({
      id: options.connectorId,
      baseDir: options.baseDir,
      patterns: options.pattern,
      projectKeys: options.projectKey
    });
    const root = resolveCliRoot(options.root);
    console.log(
      JSON.stringify(
        await runRegisteredConnectorIngestion(
          root,
          connector,
          {
            kind: "transcripts",
            connectorId: options.connectorId,
            redactionPolicy: "secrets-and-pii",
            options: {
              baseDir: path.resolve(options.baseDir),
              patterns: options.pattern,
              projectKeys: options.projectKey
            }
          },
          {
            vault: {
              key: configuredVaultKey(),
              actor: "ingest-transcripts"
            },
            // transcript 默认含客户或用户原始输入，不允许降级为只遮蔽 secret。
            redactionPolicy: "secrets-and-pii",
            ...(options.limit === undefined
              ? {}
              : { limit: parseIngestionLimit(options.limit) })
          }
        ),
        null,
        2
      )
    );
  });

ingest
  .command("git")
  .description(
    t(
      "从本地 Git object database 摄入已提交仓库文档",
      "Ingest committed repository documents from the local Git object database"
    )
  )
  .requiredOption("--connector-id <id>", t("稳定 Connector ID", "stable connector ID"))
  .requiredOption("--repository <dir>", t("本地 Git 仓库目录", "local Git repository directory"))
  .requiredOption(
    "--pathspec <path...>",
    t(
      "一个或多个 Git pathspec，例如 README.md docs",
      "one or more Git pathspecs, such as README.md docs"
    )
  )
  .option("--ref <ref>", t("只读 Git ref/commit", "read-only Git ref or commit"), "HEAD")
  .option(
    "--project-key <key>",
    t(
      "无 origin remote 时必填的 local/... key",
      "required local/... key when origin remote is absent"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--redaction <policy>",
    t(
      "secrets-only 或 secrets-and-pii",
      "secrets-only or secrets-and-pii"
    ),
    "secrets-only"
  )
  .option("--limit <count>", t("本次最多处理 source 数", "maximum sources in this run"))
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge ingest git --connector-id business-repository --repository /projects/business --pathspec README.md docs
  agent-knowledge ingest git --connector-id business-repository --repository /projects/business --ref origin/main --pathspec docs

边界：只读取本地 committed blob（来自 Git object database），不读取 dirty/untracked 内容，也不会执行 fetch/pull。
首次摄入后，日常可用 agent-knowledge source refresh --connector-id business-repository。`,
      `
Examples:
  agent-knowledge ingest git --connector-id business-repository --repository /projects/business --pathspec README.md docs
  agent-knowledge ingest git --connector-id business-repository --repository /projects/business --ref origin/main --pathspec docs

Boundary: reads local committed blobs from the Git object database only; it ignores dirty/untracked content and never runs fetch/pull.
After first ingestion, use agent-knowledge source refresh --connector-id business-repository for daily updates.`
    )
  )
  .action(async (options: {
    connectorId: string;
    repository: string;
    pathspec: string[];
    ref: string;
    projectKey?: string;
    root?: string;
    redaction: string;
    limit?: string;
  }) => {
    if (
      options.redaction !== "secrets-only" &&
      options.redaction !== "secrets-and-pii"
    ) {
      throw new Error(
        t(
          "ingest redaction 必须是 secrets-only 或 secrets-and-pii",
          "ingest redaction must be secrets-only or secrets-and-pii"
        )
      );
    }
    const connector = new GitRepositoryConnector({
      id: options.connectorId,
      repositoryDir: options.repository,
      ref: options.ref,
      pathspecs: options.pathspec,
      projectKey: options.projectKey
    });
    const root = resolveCliRoot(options.root);
    console.log(
      JSON.stringify(
        await runRegisteredConnectorIngestion(
          root,
          connector,
          {
            kind: "git",
            connectorId: options.connectorId,
            redactionPolicy: options.redaction,
            options: {
              repositoryDir: path.resolve(options.repository),
              ref: options.ref,
              pathspecs: options.pathspec,
              ...(options.projectKey
                ? { projectKey: options.projectKey }
                : {})
            }
          },
          {
            vault: { key: configuredVaultKey(), actor: "ingest-git" },
            redactionPolicy: options.redaction,
            ...(options.limit === undefined
              ? {}
              : { limit: parseIngestionLimit(options.limit) })
          }
        ),
        null,
        2
      )
    );
  });

ingest
  .command("lark-export")
  .description(
    t(
      "从离线飞书递归导出摄入 versioned evidence",
      "Ingest versioned evidence from an offline Lark export"
    )
  )
  .requiredOption("--connector-id <id>", t("稳定 Connector ID", "stable connector ID"))
  .requiredOption(
    "--export-dir <dir>",
    t("包含 manifest.json 和 content.xml 的导出目录", "export directory containing manifest.json and content.xml")
  )
  .option(
    "--project-key <key>",
    t("绑定规范 project key，可重复", "canonical project key; repeatable"),
    collectProjectKey,
    []
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--limit <count>", t("本次最多处理 source 数；带 limit 时不做删除对账", "maximum sources; disables removal reconciliation when set"))
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge ingest lark-export --connector-id lark-business --export-dir /secure/exports/lark --project-key github.com/example/business

边界：只读取 offline export，不访问在线飞书。要识别在线更新，先显式刷新 export，再运行 source refresh。`,
      `
Example:
  agent-knowledge ingest lark-export --connector-id lark-business --export-dir /secure/exports/lark --project-key github.com/example/business

Boundary: reads the offline export only and never accesses online Lark. Refresh the export explicitly before source refresh to detect online changes.`
    )
  )
  .action(async (options: {
    connectorId: string;
    exportDir: string;
    projectKey: string[];
    root?: string;
    limit?: string;
  }) => {
    const connector = new LarkExportConnector({
      id: options.connectorId,
      exportDir: options.exportDir,
      projectKeys: options.projectKey
    });
    const root = resolveCliRoot(options.root);
    console.log(
      JSON.stringify(
        await runRegisteredConnectorIngestion(
          root,
          connector,
          {
            kind: "lark-export",
            connectorId: options.connectorId,
            redactionPolicy: "secrets-and-pii",
            options: {
              exportDir: path.resolve(options.exportDir),
              projectKeys: options.projectKey
            }
          },
          {
            vault: {
              key: configuredVaultKey(),
              actor: "ingest-lark-export"
            },
            // 飞书导出可能包含用户身份和客服材料，不允许降级为只遮蔽 secret。
            redactionPolicy: "secrets-and-pii",
            ...(options.limit === undefined
              ? {}
              : { limit: parseIngestionLimit(options.limit) })
          }
        ),
        null,
        2
      )
    );
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
  .option(
    "--project <key...>",
    t("允许的项目 key 或 alias", "allowed project keys or aliases")
  )
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
  .option(
    "--retain-task-evidence",
    t(
      "显式把经 secrets-and-pii 脱敏的任务文本加密写入 Vault",
      "explicitly redact and encrypt task text into the Vault"
    ),
    false
  )
  .option("--allow-remote-models", t("允许远程下载模型", "allow remote model downloads"), false)
  .action(async (options: {
    task: string;
    root?: string;
    domain?: string[];
    scenario?: string[];
    visibility?: string[];
    sensitivityClearance?: string;
    project?: string[];
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
    retainTaskEvidence: boolean;
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
    const projectKeys = await resolveQueryProjectKeys(root, options.project);
    const retainedTask = options.retainTaskEvidence
      ? await retainQueryTaskEvidence(root, options.task, {
          key: configuredVaultKey()
        })
      : undefined;
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? [],
      visibilityScopes,
      sensitivityClearance,
      projectKeys
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
        embeddingTopK,
        log: !options.rerank,
        taskVaultId: retainedTask?.vaultId
      });
    } else if (retrievalMode === "hybrid") {
      baseResult = await queryMemoriesHybridWithDebug(root, request, {
        embeddingProvider,
        embeddingTopK,
        log: !options.rerank,
        taskVaultId: retainedTask?.vaultId
      });
    } else {
      baseResult = queryMemoriesWithDebug(root, request, {
        log: !options.rerank,
        taskVaultId: retainedTask?.vaultId
      });
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
          rerankerWeight: configuredEmbeddings.rerankerModelWeight,
          taskVaultId: retainedTask?.vaultId
        })
      : baseResult;
    const packet = buildContextPacket({
      request,
      ranked,
      queryRun: { rootDir: root, queryRunId: debug.queryRunId }
    });
    console.log(
      JSON.stringify(
        options.debug
          ? {
              packet,
              debug,
              ...(retainedTask
                ? {
                    taskEvidence: {
                      vaultId: retainedTask.vaultId,
                      bytes: retainedTask.bytes,
                      redactionCounts: retainedTask.redactionCounts
                    }
                  }
                : {})
            }
          : retainedTask
            ? {
                packet,
                taskEvidence: {
                  vaultId: retainedTask.vaultId,
                  bytes: retainedTask.bytes,
                  redactionCounts: retainedTask.redactionCounts
                }
              }
            : packet,
        null,
        2
      )
    );
  });

program
  .command("feedback")
  .description(t("记录检索知识是否有用，不修改 Markdown 事实", "Log whether a retrieved memory was useful without modifying Markdown facts"))
  .option("--memory-id <id>", t("查询输出中的知识 ID", "knowledge id shown in query output"))
  .requiredOption("--usefulness <value>", t("useful、not_useful 或 neutral", "useful, not_useful, or neutral"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--query-run-id <id>", t("之前查询的 debug.queryRunId", "debug.queryRunId from a prior query"))
  .option(
    "--reason <reason>",
    t(
      "relevant、wrong_route、missing_expected、forbidden_injection、should_abstain、stale_source、insufficient_detail、conflicting_evidence、reasoning_failure 或 other",
      "structured feedback reason"
    )
  )
  .option(
    "--expected-memory-id <id...>",
    t("本次本应使用的知识 ID", "knowledge IDs that should have been used")
  )
  .option(
    "--forbidden-memory-id <id...>",
    t("本次不应注入的知识 ID", "knowledge IDs that should not have been injected")
  )
  .option("--task <task>", t("反馈关联的简短任务文本", "short task text associated with the feedback"))
  .option("--note <note>", t("可选备注，最多 500 字符", "optional feedback note, max 500 characters"))
  .action(
    (options: {
      memoryId?: string;
      usefulness: string;
      root?: string;
      queryRunId?: string;
      reason?: string;
      expectedMemoryId?: string[];
      forbiddenMemoryId?: string[];
      task?: string;
      note?: string;
    }) => {
      const result = logMemoryFeedback(resolveCliRoot(options.root), {
        memoryId: options.memoryId,
        usefulness: options.usefulness,
        reason: options.reason,
        queryRunId: options.queryRunId,
        expectedMemoryIds: options.expectedMemoryId ?? [],
        forbiddenMemoryIds: options.forbiddenMemoryId ?? [],
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

const knowledge = program
  .command("knowledge")
  .description(
    t(
      "审计和展开 V2 知识",
      "Audit and expand V2 knowledge"
    )
  );

knowledge
  .command("audit")
  .description(
    t(
      "检查正文、metadata、source、claim evidence 和 project key 质量",
      "Audit body, metadata, source, claim evidence, and project key quality"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--fail-on <severity>",
    t(
      "error、warning 或 never；命中后以状态码 2 退出",
      "error, warning, or never; exit with status 2 when matched"
    ),
    "never"
  )
  .action(async (options: { root?: string; failOn: string }) => {
    if (
      options.failOn !== "error" &&
      options.failOn !== "warning" &&
      options.failOn !== "never"
    ) {
      throw new Error("--fail-on must be error, warning, or never");
    }
    const report = await auditKnowledgeQuality(resolveCliRoot(options.root));
    console.log(JSON.stringify(report, null, 2));
    const shouldFail =
      options.failOn !== "never" &&
      report.findings.some(
        (finding) =>
          finding.severity === "error" ||
          (options.failOn === "warning" && finding.severity === "warning")
      );
    if (shouldFail) {
      process.exitCode = 2;
    }
  });

knowledge
  .command("show")
  .description(
    t(
      "显式展开 synopsis 或 knowledge 正文",
      "Explicitly expand synopsis or knowledge body"
    )
  )
  .argument("<knowledge-id>", t("知识 ID", "knowledge ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--layer <layer>",
    t("synopsis 或 knowledge", "synopsis or knowledge"),
    "knowledge"
  )
  .option("--project <key...>", t("允许的项目 key", "allowed project keys"))
  .option("--visibility <scope...>", t("允许的可见范围", "allowed visibility scopes"))
  .option(
    "--sensitivity-clearance <level>",
    t("敏感级别权限", "sensitivity clearance")
  )
  .action(async (
    knowledgeId: string,
    options: {
      root?: string;
      layer: string;
      project?: string[];
      visibility?: string[];
      sensitivityClearance?: string;
    }
  ) => {
    if (options.layer !== "synopsis" && options.layer !== "knowledge") {
      throw new Error("--layer must be synopsis or knowledge");
    }
    const root = resolveCliRoot(options.root);
    rebuildIndex(root);
    const projectKeys = await resolveQueryProjectKeys(root, options.project);
    console.log(
      JSON.stringify(
        expandKnowledge(root, {
          id: knowledgeId,
          layer: options.layer,
          request: {
            projectKeys,
            visibilityScopes: resolveVisibilityScopes(options.visibility),
            sensitivityClearance: resolveSensitivityClearance(
              options.sensitivityClearance
            )
          }
        }),
        null,
        2
      )
    );
  });

knowledge
  .command("evidence")
  .description(
    t(
      "显式展开 claim 的 source/section/hash evidence handle",
      "Explicitly expand source/section/hash evidence handles for a claim"
    )
  )
  .argument("<claim-id>", t("Claim ID", "Claim ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--project <key...>", t("允许的项目 key", "allowed project keys"))
  .option("--visibility <scope...>", t("允许的可见范围", "allowed visibility scopes"))
  .option(
    "--sensitivity-clearance <level>",
    t("敏感级别权限", "sensitivity clearance")
  )
  .action(async (
    claimId: string,
    options: {
      root?: string;
      project?: string[];
      visibility?: string[];
      sensitivityClearance?: string;
    }
  ) => {
    const root = resolveCliRoot(options.root);
    rebuildIndex(root);
    const projectKeys = await resolveQueryProjectKeys(root, options.project);
    console.log(
      JSON.stringify(
        await expandEvidence(root, {
          claimId,
          request: {
            projectKeys,
            visibilityScopes: resolveVisibilityScopes(options.visibility),
            sensitivityClearance: resolveSensitivityClearance(
              options.sensitivityClearance
            )
          }
        }),
        null,
        2
      )
    );
  });

const source = program
  .command("source")
  .description(
    t(
      "审阅 versioned source manifest 与完整 evidence",
      "Review versioned source manifests and complete evidence"
    )
  );

source.addHelpText(
  "after",
  t(
    `
推荐日常流程：
  1. agent-knowledge source refresh
  2. agent-knowledge source list --needs-review
  3. agent-knowledge source show <source-id>
  4. 使用 source-distiller 审阅并标记结果

边界：source check/refresh 都不会自动 fetch Git 远端或刷新在线飞书；应先显式更新本地 ref 或 offline export。`,
    `
Recommended daily workflow:
  1. agent-knowledge source refresh
  2. agent-knowledge source list --needs-review
  3. agent-knowledge source show <source-id>
  4. Review and mark results with source-distiller

Boundary: source check/refresh never fetch Git remotes or refresh online Lark automatically; update the local ref or offline export explicitly first.`
  )
);

source
  .command("list")
  .description(
    t(
      "列出 pending、stale、missing 或已处理 source",
      "List pending, stale, missing, or reviewed sources"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--status <status...>",
    t("按 processing status 过滤", "filter by processing status")
  )
  .option(
    "--availability <value>",
    t("available 或 missing", "available or missing")
  )
  .option(
    "--project <key...>",
    t("按规范 project key 过滤", "filter by canonical project key")
  )
  .option(
    "--needs-review",
    t("只看 pending、stale 或 missing", "show only pending, stale, or missing"),
    false
  )
  .action(async (options: {
    root?: string;
    status?: string[];
    availability?: string;
    project?: string[];
    needsReview: boolean;
  }) => {
    if (
      options.availability !== undefined &&
      options.availability !== "available" &&
      options.availability !== "missing"
    ) {
      throw new Error(
        t(
          "--availability 必须是 available 或 missing",
          "--availability must be available or missing"
        )
      );
    }
    console.log(
      JSON.stringify(
        await listSources(resolveCliRoot(options.root), {
          statuses: options.status,
          availability: options.availability,
          projectKeys: options.project,
          needsReview: options.needsReview
        }),
        null,
        2
      )
    );
  });

source
  .command("refresh")
  .description(
    t(
      "按登记执行检查 → 按需摄入 → 复查，无需重复填写 Connector scope",
      "Run check -> conditional ingestion -> recheck from registrations without repeating Connector scope"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--connector-id <id...>",
    t("只刷新指定的已登记 Connector", "refresh only selected registered Connectors")
  )
  .option(
    "--force",
    t(
      "即使 probe 未发现变化也强制运行 ingestion",
      "run ingestion even when probes report no change"
    ),
    false
  )
  .option(
    "--limit <count>",
    t(
      "每个 Connector 本次最多处理的 source 数；会禁用完整 inventory 删除对账",
      "maximum sources per Connector; disables complete-inventory removal reconciliation"
    )
  )
  .option(
    "--fail-on-error",
    t("任一 Connector 失败时以状态码 2 退出", "exit with status 2 when any Connector fails"),
    false
  )
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge source refresh
  agent-knowledge source refresh --connector-id lark-business business-repository
  agent-knowledge source refresh --connector-id business-docs --force

流程：检查 → 按需摄入 → 复查。无变化时不会读取 Vault key。
安全边界：不会自动 fetch Git 远端，也不会刷新在线飞书；请先显式更新本地 ref 或 offline export。
输出按 Connector 汇总；逐 source 详情使用 source check。`,
      `
Examples:
  agent-knowledge source refresh
  agent-knowledge source refresh --connector-id lark-business business-repository
  agent-knowledge source refresh --connector-id business-docs --force

Flow: check -> conditional ingestion -> recheck. The Vault key is not read when nothing changed.
Safety boundary: this never fetches Git remotes or refreshes online Lark; explicitly update the local ref or offline export first.
Output is summarized by Connector; use source check for per-source details.`
    )
  )
  .action(async (options: {
    root?: string;
    connectorId?: string[];
    force: boolean;
    limit?: string;
    failOnError: boolean;
  }) => {
    const root = resolveCliRoot(options.root);
    const registrations = await listConnectorRegistrations(root);
    const requested = new Set(options.connectorId ?? []);
    const selected =
      requested.size === 0
        ? registrations
        : registrations.filter((registration) =>
            requested.has(registration.connectorId)
          );
    const missing = [...requested].filter(
      (connectorId) =>
        !registrations.some(
          (registration) => registration.connectorId === connectorId
        )
    );
    const limit =
      options.limit === undefined
        ? undefined
        : parseIngestionLimit(options.limit);
    const results: Array<Record<string, unknown>> = missing.map(
      (connectorId) => ({
        connectorId,
        action: "error",
        error: "connector_not_registered"
      })
    );

    for (const registration of selected) {
      try {
        const connector = createConnectorFromRegistration(registration);
        const before = await checkConnectorSourceUpdates(
          root,
          connector,
          registration
        );
        const needsRefresh =
          options.force ||
          before.summary.updatesAvailable > 0 ||
          before.summary.verificationRequired > 0;
        if (!needsRefresh) {
          results.push({
            connectorId: registration.connectorId,
            action: "unchanged",
            check: summarizeRefreshCheck(before)
          });
          continue;
        }
        const ingestion = await runRegisteredConnectorIngestion(
          root,
          connector,
          connectorRegistrationInput(registration),
          {
            vault: {
              key: configuredVaultKey(),
              actor: refreshVaultActor(registration.kind)
            },
            redactionPolicy: registration.redactionPolicy,
            ...(limit === undefined ? {} : { limit })
          }
        );
        const currentRegistration = await readConnectorRegistration(
          root,
          registration.connectorId
        );
        if (!currentRegistration) {
          throw new Error(
            `Connector registration disappeared after refresh: ${registration.connectorId}`
          );
        }
        const after = await checkConnectorSourceUpdates(
          root,
          connector,
          currentRegistration
        );
        results.push({
          connectorId: registration.connectorId,
          action: "refreshed",
          before: summarizeRefreshCheck(before),
          ingestion: summarizeRefreshIngestion(ingestion),
          after: summarizeRefreshCheck(after)
        });
      } catch (error) {
        results.push({
          connectorId: registration.connectorId,
          action: "error",
          error: redactIngestionError(
            error,
            registration.redactionPolicy
          )
        });
      }
    }

    const summary = {
      connectors: selected.length,
      refreshed: results.filter((result) => result.action === "refreshed")
        .length,
      unchanged: results.filter((result) => result.action === "unchanged")
        .length,
      errors: results.filter((result) => result.action === "error").length
    };
    console.log(
      JSON.stringify(
        {
          networkAccess: "none",
          summary,
          results
        },
        null,
        2
      )
    );
    if (options.failOnError && summary.errors > 0) {
      process.exitCode = 2;
    }
  });

source
  .command("check")
  .description(
    t(
      "仅用本地/离线版本 probe 检查已登记 source 更新，不抓正文或写 Vault/manifest",
      "Check registered source updates using local/offline probes without fetching bodies or writing Vault/manifests"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option(
    "--connector-id <id...>",
    t("只检查指定的已登记 Connector", "check only selected registered Connectors")
  )
  .option(
    "--fail-on-updates",
    t(
      "有确定更新、待抓取确认或检查错误时以状态码 2 退出",
      "exit with status 2 when updates, required verification, or check errors exist"
    ),
    false
  )
  .addHelpText(
    "after",
    t(
      `
示例：
  agent-knowledge source check
  agent-knowledge source check --connector-id lark-business
  agent-knowledge source check --fail-on-updates

只检查本地 ref/offline export；若要自动执行必要的摄入和复查，请使用 source refresh。`,
      `
Examples:
  agent-knowledge source check
  agent-knowledge source check --connector-id lark-business
  agent-knowledge source check --fail-on-updates

Checks local refs/offline exports only; use source refresh to run required ingestion and recheck automatically.`
    )
  )
  .action(async (options: {
    root?: string;
    connectorId?: string[];
    failOnUpdates: boolean;
  }) => {
    const root = resolveCliRoot(options.root);
    const registrations = await listConnectorRegistrations(root);
    const requested = new Set(options.connectorId ?? []);
    const selected =
      requested.size === 0
        ? registrations
        : registrations.filter((registration) =>
            requested.has(registration.connectorId)
          );
    const missing = [...requested].filter(
      (connectorId) =>
        !registrations.some(
          (registration) => registration.connectorId === connectorId
        )
    );
    const reports = [];
    const errors: Array<{ connectorId: string; message: string }> = missing.map(
      (connectorId) => ({
        connectorId,
        message: "connector_not_registered"
      })
    );
    for (const registration of selected) {
      try {
        const connector = createConnectorFromRegistration(registration);
        reports.push(
          await checkConnectorSourceUpdates(
            root,
            connector,
            registration
          )
        );
      } catch (error) {
        errors.push({
          connectorId: registration.connectorId,
          message: redactIngestionError(
            error,
            registration.redactionPolicy
          )
        });
      }
    }
    const result = {
      networkAccess: "none" as const,
      freshnessNotice:
        "Git checks the registered local ref; Lark checks the registered offline export. Refresh upstream snapshots explicitly before checking remote freshness.",
      summary: {
        connectors: selected.length,
        updatesAvailable: reports.reduce(
          (sum, report) => sum + report.summary.updatesAvailable,
          0
        ),
        verificationRequired: reports.reduce(
          (sum, report) => sum + report.summary.verificationRequired,
          0
        ),
        errors: errors.length
      },
      reports,
      errors
    };
    console.log(JSON.stringify(result, null, 2));
    if (
      options.failOnUpdates &&
      (result.summary.updatesAvailable > 0 ||
        result.summary.verificationRequired > 0 ||
        result.summary.errors > 0)
    ) {
      process.exitCode = 2;
    }
  });

source
  .command("show")
  .description(
    t(
      "显示 source metadata、section heading/hash/range 和当前 fingerprint",
      "Show source metadata, section heading/hash/range, and current fingerprint"
    )
  )
  .argument("<source-id>", t("Source ID", "Source ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (sourceId: string, options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await showSource(resolveCliRoot(options.root), sourceId),
        null,
        2
      )
    );
  });

source
  .command("export")
  .description(
    t(
      "把当前版本完整 evidence 解密到显式 0600 文件",
      "Decrypt the current source evidence to an explicit 0600 file"
    )
  )
  .argument("<source-id>", t("Source ID", "Source ID"))
  .requiredOption(
    "--fingerprint <sha256>",
    t("source show 返回的 current fingerprint", "current fingerprint returned by source show")
  )
  .requiredOption("--output <file>", t("解密输出文件", "decrypted output file"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--overwrite", t("允许覆盖已有文件", "allow overwriting an existing file"), false)
  .action(async (
    sourceId: string,
    options: {
      fingerprint: string;
      output: string;
      root?: string;
      overwrite: boolean;
    }
  ) => {
    console.log(
      JSON.stringify(
        await exportSourceEvidence(
          resolveCliRoot(options.root),
          {
            sourceId,
            expectedFingerprint: options.fingerprint,
            outputPath: options.output,
            overwrite: options.overwrite
          },
          { key: configuredVaultKey(), actor: "source-export" }
        ),
        null,
        2
      )
    );
  });

source
  .command("mark")
  .description(
    t(
      "用当前 fingerprint 标记 source 审阅结果",
      "Mark the source review result using the current fingerprint"
    )
  )
  .argument("<source-id>", t("Source ID", "Source ID"))
  .requiredOption(
    "--fingerprint <sha256>",
    t("source show 返回的 current fingerprint", "current fingerprint returned by source show")
  )
  .requiredOption(
    "--review-token <token>",
    t("source show 返回的 review token", "review token returned by source show")
  )
  .requiredOption(
    "--status <status>",
    t(
      "refined、duplicate、obsolete、no_long_term_value 或 blocked",
      "refined, duplicate, obsolete, no_long_term_value, or blocked"
    )
  )
  .option("--reason <reason>", t("可审计且不含敏感原值的原因", "auditable reason without sensitive raw values"))
  .option(
    "--knowledge-id <id...>",
    t("refined 时必填的 active knowledge ID", "active knowledge IDs required for refined")
  )
  .option(
    "--duplicate-of <source-id>",
    t("duplicate 时必填的规范 source ID", "canonical source ID required for duplicate")
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .addHelpText(
    "after",
    t(
      `
状态要求：
  - refined 需要 active knowledge，且 current claim anchor 指向该 source
  - duplicate 需要 --duplicate-of <source-id>
  - obsolete、blocked、no_long_term_value 需要不含敏感原值的 --reason

示例：
  agent-knowledge source mark src_example --fingerprint <sha256> --review-token <token> --status refined --knowledge-id k_example`,
      `
Status requirements:
  - refined requires active knowledge with a current claim anchor to this source
  - duplicate requires --duplicate-of <source-id>
  - obsolete, blocked, and no_long_term_value require --reason without sensitive raw values

Example:
  agent-knowledge source mark src_example --fingerprint <sha256> --review-token <token> --status refined --knowledge-id k_example`
    )
  )
  .action(async (
    sourceId: string,
    options: {
      fingerprint: string;
      reviewToken: string;
      status: string;
      reason?: string;
      knowledgeId?: string[];
      duplicateOf?: string;
      root?: string;
    }
  ) => {
    console.log(
      JSON.stringify(
        await markSourceReviewed(resolveCliRoot(options.root), {
          sourceId,
          expectedFingerprint: options.fingerprint,
          expectedReviewToken: options.reviewToken,
          status: options.status,
          reason: options.reason,
          duplicateOf: options.duplicateOf,
          knowledgeIds: options.knowledgeId
        }),
        null,
        2
      )
    );
  });

const event = program
  .command("event")
  .description(
    t(
      "记录和查询客服 case / 需求 initiative 的 append-only 时间线",
      "Record and query append-only support case and initiative timelines"
    )
  );

event
  .command("append")
  .description(
    t(
      "追加脱敏 timeline metadata，并把完整 payload 加密写入 Vault",
      "Append redacted timeline metadata and encrypt the complete payload in Vault"
    )
  )
  .requiredOption("--stream-type <type>", t("support 或 initiative", "support or initiative"))
  .requiredOption("--stream-id <id>", t("稳定 case/initiative ID", "stable case or initiative ID"))
  .requiredOption("--stage <stage>", t("当前生命周期阶段", "lifecycle stage"))
  .requiredOption("--event-type <type>", t("稳定事件类型", "stable event type"))
  .requiredOption("--summary <text>", t("可审阅摘要；敏感原值会被遮蔽", "reviewable summary; sensitive raw values are redacted"))
  .option("--payload <file>", t("完整 payload 本地文件；不从 CLI 文本读取", "local complete payload file; not read from CLI text"))
  .option("--content-type <type>", t("payload MIME 类型", "payload MIME type"))
  .option("--project-key <key...>", t("规范 project key，可多个", "canonical project keys"))
  .option("--actor-type <type>", t("owner、teammate、customer 或 agent", "owner, teammate, customer, or agent"), "agent")
  .option("--capture-mode <mode>", t("direct_material、verified_task、automated_session 或 explicit_remember", "direct_material, verified_task, automated_session, or explicit_remember"), "automated_session")
  .option("--parent-event-id <id>", t("同 stream 中的父事件 ID", "parent event ID in the same stream"))
  .option("--idempotency-key <key>", t("上游稳定事件 key，用于安全重试", "stable upstream event key for safe retries"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .addHelpText(
    "after",
    t(
      `
support 阶段：
  intake, triage, query, hypothesis, root_cause, action,
  verification, escalation, closure, recurrence

initiative 阶段：
  discovery, review, design, development, testing, release,
  operations, incident, retrospective, cancelled

示例：
  agent-knowledge event append --stream-type support --stream-id case_ticket_123 \
    --stage intake --event-type customer_question --summary "客户反馈登录失败" \
    --payload /secure/tmp/message.json --content-type application/json \
    --idempotency-key message_987

安全边界：完整 payload 只从文件读取，经脱敏后进入 Vault；Git timeline 只保存脱敏摘要。`,
      `
Support stages:
  intake, triage, query, hypothesis, root_cause, action,
  verification, escalation, closure, recurrence

Initiative stages:
  discovery, review, design, development, testing, release,
  operations, incident, retrospective, cancelled

Example:
  agent-knowledge event append --stream-type support --stream-id case_ticket_123 \
    --stage intake --event-type customer_question --summary "customer reports login failure" \
    --payload /secure/tmp/message.json --content-type application/json \
    --idempotency-key message_987

Safety boundary: complete payloads are read from files only, redacted, and stored in Vault; the Git timeline keeps redacted summaries only.`
    )
  )
  .action(async (options: {
    streamType: string;
    streamId: string;
    stage: string;
    eventType: string;
    summary: string;
    payload?: string;
    contentType?: string;
    projectKey?: string[];
    actorType: string;
    captureMode: string;
    parentEventId?: string;
    idempotencyKey?: string;
    root?: string;
  }) => {
    if (Boolean(options.payload) !== Boolean(options.contentType)) {
      throw new Error(
        t(
          "--payload 与 --content-type 必须同时提供",
          "--payload and --content-type must be provided together"
        )
      );
    }
    const payloadText = options.payload
      ? await readFile(path.resolve(options.payload), "utf8")
      : undefined;
    console.log(
      JSON.stringify(
        await appendLifecycleEvent(
          resolveCliRoot(options.root),
          {
            streamType: options.streamType as "support" | "initiative",
            streamId: options.streamId,
            stage: options.stage as never,
            eventType: options.eventType,
            summary: options.summary,
            payloadText,
            payloadContentType: options.contentType,
            projectKeys: options.projectKey ?? [],
            actorType: options.actorType as never,
            captureMode: options.captureMode as never,
            parentEventId: options.parentEventId,
            idempotencyKey: options.idempotencyKey
          },
          { key: configuredVaultKey(), actor: "event-append" }
        ),
        null,
        2
      )
    );
  });

event
  .command("list")
  .description(t("列出客服 case / initiative stream 摘要", "List support case and initiative stream summaries"))
  .option("--stream-type <type>", t("support 或 initiative", "support or initiative"))
  .option("--status <status>", t("active、closed、completed 或 cancelled", "active, closed, completed, or cancelled"))
  .option("--project-key <key...>", t("按规范 project key 过滤", "filter by canonical project keys"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: {
    streamType?: string;
    status?: string;
    projectKey?: string[];
    root?: string;
  }) => {
    console.log(
      JSON.stringify(
        await listEventStreams(resolveCliRoot(options.root), {
          streamType: options.streamType,
          status: options.status,
          projectKeys: options.projectKey
        }),
        null,
        2
      )
    );
  });

event
  .command("timeline")
  .description(t("读取并验证单个 case/initiative hash chain", "Read and verify one case or initiative hash chain"))
  .argument("<stream-type>", t("support 或 initiative", "support or initiative"))
  .argument("<stream-id>", t("Case/initiative ID", "case or initiative ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (
    streamType: string,
    streamId: string,
    options: { root?: string }
  ) => {
    console.log(
      JSON.stringify(
        await getEventTimeline(
          resolveCliRoot(options.root),
          streamType,
          streamId
        ),
        null,
        2
      )
    );
  });

event
  .command("show")
  .description(t("显示事件 metadata 和 payload handle，不读取完整 payload", "Show event metadata and payload handle without reading the complete payload"))
  .argument("<event-id>", t("Event ID", "Event ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (eventId: string, options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await showLifecycleEvent(resolveCliRoot(options.root), eventId),
        null,
        2
      )
    );
  });

event
  .command("export")
  .description(t("解密事件完整 payload 到 workspace 外 0600 文件", "Decrypt the complete event payload to a 0600 file outside the workspace"))
  .argument("<event-id>", t("Event ID", "Event ID"))
  .requiredOption("--output <file>", t("解密输出文件", "decrypted output file"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--overwrite", t("允许覆盖已有文件", "allow overwriting an existing file"), false)
  .action(async (
    eventId: string,
    options: { output: string; root?: string; overwrite: boolean }
  ) => {
    console.log(
      JSON.stringify(
        await exportEventPayload(
          resolveCliRoot(options.root),
          {
            eventId,
            outputPath: options.output,
            overwrite: options.overwrite
          },
          { key: configuredVaultKey(), actor: "event-export" }
        ),
        null,
        2
      )
    );
  });

event
  .command("status")
  .description(t("汇总事件流、事件数和状态，不输出内容", "Summarize streams, events, and statuses without content"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await getEventLedgerStatus(resolveCliRoot(options.root)),
        null,
        2
      )
    );
  });

program
  .command("write-candidate")
  .description(t("把单个候选 JSON 安全写入 knowledge/_inbox", "Safely write one candidate JSON into knowledge/_inbox"))
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
  .description(t("使用显式 WebDAV 参数执行一次 Markdown 同步", "Run one Markdown sync with explicit WebDAV options"))
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
  .description(t("使用显式 S3 参数执行一次 Markdown 同步", "Run one Markdown sync with explicit S3 options"))
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
  .description(t("汇总待消费 staging 事件，不输出原始正文", "Summarize pending staging events without raw content"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(JSON.stringify(await getStagingStatus(resolveCliRoot(options.root)), null, 2));
  });

staging
  .command("drain")
  .description(t("消费有界 staging 事件供显式维护流程使用", "Drain bounded staging events for explicit maintenance workflows"))
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
  .description(t("汇总本地 Subagent 日志状态", "Summarize local Subagent log status"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { root?: string }) => {
    console.log(
      JSON.stringify(await getSubagentLogStatus(resolveCliRoot(options.root)), null, 2)
    );
  });

subagents
  .command("logs")
  .description(t("读取本地详细 Subagent 调试日志", "Read local detailed Subagent debug logs"))
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

const automation = program
  .command("automation")
  .description(
    t(
      "运行有界来源刷新、审计、维护和评测任务",
      "Run bounded source refresh, audit, maintenance, and evaluation jobs"
    )
  );

automation
  .command("validate")
  .description(t("严格校验后台自动化 profile", "Strictly validate a background automation profile"))
  .requiredOption("--profile <file>", t("Automation profile JSON", "Automation profile JSON"))
  .action(async (options: { profile: string }) => {
    const profile = await readAutomationProfile(options.profile);
    console.log(
      JSON.stringify(
        {
          valid: true,
          profileId: profile.id,
          knowledgeRoot: profile.knowledgeRoot,
          sources: profile.sources.length,
          callbackConfigured: profile.callback !== undefined
        },
        null,
        2
      )
    );
  });

automation
  .command("inspect")
  .description(t("只读展开 automation 执行计划", "Expand the automation execution plan without running it"))
  .requiredOption("--profile <file>", t("Automation profile JSON", "Automation profile JSON"))
  .action(async (options: { profile: string }) => {
    console.log(
      JSON.stringify(
        await inspectAutomation(await readAutomationProfile(options.profile), {
          packageRoot: findPackageRoot()
        }),
        null,
        2
      )
    );
  });

automation
  .command("run")
  .description(t("执行有界 automation 并写通知 outbox", "Run bounded automation and write the notification outbox"))
  .requiredOption("--profile <file>", t("Automation profile JSON", "Automation profile JSON"))
  .option("--idempotency-key <key>", t("调度窗口或外部任务 ID", "scheduler window or external job ID"))
  .option(
    "--no-deliver",
    t(
      "本轮不投递 callback，只保留本地通知",
      "keep notifications local without callback delivery"
    )
  )
  .addHelpText(
    "after",
    t(
      `
安全边界：
  只访问 profile allowlist 中的 Lark roots 和 Git refs。
  只写 source/Vault/.memory/proposal/notification，不批准 inbox、不安装 Skill、不修改 active knowledge。
  需要语义确认时由后台 Agent 读取 notification outbox 后一次汇总提问。`,
      `
Safety boundaries:
  Only Lark roots and Git refs explicitly allowlisted by the profile are accessed.
  The job writes source/Vault/.memory/proposal/notification state only; it never approves inbox items, installs Skills, or modifies active knowledge.
  A background agent should batch semantic questions after reading the notification outbox.`
    )
  )
  .action(
    async (options: {
      profile: string;
      idempotencyKey?: string;
      deliver: boolean;
    }) => {
      const profile = await readAutomationProfile(options.profile);
      const result = await runAutomation(profile, {
        idempotencyKey: options.idempotencyKey,
        packageRoot: findPackageRoot()
      });
      const delivery =
        options.deliver &&
        profile.tasks.deliverNotifications &&
        profile.callback
          ? await deliverNotifications(profile.knowledgeRoot, profile.callback)
          : null;
      console.log(JSON.stringify({ result, delivery }, null, 2));
    }
  );

automation
  .command("status")
  .description(t("显示 profile 的最近 automation jobs", "Show recent automation jobs for a profile"))
  .requiredOption("--profile <file>", t("Automation profile JSON", "Automation profile JSON"))
  .option("--limit <count>", t("最大 job 数", "maximum jobs"), "20")
  .action(async (options: { profile: string; limit: string }) => {
    const profile = await readAutomationProfile(options.profile);
    const jobs = await listAutomationJobs(profile.knowledgeRoot, {
      profileId: profile.id
    });
    console.log(
      JSON.stringify(
        { profileId: profile.id, jobs: jobs.slice(0, Number.parseInt(options.limit, 10)) },
        null,
        2
      )
    );
  });

const automationService = automation
  .command("service")
  .description(
    t(
      "渲染外部 Agent CLI 的常驻服务模板",
      "Render background service templates for an external Agent CLI"
    )
  );

automationService
  .command("render")
  .description(
    t(
      "生成 launchd、systemd 或 Docker 文件，不自动安装",
      "Generate launchd, systemd, or Docker files without installing them"
    )
  )
  .requiredOption(
    "--manager <manager>",
    t("launchd、systemd 或 docker", "launchd, systemd, or docker")
  )
  .requiredOption("--label <label>", t("安全服务标签", "safe service label"))
  .requiredOption(
    "--profile <file>",
    t("Automation profile 绝对路径", "absolute automation profile path")
  )
  .requiredOption(
    "--runner <file>",
    t("外部 Agent wrapper 绝对路径", "absolute external Agent wrapper path")
  )
  .requiredOption(
    "--interval-minutes <minutes>",
    t("执行间隔分钟数", "execution interval in minutes")
  )
  .requiredOption(
    "--output <dir>",
    t("生成文件目录", "generated file directory")
  )
  .option(
    "--workspace <dir>",
    t("Docker 需要的知识库绝对路径", "absolute knowledge workspace required by Docker")
  )
  .option(
    "--system-prompt <file>",
    t("覆盖系统提示词绝对路径", "override the absolute system prompt path")
  )
  .option(
    "--environment-file <file>",
    t(
      "可选凭据/运行环境文件绝对路径",
      "optional absolute credentials/runtime environment file"
    )
  )
  .option(
    "--container-image <image>",
    t(
      "Docker 必需：已安装 agent-knowledge 和外部 Agent CLI 的固定版本镜像",
      "required for Docker: pinned image containing agent-knowledge and the external Agent CLI"
    )
  )
  .option(
    "--container-readonly-mount <path...>",
    t(
      "Docker 额外只读同路径挂载，如 eval 和 sidecar config 目录",
      "extra read-only same-path Docker mounts, such as eval and sidecar config directories"
    )
  )
  .option(
    "--container-readwrite-mount <path...>",
    t(
      "Docker 额外可写同路径挂载，如需 fetch 的 Git repo、Lark export 和 report 目录",
      "extra writable same-path Docker mounts for Git fetch, Lark exports, and reports"
    )
  )
  .addHelpText(
    "after",
    t(
      `
命令只生成模板并返回 install/uninstall 命令，不会调用 launchctl、systemctl 或 docker。
Runner wrapper 契约见 templates/automation/runner-contract.md。`,
      `
This command only renders files and returns install/uninstall commands. It never invokes launchctl, systemctl, or Docker.
See templates/automation/runner-contract.md for the wrapper contract.`
    )
  )
  .action(
    async (options: {
      manager: string;
      label: string;
      profile: string;
      runner: string;
      intervalMinutes: string;
      output: string;
      workspace?: string;
      systemPrompt?: string;
      environmentFile?: string;
      containerImage?: string;
      containerReadonlyMount?: string[];
      containerReadwriteMount?: string[];
    }) => {
      if (
        options.manager !== "launchd" &&
        options.manager !== "systemd" &&
        options.manager !== "docker"
      ) {
        throw new Error("--manager must be launchd, systemd, or docker");
      }
      console.log(
        JSON.stringify(
          await renderAutomationService({
            manager: options.manager,
            label: options.label,
            profilePath: options.profile,
            runnerPath: options.runner,
            intervalMinutes: Number.parseInt(options.intervalMinutes, 10),
            outputDir: options.output,
            workspacePath: options.workspace,
            systemPromptPath: options.systemPrompt,
            environmentFilePath: options.environmentFile,
            containerImage: options.containerImage,
            containerReadOnlyMountPaths: options.containerReadonlyMount ?? [],
            containerReadWriteMountPaths:
              options.containerReadwriteMount ?? []
          }),
          null,
          2
        )
      );
    }
  );

const notifications = program
  .command("notifications")
  .description(
    t(
      "查看、投递和确认后台通知 outbox",
      "Inspect, deliver, and acknowledge the background notification outbox"
    )
  );

notifications
  .command("list")
  .description(t("列出本地通知", "List local notifications"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--status <status>", t("按 pending、delivered、failed、acked 过滤", "filter by pending, delivered, failed, or acked"))
  .action(async (options: { root?: string; status?: string }) => {
    const items = await listNotifications(resolveCliRoot(options.root));
    console.log(
      JSON.stringify(
        options.status
          ? items.filter((item) => item.status === options.status)
          : items,
        null,
        2
      )
    );
  });

notifications
  .command("enqueue")
  .description(
    t(
      "从 JSON 文件写入一个去重通知",
      "Enqueue one deduplicated notification from a JSON file"
    )
  )
  .requiredOption(
    "--input <file>",
    t("通知 JSON 文件", "notification JSON file")
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { input: string; root?: string }) => {
    console.log(
      JSON.stringify(
        await enqueueNotification(
          resolveCliRoot(options.root),
          JSON.parse(await readFile(options.input, "utf8"))
        ),
        null,
        2
      )
    );
  });

notifications
  .command("show")
  .description(t("显示单个通知", "Show one notification"))
  .argument("<notification-id>", t("Notification ID", "Notification ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (notificationId: string, options: { root?: string }) => {
    const notification = await readNotification(
      resolveCliRoot(options.root),
      notificationId
    );
    if (!notification) {
      throw new Error(`Notification not found: ${notificationId}`);
    }
    console.log(JSON.stringify(notification, null, 2));
  });

notifications
  .command("deliver")
  .description(t("按 profile callback 投递待处理通知", "Deliver pending notifications using a profile callback"))
  .requiredOption("--profile <file>", t("Automation profile JSON", "Automation profile JSON"))
  .action(async (options: { profile: string }) => {
    const profile = await readAutomationProfile(options.profile);
    if (!profile.callback) {
      throw new Error("Automation profile does not configure a callback");
    }
    console.log(
      JSON.stringify(
        await deliverNotifications(profile.knowledgeRoot, profile.callback),
        null,
        2
      )
    );
  });

notifications
  .command("ack")
  .description(t("确认一个通知已处理", "Acknowledge a notification as handled"))
  .argument("<notification-id>", t("Notification ID", "Notification ID"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (notificationId: string, options: { root?: string }) => {
    console.log(
      JSON.stringify(
        await ackNotification(resolveCliRoot(options.root), notificationId),
        null,
        2
      )
    );
  });

const sidecar = program
  .command("sidecar")
  .description(
    t(
      "管理 Hindsight、memU、Mem0 shadow sidecar 与对比评测",
      "Manage Hindsight, memU, and Mem0 shadow sidecars and comparisons"
    )
  );

sidecar
  .command("init")
  .description(t("生成可编辑的 sidecar 配置", "Create an editable sidecar configuration"))
  .requiredOption(
    "--provider <provider>",
    t("hindsight、memu 或 mem0", "hindsight, memu, or mem0")
  )
  .requiredOption("--id <id>", t("Sidecar 稳定 ID", "stable sidecar ID"))
  .requiredOption("--base-url <url>", t("Sidecar base URL", "Sidecar base URL"))
  .requiredOption("--scope <scope>", t("隔离 bank/user scope", "isolated bank/user scope"))
  .requiredOption("--output <file>", t("输出配置 JSON", "output configuration JSON"))
  .action(
    async (options: {
      provider: string;
      id: string;
      baseUrl: string;
      scope: string;
      output: string;
    }) => {
      const provider = SidecarProviderSchema.parse(options.provider);
      const config = createSidecarPreset(provider, {
        id: options.id,
        baseUrl: options.baseUrl,
        scope: options.scope
      });
      const output = await writeSidecarConfig(options.output, config);
      console.log(JSON.stringify({ output, config }, null, 2));
    }
  );

/** setup/scaffold 共享参数和安全说明；旧 scaffold 保留为兼容入口。 */
const configureSidecarScaffold = (
  command: Command,
  description: { zh: string; en: string }
): Command =>
  command
  .description(t(description.zh, description.en))
  .requiredOption(
    "--provider <provider>",
    t("hindsight、memu 或 mem0", "hindsight, memu, or mem0")
  )
  .requiredOption("--output <dir>", t("输出目录", "output directory"))
  .option("--id <id>", t("Sidecar 稳定 ID", "stable sidecar ID"))
  .option("--scope <scope>", t("隔离 bank/user scope", "isolated bank/user scope"))
  .option("--base-url <url>", t("覆盖 Sidecar base URL", "override the sidecar base URL"))
  .addHelpText(
    "after",
    t(
      `
生成 owner-only sidecar.json 与 provider 部署/环境骨架，但不拉镜像、不启动服务、不写真实凭据。
Hindsight/Mem0 启动前必须在 .env 固定上游 image 版本；memU 需要在安全环境注入 MEMU_API_KEY。`,
      `
Generates an owner-only sidecar.json and provider deployment/environment scaffolding without pulling images, starting services, or writing credentials.
Pin the Hindsight/Mem0 image before startup; inject MEMU_API_KEY from a secure environment for memU.`
    )
  )
  .action(async (options: {
    provider: string;
    output: string;
    id?: string;
    scope?: string;
    baseUrl?: string;
  }) => {
    console.log(
      JSON.stringify(
        await scaffoldSidecar(
          SidecarProviderSchema.parse(options.provider),
          options.output,
          {
            id: options.id,
            scope: options.scope,
            baseUrl: options.baseUrl
          }
        ),
        null,
        2
      )
    );
  });

configureSidecarScaffold(sidecar.command("setup"), {
  zh: "一条命令生成可编辑配置与 provider 接入包，不自动启动",
  en: "Generate an editable configuration and provider setup bundle without starting it"
});

configureSidecarScaffold(sidecar.command("scaffold"), {
  zh: "兼容入口：生成 provider 部署/配置骨架，不自动启动",
  en: "Compatibility entrypoint for provider deployment/configuration scaffolding"
});

sidecar
  .command("doctor")
  .description(t("探测 sidecar HTTP 能力", "Probe sidecar HTTP capabilities"))
  .requiredOption("--config <file>", t("Sidecar 配置", "sidecar configuration"))
  .action(async (options: { config: string }) => {
    console.log(
      JSON.stringify(
        await doctorSidecar(await readSidecarConfig(options.config)),
        null,
        2
      )
    );
  });

sidecar
  .command("shadow-ingest")
  .description(
    t(
      "把显式 JSON/JSONL 输入发送到 shadow sidecar",
      "Send explicit JSON/JSONL input to a shadow sidecar"
    )
  )
  .requiredOption("--config <file>", t("Sidecar 配置", "sidecar configuration"))
  .requiredOption("--input <file>", t("包含 id/text/metadata 的 JSON 或 JSONL", "JSON or JSONL with id/text/metadata"))
  .option("--root <dir>", t("保存 sidecar run 的 workspace", "workspace for sidecar run artifacts"))
  .action(async (options: { config: string; input: string; root?: string }) => {
    console.log(
      JSON.stringify(
        await ingestSidecarItems(
          await readSidecarConfig(options.config),
          await readSidecarItems(options.input),
          { rootDir: resolveCliRoot(options.root) }
        ),
        null,
        2
      )
    );
  });

sidecar
  .command("search")
  .description(t("执行单次 shadow sidecar 查询", "Run one shadow sidecar query"))
  .requiredOption("--config <file>", t("Sidecar 配置", "sidecar configuration"))
  .requiredOption("--query <text>", t("查询文本", "query text"))
  .option("--root <dir>", t("保存 sidecar run 的 workspace", "workspace for sidecar run artifacts"))
  .action(async (options: { config: string; query: string; root?: string }) => {
    console.log(
      JSON.stringify(
        await searchSidecar(
          await readSidecarConfig(options.config),
          options.query,
          { rootDir: resolveCliRoot(options.root) }
        ),
        null,
        2
      )
    );
  });

sidecar
  .command("compare")
  .description(
    t(
      "用同一 eval 对比 native lexical 与多个 sidecar",
      "Compare native lexical retrieval and multiple sidecars on one eval suite"
    )
  )
  .requiredOption("--config <file...>", t("一个或多个 sidecar 配置", "one or more sidecar configurations"))
  .requiredOption("--eval <file>", t("Eval YAML", "Eval YAML"))
  .requiredOption("--output <dir>", t("JSON/Markdown 报告目录", "JSON/Markdown report directory"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .addHelpText(
    "after",
    t(
      `
Sidecar 始终是 shadow-only。只有外部结果显式携带 native_memory_id 才参与 expected/forbidden ID 指标；
未映射文本单独统计，仍会影响 abstention failure。`,
      `
Sidecars are always shadow-only. External results participate in expected/forbidden ID metrics only when they explicitly carry native_memory_id.
Unmapped text is counted separately and still affects abstention failure.`
    )
  )
  .action(
    async (options: {
      config: string[];
      eval: string;
      output: string;
      root?: string;
    }) => {
      const root = resolveCliRoot(options.root);
      const suite = await loadEvalSuite(options.eval);
      const configs = await Promise.all(
        options.config.map((file) => readSidecarConfig(file))
      );
      const report = await compareSidecars({
        rootDir: root,
        cases: suite.cases,
        configs,
        outputDir: options.output,
        nativeSearch: async (task, evalCase) => {
          const started = performance.now();
          const request = MemoryQueryRequestSchema.parse({
            task,
            agentRole: "main",
            domains: evalCase.domains,
            scenarios: evalCase.scenarios,
            projectKeys: evalCase.project_keys ?? [],
            maxTokens: evalCase.max_tokens ?? 4500,
            now: evalCase.now ?? new Date().toISOString().slice(0, 10),
            visibilityScopes: resolveVisibilityScopes(),
            sensitivityClearance: resolveSensitivityClearance()
          });
          const { ranked } = queryMemoriesWithDebug(root, request, {
            log: false
          });
          const packet = buildContextPacket({ request, ranked });
          return {
            ids: [
              ...packet.claims,
              ...packet.procedures,
              ...packet.principles,
              ...packet.episodes
            ].map((item) => item.id),
            latencyMs: performance.now() - started
          };
        }
      });
      console.log(JSON.stringify(report, null, 2));
    }
  );

sidecar
  .command("history")
  .description(
    t(
      "读取历次 native/sidecar 比较指标",
      "Read historical native/sidecar comparison metrics"
    )
  )
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--limit <count>", t("最多返回多少次比较", "maximum comparisons to return"), "50")
  .action(async (options: { root?: string; limit: string }) => {
    console.log(
      JSON.stringify(
        await readSidecarComparisonHistory(resolveCliRoot(options.root), {
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
  .description(t("汇总 observation 和 maintenance watermark 状态", "Summarize observation and maintenance watermark status"))
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
  .description(t("显示单个 maintenance proposal", "Show one maintenance proposal"))
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
  .description(t("接受 proposal 并写入知识或 Skill inbox", "Accept a proposal into the knowledge or Skill inbox"))
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
  .description(t("拒绝 proposal 并记录原因", "Reject a proposal and record the reason"))
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
  .description(t("探测并登记当前目录的规范 project key", "Detect and register the canonical project key for a directory"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .option("--cwd <dir>", t("要检查的目录", "directory to inspect"), process.cwd())
  .option(
    "--project-key <key>",
    t("无 Git remote 时使用的显式 local project key", "explicit local project key when no Git remote exists")
  )
  .action(async (options: { root?: string; cwd: string; projectKey?: string }) => {
    console.log(
      JSON.stringify(
        await detectProject(resolveCliRoot(options.root), options.cwd, {
          projectKey: options.projectKey
        }),
        null,
        2
      )
    );
  });

const graph = program
  .command("graph")
  .description(t("构建、查询和导出知识关系图", "Build, query, and export the knowledge graph"));

graph
  .command("build")
  .description(t("从当前知识和 proposal 重建关系图", "Rebuild the relationship graph from current knowledge and proposals"))
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
  .description(t("按文本或节点 ID 查询有限深度子图", "Query a bounded-depth subgraph by text or node ID"))
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
  .description(t("把当前关系图导出为 JSON、Mermaid 或离线 HTML", "Export the graph as JSON, Mermaid, or offline HTML"))
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
  .description(t("结构化安装 hooks、agents、skills 或 plugin bundle", "Structurally install hooks, agents, skills, or a plugin bundle"))
  .option("--product <product>", t("trae、trae-cn、claude-code 或 codex", "trae, trae-cn, claude-code, or codex"))
  .option("--scope <scope>", t("user 或 project", "user or project"))
  .option("--components <components>", t("逗号分隔的 hooks,agents,skills,plugin-bundle", "comma-separated hooks,agents,skills,plugin-bundle"))
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .option("--mode <mode>", t("merge 或 overwrite", "merge or overwrite"))
  .option("--overwrite", t("覆盖目标文件和 symlink", "replace target files and symlinks"), false)
  .option("--debug", t("输出完整 JSON", "emit the full JSON result"), false)
  .addHelpText(
    "after",
    t(
      `
产品默认值：
  TRAE / TRAE CN / Claude Code 默认安装 hooks,agents,skills。
  Codex 默认安装 hooks,skills，不支持 standalone agents。

Codex 路径：
  Hooks:  ~/.codex/hooks.json 或 <repo>/.codex/hooks.json
  Skills: ~/.agents/skills 或 <repo>/.agents/skills

Codex plugin 模式：
  agent-knowledge integration install --product codex --scope user --components plugin-bundle
  codex plugin marketplace add ~/.codex/agent-knowledge-marketplace
  codex plugin add agent-knowledge@agent-knowledge-local

默认使用 merge，保留第三方 Hook 和未托管文件；只有显式 overwrite 才替换目标节点。
`,
      `
Product defaults:
  TRAE / TRAE CN / Claude Code install hooks,agents,skills by default.
  Codex installs hooks,skills by default and does not support standalone agents.

Codex paths:
  Hooks:  ~/.codex/hooks.json or <repo>/.codex/hooks.json
  Skills: ~/.agents/skills or <repo>/.agents/skills

Codex plugin mode:
  agent-knowledge integration install --product codex --scope user --components plugin-bundle
  codex plugin marketplace add ~/.codex/agent-knowledge-marketplace
  codex plugin add agent-knowledge@agent-knowledge-local

Merge is the default and preserves foreign Hooks and unmanaged files. Only explicit overwrite replaces target nodes.
`
    )
  )
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
        ...(options.product
          ? {
              product: options.product as
                | "trae"
                | "trae-cn"
                | "claude-code"
                | "codex"
            }
          : {}),
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
        const selectedProduct =
          partial.product ?? configuredDefaults.product;
        selected = {
          product: selectedProduct,
          scope: partial.scope ?? configuredDefaults.scope,
          components:
            partial.components ??
            (selectedProduct === configuredDefaults.product
              ? configuredDefaults.components
              : getIntegrationProduct(selectedProduct).defaultComponents),
          targetDir: partial.targetDir ?? configuredDefaults.targetDir ?? undefined,
          mode: partial.mode ?? configuredDefaults.mode
        };
      }
      if (
        selected.product !== "trae" &&
        selected.product !== "trae-cn" &&
        selected.product !== "claude-code" &&
        selected.product !== "codex"
      ) {
        throw new Error(
          "--product must be trae, trae-cn, claude-code, or codex"
        );
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
  .description(t("只卸载 Agent Knowledge 管理的产品资源", "Uninstall only product resources managed by Agent Knowledge"))
  .requiredOption("--product <product>", t("trae、trae-cn、claude-code 或 codex", "trae, trae-cn, claude-code, or codex"))
  .option("--scope <scope>", t("user 或 project", "user or project"), "user")
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .action(async (options: { product: string; scope: string; targetDir?: string }) => {
    if (
      options.product !== "trae" &&
      options.product !== "trae-cn" &&
      options.product !== "claude-code" &&
      options.product !== "codex"
    ) {
      throw new Error(
        "--product must be trae, trae-cn, claude-code, or codex"
      );
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
  .description(t("检查产品接入是否完整且未发生冲突", "Check whether product integration is complete and conflict-free"))
  .requiredOption("--product <product>", t("trae、trae-cn、claude-code 或 codex", "trae, trae-cn, claude-code, or codex"))
  .option("--scope <scope>", t("user 或 project", "user or project"), "user")
  .option("--target-dir <dir>", t("覆盖产品配置根目录", "override product config root"))
  .action(async (options: { product: string; scope: string; targetDir?: string }) => {
    if (
      options.product !== "trae" &&
      options.product !== "trae-cn" &&
      options.product !== "claude-code" &&
      options.product !== "codex"
    ) {
      throw new Error(
        "--product must be trae, trae-cn, claude-code, or codex"
      );
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
 * 为当前 Hook 补充自动发现的 project key，再写入脱敏 staging 和运行摘要。
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
    project_key: detectedProject?.key
  });
  appendJsonlLog(root, {
    event: "hook.lifecycle_staged",
    hookEventName:
      typeof (input.hook_event_name ?? input.event_type) === "string"
        ? String(input.hook_event_name ?? input.event_type).slice(0, 80)
        : "unknown",
    agentType: typeof input.agent_type === "string" ? input.agent_type.slice(0, 80) : undefined,
    projectKey: detectedProject?.key,
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
      project_key: detectedProject?.key
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
      projectKey: detectedProject?.key
    });
    hookContext(
      "SessionStart",
      t(
        `Agent Knowledge 已启用。知识库：${root}。${detectedProject ? `项目：${detectedProject.key}。` : ""}\n\nHook 运行环境：\n${formatRuntimeContext(runtimeContext)}`,
        `Agent Knowledge is enabled. Knowledge root: ${root}. ${detectedProject ? `Project: ${detectedProject.key}.` : ""}\n\nHook runtime context:\n${formatRuntimeContext(runtimeContext)}`
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
        projectKeys: detectedProject ? [detectedProject.key] : []
      });
      const { ranked, debug } = queryMemoriesWithDebug(root, request);
      const packet = buildContextPacket({
        request,
        ranked,
        queryRun: { rootDir: root, queryRunId: debug.queryRunId }
      });
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
        projectKey: detectedProject?.key,
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
