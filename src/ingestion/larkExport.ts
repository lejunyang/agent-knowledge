/**
 * Lark export Connector 把 `fetch-lark-corpus.mjs` 的离线导出接入统一 ingestion core。
 *
 * 它不调用网络或 lark-cli，只读 manifest.json 与 content.xml。完整导出才能声明 complete
 * inventory；正文先做 Lark XML 句柄/用户身份治理，再由 ingestion core 执行通用 secret/PII
 * redaction、Vault、source manifest v5、job 和 checkpoint。
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
  contentHash: z.string().regex(/^[a-fA-F0-9]{64}$/)
});

const LarkExportManifestSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  roots: z.array(z.string().min(1)).min(1),
  documents: z.record(z.string(), LarkDocumentSchema),
  resources: z.record(z.string(), z.unknown()).default({}),
  failures: z.record(z.string(), z.unknown()).default({}),
  complete: z.boolean(),
  pending: z.array(z.unknown()).default([])
});

type LarkDocument = z.output<typeof LarkDocumentSchema>;
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
};

/** 生成稳定 source ID；目录名和标题变化不会改变飞书文档身份。 */
function sourceId(connectorId: string, externalKey: string): string {
  return `src_${createHash("sha256")
    .update(`${connectorId}\0${externalKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 校验 document directory 解析后仍位于 export root，防止恶意 manifest 越界。 */
async function contentPath(
  exportRoot: string,
  directory: string
): Promise<string> {
  const target = path.resolve(exportRoot, directory, "content.xml");
  const relative = path.relative(exportRoot, target);
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !existsSync(target)
  ) {
    throw new Error(`Lark export content is outside or missing: ${directory}`);
  }
  const realTarget = await realpath(target);
  const realRelative = path.relative(exportRoot, realTarget);
  if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    throw new Error(`Lark export content escapes export directory: ${directory}`);
  }
  return realTarget;
}

/** 清除临时下载句柄和飞书用户身份；后续通用 redaction 继续处理凭据与 PII 原值。 */
function normalizeLarkXml(content: string): string {
  return content
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
  private readonly documentBySourceId = new Map<string, LarkDocument>();

  /** 保存显式 export 范围与 project scope；真实路径和 manifest 在首次读取时校验。 */
  constructor(options: LarkExportConnectorOptions) {
    this.id = ConnectorIdSchema.parse(options.id);
    this.processingProfile = ConnectorProcessingProfileSchema.parse(
      "lark-export-xml-v1"
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
    this.snapshot = { exportRoot, manifest, documents };
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
    const complete =
      snapshot.manifest.complete && pending === 0 && failures === 0;
    const unresolved = pending + failures;
    return {
      complete,
      unresolved,
      ...(complete
        ? {}
        : {
            reason: `lark_export_partial:pending=${pending},failures=${failures}`
          })
    };
  }

  /** 发现每个导出文档；contentHash 作为 path hash 优先判断正文是否需要读取。 */
  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    const snapshot = await this.loadSnapshot();
    for (const document of snapshot.documents) {
      const id = sourceId(this.id, document.key);
      this.documentBySourceId.set(id, document);
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
  }

  /** 读取并校验 content.xml 的 export content hash，拒绝 manifest/正文撕裂。 */
  async fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    const snapshot = await this.loadSnapshot();
    const document = this.documentBySourceId.get(descriptor.sourceId);
    if (!document) {
      throw new Error(
        `Lark export source was not discovered: ${descriptor.sourceId}`
      );
    }
    const target = await contentPath(snapshot.exportRoot, document.directory);
    const raw = await readFile(target);
    const actualHash = createHash("sha256").update(raw).digest("hex");
    if (actualHash !== document.contentHash.toLowerCase()) {
      throw new Error(
        `Lark export content hash mismatch: ${document.key}`
      );
    }
    return raw;
  }

  /** UTF-8 解码并执行 Lark XML 专项治理；通用 redaction 由 ingestion core 随后执行。 */
  async normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact> {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(
        `Lark export source is not valid UTF-8 XML: ${descriptor.externalKey}`
      );
    }
    const normalized = normalizeLarkXml(text);
    return {
      bytes: Buffer.from(normalized, "utf8"),
      textForManifest: normalized,
      contentType: "application/xml"
    };
  }
}
