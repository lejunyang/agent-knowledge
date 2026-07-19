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
import { rebuildIndex } from "./indexer.js";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import type { Sensitivity, Visibility } from "./types.js";

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

const GENERATED_FILES = new Set([
  "knowledge/README.md",
  "knowledge/_catalog.md",
  "knowledge/_conflicts.md",
  "knowledge/_review_queue.md"
]);

const SENSITIVITY_LEVEL: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  secret: 3
};

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function baseManifestPath(rootDir: string, backendId: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "sync", `base-${sha256(backendId).slice(0, 16)}.json`);
}

async function readBaseManifest(rootDir: string, backendId: string): Promise<RemoteSyncManifest | null> {
  const target = baseManifestPath(rootDir, backendId);
  if (!existsSync(target)) {
    return null;
  }
  return JSON.parse(await readFile(target, "utf8")) as RemoteSyncManifest;
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, target);
}

async function writeBaseManifest(rootDir: string, backendId: string, manifest: RemoteSyncManifest): Promise<void> {
  await writeAtomic(baseManifestPath(rootDir, backendId), `${JSON.stringify(manifest, null, 2)}\n`);
}

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

function metadataAllowed(
  metadata: { visibility: Visibility; sensitivity: Sensitivity },
  policy: Required<SyncPolicy>
): boolean {
  return (
    policy.visibilityScopes.includes(metadata.visibility) &&
    SENSITIVITY_LEVEL[metadata.sensitivity] <= SENSITIVITY_LEVEL[policy.sensitivityClearance]
  );
}

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
    if (
      GENERATED_FILES.has(normalized) ||
      normalized.startsWith("knowledge/_inbox/") ||
      normalized.startsWith("knowledge/_archive/")
    ) {
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

function stateHash(value: { hash: string } | null | undefined): string | null {
  return value?.hash ?? null;
}

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

async function markEmbeddingsStale(rootDir: string): Promise<void> {
  const target = resolveWorkspacePath(rootDir, ".memory", "embeddings", "stale.json");
  await writeAtomic(
    target,
    `${JSON.stringify({ staleAt: new Date().toISOString(), reason: "knowledge_sync" }, null, 2)}\n`
  );
}

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
