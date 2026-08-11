/**
 * 文件系统 Connector 为本地文档和宿主 transcript 提供统一增量输入。
 *
 * 它只读取显式 baseDir 下匹配 glob 的普通文件，不跟随目录外路径；版本 probe 使用
 * mtime+size，完整抓取后仍由 ingestion core 比较 content hash，避免仅依赖时间戳。
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { TextDecoder } from "node:util";
import path from "node:path";
import fg from "fast-glob";
import {
  ConnectorIdSchema,
  ConnectorProcessingProfileSchema
} from "./types.js";
import type {
  ArtifactKind,
  ConnectorCursor,
  ConnectorSourceDescriptor,
  KnowledgeConnector,
  NormalizedArtifact
} from "./types.js";

export type FileSystemConnectorOptions = {
  id: string;
  baseDir: string;
  patterns: string[];
  artifactKind: ArtifactKind;
  projectKeys?: string[];
  contentType?: string;
};

/** 生成稳定 source ID，路径变化会被视为新 source，内容变化只改变版本。 */
function sourceId(connectorId: string, externalKey: string): string {
  return `src_${createHash("sha256")
    .update(`${connectorId}\0${externalKey}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 根据扩展名给文本证据提供基本 MIME；调用方可显式覆盖。 */
function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".json":
      return "application/json";
    case ".jsonl":
      return "application/x-ndjson";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".xml":
      return "application/xml";
    case ".yaml":
    case ".yml":
      return "application/yaml";
    default:
      return "text/plain";
  }
}

/** 确保发现文件仍位于 real baseDir 内，防止 symlink/相对路径越界读取。 */
async function assertInsideBase(
  baseDir: string,
  filePath: string
): Promise<string> {
  const realBase = await realpath(baseDir);
  const realFile = await realpath(filePath);
  const relative = path.relative(realBase, realFile);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Connector file escapes base directory: ${filePath}`);
  }
  return realFile;
}

/**
 * 读取限定目录中的 UTF-8 文本证据。
 *
 * 该 Connector 不跟随符号链接、不解释二进制附件，也不写 checkpoint；目录边界在
 * discover 和 fetch 两阶段重复校验，防止 descriptor 被替换后绕过发现阶段限制。
 */
export class FileSystemConnector implements KnowledgeConnector {
  readonly id: string;
  readonly processingProfile: string;
  private readonly baseDir: string;
  private readonly patterns: string[];
  private readonly artifactKind: ArtifactKind;
  private readonly projectKeys: string[];
  private readonly contentType?: string;

  /** 保存显式读取范围，不在构造时访问文件系统。 */
  constructor(options: FileSystemConnectorOptions) {
    this.id = ConnectorIdSchema.parse(options.id);
    this.processingProfile = ConnectorProcessingProfileSchema.parse(
      "filesystem-utf8-v1"
    );
    this.baseDir = path.resolve(options.baseDir);
    this.patterns = options.patterns;
    this.artifactKind = options.artifactKind;
    this.projectKeys = options.projectKeys ?? [];
    this.contentType = options.contentType;
  }

  /** 按稳定相对路径发现文件，并生成 mtime+size 轻量 probe。 */
  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    const paths = await fg(this.patterns, {
      cwd: this.baseDir,
      absolute: false,
      onlyFiles: true,
      followSymbolicLinks: false
    });
    for (const relativePath of paths.sort()) {
      const absolutePath = await assertInsideBase(
        this.baseDir,
        path.join(this.baseDir, relativePath)
      );
      const fileStat = await stat(absolutePath);
      const externalKey = relativePath.split(path.sep).join("/");
      yield {
        sourceId: sourceId(this.id, externalKey),
        connectorId: this.id,
        externalKey,
        title: path.basename(relativePath),
        artifactKind: this.artifactKind,
        contentType: this.contentType ?? contentTypeFor(relativePath),
        projectKeys: this.projectKeys,
        probe: {
          observed_at: new Date().toISOString(),
          upstream: {
            updated_at: fileStat.mtime.toISOString(),
            opaque_version: `${fileStat.mtimeMs}:${fileStat.ctimeMs}:${fileStat.size}`
          }
        },
        metadata: {
          relativePath,
          bytes: fileStat.size
        }
      };
    }
  }

  /** 读取 descriptor 对应文件；external key 必须再次通过 baseDir 边界检查。 */
  async fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    const target = await assertInsideBase(
      this.baseDir,
      path.join(this.baseDir, descriptor.externalKey)
    );
    return readFile(target);
  }

  /** 当前 adapter 只处理 UTF-8 文本；二进制附件将在专用 Connector 中显式实现。 */
  async normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact> {
    let text: string;
    try {
      // fatal 模式拒绝 U+FFFD 静默替换，否则 manifest hash 与真实二进制内容不再等价。
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(
        `Connector source is not valid UTF-8 text: ${descriptor.externalKey}`
      );
    }
    return {
      encoding: "utf8",
      bytes: Buffer.from(text, "utf8"),
      textForManifest: text,
      contentType: descriptor.contentType
    };
  }
}

/** 创建完整 Agent session JSONL Connector 的便利入口。 */
export function createTranscriptConnector(options: {
  id: string;
  baseDir: string;
  patterns?: string[];
  projectKeys?: string[];
}): FileSystemConnector {
  return new FileSystemConnector({
    id: options.id,
    baseDir: options.baseDir,
    patterns: options.patterns ?? ["**/*.jsonl"],
    artifactKind: "transcript",
    projectKeys: options.projectKeys,
    contentType: "application/x-ndjson"
  });
}
