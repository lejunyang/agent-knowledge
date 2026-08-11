/**
 * Lark export Connector 把 `fetch-lark-corpus.mjs` 的离线导出接入统一 ingestion core。
 *
 * 它不调用网络或 lark-cli，只读 manifest.json、content.xml 与已下载媒体。文本先做 Lark
 * 句柄/用户身份治理；媒体原件作为 attachment 只进入加密 Vault，Git source manifest 只保存
 * 安全描述、hash 和父文档关系。Connector 不负责把任何二进制直接发布到知识 Git。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { ProjectKeySchema } from "../core/knowledgeV2.js";
import type { SourceVersionProbe } from "../storage/sourceManifest.js";
import {
  ConnectorIdSchema,
  ConnectorProcessingProfileSchema
} from "./types.js";
import type {
  ConnectorCursor,
  ConnectorSourceDescriptor,
  KnowledgeConnector,
  NormalizedArtifact
} from "./types.js";

const LarkDocumentSchema = z.object({
  key: z.string().min(1),
  requestedToken: z.string().min(1).optional(),
  fetchToken: z.string().min(1).optional(),
  objType: z.string().min(1).optional(),
  title: z.string().min(1),
  revisionId: z.union([z.string(), z.number()]).optional(),
  upstreamUpdatedAt: z.string().datetime().optional(),
  observedAt: z.string().datetime().optional(),
  directory: z.string().min(1),
  contentHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  mediaReferences: z
    .array(
      z.object({
        referenceId: z.string().regex(/^media_ref_[a-zA-Z0-9_-]+$/),
        kind: z.enum(["image", "attachment", "whiteboard"]),
        token: z.string().min(1),
        ordinal: z.number().int().nonnegative(),
        name: z.string().min(1).optional(),
        alt: z.string().optional(),
        mime: z.string().min(1).optional(),
        blockId: z.string().min(1).optional(),
        source: z.enum(["img", "source", "whiteboard"])
      })
    )
    .default([])
});

const LarkMediaSchema = z.object({
  referenceId: z.string().regex(/^media_ref_[a-zA-Z0-9_-]+$/),
  parent: z.string().min(1),
  kind: z.enum(["image", "attachment", "whiteboard"]),
  token: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  name: z.string().min(1).optional(),
  alt: z.string().optional(),
  mime: z.string().min(1).optional(),
  blockId: z.string().min(1).optional(),
  contentType: z.string().min(1),
  relativePath: z.string().min(1),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  downloadMethod: z.enum(["download", "preview"]),
  observedAt: z.string().datetime()
});

const LarkExportManifestSchema = z.object({
  version: z.literal(2),
  generatedAt: z.string().datetime(),
  roots: z.array(z.string().min(1)).min(1),
  documents: z.record(z.string(), LarkDocumentSchema),
  resources: z.record(z.string(), z.unknown()).default({}),
  media: z.record(z.string(), LarkMediaSchema).default({}),
  mediaFailures: z.record(z.string(), z.unknown()).default({}),
  failures: z.record(z.string(), z.unknown()).default({}),
  complete: z.boolean(),
  pending: z.array(z.unknown()).default([])
});

type LarkDocument = z.output<typeof LarkDocumentSchema>;
type LarkMedia = z.output<typeof LarkMediaSchema>;
type LarkExportManifest = z.output<typeof LarkExportManifestSchema>;

export type LarkExportConnectorOptions = {
  id: string;
  exportDir: string;
  projectKeys?: string[];
};

type LarkSnapshot = {
  exportRoot: string;
  manifest: LarkExportManifest;
  documents: LarkDocument[];
  media: LarkMedia[];
};

type LarkDiscoveredSource =
  | {
      kind: "document";
      document: LarkDocument;
    }
  | {
      kind: "attachment";
      media: LarkMedia;
      parentSourceId: string;
    };

/** 生成稳定 source ID；目录名和标题变化不会改变飞书文档身份。 */
function sourceId(connectorId: string, externalKey: string): string {
  return `src_${createHash("sha256")
    .update(`${connectorId}\0${externalKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 校验 manifest 相对路径解析后仍位于 export root，防止绝对路径和 symlink 越界。 */
async function safeExportPath(
  exportRoot: string,
  relativePath: string,
  description: string
): Promise<string> {
  const target = path.resolve(exportRoot, relativePath);
  const relative = path.relative(exportRoot, target);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(target)
  ) {
    throw new Error(`Lark export ${description} is outside or missing`);
  }
  const realTarget = await realpath(target);
  const realRelative = path.relative(exportRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Lark export ${description} escapes export directory`);
  }
  return realTarget;
}

/** 校验 document directory 并返回 content.xml。 */
async function contentPath(
  exportRoot: string,
  directory: string
): Promise<string> {
  return safeExportPath(
    exportRoot,
    path.join(directory, "content.xml"),
    "content"
  );
}

/** 解析飞书导出 XML 的双引号 attribute，仅用于将媒体 occurrence 与 manifest 对齐。 */
function parseXmlAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(/([:\w-]+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2]
      .replaceAll("&quot;", '"')
      .replaceAll("&apos;", "'")
      .replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">");
  }
  return attributes;
}

/** 编码安全 asset-ref attribute，避免标题或 alt 改写 XML 结构。 */
function encodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** 返回媒体 occurrence 对应的稳定 external key；不得包含飞书 token。 */
function mediaExternalKey(media: {
  parent: string;
  referenceId: string;
}): string {
  return `${media.parent}#media:${media.referenceId}`;
}

/**
 * 把图片、附件和画板标签替换为 attachment source 引用。
 *
 * occurrence 按 exporter 保存的 ordinal 对齐；token 只在内存中校验，绝不写入规范化 evidence。
 * 媒体下载失败时仍保留 unavailable asset-ref，帮助审阅者发现缺失，而不是静默删掉上下文。
 */
function replaceMediaReferences(
  content: string,
  document: LarkDocument,
  connectorId: string
): string {
  const references = [...document.mediaReferences].sort(
    (left, right) => left.ordinal - right.ordinal
  );
  let occurrence = 0;
  const replaced = content.replace(
    /<(img|source|whiteboard)\b([^>]*)\/?>/g,
    (_full, rawTag: string, attributeSource: string) => {
      const reference = references[occurrence];
      const ordinal = occurrence;
      occurrence += 1;
      if (!reference || reference.ordinal !== ordinal) {
        throw new Error(
          `Lark export media references do not match content: ${document.key}`
        );
      }
      const attributes = parseXmlAttributes(attributeSource);
      const observedToken =
        rawTag === "img" ? attributes.src : attributes.token;
      const expectedTag =
        reference.kind === "image"
          ? "img"
          : reference.kind === "attachment"
            ? "source"
            : "whiteboard";
      if (rawTag !== expectedTag || observedToken !== reference.token) {
        throw new Error(
          `Lark export media reference mismatch: ${document.key}#${reference.referenceId}`
        );
      }
      const externalKey = mediaExternalKey({
        parent: document.key,
        referenceId: reference.referenceId
      });
      const attributesForEvidence = [
        `source-id="${sourceId(connectorId, externalKey)}"`,
        `kind="${reference.kind}"`,
        ...(reference.name
          ? [`name="${encodeXmlAttribute(reference.name)}"`]
          : []),
        ...(reference.alt
          ? [`alt="${encodeXmlAttribute(reference.alt)}"`]
          : []),
        ...(reference.mime
          ? [`content-type="${encodeXmlAttribute(reference.mime)}"`]
          : [])
      ];
      return `<asset-ref ${attributesForEvidence.join(" ")}/>`;
    }
  );
  if (occurrence !== references.length) {
    throw new Error(
      `Lark export media references do not match content: ${document.key}`
    );
  }
  return replaced;
}

/** 清除临时下载句柄和飞书用户身份；后续通用 redaction 继续处理凭据与 PII 原值。 */
function normalizeLarkXml(
  content: string,
  document: LarkDocument,
  connectorId: string
): string {
  return replaceMediaReferences(content, document, connectorId)
    .replace(/\s+id="[^"]*"/g, "")
    .replace(
      /\s+href="https:\/\/internal-api-drive-stream\.[^"]*"/g,
      ""
    )
    .replace(/\s+src="[^"]*"/g, "")
    .replace(/\s+token="[^"]*"/g, "")
    .replace(
      /<cite\b[^>]*\btype="user"[^>]*>[\s\S]*?<\/cite>/gi,
      "[REDACTED_PERSON]"
    )
    .replace(
      /<cite\b[^>]*\btype="user"[^>]*\/?>/gi,
      "[REDACTED_PERSON]"
    )
    .replace(/\s+doc-id="([^"]*)"/g, ' doc-ref="$1"')
    .replace(/\s+src-token="([^"]*)"/g, ' doc-ref="$1"')
    .replace(/\s+src-block-id="[^"]*"/g, "");
}

/** 为二进制 attachment 构造只含审阅导航字段的安全描述。 */
function attachmentDescription(
  media: LarkMedia,
  parentSourceId: string
): string {
  const attributes = [
    `parent-source-id="${parentSourceId}"`,
    `kind="${media.kind}"`,
    `reference-id="${media.referenceId}"`,
    `content-type="${encodeXmlAttribute(media.contentType)}"`,
    ...(media.name ? [`name="${encodeXmlAttribute(media.name)}"`] : []),
    ...(media.alt ? [`alt="${encodeXmlAttribute(media.alt)}"`] : [])
  ];
  return `<attachment ${attributes.join(" ")}/>`;
}

/**
 * 读取完整飞书导出。
 *
 * `complete=false` 表示递归抓取被 limit/失败截断，不能做删除对账；为避免同一 Connector ID
 * 在 partial/complete 之间产生误删，本 adapter 直接拒绝不完整 manifest。
 */
export class LarkExportConnector implements KnowledgeConnector {
  readonly id: string;
  readonly processingProfile: string;
  readonly inventoryMode = "complete" as const;
  readonly requiredRedactionPolicy = "secrets-and-pii" as const;
  private readonly exportDir: string;
  private readonly projectKeys: string[];
  private snapshot: LarkSnapshot | null = null;
  private readonly discoveredBySourceId = new Map<
    string,
    LarkDiscoveredSource
  >();

  /** 保存显式 export 范围与 project scope；真实路径和 manifest 在首次读取时校验。 */
  constructor(options: LarkExportConnectorOptions) {
    this.id = ConnectorIdSchema.parse(options.id);
    this.processingProfile = ConnectorProcessingProfileSchema.parse(
      "lark-export-xml-media-v2"
    );
    this.exportDir = path.resolve(options.exportDir);
    this.projectKeys = (options.projectKeys ?? []).map((projectKey) =>
      ProjectKeySchema.parse(projectKey)
    );
  }

  /** 读取并冻结一次 export snapshot，保证 discover/fetch 使用同一 manifest。 */
  private async loadSnapshot(): Promise<LarkSnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    const exportRoot = await realpath(this.exportDir);
    const manifestPath = path.join(exportRoot, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Lark export manifest not found: ${manifestPath}`);
    }
    const manifest = LarkExportManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );
    const documents = Object.entries(manifest.documents)
      .map(([key, document]) => {
        if (document.key !== key) {
          throw new Error(`Lark export document key mismatch: ${key}`);
        }
        return document;
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    const media = Object.values(manifest.media).sort(
      (left, right) =>
        left.parent.localeCompare(right.parent) ||
        left.ordinal - right.ordinal ||
        left.referenceId.localeCompare(right.referenceId)
    );
    for (const item of media) {
      if (!manifest.documents[item.parent]) {
        throw new Error(
          `Lark export media parent is missing: ${item.referenceId}`
        );
      }
    }
    this.snapshot = { exportRoot, manifest, documents, media };
    return this.snapshot;
  }

  /** identity 绑定 export roots 与 project scope；切换语料范围必须使用新 Connector ID。 */
  async inventoryIdentity(): Promise<string> {
    const snapshot = await this.loadSnapshot();
    return `lark_inventory_${createHash("sha256")
      .update(
        JSON.stringify({
          roots: [...snapshot.manifest.roots].sort(),
          projectKeys: [...this.projectKeys].sort()
        })
      )
      .digest("hex")}`;
  }

  /** 返回 export generation probe，供删除对账记录 inventory 时间。 */
  async inventoryVersion(): Promise<SourceVersionProbe> {
    const snapshot = await this.loadSnapshot();
    return {
      observed_at: snapshot.manifest.generatedAt,
      upstream: {
        opaque_version: `lark-export:${snapshot.manifest.generatedAt}`
      }
    };
  }

  /** 显式报告未完成遍历或失败节点；core 会禁用删除对账但继续摄入成功文档。 */
  async inventoryStatus() {
    const snapshot = await this.loadSnapshot();
    const pending = snapshot.manifest.pending.length;
    const failures = Object.keys(snapshot.manifest.failures).length;
    const mediaFailures = Object.keys(
      snapshot.manifest.mediaFailures
    ).length;
    const complete =
      snapshot.manifest.complete &&
      pending === 0 &&
      failures === 0 &&
      mediaFailures === 0;
    const unresolved = pending + failures + mediaFailures;
    return {
      complete,
      unresolved,
      ...(complete
        ? {}
        : {
            reason: `lark_export_partial:pending=${pending},failures=${failures},media_failures=${mediaFailures}`
          })
    };
  }

  /** 发现文档和成功下载的 attachment；descriptor 不持久化飞书 token 或本机绝对路径。 */
  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    const snapshot = await this.loadSnapshot();
    for (const document of snapshot.documents) {
      const id = sourceId(this.id, document.key);
      this.discoveredBySourceId.set(id, {
        kind: "document",
        document
      });
      yield {
        sourceId: id,
        connectorId: this.id,
        externalKey: document.key,
        title: document.title,
        artifactKind: "document",
        contentType: "application/xml",
        projectKeys: this.projectKeys,
        probe: {
          observed_at:
            document.observedAt ?? snapshot.manifest.generatedAt,
          upstream: {
            ...(document.revisionId === undefined
              ? {}
              : { revision: String(document.revisionId) }),
            ...(document.upstreamUpdatedAt
              ? { updated_at: document.upstreamUpdatedAt }
              : {}),
            path_hash: document.contentHash.toLowerCase()
          }
        },
        metadata: {
          objType: document.objType ?? "docx",
          directory: document.directory
        }
      };
    }
    for (const media of snapshot.media) {
      const externalKey = mediaExternalKey(media);
      const id = sourceId(this.id, externalKey);
      const parentSourceId = sourceId(this.id, media.parent);
      this.discoveredBySourceId.set(id, {
        kind: "attachment",
        media,
        parentSourceId
      });
      yield {
        sourceId: id,
        connectorId: this.id,
        externalKey,
        title:
          media.name ??
          media.alt ??
          `${media.kind}-${media.referenceId}`,
        artifactKind: "attachment",
        contentType: media.contentType,
        projectKeys: this.projectKeys,
        probe: {
          observed_at: media.observedAt,
          upstream: {
            path_hash: media.sha256.toLowerCase(),
            opaque_version: `${media.kind}:${media.downloadMethod}`
          }
        },
        metadata: {
          parentSourceId,
          referenceId: media.referenceId,
          mediaKind: media.kind
        }
      };
    }
  }

  /** 读取并校验 document/media hash 和长度，拒绝 export manifest 与落盘文件撕裂。 */
  async fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    const snapshot = await this.loadSnapshot();
    const discovered = this.discoveredBySourceId.get(descriptor.sourceId);
    if (!discovered) {
      throw new Error(
        `Lark export source was not discovered: ${descriptor.sourceId}`
      );
    }
    if (discovered.kind === "attachment") {
      const target = await safeExportPath(
        snapshot.exportRoot,
        discovered.media.relativePath,
        `media ${discovered.media.referenceId}`
      );
      const raw = await readFile(target);
      const actualHash = createHash("sha256").update(raw).digest("hex");
      if (
        actualHash !== discovered.media.sha256.toLowerCase() ||
        raw.length !== discovered.media.bytes
      ) {
        throw new Error(
          `Lark export media hash mismatch: ${discovered.media.referenceId}`
        );
      }
      return raw;
    }
    const target = await contentPath(
      snapshot.exportRoot,
      discovered.document.directory
    );
    const raw = await readFile(target);
    const actualHash = createHash("sha256").update(raw).digest("hex");
    if (actualHash !== discovered.document.contentHash.toLowerCase()) {
      throw new Error(
        `Lark export content hash mismatch: ${discovered.document.key}`
      );
    }
    return raw;
  }

  /** 文档执行 XML 治理；attachment 保留原始 bytes，只把安全描述交给 source manifest。 */
  async normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact> {
    const discovered = this.discoveredBySourceId.get(descriptor.sourceId);
    if (!discovered) {
      throw new Error(
        `Lark export source was not discovered: ${descriptor.sourceId}`
      );
    }
    if (discovered.kind === "attachment") {
      return {
        encoding: "binary-vault-only",
        bytes: raw,
        textForManifest: attachmentDescription(
          discovered.media,
          discovered.parentSourceId
        ),
        contentType: discovered.media.contentType
      };
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(
        `Lark export source is not valid UTF-8 XML: ${descriptor.externalKey}`
      );
    }
    const normalized = normalizeLarkXml(
      text,
      discovered.document,
      this.id
    );
    return {
      encoding: "utf8",
      bytes: Buffer.from(normalized, "utf8"),
      textForManifest: normalized,
      contentType: "application/xml"
    };
  }
}
