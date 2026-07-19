import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  syncKnowledge,
  type RemoteSyncManifest,
  type SyncBackend
} from "../src/sync.js";

class MemorySyncBackend implements SyncBackend {
  readonly id = "memory";
  manifest: RemoteSyncManifest | null = null;
  files = new Map<string, string>();

  async readManifest(): Promise<RemoteSyncManifest | null> {
    return this.manifest ? structuredClone(this.manifest) : null;
  }

  async writeManifest(manifest: RemoteSyncManifest): Promise<void> {
    this.manifest = structuredClone(manifest);
  }

  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw new Error(`missing remote file: ${filePath}`);
    }
    return value;
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async deleteFile(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

let tempDirs: string[] = [];

function knowledgeMarkdown(
  summary: string,
  options: { id?: string; visibility?: string; sensitivity?: string } = {}
): string {
  return `---
id: ${options.id ?? "k_20260719_sync_test_fact"}
type: semantic
title: Sync test fact
aliases: []
domain: sync/test
related_domains: []
scenario:
  - sync-test
tags: []
status: active
confidence: 0.9
source_authority: user_confirmed
source:
  - test
related_knowledge: []
supersedes: []
conflicts_with: []
visibility: ${options.visibility ?? "project"}
sensitivity: ${options.sensitivity ?? "internal"}
project_ids: []
capture_mode: direct_material
actor_type: owner
corroboration_count: 1
created_at: 2026-07-19
updated_at: 2026-07-19
valid_from: 2026-07-19
valid_until:
---

# Sync test fact

${summary}
`;
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-sync-"));
  tempDirs.push(root);
  await mkdir(path.join(root, "knowledge", "semantic", "test"), { recursive: true });
  return root;
}

describe("syncKnowledge", () => {
  it("pushes Markdown facts on first sync and excludes machine artifacts", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    await writeFile(
      path.join(root, "knowledge", "semantic", "test", "fact.md"),
      knowledgeMarkdown("fact"),
      "utf8"
    );
    await mkdir(path.join(root, ".memory"), { recursive: true });
    await writeFile(path.join(root, ".memory", "index.sqlite"), "machine", "utf8");
    await writeFile(path.join(root, "knowledge", "_catalog.md"), "generated", "utf8");
    await mkdir(path.join(root, "knowledge", "_inbox"), { recursive: true });
    await writeFile(
      path.join(root, "knowledge", "_inbox", "candidate.md"),
      knowledgeMarkdown("candidate", { id: "k_20260719_sync_candidate" }),
      "utf8"
    );

    const result = await syncKnowledge(root, backend);

    expect(result.pushed).toEqual(["knowledge/semantic/test/fact.md"]);
    expect(backend.files.get("knowledge/semantic/test/fact.md")).toBe(knowledgeMarkdown("fact"));
    expect([...backend.files.keys()]).not.toContain(".memory/index.sqlite");
    expect([...backend.files.keys()]).not.toContain("knowledge/_catalog.md");
    expect([...backend.files.keys()]).not.toContain("knowledge/_inbox/candidate.md");
    expect(backend.manifest?.entries["knowledge/semantic/test/fact.md"]?.deleted).toBe(false);
  });

  it("applies visibility and sensitivity policy before uploading shared knowledge", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    await writeFile(
      path.join(root, "knowledge", "semantic", "test", "team.md"),
      knowledgeMarkdown("team", { id: "k_20260719_sync_team", visibility: "team" }),
      "utf8"
    );
    await writeFile(
      path.join(root, "knowledge", "semantic", "test", "private.md"),
      knowledgeMarkdown("private", { id: "k_20260719_sync_private", visibility: "private" }),
      "utf8"
    );
    await writeFile(
      path.join(root, "knowledge", "semantic", "test", "secret.md"),
      knowledgeMarkdown("secret", { id: "k_20260719_sync_secret", visibility: "team", sensitivity: "secret" }),
      "utf8"
    );

    const result = await syncKnowledge(root, backend, {
      visibilityScopes: ["project", "team"],
      sensitivityClearance: "internal"
    });

    expect(result.pushed).toEqual(["knowledge/semantic/test/team.md"]);
    expect([...backend.files.keys()]).toEqual(["knowledge/semantic/test/team.md"]);
  });

  it("skips inaccessible remote objects from manifest metadata before reading content", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    const inaccessiblePath = "knowledge/semantic/test/private.md";
    backend.files.set(
      inaccessiblePath,
      knowledgeMarkdown("private", { id: "k_20260719_remote_private", visibility: "private" })
    );
    backend.manifest = {
      version: 1,
      generation: 1,
      updatedAt: "2026-07-19T00:00:00.000Z",
      entries: {
        [inaccessiblePath]: {
          hash: "private",
          deleted: false,
          updatedAt: "2026-07-19T00:00:00.000Z",
          visibility: "private",
          sensitivity: "internal"
        }
      }
    };
    let readCount = 0;
    const originalReadFile = backend.readFile.bind(backend);
    backend.readFile = async (filePath) => {
      readCount += 1;
      return originalReadFile(filePath);
    };

    const result = await syncKnowledge(root, backend, {
      visibilityScopes: ["project", "team"],
      sensitivityClearance: "internal"
    });

    expect(readCount).toBe(0);
    expect(result.pulled).toEqual([]);
  });

  it("pulls remote-only Markdown and rebuilds the local index", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    backend.files.set("knowledge/semantic/test/remote.md", knowledgeMarkdown("remote"));
    backend.manifest = {
      version: 1,
      generation: 1,
      updatedAt: "2026-07-19T00:00:00.000Z",
      entries: {
        "knowledge/semantic/test/remote.md": {
          hash: "ignored-by-test-fixture",
          deleted: false,
          updatedAt: "2026-07-19T00:00:00.000Z"
        }
      }
    };

    const result = await syncKnowledge(root, backend);

    expect(result.pulled).toEqual(["knowledge/semantic/test/remote.md"]);
    await expect(readFile(path.join(root, "knowledge", "semantic", "test", "remote.md"), "utf8")).resolves.toBe(
      knowledgeMarkdown("remote")
    );
    await expect(stat(path.join(root, ".memory", "index.sqlite"))).resolves.toBeDefined();
    await expect(readFile(path.join(root, ".memory", "embeddings", "stale.json"), "utf8")).resolves.toContain(
      '"reason": "knowledge_sync"'
    );
  });

  it("propagates local and remote one-sided changes relative to the last base", async () => {
    const localRoot = await createRoot();
    const backend = new MemorySyncBackend();
    const filePath = path.join(localRoot, "knowledge", "semantic", "test", "fact.md");
    await writeFile(filePath, knowledgeMarkdown("v1"), "utf8");
    await syncKnowledge(localRoot, backend);

    await writeFile(filePath, knowledgeMarkdown("local v2"), "utf8");
    const push = await syncKnowledge(localRoot, backend);
    expect(push.pushed).toEqual(["knowledge/semantic/test/fact.md"]);
    expect(backend.files.get("knowledge/semantic/test/fact.md")).toBe(knowledgeMarkdown("local v2"));

    backend.files.set("knowledge/semantic/test/fact.md", knowledgeMarkdown("remote v3"));
    backend.manifest!.entries["knowledge/semantic/test/fact.md"] = {
      hash: "remote-v3-placeholder",
      deleted: false,
      updatedAt: "2026-07-19T01:00:00.000Z"
    };
    const pull = await syncKnowledge(localRoot, backend);
    expect(pull.pulled).toEqual(["knowledge/semantic/test/fact.md"]);
    await expect(readFile(filePath, "utf8")).resolves.toBe(knowledgeMarkdown("remote v3"));
  });

  it("uses tombstones for deletion and does not resurrect deleted files", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    const filePath = path.join(root, "knowledge", "semantic", "test", "fact.md");
    await writeFile(filePath, knowledgeMarkdown("fact"), "utf8");
    await syncKnowledge(root, backend);

    await rm(filePath);
    const result = await syncKnowledge(root, backend);

    expect(result.deletedRemote).toEqual(["knowledge/semantic/test/fact.md"]);
    expect(backend.files.has("knowledge/semantic/test/fact.md")).toBe(false);
    expect(backend.manifest?.entries["knowledge/semantic/test/fact.md"]?.deleted).toBe(true);
  });

  it("writes conflict artifacts when local and remote both changed", async () => {
    const root = await createRoot();
    const backend = new MemorySyncBackend();
    const filePath = path.join(root, "knowledge", "semantic", "test", "fact.md");
    await writeFile(filePath, knowledgeMarkdown("v1"), "utf8");
    await syncKnowledge(root, backend);

    await writeFile(filePath, knowledgeMarkdown("local v2"), "utf8");
    backend.files.set("knowledge/semantic/test/fact.md", knowledgeMarkdown("remote v2"));
    backend.manifest!.entries["knowledge/semantic/test/fact.md"] = {
      hash: "remote-v2-placeholder",
      deleted: false,
      updatedAt: "2026-07-19T02:00:00.000Z"
    };

    const result = await syncKnowledge(root, backend);

    expect(result.conflicts).toHaveLength(1);
    await expect(readFile(filePath, "utf8")).resolves.toBe(knowledgeMarkdown("local v2"));
    const conflict = JSON.parse(await readFile(result.conflicts[0]!, "utf8")) as {
      path: string;
      localContent: string;
      remoteContent: string;
    };
    expect(conflict.path).toBe("knowledge/semantic/test/fact.md");
    expect(conflict.localContent).toBe(knowledgeMarkdown("local v2"));
    expect(conflict.remoteContent).toBe(knowledgeMarkdown("remote v2"));
  });
});
