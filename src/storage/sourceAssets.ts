/**
 * Source asset 模块把已审阅 attachment 从加密 Vault 显式发布到 Git 可跟踪事实层。
 *
 * 自动 ingestion 的终点仍是 Vault + source manifest；只有调用方确认审阅、source fingerprint
 * 未变化且 MIME 在被动内容允许清单内时，本模块才创建内容寻址对象。它不做 OCR、病毒扫描、
 * 像素 DLP 或授权判断，也不自动删除历史资产。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveWorkspacePath } from "../core/paths.js";
import { withConnectorIngestionLock } from "../ingestion/core.js";
import {
  SourceManifestSchema,
  type SourceManifest
} from "./sourceManifest.js";
import { getVaultObject, type VaultOptions } from "../vault/core.js";

const FingerprintSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/);
const AssetIdSchema = z
  .string()
  .regex(/^asset_sha256_[a-f0-9]{64}$/);
const ASSET_URI_PREFIX = `asset:${String.fromCharCode(47, 47)}`;

/** Git asset manifest 只保存来源、hash 和相对路径，不保存飞书 token 或本机绝对路径。 */
export const PublishedAssetManifestSchema = z.object({
  schema_version: z.literal(1),
  asset_id: AssetIdSchema,
  source_id: z.string().regex(/^src_[A-Za-z0-9_.-]+$/),
  source_fingerprint: FingerprintSchema,
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content_type: z.string().min(1),
  content_bytes: z.number().int().nonnegative(),
  title: z.string().min(1),
  relative_path: z
    .string()
    .regex(
      /^knowledge\/assets\/objects\/[a-f0-9]{2}\/asset_sha256_[a-f0-9]{64}\.[a-z0-9]+$/
    ),
  published_at: z.string().datetime()
});

export type PublishedAssetManifest = z.output<
  typeof PublishedAssetManifestSchema
>;

export type PublishSourceAssetResult = {
  assetId: string;
  uri: string;
  relativePath: string;
  manifestPath: string;
  bytes: number;
  contentType: string;
  deduplicated: boolean;
};

/**
 * 允许发布的 MIME 映射同时决定规范扩展名。
 *
 * 清单只包含常见被动图片、音视频、PDF、Office 和归档附件；HTML、SVG、脚本、可执行文件与
 * application/octet-stream 必须留在 Vault，防止未知 active content 被直接放进 Git/Markdown。
 */
const PUBLISHABLE_MEDIA_TYPES = new Map<string, string>([
  ["application/json", "json"],
  ["application/pdf", "pdf"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/msword", "doc"],
  [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "pptx"
  ],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsx"
  ],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "docx"
  ],
  ["application/zip", "zip"],
  ["audio/m4a", "m4a"],
  ["audio/mpeg", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/wav", "wav"],
  ["image/gif", "gif"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
  ["text/csv", "csv"],
  ["text/plain", "txt"],
  ["video/mp4", "mp4"],
  ["video/quicktime", "mov"],
  ["video/webm", "webm"]
]);

/** 返回 source manifest 规范路径，并通过 schema 防止 source ID 路径逃逸。 */
function sourceManifestPath(rootDir: string, sourceId: string): string {
  const parsed = z
    .string()
    .regex(/^src_[A-Za-z0-9_.-]+$/)
    .parse(sourceId);
  return resolveWorkspacePath(
    rootDir,
    "knowledge",
    "source-manifests",
    `${parsed}.json`
  );
}

/** 读取并运行时校验 source manifest；缺失和撕裂均显式失败。 */
async function readSourceManifest(
  rootDir: string,
  sourceId: string
): Promise<SourceManifest> {
  const target = sourceManifestPath(rootDir, sourceId);
  if (!existsSync(target)) {
    throw new Error(`Source manifest not found: ${sourceId}`);
  }
  return SourceManifestSchema.parse(
    JSON.parse(await readFile(target, "utf8"))
  );
}

/** 从内容 hash 生成公开资产 ID；它不继承上游 token 或 source identity。 */
function assetIdFromContentHash(contentHash: string): string {
  const hash = contentHash.replace(/^sha256:/, "");
  return AssetIdSchema.parse(`asset_sha256_${hash}`);
}

/** 返回 Git asset manifest 的绝对路径。 */
export function getPublishedAssetManifestPath(
  rootDir: string,
  assetId: string
): string {
  return resolveWorkspacePath(
    rootDir,
    "knowledge",
    "assets",
    "manifests",
    `${AssetIdSchema.parse(assetId)}.json`
  );
}

/** 构造 content-addressed object 相对路径；扩展名只来自 MIME allowlist。 */
function assetObjectRelativePath(
  assetId: string,
  extension: string
): string {
  const parsed = AssetIdSchema.parse(assetId);
  const hash = parsed.slice("asset_sha256_".length);
  return path.posix.join(
    "knowledge",
    "assets",
    "objects",
    hash.slice(0, 2),
    `${parsed}.${extension}`
  );
}

/** 原子写 JSON；已存在 manifest 由调用方先做内容一致性检查，不能静默覆盖。 */
async function writeJsonAtomic(
  target: string,
  value: PublishedAssetManifest
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify(PublishedAssetManifestSchema.parse(value), null, 2)}\n`,
      { encoding: "utf8", mode: 0o644 }
    );
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** 验证已有对象和 manifest 与当前发布请求完全一致，供幂等重试。 */
async function validateExistingPublication(
  rootDir: string,
  expected: Omit<PublishedAssetManifest, "published_at">,
  bytes: Buffer,
  manifestPath: string
): Promise<PublishedAssetManifest | null> {
  if (!existsSync(manifestPath)) {
    return null;
  }
  const manifest = PublishedAssetManifestSchema.parse(
    JSON.parse(await readFile(manifestPath, "utf8"))
  );
  for (const [key, value] of Object.entries(expected)) {
    if (manifest[key as keyof PublishedAssetManifest] !== value) {
      throw new Error(
        `Published asset manifest conflicts with source: ${expected.asset_id}`
      );
    }
  }
  const objectPath = resolveWorkspacePath(rootDir, manifest.relative_path);
  if (!existsSync(objectPath)) {
    throw new Error(`Published asset object is missing: ${expected.asset_id}`);
  }
  const existingBytes = await readFile(objectPath);
  if (!existingBytes.equals(bytes)) {
    throw new Error(
      `Published asset object hash mismatch: ${expected.asset_id}`
    );
  }
  return manifest;
}

/**
 * 显式发布一条已审阅 attachment。
 *
 * `reviewed` 是不可省略的用户/上层 Agent 确认；fingerprint 与 Connector 锁共同避免检查后
 * source 被刷新。Vault bytes 的 hash、长度和 MIME 必须与 source manifest 完全一致，
 * 任何冲突都拒绝覆盖已有 Git 文件。
 */
export async function publishSourceAsset(
  rootDir: string,
  input: {
    sourceId: string;
    expectedFingerprint: string;
    reviewed: boolean;
  },
  vault: VaultOptions
): Promise<PublishSourceAssetResult> {
  if (!input.reviewed) {
    throw new Error(
      "Publishing a source asset requires explicit reviewed confirmation"
    );
  }
  const expectedFingerprint = FingerprintSchema.parse(
    input.expectedFingerprint
  );
  const initial = await readSourceManifest(rootDir, input.sourceId);
  return withConnectorIngestionLock(rootDir, initial.connector, async () => {
    const manifest = await readSourceManifest(rootDir, input.sourceId);
    if (manifest.connector !== initial.connector) {
      throw new Error(`Source connector changed: ${input.sourceId}`);
    }
    if (manifest.version.fingerprint !== expectedFingerprint) {
      throw new Error(`Source fingerprint changed: ${input.sourceId}`);
    }
    if (
      manifest.artifact_kind !== "attachment" ||
      manifest.availability !== "available"
    ) {
      throw new Error(
        `Only available attachment sources can be published: ${input.sourceId}`
      );
    }
    const extension = PUBLISHABLE_MEDIA_TYPES.get(
      manifest.content_type.toLowerCase()
    );
    if (!extension) {
      throw new Error(
        `Attachment content type is not safe to publish: ${manifest.content_type}`
      );
    }
    if (!manifest.vault_object) {
      throw new Error(
        `Attachment source has no Vault object: ${input.sourceId}`
      );
    }
    const evidence = await getVaultObject(
      rootDir,
      manifest.vault_object,
      vault
    );
    const contentHash = `sha256:${createHash("sha256")
      .update(evidence.bytes)
      .digest("hex")}`;
    if (
      contentHash !== manifest.version.content_hash ||
      evidence.bytes.length !== manifest.content_bytes ||
      evidence.contentType.toLowerCase() !== manifest.content_type.toLowerCase()
    ) {
      throw new Error(
        `Attachment Vault evidence does not match source manifest: ${input.sourceId}`
      );
    }
    const assetId = assetIdFromContentHash(contentHash);
    const relativePath = assetObjectRelativePath(assetId, extension);
    const objectPath = resolveWorkspacePath(rootDir, relativePath);
    const manifestPath = getPublishedAssetManifestPath(rootDir, assetId);
    const expected = {
      schema_version: 1 as const,
      asset_id: assetId,
      source_id: manifest.source_id,
      source_fingerprint: manifest.version.fingerprint,
      content_hash: contentHash,
      content_type: manifest.content_type,
      content_bytes: evidence.bytes.length,
      title: manifest.title,
      relative_path: relativePath
    };
    const existing = await validateExistingPublication(
      rootDir,
      expected,
      evidence.bytes,
      manifestPath
    );
    if (existing) {
      return {
        assetId,
        uri: `${ASSET_URI_PREFIX}${assetId}`,
        relativePath,
        manifestPath,
        bytes: evidence.bytes.length,
        contentType: manifest.content_type,
        deduplicated: true
      };
    }

    await mkdir(path.dirname(objectPath), { recursive: true });
    try {
      await writeFile(objectPath, evidence.bytes, {
        flag: "wx",
        mode: 0o644
      });
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
      const existingBytes = await readFile(objectPath);
      if (!existingBytes.equals(evidence.bytes)) {
        throw new Error(`Published asset object conflicts: ${assetId}`);
      }
    }
    await writeJsonAtomic(
      manifestPath,
      PublishedAssetManifestSchema.parse({
        ...expected,
        published_at: new Date().toISOString()
      })
    );
    return {
      assetId,
      uri: `${ASSET_URI_PREFIX}${assetId}`,
      relativePath,
      manifestPath,
      bytes: evidence.bytes.length,
      contentType: manifest.content_type,
      deduplicated: false
    };
  });
}
