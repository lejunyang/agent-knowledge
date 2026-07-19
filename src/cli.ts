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
  appendJsonlLog,
  buildContextPacket,
  catalogKnowledge,
  captureMaterial,
  createEmbeddingProvider,
  createConfiguredSyncBackend,
  decideHookInjection,
  downloadRetrievalModel,
  getDefaultUserConfigPath,
  getRetrievalModelStatus,
  embedKnowledgeIndex,
  loadEvalSuite,
  loadEvalCorpus,
  materializeEvalCorpus,
  initKnowledgeWorkspace,
  listKnowledge,
  logMemoryFeedback,
  organizeInbox,
  queryMemories,
  queryMemoriesHybridWithDebug,
  queryMemoriesWithDebug,
  rebuildIndex,
  runEvalSuite,
  runScheduledSync,
  resolveRetrievalModelDescriptor,
  S3HttpObjectClient,
  S3SyncBackend,
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
  loadUserConfig,
  writeCandidateMemory,
  type CandidateMemoryInput,
  type UserConfig,
  resolveLocale,
  translate,
  type SupportedLocale
} from "./index.js";
import { getDefaultKnowledgeRoot } from "./core/paths.js";
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
const startupConfig = loadUserConfig(startupConfigPath);
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

function resolveConfigPath(): string {
  return startupConfigPath;
}

function userConfig(): UserConfig {
  return loadUserConfig(resolveConfigPath());
}

function hasUserConfigFile(): boolean {
  return existsSync(resolveConfigPath());
}

function resolveCliRoot(root?: string): string {
  return (
    root ??
    (hasUserConfigFile() ? userConfig().knowledgeRoot : undefined) ??
    process.env.AGENT_KNOWLEDGE_ROOT ??
    getDefaultKnowledgeRoot()
  );
}

function resolveVisibilityScopes(explicit?: string[]): Array<"private" | "project" | "team"> {
  const values =
    explicit ??
    (hasUserConfigFile() ? userConfig().identity.visibilityScopes : undefined) ??
    process.env.AGENT_KNOWLEDGE_VISIBILITY_SCOPES?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ??
    ["private", "project", "team"];
  const allowed = new Set(["private", "project", "team"]);
  if (values.some((scope) => !allowed.has(scope))) {
    throw new Error("visibility scopes must be private, project, or team");
  }
  return values as Array<"private" | "project" | "team">;
}

function resolveSensitivityClearance(
  explicit?: string
): "public" | "internal" | "confidential" | "secret" {
  const value =
    explicit ??
    (hasUserConfigFile() ? userConfig().identity.sensitivityClearance : undefined) ??
    process.env.AGENT_KNOWLEDGE_SENSITIVITY_CLEARANCE ??
    "internal";
  if (value !== "public" && value !== "internal" && value !== "confidential" && value !== "secret") {
    throw new Error("sensitivity clearance must be public, internal, confidential, or secret");
  }
  return value;
}

function applyCapturePolicyOverrides(input: CandidateMemoryInput): CandidateMemoryInput {
  const configuredIdentity = hasUserConfigFile() ? userConfig().identity : undefined;
  const actorType =
    configuredIdentity?.actorType ?? process.env.AGENT_KNOWLEDGE_ACTOR_TYPE;
  const captureMode =
    configuredIdentity?.captureMode ?? process.env.AGENT_KNOWLEDGE_CAPTURE_MODE;
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

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
  .action(async () => {
    const configPath = resolveConfigPath();
    const prompter = new TerminalConfigurationPrompter();
    try {
      const configured = await runConfigurationWizard({
        configPath,
        prompter,
        current: loadUserConfig(configPath),
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
  .description(t("查看当前用户配置", "Inspect the active user configuration"));

configCommand.command("path").action(() => {
  console.log(resolveConfigPath());
});

configCommand.command("show").action(() => {
  console.log(JSON.stringify(loadUserConfig(resolveConfigPath()), null, 2));
});

const embeddingCommand = program
  .command("embedding")
  .description(t("检查和下载本地检索模型", "Inspect and download local retrieval models"));

embeddingCommand
  .command("status")
  .description(t("离线检查当前模型是否已完整缓存", "Check whether the configured model is fully cached"))
  .option("--kind <kind>", t("模型类型：embedding 或 reranker", "model kind: embedding or reranker"), "embedding")
  .option("--model <model>", t("临时覆盖模型 ID", "override the configured model ID"))
  .option("--cache-dir <dir>", t("临时覆盖模型缓存目录", "override the model cache directory"))
  .option("--json", t("输出完整 JSON", "emit full JSON"), false)
  .action(async (options: { kind: string; model?: string; cacheDir?: string; json: boolean }) => {
    if (options.kind !== "embedding" && options.kind !== "reranker") {
      throw new Error(t("--kind 必须是 embedding 或 reranker", "--kind must be embedding or reranker"));
    }
    const descriptor = resolveRetrievalModelDescriptor(userConfig().embeddings, options.kind);
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
  .option("--kind <kind>", t("模型类型：embedding 或 reranker", "model kind: embedding or reranker"), "embedding")
  .option("--model <model>", t("临时覆盖模型 ID", "override the configured model ID"))
  .option("--cache-dir <dir>", t("临时覆盖模型缓存目录", "override the model cache directory"))
  .option("--json", t("完成后输出完整 JSON", "emit full JSON after completion"), false)
  .action(async (options: { kind: string; model?: string; cacheDir?: string; json: boolean }) => {
    if (options.kind !== "embedding" && options.kind !== "reranker") {
      throw new Error(t("--kind 必须是 embedding 或 reranker", "--kind must be embedding or reranker"));
    }
    const descriptor = resolveRetrievalModelDescriptor(userConfig().embeddings, options.kind);
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

function hookContext(hookEventName: "SessionStart" | "UserPromptSubmit", additionalContext: string): void {
  const output = hookContextJson(hookEventName, additionalContext);
  if (output) {
    console.log(JSON.stringify(output));
  }
}

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
    console.log(`Initialized knowledge workspace at ${root}`);
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
      allowRemoteModels: options.allowRemoteModels || configuredEmbeddings.allowRemoteModels
    });
    const result = await embedKnowledgeIndex(resolveCliRoot(options.root), { provider });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("eval")
  .description(t("运行 YAML 检索评测集", "Run a retrieval eval suite from YAML"))
  .option("--input <file>", t("包含单个 case 或 cases 数组的评测 YAML", "eval YAML containing one case or a cases array"))
  .option("--fixture <file>", t("可选：包含文档和 cases 的完整评测 corpus YAML", "optional corpus YAML containing documents and cases"))
  .option("--root <dir>", t("知识库 workspace root", "knowledge workspace root"))
  .action(async (options: { input?: string; fixture?: string; root?: string }) => {
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
    console.log(JSON.stringify(await runEvalSuite(root, suite), null, 2));
  });

program
  .command("suggest-aliases")
  .description(t("根据 Embedding、日志和 Markdown 生成别名建议（dry-run）", "Dry-run alias suggestions using embeddings, logs, and Markdown docs"))
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--provider <provider>", "transformers or local; defaults to user config")
  .option("--model <model>", "Transformers.js model id or local model path")
  .option("--allow-remote-models", "allow Transformers.js to download model files; disabled by default", false)
  .option("--max <count>", "max suggestions per memory", "5")
  .option("--min-score <score>", "minimum cosine score", "0.35")
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
        allowRemoteModels: options.allowRemoteModels || configuredEmbeddings.allowRemoteModels
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
  .option("--project-id <id...>", "allowed project IDs")
  .option("--agent-role <role>", "agent role", "main")
  .option("--debug", t("在 JSON 中包含检索调试信息", "include retrieval debug details in JSON output"), false)
  .option("--retrieval <mode>", t("lexical 或 hybrid；默认读取用户配置", "lexical or hybrid; defaults to user config"))
  .option("--provider <provider>", "embedding provider for hybrid retrieval: transformers or local")
  .option("--profile <profile>", "embedding profile: multilingual-e5-small or bge-small-zh-v1.5")
  .option("--model <model>", "Transformers.js model id or local model path for hybrid retrieval")
  .option("--embedding-top-k <count>", "embedding topK for hybrid retrieval; defaults to user config")
  .option("--allow-remote-models", "allow Transformers.js to download model files; disabled by default", false)
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
    allowRemoteModels: boolean;
  }) => {
    const configuredEmbeddings = userConfig().embeddings;
    const retrievalMode = options.retrieval ?? configuredEmbeddings.retrieval;
    if (retrievalMode !== "lexical" && retrievalMode !== "hybrid") {
      throw new Error("--retrieval must be lexical or hybrid");
    }
    const providerName = options.provider ?? configuredEmbeddings.provider;
    if (providerName !== "transformers" && providerName !== "local") {
      throw new Error("--provider must be transformers or local");
    }
    const visibilityScopes = resolveVisibilityScopes(options.visibility);
    const sensitivityClearance = resolveSensitivityClearance(options.sensitivityClearance);
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? [],
      visibilityScopes,
      sensitivityClearance,
      projectIds: options.projectId ?? []
    });
    const root = resolveCliRoot(options.root);
    const { ranked, debug } =
      retrievalMode === "hybrid"
        ? await queryMemoriesHybridWithDebug(root, request, {
            embeddingProvider: createEmbeddingProvider({
              provider: providerName,
              profile:
                options.profile === "multilingual-e5-small" || options.profile === "bge-small-zh-v1.5"
                  ? options.profile
                  : configuredEmbeddings.profile,
              model: options.model ?? configuredEmbeddings.model ?? undefined,
              allowRemoteModels: options.allowRemoteModels || configuredEmbeddings.allowRemoteModels
            }),
            embeddingTopK: options.embeddingTopK
              ? Number.parseInt(options.embeddingTopK, 10)
              : configuredEmbeddings.embeddingTopK
          })
        : queryMemoriesWithDebug(root, request);
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(options.debug ? { packet, debug } : packet, null, 2));
  });

program
  .command("feedback")
  .description(t("记录检索知识是否有用，不修改 Markdown 事实", "Log whether a retrieved memory was useful without modifying Markdown facts"))
  .requiredOption("--memory-id <id>", "knowledge id shown in query output")
  .requiredOption("--usefulness <value>", "one of: useful, not_useful, neutral")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--query-run-id <id>", "debug.queryRunId from a prior query")
  .option("--task <task>", "short task text associated with the feedback")
  .option("--note <note>", "optional feedback note, max 500 characters")
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
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--no-write", "print catalog JSON without rewriting knowledge/_catalog.md")
  .action(async (options: { root?: string; write: boolean }) => {
    const result = await catalogKnowledge(resolveCliRoot(options.root), { write: options.write });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", "candidate JSON file")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { input: string; root?: string }) => {
    const input = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput;
    const result = await writeCandidateMemory(resolveCliRoot(options.root), applyCapturePolicyOverrides(input));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("list")
  .description(t("汇总知识文件、状态、领域和 inbox", "Summarize knowledge files, statuses, domains, and inbox items"))
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const result = await listKnowledge(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("organize-inbox")
  .description(t("预览或应用 inbox 知识晋升", "Plan or apply promotion of inbox Markdown into active directories"))
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--apply", "move files and activate them; defaults to dry-run", false)
  .option("--no-rebuild", "skip index rebuild after applying changes")
  .action(async (options: { root?: string; apply: boolean; rebuild: boolean }) => {
    const result = await organizeInbox(resolveCliRoot(options.root), {
      apply: options.apply,
      rebuild: options.rebuild
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("capture-material")
  .description(t("把用户材料写入 active 知识或 inbox", "Write user-provided material into active knowledge or inbox"))
  .requiredOption("--input <file>", "JSON file containing one candidate object or an array of candidates")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--target <target>", "active or inbox", "active")
  .option("--no-rebuild", "skip index rebuild after writing material")
  .action(async (options: { input: string; root?: string; target: string; rebuild: boolean }) => {
    if (options.target !== "active" && options.target !== "inbox") {
      throw new Error("--target must be either active or inbox");
    }
    const rawInput = JSON.parse(await readFile(options.input, "utf8")) as CandidateMemoryInput | CandidateMemoryInput[];
    const inputs = (Array.isArray(rawInput) ? rawInput : [rawInput]).map(applyCapturePolicyOverrides);
    const result = await captureMaterial(resolveCliRoot(options.root), inputs, {
      target: options.target,
      rebuild: options.rebuild
    });
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("sync")
  .description(t("通过 WebDAV 或 S3 同步 Markdown 知识", "Synchronize Markdown knowledge with WebDAV or S3"));

const sync = program.commands.find((command) => command.name() === "sync")!;

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
  .option("--root <dir>", "workspace root override")
  .option("--json", "emit the full JSON result", false)
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
  .option("--root <dir>", "workspace root override")
  .option("--interval-minutes <minutes>", "override the configured sync interval")
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
  .requiredOption("--url <url>", "WebDAV collection URL")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--username <username>", "WebDAV username; defaults to WEBDAV_USERNAME")
  .option("--password-env <name>", "environment variable containing WebDAV password", "WEBDAV_PASSWORD")
  .option("--visibility <scope...>", "visibility scopes to sync", ["project", "team"])
  .option("--sensitivity-clearance <level>", "maximum sensitivity to sync", "internal")
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
  .requiredOption("--bucket <bucket>", "S3 bucket")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--region <region>", "AWS region; defaults to AWS_REGION or us-east-1")
  .option("--prefix <prefix>", "object prefix", "")
  .option("--endpoint <url>", "S3-compatible endpoint")
  .option("--force-path-style", "use path-style bucket addressing", false)
  .option("--visibility <scope...>", "visibility scopes to sync", ["project", "team"])
  .option("--sensitivity-clearance <level>", "maximum sensitivity to sync", "internal")
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
  .description("Inspect and drain proactive-memory staging events");

const staging = program.commands.find((command) => command.name() === "staging")!;

staging
  .command("status")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    console.log(JSON.stringify(await getStagingStatus(resolveCliRoot(options.root)), null, 2));
  });

staging
  .command("drain")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--limit <count>", "maximum events to consume", "100")
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

program
  .command("project")
  .description(t("检测并注册当前 Git 项目", "Detect and register the current Git project"));

const project = program.commands.find((command) => command.name() === "project")!;

project
  .command("detect")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--cwd <dir>", "directory to inspect", process.cwd())
  .action(async (options: { root?: string; cwd: string }) => {
    console.log(JSON.stringify(await detectProject(resolveCliRoot(options.root), options.cwd), null, 2));
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
  .option("--product <product>", "trae, trae-cn, or claude-code")
  .option("--scope <scope>", "user or project")
  .option("--components <components>", "comma-separated hooks,agents,skills,plugin-bundle")
  .option("--target-dir <dir>", "override product config root; primarily for project installs and testing")
  .option("--mode <mode>", "merge or overwrite")
  .option("--overwrite", "replace target files and symlinks instead of merging", false)
  .option("--debug", "emit the full JSON result", false)
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
  .requiredOption("--product <product>", "trae or claude-code")
  .option("--scope <scope>", "user or project", "user")
  .option("--target-dir <dir>", "override product config root")
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
  .requiredOption("--product <product>", "trae or claude-code")
  .option("--scope <scope>", "user or project", "user")
  .option("--target-dir <dir>", "override product config root")
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
  .description("Build the local package in the current directory and install it globally with npm")
  .option("--package-dir <dir>", "local package directory", process.cwd())
  .option("--skip-build", "skip npm run build before global installation", false)
  .action((options: { packageDir: string; skipBuild: boolean }) => {
    const packageDir = path.resolve(options.packageDir);
    if (!options.skipBuild) {
      execFileSync("npm", ["run", "build"], { cwd: packageDir, stdio: "inherit" });
    }
    execFileSync("npm", ["install", "-g", packageDir], { stdio: "inherit" });
    console.log(`Installed global command from ${packageDir}`);
  });

const hook = program.command("hook").description("Commands intended to be called from TRAE hooks.json templates");

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
  .description("Stage a bounded, redacted lifecycle event for later memory maintenance")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    await stageCurrentHook(root);
  });

hook
  .command("session-start")
  .description("Initialize AGENT_KNOWLEDGE_ROOT for the TRAE session and provide startup context")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
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
      `Agent Knowledge 已启用。默认知识库 workspace root：${root}。知识文件位于 ${root}/knowledge，索引位于 ${root}/.memory/index.sqlite。${detectedProject ? ` 当前 project ID：${detectedProject.id}。` : ""}\n\nHook runtime context:\n\n${formatRuntimeContext(runtimeContext)}`
    );
  });

hook
  .command("doctor")
  .description("Print hook runtime diagnostics such as cwd, git root, and git origin")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
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
  .description("Query Agent Knowledge for the submitted prompt and return additional context")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
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
