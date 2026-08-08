/**
 * Connector registry 保存可重复执行的本地来源配置。
 *
 * 登记表位于 `.memory` 且权限为 0600，不进入 Git、同步或普通 query。它只保存内置
 * Connector 的非凭据参数；完整 inventory Connector 还绑定 inventory identity，避免同一
 * Connector ID 被另一个仓库、飞书空间或 path scope 复用。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ProjectKeySchema } from "../core/knowledgeV2.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { FileSystemConnector, createTranscriptConnector } from "./filesystem.js";
import { GitRepositoryConnector } from "./gitRepository.js";
import { LarkExportConnector } from "./larkExport.js";
import {
  ArtifactKindSchema,
  ConnectorIdSchema,
  ConnectorInventoryIdentitySchema,
  EvidenceRedactionPolicySchema,
  type KnowledgeConnector
} from "./types.js";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "expected an absolute path");

const FilesRegistrationSchema = z
  .object({
    kind: z.literal("files"),
    connectorId: ConnectorIdSchema,
    redactionPolicy: EvidenceRedactionPolicySchema,
    options: z
      .object({
        baseDir: AbsolutePathSchema,
        patterns: z.array(z.string().min(1)).min(1),
        artifactKind: ArtifactKindSchema.exclude([
          "transcript",
          "attachment"
        ]),
        projectKeys: z.array(ProjectKeySchema),
        contentType: z.string().min(1).optional()
      })
      .strict()
  })
  .strict();

const TranscriptRegistrationSchema = z
  .object({
    kind: z.literal("transcripts"),
    connectorId: ConnectorIdSchema,
    redactionPolicy: z.literal("secrets-and-pii"),
    options: z
      .object({
        baseDir: AbsolutePathSchema,
        patterns: z.array(z.string().min(1)).min(1),
        projectKeys: z.array(ProjectKeySchema)
      })
      .strict()
  })
  .strict();

const GitRegistrationSchema = z
  .object({
    kind: z.literal("git"),
    connectorId: ConnectorIdSchema,
    redactionPolicy: EvidenceRedactionPolicySchema,
    options: z
      .object({
        repositoryDir: AbsolutePathSchema,
        ref: z.string().min(1),
        pathspecs: z.array(z.string().min(1)).min(1),
        projectKey: ProjectKeySchema.optional()
      })
      .strict()
  })
  .strict();

const LarkExportRegistrationSchema = z
  .object({
    kind: z.literal("lark-export"),
    connectorId: ConnectorIdSchema,
    redactionPolicy: z.literal("secrets-and-pii"),
    options: z
      .object({
        exportDir: AbsolutePathSchema,
        projectKeys: z.array(ProjectKeySchema)
      })
      .strict()
  })
  .strict();

/** 登记输入只允许仓库内置 Connector，未知字段会被拒绝而不是静默持久化。 */
export const ConnectorRegistrationInputSchema = z.discriminatedUnion("kind", [
  FilesRegistrationSchema,
  TranscriptRegistrationSchema,
  GitRegistrationSchema,
  LarkExportRegistrationSchema
]);

export type ConnectorRegistrationInput = z.output<
  typeof ConnectorRegistrationInputSchema
>;

const RegistrationCommonSchema = z.object({
  version: z.literal(1),
  registeredAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  generation: z
    .string()
    .regex(/^registration_sha256_[a-f0-9]{64}$/),
  inventoryIdentity: ConnectorInventoryIdentitySchema.optional(),
  scopeFingerprint: z
    .string()
    .regex(/^scope_sha256_[a-f0-9]{64}$/)
});

/** 持久化记录附带时间与 scope fingerprint，正文、凭据和 Vault key 不属于该契约。 */
export const ConnectorRegistrationSchema = z.discriminatedUnion("kind", [
  FilesRegistrationSchema.merge(RegistrationCommonSchema).strict(),
  TranscriptRegistrationSchema.merge(RegistrationCommonSchema).strict(),
  GitRegistrationSchema.merge(
    RegistrationCommonSchema.extend({
      inventoryIdentity: ConnectorInventoryIdentitySchema
    })
  ).strict(),
  LarkExportRegistrationSchema.merge(
    RegistrationCommonSchema.extend({
      inventoryIdentity: ConnectorInventoryIdentitySchema
    })
  ).strict()
]);

export type ConnectorRegistration = z.output<
  typeof ConnectorRegistrationSchema
>;

export type RegisterConnectorResult = {
  record: ConnectorRegistration;
  path: string;
  created: boolean;
};

/** 用稳定 hash 生成登记文件名，避免 Connector ID 中的冒号影响跨平台路径。 */
function registrationFileName(connectorId: string): string {
  const parsed = ConnectorIdSchema.parse(connectorId);
  return `${createHash("sha256").update(parsed).digest("hex").slice(0, 20)}.json`;
}

/** 返回单个 Connector 登记路径；登记只属于本机运行状态。 */
export function getConnectorRegistrationPath(
  rootDir: string,
  connectorId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "connectors",
    registrationFileName(connectorId)
  );
}

/** 对 scope 使用规范排序，避免 pattern/project key 参数顺序造成伪冲突。 */
function canonicalScope(input: ConnectorRegistrationInput): unknown {
  switch (input.kind) {
    case "files":
      return {
        kind: input.kind,
        baseDir: input.options.baseDir,
        patterns: [...input.options.patterns].sort(),
        artifactKind: input.options.artifactKind,
        projectKeys: [...input.options.projectKeys].sort(),
        contentType: input.options.contentType ?? null
      };
    case "transcripts":
      return {
        kind: input.kind,
        baseDir: input.options.baseDir,
        patterns: [...input.options.patterns].sort(),
        projectKeys: [...input.options.projectKeys].sort()
      };
    case "git":
    case "lark-export":
      throw new Error(
        `Complete inventory Connector scope requires inventory identity: ${input.connectorId}`
      );
  }
}

/**
 * 计算 source identity scope。
 *
 * files/transcripts 没有 provider identity，因此本地路径属于身份；Git/Lark 则使用 Connector
 * 已验证的 inventory identity，使同一仓库或导出 scope 搬移本地目录后仍可更新登记。
 */
function scopeFingerprint(
  input: ConnectorRegistrationInput,
  inventoryIdentity?: string
): string {
  const scope =
    input.kind === "git" || input.kind === "lark-export"
      ? {
          kind: input.kind,
          inventoryIdentity: ConnectorInventoryIdentitySchema.parse(
            inventoryIdentity
          )
        }
      : canonicalScope(input);
  return `scope_sha256_${createHash("sha256")
    .update(JSON.stringify(scope))
    .digest("hex")}`;
}

/** 把调用参数中的相对路径规范为绝对路径，再执行 strict schema 校验。 */
function normalizeRegistrationInput(
  input: z.input<typeof ConnectorRegistrationInputSchema>
): ConnectorRegistrationInput {
  if (!input || typeof input !== "object" || !("kind" in input)) {
    return ConnectorRegistrationInputSchema.parse(input);
  }
  switch (input.kind) {
    case "files":
    case "transcripts":
      return ConnectorRegistrationInputSchema.parse({
        ...input,
        options: {
          ...input.options,
          baseDir: path.resolve(input.options.baseDir)
        }
      });
    case "git":
      return ConnectorRegistrationInputSchema.parse({
        ...input,
        options: {
          ...input.options,
          repositoryDir: path.resolve(input.options.repositoryDir)
        }
      });
    case "lark-export":
      return ConnectorRegistrationInputSchema.parse({
        ...input,
        options: {
          ...input.options,
          exportDir: path.resolve(input.options.exportDir)
        }
      });
    default:
      return ConnectorRegistrationInputSchema.parse(input);
  }
}

/** 原子写 0600 登记，避免进程中断留下半份 JSON 或宽松权限文件。 */
async function writeRegistration(
  target: string,
  record: ConnectorRegistration
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(
    temporary,
    `${JSON.stringify(ConnectorRegistrationSchema.parse(record), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await rename(temporary, target);
}

/** 读取单个严格登记；缺失返回 null，非法内容直接失败以暴露本地状态损坏。 */
export async function readConnectorRegistration(
  rootDir: string,
  connectorId: string
): Promise<ConnectorRegistration | null> {
  const target = getConnectorRegistrationPath(rootDir, connectorId);
  if (!existsSync(target)) {
    return null;
  }
  const record = ConnectorRegistrationSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
  if (record.connectorId !== ConnectorIdSchema.parse(connectorId)) {
    throw new Error(`Connector registration ID mismatch: ${connectorId}`);
  }
  return record;
}

/** 列出全部登记并按 Connector ID 排序，非法文件不会被静默跳过。 */
export async function listConnectorRegistrations(
  rootDir: string
): Promise<ConnectorRegistration[]> {
  const directory = resolveWorkspacePath(
    rootDir,
    ".memory",
    "ingestion",
    "connectors"
  );
  if (!existsSync(directory)) {
    return [];
  }
  const records: ConnectorRegistration[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    records.push(
      ConnectorRegistrationSchema.parse(
        JSON.parse(await readFile(path.join(directory, entry.name), "utf8"))
      )
    );
  }
  return records.sort((left, right) =>
    left.connectorId.localeCompare(right.connectorId)
  );
}

/**
 * 新增或刷新 Connector 登记。
 *
 * scope fingerprint 不变时允许更新本地路径或 redaction policy；scope 改变必须使用新 ID，
 * 防止后续 complete inventory 把旧来源误判为删除。登记不接受任意 metadata 或 secret。
 */
export async function registerConnector(
  rootDir: string,
  rawInput: z.input<typeof ConnectorRegistrationInputSchema>,
  options: { inventoryIdentity?: string; now?: () => Date } = {}
): Promise<RegisterConnectorResult> {
  const input = normalizeRegistrationInput(rawInput);
  const inventoryIdentity =
    input.kind === "git" || input.kind === "lark-export"
      ? ConnectorInventoryIdentitySchema.parse(options.inventoryIdentity)
      : undefined;
  if (
    input.kind !== "git" &&
    input.kind !== "lark-export" &&
    options.inventoryIdentity !== undefined
  ) {
    throw new Error(
      `Partial inventory Connector cannot register inventory identity: ${input.connectorId}`
    );
  }
  const fingerprint = scopeFingerprint(input, inventoryIdentity);
  const existing = await readConnectorRegistration(
    rootDir,
    input.connectorId
  );
  if (existing && existing.scopeFingerprint !== fingerprint) {
    throw new Error(
      `Connector registration scope changed; use a new connector ID: ${input.connectorId}`
    );
  }
  if (existing && existing.kind !== input.kind) {
    throw new Error(
      `Connector registration kind changed; use a new connector ID: ${input.connectorId}`
    );
  }
  const now = (options.now?.() ?? new Date()).toISOString();
  const record = ConnectorRegistrationSchema.parse({
    ...input,
    version: 1,
    registeredAt: existing?.registeredAt ?? now,
    updatedAt: now,
    // 每次登记都轮换 generation；不能只靠毫秒时间判断旧 update report 是否失效。
    generation: `registration_sha256_${createHash("sha256")
      .update(randomUUID())
      .digest("hex")}`,
    ...(inventoryIdentity ? { inventoryIdentity } : {}),
    scopeFingerprint: fingerprint
  });
  const target = getConnectorRegistrationPath(rootDir, input.connectorId);
  await writeRegistration(target, record);
  return { record, path: target, created: existing === null };
}

/**
 * 从严格登记恢复内置 Connector。
 *
 * factory 只构造本地/离线 adapter，不 fetch remote、不读取正文；实际 discover/check/ingest
 * 由调用方在明确命令中触发。
 */
export function createConnectorFromRegistration(
  rawRegistration: ConnectorRegistration
): KnowledgeConnector {
  const registration = ConnectorRegistrationSchema.parse(rawRegistration);
  switch (registration.kind) {
    case "files":
      return new FileSystemConnector({
        id: registration.connectorId,
        baseDir: registration.options.baseDir,
        patterns: registration.options.patterns,
        artifactKind: registration.options.artifactKind,
        projectKeys: registration.options.projectKeys,
        contentType: registration.options.contentType
      });
    case "transcripts":
      return createTranscriptConnector({
        id: registration.connectorId,
        baseDir: registration.options.baseDir,
        patterns: registration.options.patterns,
        projectKeys: registration.options.projectKeys
      });
    case "git":
      return new GitRepositoryConnector({
        id: registration.connectorId,
        repositoryDir: registration.options.repositoryDir,
        ref: registration.options.ref,
        pathspecs: registration.options.pathspecs,
        projectKey: registration.options.projectKey
      });
    case "lark-export":
      return new LarkExportConnector({
        id: registration.connectorId,
        exportDir: registration.options.exportDir,
        projectKeys: registration.options.projectKeys
      });
  }
}
