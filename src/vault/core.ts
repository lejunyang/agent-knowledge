/**
 * Evidence Vault 保存完整文档、会话、工具轨迹和附件的加密对象。
 *
 * Vault 位于 workspace `.vault/`，不进入 Git、Markdown 同步或普通检索。对象使用
 * AES-256-GCM 客户端加密，ID 来自明文字节 SHA-256；读取时同时校验 GCM 认证标签和
 * 明文 hash。删除会物理移除密文并写 tombstone，避免 Git 历史残留原文。
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";

const VaultObjectIdSchema = z
  .string()
  .regex(/^vault_sha256_[a-f0-9]{64}$/);

const VaultEnvelopeSchema = z.object({
  version: z.literal(1),
  id: VaultObjectIdSchema,
  algorithm: z.literal("aes-256-gcm"),
  key_id: z.string().regex(/^key_[a-f0-9]{16}$/),
  plaintext_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content_type: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  iv: z.string().min(1),
  auth_tag: z.string().min(1),
  ciphertext: z.string()
});

const VaultTombstoneSchema = z.object({
  version: z.literal(1),
  id: VaultObjectIdSchema,
  deleted_at: z.string().datetime(),
  reason_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional()
});

export type VaultEnvelope = z.output<typeof VaultEnvelopeSchema>;
export type VaultTombstone = z.output<typeof VaultTombstoneSchema>;

export type VaultPutResult = {
  id: string;
  objectPath: string;
  bytes: number;
  contentType: string;
  deduplicated: boolean;
};

export type VaultGetResult = {
  id: string;
  bytes: Buffer;
  contentType: string;
  createdAt: string;
};

export type VaultDeleteResult = {
  id: string;
  deleted: boolean;
  tombstonePath: string;
};

export type VaultStatus = {
  initialized: boolean;
  keyAvailable: boolean;
  keyId?: string;
  objects: number;
  tombstones: number;
  encryptedBytes: number;
};

export type VaultOptions = {
  key: Buffer;
  actor?: string;
  now?: () => Date;
};

/** 计算统一 SHA-256 hex。 */
function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 从 key 派生非敏感标识，用于拒绝错误密钥下的静默 dedupe。 */
function keyId(key: Buffer): string {
  return `key_${sha256(key).slice(0, 16)}`;
}

/** Vault object ID 只依赖明文字节，便于跨 connector 去重。 */
export function vaultObjectId(bytes: Buffer): string {
  return `vault_sha256_${sha256(bytes)}`;
}

/** 解析 64 位 hex 或 base64 编码的 32 字节密钥。 */
export function parseVaultKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-fA-F0-9]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error(
      "Evidence Vault key must be exactly 32 bytes encoded as 64 hex characters or base64"
    );
  }
  return key;
}

/** 从环境变量读取密钥；只接受变量名，不允许把密钥写进配置或参数日志。 */
export function vaultKeyFromEnvironment(
  keyEnv = "AGENT_KNOWLEDGE_VAULT_KEY",
  environment: NodeJS.ProcessEnv = process.env
): Buffer {
  const value = environment[keyEnv];
  if (!value) {
    throw new Error(`Missing Evidence Vault key environment variable: ${keyEnv}`);
  }
  return parseVaultKey(value);
}

/** 返回 Vault 根目录。 */
export function getVaultRoot(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".vault");
}

/** 按明文 hash 前两位分片对象路径，避免单目录文件数无限增长。 */
export function getVaultObjectPath(rootDir: string, id: string): string {
  const parsed = VaultObjectIdSchema.parse(id);
  const hash = parsed.slice("vault_sha256_".length);
  return resolveWorkspacePath(
    rootDir,
    ".vault",
    "objects",
    hash.slice(0, 2),
    `${parsed}.json`
  );
}

/** 返回 tombstone 路径。 */
export function getVaultTombstonePath(rootDir: string, id: string): string {
  const parsed = VaultObjectIdSchema.parse(id);
  return resolveWorkspacePath(
    rootDir,
    ".vault",
    "tombstones",
    `${parsed}.json`
  );
}

/** 返回按日分片的访问日志路径。 */
function accessLogPath(rootDir: string, now: Date): string {
  return resolveWorkspacePath(
    rootDir,
    ".vault",
    "access-log",
    `${now.toISOString().slice(0, 10)}.jsonl`
  );
}

/** 原子写密文 envelope 或 tombstone，避免崩溃留下半写 JSON。 */
async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, target);
}

/** 追加不含内容和路径的访问摘要。 */
async function appendAccessLog(
  rootDir: string,
  event: {
    action: "put" | "get" | "delete";
    id: string;
    actor?: string;
    bytes?: number;
    deduplicated?: boolean;
  },
  now: Date
): Promise<void> {
  const target = accessLogPath(rootDir, now);
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(
    target,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      action: event.action,
      id: event.id,
      actor: event.actor?.slice(0, 80),
      bytes: event.bytes,
      deduplicated: event.deduplicated
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

/** 构造绑定对象 ID 和 content type 的 GCM AAD，防止 envelope 字段被替换。 */
function additionalAuthenticatedData(input: {
  id: string;
  contentType: string;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      id: input.id,
      content_type: input.contentType
    }),
    "utf8"
  );
}

/** 初始化 Vault 目录并验证密钥长度；不生成或持久化密钥。 */
export async function initializeVault(
  rootDir: string,
  options: VaultOptions
): Promise<{ initialized: true; rootDir: string; keyId: string }> {
  if (options.key.length !== 32) {
    throw new Error("Evidence Vault key must be exactly 32 bytes");
  }
  const vaultRoot = getVaultRoot(rootDir);
  for (const directory of [
    "objects",
    "manifests",
    "tombstones",
    "access-log"
  ]) {
    await mkdir(path.join(vaultRoot, directory), {
      recursive: true,
      mode: 0o700
    });
  }
  return { initialized: true, rootDir: vaultRoot, keyId: keyId(options.key) };
}

/** 加密并内容寻址写入完整 evidence；相同明文在相同密钥下幂等去重。 */
export async function putVaultObject(
  rootDir: string,
  input: {
    bytes: Buffer;
    contentType: string;
  },
  options: VaultOptions
): Promise<VaultPutResult> {
  await initializeVault(rootDir, options);
  const now = options.now?.() ?? new Date();
  const id = vaultObjectId(input.bytes);
  const objectPath = getVaultObjectPath(rootDir, id);
  if (existsSync(getVaultTombstonePath(rootDir, id))) {
    throw new Error(
      `Evidence Vault object was deleted and cannot be silently recreated: ${id}`
    );
  }
  if (existsSync(objectPath)) {
    const existing = VaultEnvelopeSchema.parse(
      JSON.parse(await readFile(objectPath, "utf8"))
    );
    if (existing.key_id !== keyId(options.key)) {
      throw new Error(
        `Evidence Vault object exists under a different key; rotate explicitly: ${id}`
      );
    }
    await appendAccessLog(
      rootDir,
      {
        action: "put",
        id,
        actor: options.actor,
        bytes: input.bytes.length,
        deduplicated: true
      },
      now
    );
    return {
      id,
      objectPath,
      bytes: input.bytes.length,
      contentType: existing.content_type,
      deduplicated: true
    };
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", options.key, iv);
  cipher.setAAD(
    additionalAuthenticatedData({ id, contentType: input.contentType })
  );
  const ciphertext = Buffer.concat([
    cipher.update(input.bytes),
    cipher.final()
  ]);
  const envelope = VaultEnvelopeSchema.parse({
    version: 1,
    id,
    algorithm: "aes-256-gcm",
    key_id: keyId(options.key),
    plaintext_hash: `sha256:${sha256(input.bytes)}`,
    content_type: input.contentType,
    bytes: input.bytes.length,
    created_at: now.toISOString(),
    iv: iv.toString("base64"),
    auth_tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  });
  await writeAtomic(objectPath, `${JSON.stringify(envelope)}\n`);
  await appendAccessLog(
    rootDir,
    {
      action: "put",
      id,
      actor: options.actor,
      bytes: input.bytes.length,
      deduplicated: false
    },
    now
  );
  return {
    id,
    objectPath,
    bytes: input.bytes.length,
    contentType: input.contentType,
    deduplicated: false
  };
}

/** 解密对象并验证认证标签、ID 和明文 hash；任何不一致都明确失败。 */
export async function getVaultObject(
  rootDir: string,
  id: string,
  options: VaultOptions
): Promise<VaultGetResult> {
  const objectPath = getVaultObjectPath(rootDir, id);
  if (!existsSync(objectPath)) {
    throw new Error(`Evidence Vault object not found: ${id}`);
  }
  const envelope = VaultEnvelopeSchema.parse(
    JSON.parse(await readFile(objectPath, "utf8"))
  );
  if (envelope.key_id !== keyId(options.key)) {
    throw new Error(`Evidence Vault key mismatch for object: ${id}`);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    options.key,
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(
    additionalAuthenticatedData({
      id: envelope.id,
      contentType: envelope.content_type
    })
  );
  decipher.setAuthTag(Buffer.from(envelope.auth_tag, "base64"));
  let bytes: Buffer;
  try {
    bytes = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final()
    ]);
  } catch {
    throw new Error(`Evidence Vault authentication failed for object: ${id}`);
  }
  const plaintextHash = `sha256:${sha256(bytes)}`;
  if (
    envelope.id !== id ||
    vaultObjectId(bytes) !== id ||
    plaintextHash !== envelope.plaintext_hash ||
    bytes.length !== envelope.bytes
  ) {
    throw new Error(`Evidence Vault integrity check failed for object: ${id}`);
  }
  const now = options.now?.() ?? new Date();
  await appendAccessLog(
    rootDir,
    { action: "get", id, actor: options.actor, bytes: bytes.length },
    now
  );
  return {
    id,
    bytes,
    contentType: envelope.content_type,
    createdAt: envelope.created_at
  };
}

/**
 * 把解密对象写入显式目标文件。
 *
 * 默认使用 `wx` 拒绝覆盖，文件权限为 0600；调用方必须显式 `overwrite=true` 才能替换。
 * 函数不返回明文，避免 CLI 或日志意外序列化完整 evidence。
 */
export async function writeVaultObjectToFile(
  rootDir: string,
  input: {
    id: string;
    outputPath: string;
    overwrite?: boolean;
  },
  options: VaultOptions
): Promise<{
  id: string;
  outputPath: string;
  bytes: number;
  contentType: string;
}> {
  const result = await getVaultObject(rootDir, input.id, options);
  const outputPath = path.resolve(input.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.bytes, {
    flag: input.overwrite ? "w" : "wx",
    mode: 0o600
  });
  return {
    id: result.id,
    outputPath,
    bytes: result.bytes.length,
    contentType: result.contentType
  };
}

/** 物理删除密文并写 tombstone；默认禁止同 ID 静默复活。 */
export async function deleteVaultObject(
  rootDir: string,
  id: string,
  input: { reason?: string } = {},
  options: VaultOptions
): Promise<VaultDeleteResult> {
  const objectPath = getVaultObjectPath(rootDir, id);
  const tombstonePath = getVaultTombstonePath(rootDir, id);
  const now = options.now?.() ?? new Date();
  const deleted = existsSync(objectPath);
  await rm(objectPath, { force: true });
  const tombstone = VaultTombstoneSchema.parse({
    version: 1,
    id,
    deleted_at: now.toISOString(),
    ...(input.reason
      ? { reason_hash: `sha256:${sha256(input.reason)}` }
      : {})
  });
  await writeAtomic(tombstonePath, `${JSON.stringify(tombstone, null, 2)}\n`);
  await appendAccessLog(
    rootDir,
    { action: "delete", id, actor: options.actor },
    now
  );
  return { id, deleted, tombstonePath };
}

/** 递归统计指定目录中的文件数量和字节数。 */
async function directoryStats(
  directory: string
): Promise<{ files: number; bytes: number }> {
  if (!existsSync(directory)) {
    return { files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await directoryStats(target);
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += (await stat(target)).size;
    }
  }
  return { files, bytes };
}

/** 返回不泄露对象内容、文件名或访问日志的 Vault 健康摘要。 */
export async function getVaultStatus(
  rootDir: string,
  input: { key?: Buffer } = {}
): Promise<VaultStatus> {
  const vaultRoot = getVaultRoot(rootDir);
  const objects = await directoryStats(path.join(vaultRoot, "objects"));
  const tombstones = await directoryStats(path.join(vaultRoot, "tombstones"));
  return {
    initialized: existsSync(vaultRoot),
    keyAvailable: input.key?.length === 32,
    ...(input.key?.length === 32 ? { keyId: keyId(input.key) } : {}),
    objects: objects.files,
    tombstones: tombstones.files,
    encryptedBytes: objects.bytes
  };
}
