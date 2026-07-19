/**
 * sync 模块同步 Markdown 事实源，不同步索引、embedding、日志或凭据。
 *
 * 本地 base manifest 与远端 manifest 构成三方比较：
 * - 单边变化自动传播。
 * - 双边变化且内容不同生成本地冲突文件，不静默覆盖。
 * - 删除保存 tombstone，防止另一端把旧文件复活。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { rebuildIndex } from "../storage/indexer.js";
import { parseKnowledgeMarkdown } from "../storage/markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import type { Sensitivity, Visibility } from "../core/types.js";
import { isDiscoverableKnowledgeFile } from "../storage/knowledgePaths.js";

export type SyncManifestEntry = {
  hash: string;
  deleted: boolean;
  updatedAt: string;
  visibility?: Visibility;
  sensitivity?: Sensitivity;
};

export type RemoteSyncManifest = {
  version: 1;
  generation: number;
  updatedAt: string;
  entries: Record<string, SyncManifestEntry>;
};

export type SyncBackend = {
  id: string;
  readManifest(): Promise<RemoteSyncManifest | null>;
  writeManifest(manifest: RemoteSyncManifest): Promise<void>;
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  deleteFile(filePath: string): Promise<void>;
};

export type SyncResult = {
  backend: string;
  pushed: string[];
  pulled: string[];
  deletedLocal: string[];
  deletedRemote: string[];
  conflicts: string[];
  remoteGeneration: number;
  indexRebuilt: boolean;
};

export type SyncPolicy = {
  visibilityScopes?: Visibility[];
  sensitivityClearance?: Sensitivity;
};

const SENSITIVITY_LEVEL: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3
};

/** 计算同步 manifest、内容和冲突文件名使用的 SHA-256。 */
function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 按 backend+policy 身份隔离本地共同祖先 manifest。 */
function baseManifestPath(rootDir: string, backendId: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "sync", `base-${sha256(backendId).slice(0, 16)}.json`);
}

/** 读取上次成功同步的共同祖先；缺失表示首次同步。 */
async function readBaseManifest(rootDir: string, backendId: string): Promise<RemoteSyncManifest | null> {
  const target = baseManifestPath(rootDir, backendId);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(await readFile(target, "utf8")) as RemoteSyncManifest;
}

/** 原子写本地同步状态或拉取文件，避免中断留下半写内容。 */
async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

/** 仅在完整同步完成后持久化新的共同祖先 manifest。 */
async function writeBaseManifest(rootDir: string, backendId: string, manifest: RemoteSyncManifest): Promise<void> {
  await writeAtomic(baseManifestPath(rootDir, backendId), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 从 Markdown frontmatter 提取同步权限元数据；远端 manifest 不能替代正文校验。 */
function contentMetadata(
  filePath: string,
  content: string
): { visibility: Visibility; sensitivity: Sensitivity } {
  const document = parseKnowledgeMarkdown(filePath, content);
  return {
    visibility: document.frontmatter.visibility,
    sensitivity: document.frontmatter.sensitivity
  };
}

/** 按 visibility 集合和 sensitivity clearance 执行同步硬过滤。 */
function metadataAllowed(
  metadata: { visibility: Visibility; sensitivity: Sensitivity },
  policy: Required<SyncPolicy>
): boolean {
  return (
    policy.visibilityScopes.includes(metadata.visibility) &&
    SENSITIVITY_LEVEL[metadata.sensitivity] <= SENSITIVITY_LEVEL[policy.sensitivityClearance]
  );
}

/** 读取允许同步的正式 Markdown，并硬排除生成文件、inbox 和 archive。 */
async function readLocalFiles(
  rootDir: string,
  policy: Required<SyncPolicy>
): Promise<Map<string, { hash: string; content: string; visibility: Visibility; sensitivity: Sensitivity }>> {
  const paths = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true
  });
  const files = new Map<
    string,
    { hash: string; content: string; visibility: Visibility; sensitivity: Sensitivity }
  >();
  for (const filePath of paths.sort()) {
    const normalized = filePath.split(path.sep).join("/");
    if (!isDiscoverableKnowledgeFile(normalized)) {
      continue;
    }
    const content = await readFile(resolveWorkspacePath(rootDir, normalized), "utf8");
    const metadata = contentMetadata(normalized, content);
    if (!metadataAllowed(metadata, policy)) {
      continue;
    }
    files.set(normalized, { hash: sha256(content), content, ...metadata });
  }
  return files;
}

/**
 * 读取策略允许的远端状态；无权限项放入 inaccessible，不能误解释为删除。
 */
async function readRemoteState(
  backend: SyncBackend,
  manifest: RemoteSyncManifest | null,
  policy: Required<SyncPolicy>
): Promise<{
  state: Map<string, { hash: string; content: string; visibility: Visibility; sensitivity: Sensitivity } | null>;
  inaccessible: Set<string>;
}> {
  const state = new Map<
    string,
    { hash: string; content: string; visibility: Visibility; sensitivity: Sensitivity } | null
  >();
  const inaccessible = new Set<string>();
  for (const [filePath, entry] of Object.entries(manifest?.entries ?? {})) {
    if (entry.deleted) {
      state.set(filePath, null);
      continue;
    }
    if (
      entry.visibility !== undefined &&
      entry.sensitivity !== undefined &&
      !metadataAllowed({ visibility: entry.visibility, sensitivity: entry.sensitivity }, policy)
    ) {
      inaccessible.add(filePath);
      continue;
    }
    const content = await backend.readFile(filePath);
    const metadata = contentMetadata(filePath, content);
    if (!metadataAllowed(metadata, policy)) {
      inaccessible.add(filePath);
      continue;
    }
    state.set(filePath, { hash: sha256(content), content, ...metadata });
  }
  return { state, inaccessible };
}

/** 把存在、删除和未知状态统一为三方比较使用的 hash/null。 */
function stateHash(value: { hash: string } | null | undefined): string | null {
  return value?.hash ?? null;
}

/** 把双边内容原样写入本地冲突产物，等待人工决定事实版本。 */
async function writeConflict(
  rootDir: string,
  backendId: string,
  filePath: string,
  localContent: string | null,
  remoteContent: string | null
): Promise<string> {
  const target = resolveWorkspacePath(
    rootDir,
    ".memory",
    "sync",
    "conflicts",
    `${sha256(`${backendId}:${filePath}`).slice(0, 16)}.json`
  );
  await writeAtomic(
    target,
    `${JSON.stringify(
      {
        backend: backendId,
        path: filePath,
        detectedAt: new Date().toISOString(),
        localContent,
        remoteContent
      },
      null,
      2
    )}\n`
  );
  return target;
}

/** 远端拉取修改 Markdown 后标记 embedding 过期，避免继续使用旧向量。 */
async function markEmbeddingsStale(rootDir: string): Promise<void> {
  const target = resolveWorkspacePath(rootDir, ".memory", "embeddings", "stale.json");
  await writeAtomic(
    target,
    `${JSON.stringify({ staleAt: new Date().toISOString(), reason: "knowledge_sync" }, null, 2)}\n`
  );
}

/**
 * 通过 local/base/remote 三方比较同步正式 Markdown，并把并发修改写成冲突产物。
 *
 * 同步遵守 visibility/sensitivity 上传边界，不采用 last-write-wins；远端拉取后重建 lexical
 * 索引并标记 embedding stale，但 graph 仍由用户显式重建。
 */
export async function syncKnowledge(
  rootDir: string,
  backend: SyncBackend,
  rawPolicy: SyncPolicy = {}
): Promise<SyncResult> {
  const policy: Required<SyncPolicy> = {
    visibilityScopes: rawPolicy.visibilityScopes ?? ["private", "project", "team"],
    sensitivityClearance: rawPolicy.sensitivityClearance ?? "internal"
  };
  const policyId = `${backend.id}:${policy.visibilityScopes.slice().sort().join(",")}:${policy.sensitivityClearance}`;
  const local = await readLocalFiles(rootDir, policy);
  const remoteManifest = await backend.readManifest();
  const remoteRead = await readRemoteState(backend, remoteManifest, policy);
  const remote = remoteRead.state;
  const base = await readBaseManifest(rootDir, policyId);
  const baseState = new Map<string, SyncManifestEntry | null>(
    Object.entries(base?.entries ?? {}).map(([filePath, entry]) => [filePath, entry.deleted ? null : entry])
  );
  const paths = new Set([
    ...local.keys(),
    ...remote.keys(),
    ...baseState.keys()
  ]);
  const now = new Date().toISOString();
  const pushed: string[] = [];
  const pulled: string[] = [];
  const deletedLocal: string[] = [];
  const deletedRemote: string[] = [];
  const conflicts: string[] = [];
  const nextEntries: Record<string, SyncManifestEntry> = {
    ...(remoteManifest?.entries ?? {})
  };
  const nextBaseEntries: Record<string, SyncManifestEntry> = {
    ...(base?.entries ?? {})
  };

  for (const filePath of [...paths].sort()) {
    if (remoteRead.inaccessible.has(filePath)) {
      // 无权限读取的远端项不能被当作“已删除”，否则会错误传播 tombstone。
      continue;
    }
    const localValue = local.get(filePath);
    const remoteValue = remote.get(filePath);
    const baseValue = baseState.get(filePath);
    const localHash = stateHash(localValue);
    const remoteHash = stateHash(remoteValue);
    const baseHash = stateHash(baseValue);
    const hasBase = baseState.has(filePath);

    if (!hasBase) {
      // 首次见到路径时没有共同祖先：双端内容不同必须冲突，不能猜测哪一端更新。
      if (!localValue && !remoteValue && remoteManifest?.entries[filePath]?.deleted) {
        nextBaseEntries[filePath] = remoteManifest.entries[filePath];
        continue;
      }
      if (localValue && !remoteValue) {
        await backend.writeFile(filePath, localValue.content);
        pushed.push(filePath);
        nextEntries[filePath] = {
          hash: localValue.hash,
          deleted: false,
          updatedAt: now,
          visibility: localValue.visibility,
          sensitivity: localValue.sensitivity
        };
        nextBaseEntries[filePath] = nextEntries[filePath];
        continue;
      }
      if (!localValue && remoteValue) {
        await writeAtomic(resolveWorkspacePath(rootDir, filePath), remoteValue.content);
        pulled.push(filePath);
        nextEntries[filePath] = {
          hash: remoteValue.hash,
          deleted: false,
          updatedAt: now,
          visibility: remoteValue.visibility,
          sensitivity: remoteValue.sensitivity
        };
        nextBaseEntries[filePath] = nextEntries[filePath];
        continue;
      }
      if (localValue && remoteValue && localHash !== remoteHash) {
        conflicts.push(await writeConflict(rootDir, policyId, filePath, localValue.content, remoteValue.content));
        continue;
      }
      if (localValue && remoteValue) {
        nextEntries[filePath] = {
          hash: localValue.hash,
          deleted: false,
          updatedAt: now,
          visibility: localValue.visibility,
          sensitivity: localValue.sensitivity
        };
        nextBaseEntries[filePath] = nextEntries[filePath];
      }
      continue;
    }

    const localChanged = localHash !== baseHash;
    const remoteChanged = remoteHash !== baseHash;
    if (localChanged && remoteChanged && localHash !== remoteHash) {
      // 双边都偏离共同 base 时保留两份内容，禁止用时间戳或遍历顺序静默覆盖。
      conflicts.push(
        await writeConflict(rootDir, policyId, filePath, localValue?.content ?? null, remoteValue?.content ?? null)
      );
      continue;
    }

    if (localChanged && !remoteChanged) {
      if (localValue) {
        await backend.writeFile(filePath, localValue.content);
        pushed.push(filePath);
        nextEntries[filePath] = { hash: localValue.hash, deleted: false, updatedAt: now };
      } else {
        // 本地删除而远端未变时传播 tombstone，防止下次同步把旧文件复活。
        await backend.deleteFile(filePath);
        deletedRemote.push(filePath);
        nextEntries[filePath] = { hash: baseHash ?? "", deleted: true, updatedAt: now };
      }
      nextBaseEntries[filePath] = nextEntries[filePath];
      continue;
    }

    if (remoteChanged && !localChanged) {
      if (remoteValue) {
        await writeAtomic(resolveWorkspacePath(rootDir, filePath), remoteValue.content);
        pulled.push(filePath);
        nextEntries[filePath] = {
          hash: remoteValue.hash,
          deleted: false,
          updatedAt: now,
          visibility: remoteValue.visibility,
          sensitivity: remoteValue.sensitivity
        };
      } else {
        // 远端 tombstone 只在本地未修改时生效，避免删除本地新内容。
        await rm(resolveWorkspacePath(rootDir, filePath), { force: true });
        deletedLocal.push(filePath);
        nextEntries[filePath] = {
          hash: remoteManifest?.entries[filePath]?.hash ?? baseHash ?? "",
          deleted: true,
          updatedAt: now
        };
      }
      nextBaseEntries[filePath] = nextEntries[filePath];
      continue;
    }

    if (localHash === remoteHash) {
      if (localValue) {
        nextEntries[filePath] = {
          hash: localValue.hash,
          deleted: false,
          updatedAt: now,
          visibility: localValue.visibility,
          sensitivity: localValue.sensitivity
        };
      } else {
        nextEntries[filePath] = {
          hash: remoteManifest?.entries[filePath]?.hash ?? baseHash ?? "",
          deleted: true,
          updatedAt: now
        };
      }
      nextBaseEntries[filePath] = nextEntries[filePath];
    }
  }

  const generation = (remoteManifest?.generation ?? 0) + 1;
  const nextManifest: RemoteSyncManifest = {
    version: 1,
    generation,
    updatedAt: now,
    entries: nextEntries
  };
  const nextBase: RemoteSyncManifest = {
    version: 1,
    generation,
    updatedAt: now,
    entries: nextBaseEntries
  };
  await backend.writeManifest(nextManifest);
  await writeBaseManifest(rootDir, policyId, nextBase);

  const localChangedBySync = pulled.length > 0 || deletedLocal.length > 0;
  if (localChangedBySync) {
    rebuildIndex(rootDir);
    await markEmbeddingsStale(rootDir);
  }

  return {
    backend: backend.id,
    pushed,
    pulled,
    deletedLocal,
    deletedRemote,
    conflicts,
    remoteGeneration: generation,
    indexRebuilt: localChangedBySync
  };
}
