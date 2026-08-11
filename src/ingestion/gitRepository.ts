/**
 * Git repository Connector 从已提交对象读取文档，不读取工作区脏改动或 untracked 文件。
 *
 * 每个 tracked path 是稳定 source；blob SHA 用作 path hash，commit SHA 用作仓库版本元数据。
 * Connector 不 fetch remote、不 checkout、不修改仓库，联网更新必须由用户显式执行。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { promisify } from "node:util";
import { ProjectKeySchema } from "../core/knowledgeV2.js";
import { normalizeGitRemote } from "../integration/projects.js";
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

const execFileAsync = promisify(execFile);

export type GitRepositoryConnectorOptions = {
  id: string;
  repositoryDir: string;
  ref?: string;
  pathspecs: string[];
  projectKey?: string;
};

type GitBlob = {
  relativePath: string;
  objectId: string;
};

type GitSnapshot = {
  gitRoot: string;
  projectKey: string;
  refIdentity: string;
  commitSha: string;
  committedAt: string;
  blobs: GitBlob[];
};

/** Git 命令错误不包含 stdout/stderr，避免 remote helper 或路径把敏感文本带入 job。 */
async function runGit(
  cwd: string,
  arguments_: string[],
  encoding: BufferEncoding | "buffer" = "utf8"
): Promise<string | Buffer> {
  try {
    const result = await execFileAsync(
      "git",
      ["-C", cwd, ...arguments_],
      {
        encoding: encoding === "buffer" ? "buffer" : encoding,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true
      }
    );
    return result.stdout;
  } catch {
    throw new Error(`Git Connector command failed: git ${arguments_[0] ?? ""}`);
  }
}

/** 生成 path 稳定 source ID；commit/blob 变化不会改变身份。 */
function sourceId(
  connectorId: string,
  projectKey: string,
  relativePath: string
): string {
  return `src_${createHash("sha256")
    .update(`${connectorId}\0${projectKey}\0${relativePath}`)
    .digest("hex")
    .slice(0, 24)}`;
}

/** 根据仓库文档扩展名选择 MIME；Git Connector 当前只接受 UTF-8 文本。 */
function contentTypeFor(relativePath: string): string {
  switch (path.extname(relativePath).toLowerCase()) {
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

/** 解析 `git ls-tree -rz`，只保留 blob；path 原样来自 Git tree，不接触工作区。 */
function parseTree(output: Buffer): GitBlob[] {
  const blobs: GitBlob[] = [];
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch {
    throw new Error("Git Connector requires UTF-8 repository paths");
  }
  for (const rawEntry of decoded.split("\0")) {
    if (!rawEntry) {
      continue;
    }
    const tab = rawEntry.indexOf("\t");
    if (tab < 0) {
      throw new Error("Git Connector received an invalid tree entry");
    }
    const metadata = rawEntry.slice(0, tab).split(" ");
    const relativePath = rawEntry.slice(tab + 1);
    const mode = metadata[0];
    const objectId = metadata[2];
    if (
      (mode !== "100644" && mode !== "100755") ||
      metadata[1] !== "blob" ||
      !objectId ||
      !/^[a-fA-F0-9]{40,64}$/.test(objectId)
    ) {
      continue;
    }
    blobs.push({ relativePath, objectId: objectId.toLowerCase() });
  }
  return blobs.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

/**
 * 从本地 Git object database 摄入已提交文档。
 *
 * `inventoryMode=complete` 只针对配置 pathspec 的结果集；完整运行会把上次存在但本次缺失的
 * source 标记 removed，传 limit 的截断运行不会执行删除对账。
 */
export class GitRepositoryConnector implements KnowledgeConnector {
  readonly id: string;
  readonly processingProfile: string;
  readonly inventoryMode = "complete" as const;
  private readonly repositoryDir: string;
  private readonly ref: string;
  private readonly pathspecs: string[];
  private readonly explicitProjectKey?: string;
  private snapshot: GitSnapshot | null = null;
  private readonly blobBySourceId = new Map<string, string>();

  /** 保存显式 Git 读取范围；仓库、ref 与 project identity 在首次探测时校验。 */
  constructor(options: GitRepositoryConnectorOptions) {
    this.id = ConnectorIdSchema.parse(options.id);
    this.processingProfile = ConnectorProcessingProfileSchema.parse(
      "git-committed-utf8-v1"
    );
    this.repositoryDir = path.resolve(options.repositoryDir);
    this.ref = options.ref?.trim() || "HEAD";
    if (
      options.pathspecs.length === 0 ||
      options.pathspecs.some((item) => item.length === 0)
    ) {
      throw new Error("Git Connector requires at least one pathspec");
    }
    if (options.pathspecs.some((item) => item.includes("\0"))) {
      throw new Error("Git Connector pathspec cannot contain NUL");
    }
    this.pathspecs = [...new Set(options.pathspecs)];
    this.explicitProjectKey = options.projectKey
      ? ProjectKeySchema.parse(options.projectKey)
      : undefined;
  }

  /** 构建一次 immutable Git snapshot，后续 fetch 始终按 blob SHA 读取同一内容。 */
  private async loadSnapshot(): Promise<GitSnapshot> {
    if (this.snapshot) {
      return this.snapshot;
    }
    const gitRoot = await realpath(
      String(await runGit(this.repositoryDir, ["rev-parse", "--show-toplevel"]))
        .trim()
    );
    const rawRemote = String(
      await runGit(gitRoot, ["config", "--get", "remote.origin.url"])
        .catch(() => "")
    ).trim();
    const normalizedRemote = rawRemote
      ? normalizeGitRemote(rawRemote)
      : undefined;
    const projectKey = ProjectKeySchema.parse(
      normalizedRemote ?? this.explicitProjectKey
    );
    const symbolicRef = String(
      await runGit(gitRoot, [
        "rev-parse",
        "--symbolic-full-name",
        "--verify",
        "--end-of-options",
        this.ref
      ]).catch(() => "")
    ).trim();
    const refIdentity = symbolicRef || this.ref;
    const commitSha = String(
      await runGit(gitRoot, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${this.ref}^{commit}`
      ])
    )
      .trim()
      .toLowerCase();
    const committedAtRaw = String(
      await runGit(gitRoot, ["show", "-s", "--format=%cI", commitSha])
    ).trim();
    const committedAt = new Date(committedAtRaw).toISOString();
    const tree = (await runGit(
      gitRoot,
      [
        "ls-tree",
        "-r",
        "-z",
        "--full-tree",
        commitSha,
        "--",
        ...this.pathspecs
      ],
      "buffer"
    )) as Buffer;
    const blobs = parseTree(tree);
    this.snapshot = {
      gitRoot,
      projectKey,
      refIdentity,
      commitSha,
      committedAt,
      blobs
    };
    return this.snapshot;
  }

  /** 返回仓库级 commit probe，供完整 inventory 删除对账记录删除发生的 commit。 */
  async inventoryVersion(): Promise<SourceVersionProbe> {
    const snapshot = await this.loadSnapshot();
    return {
      observed_at: new Date().toISOString(),
      upstream: {
        commit_sha: snapshot.commitSha,
        updated_at: snapshot.committedAt
      }
    };
  }

  /**
   * 锁定 connector ID 对应的仓库、ref 表达式和 pathspec 范围。
   *
   * commit SHA 不参与 identity，使 HEAD 前进仍是增量更新；改变仓库/ref/pathspec 会拒绝复用
   * 旧 checkpoint，避免把另一个 inventory 的 source 静默标记 removed。
   */
  async inventoryIdentity(): Promise<string> {
    const snapshot = await this.loadSnapshot();
    return `git_inventory_${createHash("sha256")
      .update(
        JSON.stringify({
          projectKey: snapshot.projectKey,
          ref: snapshot.refIdentity,
          pathspecs: [...this.pathspecs].sort()
        })
      )
      .digest("hex")}`;
  }

  /** 发现匹配 pathspec 的 committed blobs；path hash 优先于 commit 判断是否需读取正文。 */
  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    const snapshot = await this.loadSnapshot();
    for (const blob of snapshot.blobs) {
      const id = sourceId(this.id, snapshot.projectKey, blob.relativePath);
      this.blobBySourceId.set(id, blob.objectId);
      yield {
        sourceId: id,
        connectorId: this.id,
        externalKey: `${snapshot.projectKey}:${blob.relativePath}`,
        title: path.posix.basename(blob.relativePath),
        artifactKind: "repository",
        contentType: contentTypeFor(blob.relativePath),
        projectKeys: [snapshot.projectKey],
        probe: {
          observed_at: new Date().toISOString(),
          upstream: {
            commit_sha: snapshot.commitSha,
            path_hash: blob.objectId,
            updated_at: snapshot.committedAt
          }
        },
        metadata: {
          relativePath: blob.relativePath,
          ref: this.ref
        }
      };
    }
  }

  /** 按 discover 锁定的 blob SHA 读取对象，ref 后续移动也不会产生版本/正文撕裂。 */
  async fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    const snapshot = await this.loadSnapshot();
    const objectId = this.blobBySourceId.get(descriptor.sourceId);
    if (!objectId) {
      throw new Error(
        `Git Connector source was not discovered: ${descriptor.sourceId}`
      );
    }
    return (await runGit(
      snapshot.gitRoot,
      ["cat-file", "blob", objectId],
      "buffer"
    )) as Buffer;
  }

  /** 拒绝非 UTF-8 blob，二进制仓库资产应由 attachment Connector 显式处理。 */
  async normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact> {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new Error(
        `Git Connector source is not valid UTF-8 text: ${descriptor.externalKey}`
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
