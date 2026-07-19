/**
 * 配置向导只负责解释选项、收集答案并写入用户配置。
 *
 * 它不立即安装 integration、下载 embedding 模型或连接远端同步服务；这样一次配置操作
 * 不会产生难以撤销的外部副作用。对应命令会在实际执行时消费这些持久默认值。
 */
import {
  resolveUserConfig,
  writeUserConfig,
  type UserConfig
} from "../core/config.js";
import {
  InquirerPrompter,
  promptCheckbox,
  promptConfirm,
  promptInput,
  promptNumber,
  promptSelect,
  type InteractivePrompter
} from "./prompts.js";

export type ConfigurationPrompter = InteractivePrompter;
export class TerminalConfigurationPrompter extends InquirerPrompter {}

function withDefault(answer: string, defaultValue: string): string {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

export async function runConfigurationWizard(options: {
  configPath: string;
  prompter: ConfigurationPrompter;
  current: UserConfig;
}): Promise<UserConfig> {
  const { prompter, current } = options;
  const knowledgeRoot = await promptInput(
    prompter,
    "Knowledge root — Markdown facts and .memory caches live here",
    current.knowledgeRoot
  );
  const actorType = await promptSelect(
    prompter,
    "Actor type — controls write authority",
    [
      { name: "Owner", value: "owner", description: "Trusted personal input" },
      { name: "Teammate", value: "teammate", description: "Known collaborator input" },
      { name: "Customer", value: "customer", description: "Untrusted observation; always reviewed" },
      { name: "Agent", value: "agent", description: "AI agent or automated service" }
    ],
    current.identity.actorType
  );
  const captureMode = await promptSelect(
    prompter,
    "Capture mode — controls review policy",
    [
      { name: "Direct material", value: "direct_material", description: "Owner-provided source material" },
      { name: "Explicit remember", value: "explicit_remember", description: "User explicitly requested memory" },
      { name: "Verified task", value: "verified_task", description: "Reusable result verified by execution" },
      { name: "Automated session", value: "automated_session", description: "Always enters review inbox" }
    ],
    current.identity.captureMode
  );
  const identityVisibility = await promptCheckbox(
    prompter,
    "Query visibility scopes",
    [
      { name: "Private", value: "private" },
      { name: "Project", value: "project" },
      { name: "Team", value: "team" }
    ],
    current.identity.visibilityScopes
  );
  const identitySensitivity = await promptSelect(
    prompter,
    "Query sensitivity clearance",
    [
      { name: "Public", value: "public" },
      { name: "Internal", value: "internal" },
      { name: "Confidential", value: "confidential" },
      { name: "Secret", value: "secret" }
    ],
    current.identity.sensitivityClearance
  );

  const embeddingProvider = await promptSelect(
    prompter,
    "Embedding provider",
    [
      { name: "Transformers.js", value: "transformers", description: "Semantic local model" },
      { name: "Deterministic local", value: "local", description: "Offline tests and protocol checks" }
    ],
    current.embeddings.provider
  );
  const embeddingProfile = await promptSelect(
    prompter,
    "Embedding profile",
    [
      {
        name: "Multilingual E5 small",
        value: "multilingual-e5-small",
        description: "Default for mixed Chinese/English knowledge"
      },
      {
        name: "BGE small zh v1.5",
        value: "bge-small-zh-v1.5",
        description: "Resource-efficient Chinese retrieval"
      }
    ],
    current.embeddings.profile
  );
  const embeddingModelAnswer = await promptInput(
    prompter,
    "Embedding model/path — blank uses the selected profile",
    current.embeddings.model ?? ""
  );
  const embeddingModel = withDefault(embeddingModelAnswer, current.embeddings.model ?? "");
  const allowRemoteModels = await promptConfirm(
    prompter,
    "Allow Transformers.js remote model downloads?",
    current.embeddings.allowRemoteModels
  );
  const retrieval = await promptSelect(
    prompter,
    "Retrieval mode",
    [
      { name: "Lexical", value: "lexical", description: "Lightweight FTS/BM25 retrieval" },
      { name: "Hybrid", value: "hybrid", description: "Fuse lexical and embedding retrieval" }
    ],
    current.embeddings.retrieval
  );
  const embeddingTopK = await promptNumber(
    prompter,
    "Embedding candidate count before reranking",
    current.embeddings.embeddingTopK,
    1
  );

  const integrationProduct = await promptSelect(
    prompter,
    "Integration product",
    [
      { name: "TRAE", value: "trae", description: ".trae and .trae/cli hooks" },
      { name: "TRAE CN", value: "trae-cn", description: ".trae-cn resources" },
      { name: "Claude Code", value: "claude-code", description: ".claude resources" }
    ],
    current.integration.product
  );
  const integrationScope = await promptSelect(
    prompter,
    "Integration scope",
    [
      { name: "User", value: "user" },
      { name: "Project", value: "project" }
    ],
    current.integration.scope
  );
  const integrationComponents = await promptCheckbox(
    prompter,
    "Integration components",
    [
      { name: "Hooks", value: "hooks" },
      { name: "Agents", value: "agents" },
      { name: "Skills", value: "skills" },
      { name: "Plugin bundle", value: "plugin-bundle" }
    ],
    current.integration.components
  );
  const integrationTargetAnswer = await promptInput(
    prompter,
    "Integration target override — blank uses the product default",
    current.integration.targetDir ?? ""
  );
  const integrationTarget = withDefault(integrationTargetAnswer, current.integration.targetDir ?? "");
  const integrationMode = await promptSelect(
    prompter,
    "Integration write mode",
    [
      { name: "Merge (recommended)", value: "merge", description: "Preserve foreign configuration" },
      { name: "Overwrite", value: "overwrite", description: "Replace target files and symlinks" }
    ],
    current.integration.mode
  );

  const syncProvider = await promptSelect(
    prompter,
    "Sync provider",
    [
      { name: "None", value: "none" },
      { name: "WebDAV", value: "webdav" },
      { name: "S3 / S3-compatible", value: "s3" }
    ],
    current.sync.provider
  );

  let webdav = current.sync.webdav;
  let s3 = current.sync.s3;
  if (syncProvider === "webdav") {
    webdav = {
      url: await promptInput(
        prompter,
        "WebDAV base URL",
        current.sync.webdav.url
      ),
      username: await promptInput(
        prompter,
        "WebDAV username",
        current.sync.webdav.username
      ),
      passwordEnv: await promptInput(
        prompter,
        "Environment variable containing the WebDAV password",
        current.sync.webdav.passwordEnv
      )
    };
  } else if (syncProvider === "s3") {
    const endpointAnswer = await promptInput(
      prompter,
      "S3-compatible endpoint — blank uses AWS",
      current.sync.s3.endpoint ?? ""
    );
    s3 = {
      bucket: await promptInput(
        prompter,
        "S3 bucket",
        current.sync.s3.bucket
      ),
      region: await promptInput(
        prompter,
        "S3 region",
        current.sync.s3.region
      ),
      prefix: await promptInput(
        prompter,
        "S3 object prefix",
        current.sync.s3.prefix
      ),
      endpoint: withDefault(endpointAnswer, current.sync.s3.endpoint ?? "") || null,
      forcePathStyle: await promptConfirm(
        prompter,
        "Force path-style S3 addressing?",
        current.sync.s3.forcePathStyle
      ),
      accessKeyIdEnv: await promptInput(
        prompter,
        "Environment variable containing the S3 access key ID",
        current.sync.s3.accessKeyIdEnv
      ),
      secretAccessKeyEnv: await promptInput(
        prompter,
        "Environment variable containing the S3 secret key",
        current.sync.s3.secretAccessKeyEnv
      ),
      sessionTokenEnv: await promptInput(
        prompter,
        "Environment variable containing the optional S3 session token",
        current.sync.s3.sessionTokenEnv
      )
    };
  }

  const intervalMinutes = await promptNumber(
    prompter,
    "Sync interval in minutes — 0 disables scheduled sync",
    current.sync.intervalMinutes,
    0
  );
  const syncVisibility = await promptCheckbox(
    prompter,
    "Sync visibility scopes",
    [
      { name: "Private", value: "private" },
      { name: "Project", value: "project" },
      { name: "Team", value: "team" }
    ],
    current.sync.visibilityScopes
  );
  const syncSensitivity = await promptSelect(
    prompter,
    "Maximum sensitivity allowed in sync",
    [
      { name: "Public", value: "public" },
      { name: "Internal", value: "internal" },
      { name: "Confidential", value: "confidential" },
      { name: "Secret", value: "secret" }
    ],
    current.sync.sensitivityClearance
  );

  const configured = resolveUserConfig({
    version: 1,
    knowledgeRoot,
    identity: {
      actorType,
      captureMode,
      visibilityScopes: identityVisibility,
      sensitivityClearance: identitySensitivity
    },
    embeddings: {
      provider: embeddingProvider,
      profile: embeddingProfile,
      model: embeddingModel || null,
      allowRemoteModels,
      retrieval,
      embeddingTopK
    },
    integration: {
      product: integrationProduct,
      scope: integrationScope,
      components: integrationComponents,
      targetDir: integrationTarget || null,
      mode: integrationMode
    },
    sync: {
      provider: syncProvider,
      intervalMinutes,
      visibilityScopes: syncVisibility,
      sensitivityClearance: syncSensitivity,
      webdav,
      s3
    }
  });
  writeUserConfig(options.configPath, configured);
  return configured;
}
