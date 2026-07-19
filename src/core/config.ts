/**
 * 用户配置是 CLI 各功能的持久默认值来源。
 *
 * 设计边界：
 * - 配置只保存行为参数和“凭据所在环境变量名”，不保存密码、access key 或 session token。
 * - 命令行显式参数始终优先；用户配置其次；环境变量用于兼容旧部署；最后才使用内置默认值。
 * - 读取时允许部分配置，统一通过 Zod 补齐默认值，避免每个命令重复处理缺失字段。
 */
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { ActorTypeSchema, CaptureModeSchema, SensitivitySchema, VisibilitySchema } from "./schema.js";
import type { LocalePreference } from "../i18n/locale.js";

const EmbeddingProfileSchema = z.enum(["multilingual-e5-small", "bge-small-zh-v1.5"]);
const IntegrationProductSchema = z.enum(["trae", "trae-cn", "claude-code"]);
const IntegrationComponentSchema = z.enum(["hooks", "agents", "skills", "plugin-bundle"]);

const IdentityConfigSchema = z
  .object({
    actorType: ActorTypeSchema.default("owner"),
    captureMode: CaptureModeSchema.default("direct_material"),
    visibilityScopes: z.array(VisibilitySchema).min(1).default(["private", "project", "team"]),
    sensitivityClearance: SensitivitySchema.default("internal")
  })
  .default({});

const EmbeddingsConfigSchema = z
  .object({
    provider: z.enum(["transformers", "local"]).default("transformers"),
    profile: EmbeddingProfileSchema.default("multilingual-e5-small"),
    model: z.string().min(1).nullable().default(null),
    allowRemoteModels: z.boolean().default(false),
    retrieval: z.enum(["lexical", "hybrid"]).default("lexical"),
    embeddingTopK: z.number().int().positive().default(20)
  })
  .default({});

const IntegrationConfigSchema = z
  .object({
    product: IntegrationProductSchema.default("trae"),
    scope: z.enum(["user", "project"]).default("user"),
    components: z.array(IntegrationComponentSchema).min(1).default(["hooks", "agents", "skills"]),
    targetDir: z.string().min(1).nullable().default(null),
    mode: z.enum(["merge", "overwrite"]).default("merge")
  })
  .default({});

const WebDavConfigSchema = z
  .object({
    url: z.string().default(""),
    username: z.string().default(""),
    passwordEnv: z.string().min(1).default("WEBDAV_PASSWORD")
  })
  .default({});

const S3ConfigSchema = z
  .object({
    bucket: z.string().default(""),
    region: z.string().min(1).default("us-east-1"),
    prefix: z.string().default(""),
    endpoint: z.string().nullable().default(null),
    forcePathStyle: z.boolean().default(false),
    accessKeyIdEnv: z.string().min(1).default("AWS_ACCESS_KEY_ID"),
    secretAccessKeyEnv: z.string().min(1).default("AWS_SECRET_ACCESS_KEY"),
    sessionTokenEnv: z.string().min(1).default("AWS_SESSION_TOKEN")
  })
  .default({});

const SyncConfigSchema = z
  .object({
    provider: z.enum(["none", "webdav", "s3"]).default("none"),
    intervalMinutes: z.number().int().nonnegative().default(0),
    visibilityScopes: z.array(VisibilitySchema).min(1).default(["project", "team"]),
    sensitivityClearance: SensitivitySchema.default("internal"),
    webdav: WebDavConfigSchema,
    s3: S3ConfigSchema
  })
  .default({});

const HookConfigSchema = z
  .object({
    minScore: z.number().min(0).max(1).default(0.55),
    maxTokens: z.number().int().positive().default(1200),
    catalogMaxItems: z.number().int().positive().max(20).default(5)
  })
  .default({});

export const UserConfigSchema = z.object({
  version: z.literal(1).default(1),
  locale: z.enum(["auto", "zh-CN", "en"]).default("auto"),
  knowledgeRoot: z.string().min(1).default(path.join(homedir(), ".agent_knowledge")),
  identity: IdentityConfigSchema,
  embeddings: EmbeddingsConfigSchema,
  integration: IntegrationConfigSchema,
  sync: SyncConfigSchema,
  hooks: HookConfigSchema
});

export type UserConfig = z.output<typeof UserConfigSchema>;
export type UserConfigInput = z.input<typeof UserConfigSchema>;
export type UserLocalePreference = LocalePreference;

export const DEFAULT_USER_CONFIG: UserConfig = UserConfigSchema.parse({});

export function getDefaultUserConfigPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  if (environment.AGENT_KNOWLEDGE_CONFIG) {
    return path.resolve(environment.AGENT_KNOWLEDGE_CONFIG);
  }
  const configHome = environment.XDG_CONFIG_HOME
    ? path.resolve(environment.XDG_CONFIG_HOME)
    : path.join(homedir(), ".config");
  return path.join(configHome, "agent-knowledge", "config.json");
}

export function resolveUserConfig(input: unknown = {}): UserConfig {
  return UserConfigSchema.parse(input);
}

export function readUserConfigSource(configPath = getDefaultUserConfigPath()): unknown {
  if (!existsSync(configPath)) {
    return {};
  }
  return JSON.parse(readFileSync(configPath, "utf8")) as unknown;
}

export function loadUserConfig(configPath = getDefaultUserConfigPath()): UserConfig {
  return resolveUserConfig(readUserConfigSource(configPath));
}

export function writeUserConfig(configPath: string, config: UserConfig): void {
  const resolvedPath = path.resolve(configPath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const temporaryPath = `${resolvedPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  renameSync(temporaryPath, resolvedPath);
}
