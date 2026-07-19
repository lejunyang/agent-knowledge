/**
 * 配置向导只负责解释选项、收集答案并写入用户配置。
 *
 * 它不立即安装 integration、下载 embedding 模型或连接远端同步服务；这样一次配置操作
 * 不会产生难以撤销的外部副作用。对应命令会在实际执行时消费这些持久默认值。
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  resolveUserConfig,
  writeUserConfig,
  type UserConfig
} from "../core/config.js";

export type ConfigurationPrompter = {
  ask(question: string): Promise<string>;
};

export class TerminalConfigurationPrompter implements ConfigurationPrompter {
  private readonly readline = createInterface({ input: stdin, output: stdout });

  async ask(question: string): Promise<string> {
    return this.readline.question(question);
  }

  close(): void {
    this.readline.close();
  }
}

function withDefault(answer: string, defaultValue: string): string {
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : defaultValue;
}

function parseBoolean(answer: string, defaultValue: boolean): boolean {
  const normalized = answer.trim().toLowerCase();
  if (normalized.length === 0) {
    return defaultValue;
  }
  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }
  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }
  throw new Error(`Expected yes/no, received: ${answer}`);
}

function parsePositiveInteger(answer: string, defaultValue: number): number {
  const normalized = answer.trim();
  if (normalized.length === 0) {
    return defaultValue;
  }
  const value = Number.parseInt(normalized, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, received: ${answer}`);
  }
  return value;
}

function parseNonNegativeInteger(answer: string, defaultValue: number): number {
  const normalized = answer.trim();
  if (normalized.length === 0) {
    return defaultValue;
  }
  const value = Number.parseInt(normalized, 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, received: ${answer}`);
  }
  return value;
}

function parseList(answer: string, defaults: string[]): string[] {
  const normalized = answer.trim();
  return normalized.length === 0
    ? defaults
    : normalized
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
}

export async function runConfigurationWizard(options: {
  configPath: string;
  prompter: ConfigurationPrompter;
  current: UserConfig;
}): Promise<UserConfig> {
  const { prompter, current } = options;
  const knowledgeRoot = withDefault(
    await prompter.ask(
      `Knowledge root — Markdown facts and .memory caches live here [${current.knowledgeRoot}]: `
    ),
    current.knowledgeRoot
  );
  const actorType = withDefault(
    await prompter.ask(
      `Actor type — owner/teammate/customer/system controls write authority [${current.identity.actorType}]: `
    ),
    current.identity.actorType
  );
  const captureMode = withDefault(
    await prompter.ask(
      `Capture mode — explicit_remember/verified_task/automated_session/direct_material controls review policy [${current.identity.captureMode}]: `
    ),
    current.identity.captureMode
  );
  const identityVisibility = parseList(
    await prompter.ask(
      `Query visibility scopes — comma separated private,project,team [${current.identity.visibilityScopes.join(",")}]: `
    ),
    current.identity.visibilityScopes
  );
  const identitySensitivity = withDefault(
    await prompter.ask(
      `Query sensitivity clearance — public/internal/confidential/secret [${current.identity.sensitivityClearance}]: `
    ),
    current.identity.sensitivityClearance
  );

  const embeddingProvider = withDefault(
    await prompter.ask(
      `Embedding provider — transformers for semantic models, local for deterministic tests [${current.embeddings.provider}]: `
    ),
    current.embeddings.provider
  );
  const embeddingProfile = withDefault(
    await prompter.ask(
      `Embedding profile — multilingual-e5-small or bge-small-zh-v1.5 [${current.embeddings.profile}]: `
    ),
    current.embeddings.profile
  );
  const embeddingModelAnswer = await prompter.ask(
    `Embedding model/path — blank uses the selected profile [${current.embeddings.model ?? ""}]: `
  );
  const embeddingModel = withDefault(embeddingModelAnswer, current.embeddings.model ?? "");
  const allowRemoteModels = parseBoolean(
    await prompter.ask(
      `Allow Transformers.js remote model downloads? yes/no [${current.embeddings.allowRemoteModels ? "yes" : "no"}]: `
    ),
    current.embeddings.allowRemoteModels
  );
  const retrieval = withDefault(
    await prompter.ask(
      `Retrieval mode — lexical is lightweight; hybrid also uses embeddings [${current.embeddings.retrieval}]: `
    ),
    current.embeddings.retrieval
  );
  const embeddingTopK = parsePositiveInteger(
    await prompter.ask(
      `Embedding candidate count before reranking [${current.embeddings.embeddingTopK}]: `
    ),
    current.embeddings.embeddingTopK
  );

  const integrationProduct = withDefault(
    await prompter.ask(
      `Integration product — trae, trae-cn, or claude-code [${current.integration.product}]: `
    ),
    current.integration.product
  );
  const integrationScope = withDefault(
    await prompter.ask(
      `Integration scope — user or project [${current.integration.scope}]: `
    ),
    current.integration.scope
  );
  const integrationComponents = parseList(
    await prompter.ask(
      `Integration components — comma separated hooks,agents,skills,plugin-bundle [${current.integration.components.join(",")}]: `
    ),
    current.integration.components
  );
  const integrationTargetAnswer = await prompter.ask(
    `Integration target override — blank uses the product default [${current.integration.targetDir ?? ""}]: `
  );
  const integrationTarget = withDefault(integrationTargetAnswer, current.integration.targetDir ?? "");
  const integrationMode = withDefault(
    await prompter.ask(
      `Integration write mode — merge preserves foreign config; overwrite replaces targets [${current.integration.mode}]: `
    ),
    current.integration.mode
  );

  const syncProvider = withDefault(
    await prompter.ask(
      `Sync provider — none, webdav, or s3 [${current.sync.provider}]: `
    ),
    current.sync.provider
  );

  let webdav = current.sync.webdav;
  let s3 = current.sync.s3;
  if (syncProvider === "webdav") {
    webdav = {
      url: withDefault(
        await prompter.ask(`WebDAV base URL [${current.sync.webdav.url}]: `),
        current.sync.webdav.url
      ),
      username: withDefault(
        await prompter.ask(`WebDAV username [${current.sync.webdav.username}]: `),
        current.sync.webdav.username
      ),
      passwordEnv: withDefault(
        await prompter.ask(
          `Environment variable containing the WebDAV password [${current.sync.webdav.passwordEnv}]: `
        ),
        current.sync.webdav.passwordEnv
      )
    };
  } else if (syncProvider === "s3") {
    const endpointAnswer = await prompter.ask(
      `S3-compatible endpoint — blank uses AWS [${current.sync.s3.endpoint ?? ""}]: `
    );
    s3 = {
      bucket: withDefault(
        await prompter.ask(`S3 bucket [${current.sync.s3.bucket}]: `),
        current.sync.s3.bucket
      ),
      region: withDefault(
        await prompter.ask(`S3 region [${current.sync.s3.region}]: `),
        current.sync.s3.region
      ),
      prefix: withDefault(
        await prompter.ask(`S3 object prefix [${current.sync.s3.prefix}]: `),
        current.sync.s3.prefix
      ),
      endpoint: withDefault(endpointAnswer, current.sync.s3.endpoint ?? "") || null,
      forcePathStyle: parseBoolean(
        await prompter.ask(
          `Force path-style S3 addressing? yes/no [${current.sync.s3.forcePathStyle ? "yes" : "no"}]: `
        ),
        current.sync.s3.forcePathStyle
      ),
      accessKeyIdEnv: withDefault(
        await prompter.ask(
          `Environment variable containing the S3 access key ID [${current.sync.s3.accessKeyIdEnv}]: `
        ),
        current.sync.s3.accessKeyIdEnv
      ),
      secretAccessKeyEnv: withDefault(
        await prompter.ask(
          `Environment variable containing the S3 secret key [${current.sync.s3.secretAccessKeyEnv}]: `
        ),
        current.sync.s3.secretAccessKeyEnv
      ),
      sessionTokenEnv: withDefault(
        await prompter.ask(
          `Environment variable containing the optional S3 session token [${current.sync.s3.sessionTokenEnv}]: `
        ),
        current.sync.s3.sessionTokenEnv
      )
    };
  }

  const intervalMinutes = parseNonNegativeInteger(
    await prompter.ask(
      `Sync interval in minutes — 0 disables scheduled sync [${current.sync.intervalMinutes}]: `
    ),
    current.sync.intervalMinutes
  );
  const syncVisibility = parseList(
    await prompter.ask(
      `Sync visibility scopes [${current.sync.visibilityScopes.join(",")}]: `
    ),
    current.sync.visibilityScopes
  );
  const syncSensitivity = withDefault(
    await prompter.ask(
      `Maximum sensitivity allowed in sync [${current.sync.sensitivityClearance}]: `
    ),
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
