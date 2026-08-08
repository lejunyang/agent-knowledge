import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSourceManifestPath,
  runConnectorIngestion
} from "../src/ingestion/core.js";
import { GitRepositoryConnector } from "../src/ingestion/gitRepository.js";
import type { ConnectorSourceDescriptor } from "../src/ingestion/types.js";
import { SourceManifestSchema } from "../src/storage/sourceManifest.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const key = Buffer.alloc(32, 17);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

/** 执行测试仓库 Git 命令，不使用 shell 或网络。 */
async function git(repositoryDir: string, arguments_: string[]): Promise<string> {
  const result = await execFileAsync("git", arguments_, {
    cwd: repositoryDir,
    encoding: "utf8"
  });
  return result.stdout.trim();
}

/** 创建有稳定 remote 和两个 committed 文档的本地仓库。 */
async function createRepository(): Promise<string> {
  const repositoryDir = await mkdtemp(
    path.join(tmpdir(), "agent-knowledge-git-connector-")
  );
  tempDirs.push(repositoryDir);
  await git(repositoryDir, ["init", "--initial-branch=main"]);
  await git(repositoryDir, ["config", "user.email", "test@example.com"]);
  await git(repositoryDir, ["config", "user.name", "Connector Test"]);
  await git(repositoryDir, [
    "remote",
    "add",
    "origin",
    "git@github.com:Example/Business.git"
  ]);
  await mkdir(path.join(repositoryDir, "docs"), { recursive: true });
  await writeFile(
    path.join(repositoryDir, "README.md"),
    "# Business\n\nStable overview.\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryDir, "docs", "guide.md"),
    "# Guide\n\nVersion one.\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryDir, "docs", "guide-link.md"),
    "guide.md",
    "utf8"
  );
    await git(repositoryDir, [
      "add",
      "README.md",
      "docs/guide.md",
      "docs/guide-link.md"
    ]);
  const linkBlob = await git(repositoryDir, [
    "rev-parse",
    ":docs/guide-link.md"
  ]);
  await git(repositoryDir, [
    "update-index",
    "--cacheinfo",
    `120000,${linkBlob},docs/guide-link.md`
  ]);
  await git(repositoryDir, ["commit", "-m", "docs: initial"]);
  return repositoryDir;
}

class CountingGitConnector extends GitRepositoryConnector {
  fetchCount = 0;

  /** 统计正文 blob 读取次数，验证 path hash 未变时只更新 metadata。 */
  override async fetch(
    descriptor: ConnectorSourceDescriptor
  ): Promise<Buffer> {
    this.fetchCount += 1;
    return super.fetch(descriptor);
  }
}

/** 创建固定读取范围的新 Connector，模拟每次 CLI 进程重新启动。 */
function connector(repositoryDir: string): CountingGitConnector {
  return new CountingGitConnector({
    id: "business-repository",
    repositoryDir,
    pathspecs: ["README.md", "docs"]
  });
}

describe("GitRepositoryConnector", () => {
  it("ingests committed blobs and ignores dirty or untracked working-tree content", async () => {
    const repositoryDir = await createRepository();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-git-data-")
    );
    tempDirs.push(knowledgeRoot);
    const firstConnector = connector(repositoryDir);

    const first = await runConnectorIngestion(
      knowledgeRoot,
      firstConnector,
      {
        vault: { key, actor: "git-test" },
        redactionPolicy: "secrets-only"
      }
    );

    expect(first).toMatchObject({
      discovered: 2,
      completed: 2,
      skipped: 0,
      failed: 0
    });
    expect(firstConnector.fetchCount).toBe(2);
    expect(
      first.jobs.some((job) => job.externalKey.endsWith(":docs/guide-link.md"))
    ).toBe(false);
    expect(
      first.jobs.every((job) => job.classification === "new")
    ).toBe(true);

    await writeFile(
      path.join(repositoryDir, "README.md"),
      "# Business\n\nUNCOMMITTED PRIVATE DRAFT.\n",
      "utf8"
    );
    await writeFile(
      path.join(repositoryDir, "docs", "untracked.md"),
      "UNTRACKED PRIVATE DOCUMENT",
      "utf8"
    );
    const secondConnector = connector(repositoryDir);
    const second = await runConnectorIngestion(
      knowledgeRoot,
      secondConnector,
      {
        vault: { key, actor: "git-test" },
        redactionPolicy: "secrets-only"
      }
    );
    const serialized = await Promise.all(
      second.jobs.map(async (job) =>
        readFile(job.sourceManifestPath!, "utf8")
      )
    );

    expect(second).toMatchObject({
      discovered: 2,
      completed: 0,
      skipped: 2,
      failed: 0
    });
    expect(secondConnector.fetchCount).toBe(0);
    expect(serialized.join("\n")).not.toContain("UNCOMMITTED PRIVATE DRAFT");
    expect(serialized.join("\n")).not.toContain("UNTRACKED PRIVATE DOCUMENT");
  });

  it("uses blob hashes to avoid reads on unrelated commits and fetches changed documents", async () => {
    const repositoryDir = await createRepository();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-git-update-")
    );
    tempDirs.push(knowledgeRoot);
    await runConnectorIngestion(knowledgeRoot, connector(repositoryDir), {
      vault: { key },
      redactionPolicy: "secrets-only"
    });

    await writeFile(path.join(repositoryDir, "code.ts"), "export {};\n", "utf8");
    await git(repositoryDir, ["add", "code.ts"]);
    await git(repositoryDir, ["commit", "-m", "feat: unrelated code"]);
    const unrelatedConnector = connector(repositoryDir);
    const unrelated = await runConnectorIngestion(
      knowledgeRoot,
      unrelatedConnector,
      {
        vault: { key },
        redactionPolicy: "secrets-only"
      }
    );

    expect(unrelatedConnector.fetchCount).toBe(0);
    expect(unrelated.completed).toBe(0);
    expect(unrelated.skipped).toBe(2);
    expect(
      unrelated.jobs.every((job) => job.classification === "metadata_only")
    ).toBe(true);

    await writeFile(
      path.join(repositoryDir, "docs", "guide.md"),
      "# Guide\n\nVersion two with a new workflow.\n",
      "utf8"
    );
    await git(repositoryDir, ["add", "docs/guide.md"]);
    await git(repositoryDir, ["commit", "-m", "docs: update guide"]);
    const changedConnector = connector(repositoryDir);
    const changed = await runConnectorIngestion(
      knowledgeRoot,
      changedConnector,
      {
        vault: { key },
        redactionPolicy: "secrets-only"
      }
    );

    expect(changedConnector.fetchCount).toBe(1);
    expect(changed.jobs.filter((job) => job.status === "completed")).toHaveLength(
      1
    );
    expect(
      changed.jobs.some((job) => job.classification === "content_changed")
    ).toBe(true);
    expect(
      changed.jobs.some((job) => job.classification === "metadata_only")
    ).toBe(true);
  });

  it("marks removed paths obsolete and restores them as pending when they return", async () => {
    const repositoryDir = await createRepository();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-git-removal-")
    );
    tempDirs.push(knowledgeRoot);
    const first = await runConnectorIngestion(
      knowledgeRoot,
      connector(repositoryDir),
      {
        vault: { key },
        redactionPolicy: "secrets-only"
      }
    );
    const guideJob = first.jobs.find((job) =>
      job.externalKey.endsWith(":docs/guide.md")
    )!;
    const guideManifestPath = getSourceManifestPath(
      knowledgeRoot,
      guideJob.sourceId
    );
    const refined = SourceManifestSchema.parse(
      JSON.parse(await readFile(guideManifestPath, "utf8"))
    );
    await writeFile(
      guideManifestPath,
      `${JSON.stringify(
        { ...refined, processing_status: "refined" },
        null,
        2
      )}\n`,
      "utf8"
    );

    await git(repositoryDir, ["rm", "docs/guide.md"]);
    await git(repositoryDir, ["commit", "-m", "docs: remove guide"]);
    const bounded = await runConnectorIngestion(
      knowledgeRoot,
      connector(repositoryDir),
      {
        vault: { key },
        redactionPolicy: "secrets-only",
        limit: 1
      }
    );
    const stillAvailable = SourceManifestSchema.parse(
      JSON.parse(await readFile(guideManifestPath, "utf8"))
    );

    expect(bounded.jobs.some((job) => job.classification === "removed")).toBe(
      false
    );
    expect(stillAvailable.availability).toBe("available");

    const removed = await runConnectorIngestion(
      knowledgeRoot,
      connector(repositoryDir),
      {
        vault: { key },
        redactionPolicy: "secrets-only"
      }
    );
    const missingManifest = SourceManifestSchema.parse(
      JSON.parse(await readFile(guideManifestPath, "utf8"))
    );

    expect(removed.jobs.some((job) => job.classification === "removed")).toBe(
      true
    );
    expect(missingManifest).toMatchObject({
      availability: "missing",
      processing_status: "obsolete",
      processing_reason: "connector_source_missing"
    });
    expect(missingManifest.missing_since).toBeDefined();

    await mkdir(path.join(repositoryDir, "docs"), { recursive: true });
    await writeFile(
      path.join(repositoryDir, "docs", "guide.md"),
      "# Guide\n\nVersion one.\n",
      "utf8"
    );
    await git(repositoryDir, ["add", "docs/guide.md"]);
    await git(repositoryDir, ["commit", "-m", "docs: restore guide"]);
    const restoredConnector = connector(repositoryDir);
    const restored = await runConnectorIngestion(
      knowledgeRoot,
      restoredConnector,
      {
        vault: { key },
        redactionPolicy: "secrets-only"
      }
    );
    const restoredManifest = SourceManifestSchema.parse(
      JSON.parse(await readFile(guideManifestPath, "utf8"))
    );

    expect(restoredConnector.fetchCount).toBe(1);
    expect(restored.jobs.some((job) => job.classification === "restored")).toBe(
      true
    );
    expect(restoredManifest.availability).toBe("available");
    expect(restoredManifest).not.toHaveProperty("missing_since");
    expect(restoredManifest.processing_status).toBe("pending");
  });

  it("requires an explicit local project key when the repository has no remote", async () => {
    const repositoryDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-git-local-")
    );
    tempDirs.push(repositoryDir);
    await git(repositoryDir, ["init", "--initial-branch=main"]);
    await git(repositoryDir, ["config", "user.email", "test@example.com"]);
    await git(repositoryDir, ["config", "user.name", "Connector Test"]);
    await writeFile(path.join(repositoryDir, "README.md"), "# Local\n", "utf8");
    await git(repositoryDir, ["add", "README.md"]);
    await git(repositoryDir, ["commit", "-m", "docs: local"]);

    const missingKey = new GitRepositoryConnector({
      id: "local-repository",
      repositoryDir,
      pathspecs: ["README.md"]
    });
    await expect(missingKey.inventoryVersion()).rejects.toThrow();

    const explicitKey = new GitRepositoryConnector({
      id: "local-repository",
      repositoryDir,
      pathspecs: ["README.md"],
      projectKey: "local/example/repository"
    });
    const descriptors: ConnectorSourceDescriptor[] = [];
    for await (const descriptor of explicitKey.discover(null)) {
      descriptors.push(descriptor);
    }
    expect(descriptors[0]?.projectKeys).toEqual([
      "local/example/repository"
    ]);
  });

  it("rejects reusing a connector ID for a different Git inventory scope", async () => {
    const repositoryDir = await createRepository();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-git-identity-")
    );
    tempDirs.push(knowledgeRoot);
    const initial = connector(repositoryDir);
    await runConnectorIngestion(knowledgeRoot, initial, {
      vault: { key },
      redactionPolicy: "secrets-only"
    });
    const guideJob = (
      await runConnectorIngestion(knowledgeRoot, connector(repositoryDir), {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).jobs.find((job) => job.externalKey.endsWith(":docs/guide.md"))!;
    const manifestPath = getSourceManifestPath(
      knowledgeRoot,
      guideJob.sourceId
    );
    const before = await readFile(manifestPath, "utf8");
    const changedScope = new GitRepositoryConnector({
      id: "business-repository",
      repositoryDir,
      pathspecs: ["README.md"]
    });

    await expect(
      runConnectorIngestion(knowledgeRoot, changedScope, {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).rejects.toThrow(/inventory identity changed/);
    expect(await readFile(manifestPath, "utf8")).toBe(before);

    await git(repositoryDir, ["switch", "-c", "other"]);
    const changedBranch = connector(repositoryDir);
    await expect(
      runConnectorIngestion(knowledgeRoot, changedBranch, {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).rejects.toThrow(/inventory identity changed/);
  });
});
