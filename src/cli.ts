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
  getDefaultUserConfigPath,
  embedKnowledgeIndex,
  loadEvalSuite,
  initKnowledgeWorkspace,
  listKnowledge,
  logMemoryFeedback,
  organizeInbox,
  queryMemories,
  queryMemoriesHybridWithDebug,
  queryMemoriesWithDebug,
  rebuildIndex,
  runEvalSuite,
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
  type UserConfig
} from "./index.js";
import { getDefaultKnowledgeRoot } from "./core/paths.js";
import { getGitRuntimeContext, type GitRuntimeContext } from "./hooks/gitContext.js";
import { coarseCatalogForHook, compactCatalogForHook } from "./hooks/hookOutput.js";
import {
  runConfigurationWizard,
  TerminalConfigurationPrompter
} from "./cli/configure.js";

const program = new Command();

program
  .name("agent-knowledge")
  .description("Local human-readable memory toolkit for agents")
  .version("0.1.0")
  .option("--config <file>", "user config file; defaults to ~/.config/agent-knowledge/config.json")
  .option("--json", "emit machine-readable JSON for commands that support human output", false);

function resolveConfigPath(): string {
  const option = program.opts<{ config?: string }>().config;
  return option ? path.resolve(option) : getDefaultUserConfigPath();
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
    actorType === "system"
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
  .description("Interactively configure Agent Knowledge defaults")
  .action(async () => {
    const configPath = resolveConfigPath();
    const prompter = new TerminalConfigurationPrompter();
    try {
      const configured = await runConfigurationWizard({
        configPath,
        prompter,
        current: loadUserConfig(configPath)
      });
      console.log(`Saved Agent Knowledge configuration to ${configPath}`);
      console.log(
        `Knowledge root: ${configured.knowledgeRoot}; actor: ${configured.identity.actorType}; sync: ${configured.sync.provider}`
      );
    } finally {
      prompter.close();
    }
  });

const configCommand = program.command("config").description("Inspect the active user configuration");

configCommand.command("path").action(() => {
  console.log(resolveConfigPath());
});

configCommand.command("show").action(() => {
  console.log(JSON.stringify(loadUserConfig(resolveConfigPath()), null, 2));
});

function hookContext(hookEventName: "SessionStart" | "UserPromptSubmit", additionalContext: string): void {
  console.log(
    JSON.stringify(
      {
        hookSpecificOutput: {
          hookEventName,
          additionalContext
        }
      },
      null,
      2
    )
  );
}

function formatRuntimeContext(context: GitRuntimeContext): string {
  return JSON.stringify(context, null, 2);
}

program
  .command("init")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const root = resolveCliRoot(options.root);
    await initKnowledgeWorkspace(root);
    console.log(`Initialized knowledge workspace at ${root}`);
  });

program
  .command("index")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action((options: { root?: string }) => {
    const result = rebuildIndex(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("embed-index")
  .description("Build .memory/embeddings/index.jsonl from active Markdown knowledge")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--provider <provider>", "transformers or local; defaults to user config")
  .option("--profile <profile>", "embedding profile: multilingual-e5-small or bge-small-zh-v1.5")
  .option("--model <model>", "Transformers.js model id or local model path")
  .option("--allow-remote-models", "allow Transformers.js to download model files; disabled by default", false)
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
  .description("Run a retrieval eval suite from YAML")
  .requiredOption("--input <file>", "eval YAML containing one case or a cases array")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { input: string; root?: string }) => {
    const root = resolveCliRoot(options.root);
    rebuildIndex(root);
    const suite = await loadEvalSuite(options.input);
    console.log(JSON.stringify(await runEvalSuite(root, suite), null, 2));
  });

program
  .command("suggest-aliases")
  .description("Dry-run alias suggestions using embeddings, logs, and Markdown docs")
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
  .requiredOption("--task <task>", "task text")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .option("--domain <domain...>", "domains")
  .option("--scenario <scenario...>", "scenarios")
  .option("--visibility <scope...>", "allowed visibility scopes: private, project, team")
  .option("--sensitivity-clearance <level>", "public, internal, confidential, or secret")
  .option("--project-id <id...>", "allowed project IDs")
  .option("--agent-role <role>", "agent role", "main")
  .option("--debug", "include retrieval debug details in JSON output", false)
  .option("--retrieval <mode>", "lexical or hybrid; defaults to user config")
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
  .description("Log whether a retrieved memory was useful without modifying Markdown facts")
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
  .description("Build a knowledge catalog and optionally refresh knowledge/_catalog.md")
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
  .description("Summarize knowledge files, statuses, domains, and inbox items")
  .option("--root <dir>", "workspace root; defaults to AGENT_KNOWLEDGE_ROOT or ~/.agent_knowledge")
  .action(async (options: { root?: string }) => {
    const result = await listKnowledge(resolveCliRoot(options.root));
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("organize-inbox")
  .description("Plan or apply promotion of knowledge/_inbox Markdown files into typed active directories")
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
  .description("Write user-provided, skill-structured material into active knowledge or inbox")
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
  .description("Synchronize Markdown knowledge with WebDAV or S3");

const sync = program.commands.find((command) => command.name() === "sync")!;

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
  .description("Detect and register the current Git project");

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
  .description("Manage Agent Knowledge integrations for supported agent products");

const integration = program.commands.find((command) => command.name() === "integration")!;

integration
  .command("list")
  .description("List supported products and optional components")
  .action(() => {
    console.log(JSON.stringify({ products: listIntegrationProducts() }, null, 2));
  });

integration
  .command("install")
  .requiredOption("--product <product>", "trae or claude-code")
  .option("--scope <scope>", "user or project", "user")
  .option("--components <components>", "comma-separated hooks,agents,skills,plugin-bundle", "hooks,agents,skills")
  .option("--target-dir <dir>", "override product config root; primarily for project installs and testing")
  .action(
    async (options: {
      product: string;
      scope: string;
      components: string;
      targetDir?: string;
    }) => {
      if (options.product !== "trae" && options.product !== "claude-code") {
        throw new Error("--product must be trae or claude-code");
      }
      if (options.scope !== "user" && options.scope !== "project") {
        throw new Error("--scope must be user or project");
      }
      const components = options.components
        .split(",")
        .map((component) => component.trim())
        .filter(Boolean);
      const allowed = new Set(["hooks", "agents", "skills", "plugin-bundle"]);
      if (components.some((component) => !allowed.has(component))) {
        throw new Error("--components contains an unsupported component");
      }
      const result = await installIntegration({
        packageRoot: findPackageRoot(),
        product: options.product,
        scope: options.scope,
        targetDir: options.targetDir,
        components: components as Array<"hooks" | "agents" | "skills" | "plugin-bundle">
      });
      console.log(JSON.stringify(result, null, 2));
    }
  );

integration
  .command("uninstall")
  .requiredOption("--product <product>", "trae or claude-code")
  .option("--scope <scope>", "user or project", "user")
  .option("--target-dir <dir>", "override product config root")
  .action(async (options: { product: string; scope: string; targetDir?: string }) => {
    if (options.product !== "trae" && options.product !== "claude-code") {
      throw new Error("--product must be trae or claude-code");
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
    if (options.product !== "trae" && options.product !== "claude-code") {
      throw new Error("--product must be trae or claude-code");
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

program
  .command("link-trae-templates")
  .description("Deprecated compatibility wrapper for integration install --product trae")
  .option("--target-dir <dir>", "TRAE config directory override")
  .option("--force", "deprecated and ignored; managed resources are merged safely", false)
  .action(async (options: { targetDir?: string; force: boolean }) => {
    const result = await installIntegration({
      packageRoot: findPackageRoot(),
      product: "trae",
      scope: "user",
      targetDir: options.targetDir,
      components: ["hooks", "agents", "skills"]
    });
    console.log(
      JSON.stringify(
        {
          deprecated: "Use `agent-knowledge integration install --product trae --scope user`.",
          forceIgnored: options.force,
          ...result
        },
        null,
        2
      )
    );
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
    const root = resolveCliRoot(options.root);
    const runtimeContext = getGitRuntimeContext();
    const detectedProject = runtimeContext.isGit
      ? await detectProject(root, runtimeContext.cwd).catch(() => undefined)
      : undefined;
    const input = await readHookInput();
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (prompt.trim().length === 0) {
      hookContext("UserPromptSubmit", "Agent Knowledge 未收到用户 prompt，跳过知识检索。");
      return;
    }

    try {
      await initKnowledgeWorkspace(root);
      rebuildIndex(root);
      const catalog = await catalogKnowledge(root, { write: false });
      const request = MemoryQueryRequestSchema.parse({
        task: prompt,
        agentRole: "main",
        visibilityScopes: resolveVisibilityScopes(),
        sensitivityClearance: resolveSensitivityClearance(),
        projectIds: detectedProject ? [detectedProject.id] : []
      });
      const { ranked, debug } = queryMemoriesWithDebug(root, request);
      const packet = buildContextPacket({ request, ranked });
      const hasContext =
        packet.always_apply.length +
          packet.relevant_facts.length +
          packet.procedures.length +
          packet.examples.length +
          packet.warnings.length >
        0;

      appendJsonlLog(root, {
        event: "hook.user_prompt_submit",
        promptLength: prompt.length,
        catalogTotal: catalog.total,
        resultIds: debug.resultIds,
        fallbackUsed: debug.fallbackUsed,
        fallbackSuppressedReason: debug.fallbackSuppressedReason,
        runtimeContext,
        projectId: detectedProject?.id
      });

      hookContext(
        "UserPromptSubmit",
        hasContext
          ? `Hook runtime context:\n\n${formatRuntimeContext(runtimeContext)}\n\nAgent Knowledge catalog:\n\n${JSON.stringify(compactCatalogForHook(catalog), null, 2)}\n\nAgent Knowledge context packet:\n\n${JSON.stringify(packet, null, 2)}`
          : `Hook runtime context:\n\n${formatRuntimeContext(runtimeContext)}\n\nAgent Knowledge coarse catalog:\n\n${JSON.stringify(coarseCatalogForHook(catalog), null, 2)}\n\nAgent Knowledge 已查询 ${root}，没有命中可注入的 active 知识。仅注入粗粒度 catalog；如任务需要历史知识，可根据 domains/scenarios 调用 memory-reader 精查。`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendJsonlLog(root, {
        event: "hook.user_prompt_submit.error",
        promptLength: prompt.length,
        message
      });
      hookContext("UserPromptSubmit", `Agent Knowledge 检索失败，主流程可继续。错误：${message}`);
    }
  });

await program.parseAsync(process.argv);
