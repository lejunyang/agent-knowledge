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
import { translate, type SupportedLocale } from "../i18n/locale.js";
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
  locale?: SupportedLocale;
}): Promise<UserConfig> {
  const { prompter, current } = options;
  let activeLocale = options.locale ?? "zh-CN";
  const uiLocale = await promptSelect(
    prompter,
    translate(activeLocale, "界面语言", "Interface language"),
    [
      { name: "自动检测 / Auto", value: "auto" },
      { name: "简体中文", value: "zh-CN" },
      { name: "English", value: "en" }
    ],
    current.locale
  );
  if (uiLocale === "zh-CN" || uiLocale === "en") {
    activeLocale = uiLocale;
  }
  const t = (chinese: string, english: string): string => translate(activeLocale, chinese, english);
  const knowledgeRoot = await promptInput(
    prompter,
    t("知识库根目录 — Markdown 事实和 .memory 缓存存放位置", "Knowledge root — Markdown facts and .memory caches live here"),
    current.knowledgeRoot
  );
  const actorType = await promptSelect(
    prompter,
    t("行为主体 — 决定写入权威性", "Actor type — controls write authority"),
    [
      { name: t("所有者", "Owner"), value: "owner", description: t("可信的个人输入", "Trusted personal input") },
      { name: t("协作者", "Teammate"), value: "teammate", description: t("已知协作者输入", "Known collaborator input") },
      { name: t("客户", "Customer"), value: "customer", description: t("不可信观察，始终需要审核", "Untrusted observation; always reviewed") },
      { name: t("Agent", "Agent"), value: "agent", description: t("AI Agent 或自动化服务", "AI agent or automated service") }
    ],
    current.identity.actorType
  );
  const captureMode = await promptSelect(
    prompter,
    t("捕获模式 — 决定审核策略", "Capture mode — controls review policy"),
    [
      { name: t("直接材料", "Direct material"), value: "direct_material", description: t("所有者提供的源材料", "Owner-provided source material") },
      { name: t("显式记忆", "Explicit remember"), value: "explicit_remember", description: t("用户明确要求记忆", "User explicitly requested memory") },
      { name: t("已验证任务", "Verified task"), value: "verified_task", description: t("执行验证通过的可复用结果", "Reusable result verified by execution") },
      { name: t("自动会话", "Automated session"), value: "automated_session", description: t("始终进入审核 inbox", "Always enters review inbox") }
    ],
    current.identity.captureMode
  );
  const identityVisibility = await promptCheckbox(
    prompter,
    t("查询可见范围", "Query visibility scopes"),
    [
      { name: t("私有", "Private"), value: "private" },
      { name: t("项目", "Project"), value: "project" },
      { name: t("团队", "Team"), value: "team" }
    ],
    current.identity.visibilityScopes
  );
  const identitySensitivity = await promptSelect(
    prompter,
    t("查询敏感级别权限", "Query sensitivity clearance"),
    [
      { name: t("公开", "Public"), value: "public", description: t("可公开传播", "Safe for public distribution") },
      { name: t("内部", "Internal"), value: "internal", description: t("组织或项目内部，默认选项", "Organization or project internal; default") },
      { name: t("机密", "Confidential"), value: "confidential", description: t("限制成员可见的敏感业务信息", "Sensitive business information limited to authorized members") },
      { name: t("绝密", "Secret"), value: "secret", description: t("最高敏感级别；仍禁止存储密钥原文", "Highest sensitivity; raw credentials remain prohibited") }
    ],
    current.identity.sensitivityClearance
  );

  const embeddingProvider = await promptSelect(
    prompter,
    t("Embedding 提供方", "Embedding provider"),
    [
      { name: "Transformers.js", value: "transformers", description: t("本地语义模型", "Semantic local model") },
      { name: t("确定性本地", "Deterministic local"), value: "local", description: t("离线测试和协议检查", "Offline tests and protocol checks") }
    ],
    current.embeddings.provider
  );
  const embeddingProfile = await promptSelect(
    prompter,
    t("Embedding 模型配置", "Embedding profile"),
    [
      {
        name: "Multilingual E5 small",
        value: "multilingual-e5-small",
        description: t("中英文混合知识的默认选择", "Default for mixed Chinese/English knowledge")
      },
      {
        name: "BGE small zh v1.5",
        value: "bge-small-zh-v1.5",
        description: t("资源友好的中文检索", "Resource-efficient Chinese retrieval")
      }
    ],
    current.embeddings.profile
  );
  const embeddingModelAnswer = await promptInput(
    prompter,
    t("Embedding 模型或路径 — 留空使用所选配置", "Embedding model/path — blank uses the selected profile"),
    current.embeddings.model ?? ""
  );
  const embeddingModel = withDefault(embeddingModelAnswer, current.embeddings.model ?? "");
  const embeddingCacheDir = await promptInput(
    prompter,
    t("模型缓存目录", "Model cache directory"),
    current.embeddings.cacheDir
  );
  const allowRemoteModels = await promptConfirm(
    prompter,
    t("允许 Transformers.js 远程下载模型？", "Allow Transformers.js remote model downloads?"),
    current.embeddings.allowRemoteModels
  );
  const retrieval = await promptSelect(
    prompter,
    t("检索模式", "Retrieval mode"),
    [
      { name: t("词法检索", "Lexical"), value: "lexical", description: t("轻量 FTS/BM25 检索", "Lightweight FTS/BM25 retrieval") },
      { name: t("混合检索", "Hybrid"), value: "hybrid", description: t("融合词法和 embedding 检索", "Fuse lexical and embedding retrieval") }
    ],
    current.embeddings.retrieval
  );
  const embeddingTopK = await promptNumber(
    prompter,
    t("重排前的 Embedding 候选数量", "Embedding candidate count before reranking"),
    current.embeddings.embeddingTopK,
    1
  );
  const rerankerModelAnswer = await promptInput(
    prompter,
    t(
      "Reranker 模型 — 留空使用 Xenova/bge-reranker-large",
      "Reranker model — blank uses Xenova/bge-reranker-large"
    ),
    current.embeddings.rerankerModel ?? ""
  );

  const integrationProduct = await promptSelect(
    prompter,
    t("集成产品", "Integration product"),
    [
      { name: "TRAE", value: "trae", description: t(".trae 和 .trae/cli hooks", ".trae and .trae/cli hooks") },
      { name: "TRAE CN", value: "trae-cn", description: t(".trae-cn 资源", ".trae-cn resources") },
      { name: "Claude Code", value: "claude-code", description: t(".claude 资源", ".claude resources") }
    ],
    current.integration.product
  );
  const integrationScope = await promptSelect(
    prompter,
    t("集成范围", "Integration scope"),
    [
      { name: t("用户级", "User"), value: "user" },
      { name: t("项目级", "Project"), value: "project" }
    ],
    current.integration.scope
  );
  const integrationComponents = await promptCheckbox(
    prompter,
    t("集成组件", "Integration components"),
    [
      { name: "Hooks", value: "hooks" },
      { name: "Agents", value: "agents" },
      { name: "Skills", value: "skills" },
      { name: t("插件包", "Plugin bundle"), value: "plugin-bundle" }
    ],
    current.integration.components
  );
  const integrationTargetAnswer = await promptInput(
    prompter,
    t("集成目标覆盖 — 留空使用产品默认位置", "Integration target override — blank uses the product default"),
    current.integration.targetDir ?? ""
  );
  const integrationTarget = withDefault(integrationTargetAnswer, current.integration.targetDir ?? "");
  const integrationMode = await promptSelect(
    prompter,
    t("集成写入模式", "Integration write mode"),
    [
      { name: t("合并（推荐）", "Merge (recommended)"), value: "merge", description: t("保留外部配置", "Preserve foreign configuration") },
      { name: t("覆盖", "Overwrite"), value: "overwrite", description: t("替换目标文件和 symlink", "Replace target files and symlinks") }
    ],
    current.integration.mode
  );

  const syncProvider = await promptSelect(
    prompter,
    t("同步提供方", "Sync provider"),
    [
      { name: t("不启用", "None"), value: "none" },
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
        t("WebDAV 基础 URL", "WebDAV base URL"),
        current.sync.webdav.url
      ),
      username: await promptInput(
        prompter,
        t("WebDAV 用户名", "WebDAV username"),
        current.sync.webdav.username
      ),
      passwordEnv: await promptInput(
        prompter,
        t("保存 WebDAV 密码的环境变量名", "Environment variable containing the WebDAV password"),
        current.sync.webdav.passwordEnv
      )
    };
  } else if (syncProvider === "s3") {
    const endpointAnswer = await promptInput(
      prompter,
      t("S3 兼容 endpoint — 留空使用 AWS", "S3-compatible endpoint — blank uses AWS"),
      current.sync.s3.endpoint ?? ""
    );
    s3 = {
      bucket: await promptInput(
        prompter,
        t("S3 bucket", "S3 bucket"),
        current.sync.s3.bucket
      ),
      region: await promptInput(
        prompter,
        t("S3 region", "S3 region"),
        current.sync.s3.region
      ),
      prefix: await promptInput(
        prompter,
        t("S3 对象前缀", "S3 object prefix"),
        current.sync.s3.prefix
      ),
      endpoint: withDefault(endpointAnswer, current.sync.s3.endpoint ?? "") || null,
      forcePathStyle: await promptConfirm(
        prompter,
        t("强制使用 path-style S3 寻址？", "Force path-style S3 addressing?"),
        current.sync.s3.forcePathStyle
      ),
      accessKeyIdEnv: await promptInput(
        prompter,
        t("保存 S3 access key ID 的环境变量名", "Environment variable containing the S3 access key ID"),
        current.sync.s3.accessKeyIdEnv
      ),
      secretAccessKeyEnv: await promptInput(
        prompter,
        t("保存 S3 secret key 的环境变量名", "Environment variable containing the S3 secret key"),
        current.sync.s3.secretAccessKeyEnv
      ),
      sessionTokenEnv: await promptInput(
        prompter,
        t("保存可选 S3 session token 的环境变量名", "Environment variable containing the optional S3 session token"),
        current.sync.s3.sessionTokenEnv
      )
    };
  }

  const intervalMinutes = await promptNumber(
    prompter,
    t("同步间隔（分钟）— 0 表示禁用定时同步", "Sync interval in minutes — 0 disables scheduled sync"),
    current.sync.intervalMinutes,
    0
  );
  const syncVisibility = await promptCheckbox(
    prompter,
    t("同步可见范围", "Sync visibility scopes"),
    [
      { name: t("私有", "Private"), value: "private" },
      { name: t("项目", "Project"), value: "project" },
      { name: t("团队", "Team"), value: "team" }
    ],
    current.sync.visibilityScopes
  );
  const syncSensitivity = await promptSelect(
    prompter,
    t("同步允许的最高敏感级别", "Maximum sensitivity allowed in sync"),
    [
      { name: t("公开", "Public"), value: "public", description: t("可公开传播", "Safe for public distribution") },
      { name: t("内部", "Internal"), value: "internal", description: t("组织或项目内部", "Organization or project internal") },
      { name: t("机密", "Confidential"), value: "confidential", description: t("限制成员可见的敏感业务信息", "Sensitive business information limited to authorized members") },
      { name: t("绝密", "Secret"), value: "secret", description: t("最高敏感级别；密钥原文仍禁止同步", "Highest sensitivity; raw credentials remain prohibited") }
    ],
    current.sync.sensitivityClearance
  );

  const configured = resolveUserConfig({
    version: 1,
    locale: uiLocale,
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
      cacheDir: embeddingCacheDir,
      allowRemoteModels,
      retrieval,
      embeddingTopK,
      rerankerProfile: current.embeddings.rerankerProfile,
      rerankerModel: rerankerModelAnswer.trim() || null
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
