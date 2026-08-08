import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getSourceManifestPath,
  runConnectorIngestion
} from "../src/ingestion/core.js";
import {
  getSourceUpdateReportPath,
  checkConnectorSourceUpdates,
  readSourceUpdateReport
} from "../src/ingestion/sourceUpdates.js";
import { registerConnector } from "../src/ingestion/registry.js";
import type {
  ConnectorCursor,
  ConnectorInventoryStatus,
  ConnectorSourceDescriptor,
  KnowledgeConnector,
  NormalizedArtifact
} from "../src/ingestion/types.js";
import { SourceManifestSchema } from "../src/storage/sourceManifest.js";
import { getVaultObjectPath } from "../src/vault/core.js";

const tempDirs: string[] = [];
const vaultKey = Buffer.alloc(32, 29);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

type ProbeSource = {
  sourceId: string;
  externalKey: string;
  content: string;
  revision?: string;
  pathHash?: string;
};

class ProbeOnlyConnector implements KnowledgeConnector {
  readonly id: string;
  readonly inventoryMode?: "partial" | "complete";
  processingProfile = "probe-only-v1";
  sources: ProbeSource[];
  fetchCount = 0;
  forbidFetch = false;
  private readonly identity?: string;
  private readonly complete: boolean;

  /** 保存测试所需的 probe inventory；生产逻辑仍通过公共 Connector 契约执行。 */
  constructor(options: {
    id: string;
    sources: ProbeSource[];
    inventoryMode?: "partial" | "complete";
    identity?: string;
    complete?: boolean;
  }) {
    this.id = options.id;
    this.sources = options.sources;
    this.inventoryMode = options.inventoryMode;
    this.identity = options.identity;
    this.complete = options.complete ?? true;
  }

  /** complete inventory 测试使用稳定 identity 验证删除检测边界。 */
  async inventoryIdentity(): Promise<string | null> {
    return this.identity ?? null;
  }

  /** 可声明 incomplete，验证不完整 inventory 不能推断 source 删除。 */
  async inventoryStatus(): Promise<ConnectorInventoryStatus> {
    return this.complete
      ? { complete: true, unresolved: 0 }
      : {
          complete: false,
          unresolved: 1,
          reason: "test inventory incomplete"
        };
  }

  /** 只暴露版本 descriptor，不读取 content。 */
  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    for (const source of this.sources) {
      yield {
        sourceId: source.sourceId,
        connectorId: this.id,
        externalKey: source.externalKey,
        title: source.externalKey,
        artifactKind: "document",
        contentType: "text/plain",
        projectKeys: ["github.com/example/business"],
        probe: {
          observed_at: "2026-08-09T04:00:00.000Z",
          upstream: {
            ...(source.revision ? { revision: source.revision } : {}),
            ...(source.pathHash ? { path_hash: source.pathHash } : {})
          }
        }
      };
    }
  }

  /** 摄入阶段允许读取；source check 阶段设置 forbidFetch 后任何误读都会使测试失败。 */
  async fetch(descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    this.fetchCount += 1;
    if (this.forbidFetch) {
      throw new Error("source check must not fetch content");
    }
    const source = this.sources.find(
      (item) => item.sourceId === descriptor.sourceId
    );
    if (!source) {
      throw new Error(`missing test source: ${descriptor.sourceId}`);
    }
    return Buffer.from(source.content, "utf8");
  }

  /** 测试正文已经是 UTF-8，无额外 provider 规范化。 */
  async normalize(
    descriptor: ConnectorSourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact> {
    const text = raw.toString("utf8");
    return {
      bytes: Buffer.from(text, "utf8"),
      textForManifest: text,
      contentType: descriptor.contentType
    };
  }
}

/** 为自定义测试 Connector 创建 files 类型本地登记。 */
async function registerPartial(root: string, connectorId: string) {
  return (
    await registerConnector(root, {
      kind: "files",
      connectorId,
      redactionPolicy: "secrets-only",
      options: {
        baseDir: path.join(root, "upstream"),
        patterns: ["**/*.md"],
        artifactKind: "document",
        projectKeys: ["github.com/example/business"]
      }
    })
  ).record;
}

describe("source update checks", () => {
  it("separates unchanged metadata-only and content changes without fetching bodies", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-check-")
    );
    tempDirs.push(root);
    const connector = new ProbeOnlyConnector({
      id: "business-docs",
      sources: [
        {
          sourceId: "src_business_rules",
          externalKey: "rules.md",
          content: "第一版规则",
          revision: "1",
          pathHash: "a".repeat(64)
        }
      ]
    });
    const registration = await registerPartial(root, connector.id);
    await runConnectorIngestion(root, connector, {
      vault: { key: vaultKey },
      redactionPolicy: "secrets-only"
    });
    const manifestPath = getSourceManifestPath(
      root,
      "src_business_rules"
    );

    connector.forbidFetch = true;
    const before = await readFile(manifestPath, "utf8");
    const unchanged = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );

    expect(unchanged.summary).toMatchObject({
      unchanged: 1,
      metadata_only: 0,
      content_changed: 0,
      updatesAvailable: 0,
      verificationRequired: 0
    });
    expect(connector.fetchCount).toBe(1);
    expect(await readFile(manifestPath, "utf8")).toBe(before);

    connector.sources[0]!.revision = "2";
    const metadataOnly = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );

    expect(metadataOnly.items[0]).toMatchObject({
      sourceId: "src_business_rules",
      state: "metadata_only",
      requiresIngestion: true,
      requiresDistillation: false,
      verificationRequired: false,
      changedFields: ["revision"]
    });
    expect(metadataOnly.summary.updatesAvailable).toBe(1);
    expect(await readFile(manifestPath, "utf8")).toBe(before);

    connector.sources[0]!.pathHash = "b".repeat(64);
    const changed = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );

    expect(changed.items[0]).toMatchObject({
      state: "content_changed",
      requiresIngestion: true,
      requiresDistillation: true,
      verificationRequired: false
    });
    expect(changed.summary).toMatchObject({
      content_changed: 1,
      updatesAvailable: 1,
      verificationRequired: 0
    });
    expect(connector.fetchCount).toBe(1);
    expect(await readFile(manifestPath, "utf8")).toBe(before);
    expect((await stat(getSourceUpdateReportPath(root, connector.id))).mode & 0o777)
      .toBe(0o600);
    await expect(
      readSourceUpdateReport(root, connector.id)
    ).resolves.toEqual(changed);
  });

  it("reports unknown changes when upstream versions move without content hashes", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-unknown-")
    );
    tempDirs.push(root);
    const connector = new ProbeOnlyConnector({
      id: "revision-only",
      sources: [
        {
          sourceId: "src_revision_only",
          externalKey: "document:one",
          content: "稳定正文",
          revision: "1"
        }
      ]
    });
    const registration = await registerPartial(root, connector.id);
    await runConnectorIngestion(root, connector, {
      vault: { key: vaultKey },
      redactionPolicy: "secrets-only"
    });

    connector.sources[0]!.revision = "2";
    connector.forbidFetch = true;
    const report = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );

    expect(report.items[0]).toMatchObject({
      state: "update_unknown",
      requiresIngestion: true,
      requiresDistillation: false,
      verificationRequired: true,
      changedFields: ["revision"]
    });
    expect(report.summary).toMatchObject({
      update_unknown: 1,
      updatesAvailable: 0,
      verificationRequired: 1
    });
    expect(connector.fetchCount).toBe(1);
  });

  it("detects processing profile and missing evidence even when probes are unchanged", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-health-")
    );
    tempDirs.push(root);
    const connector = new ProbeOnlyConnector({
      id: "health-docs",
      sources: [
        {
          sourceId: "src_health_doc",
          externalKey: "health.md",
          content: "健康文档",
          revision: "1",
          pathHash: "c".repeat(64)
        }
      ]
    });
    const registration = await registerPartial(root, connector.id);
    await runConnectorIngestion(root, connector, {
      vault: { key: vaultKey },
      redactionPolicy: "secrets-only"
    });
    const manifest = SourceManifestSchema.parse(
      JSON.parse(
        await readFile(
          getSourceManifestPath(root, "src_health_doc"),
          "utf8"
        )
      )
    );

    connector.forbidFetch = true;
    connector.processingProfile = "probe-only-v2";
    const profile = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );
    expect(profile.items[0]?.state).toBe("processing_profile_changed");

    connector.processingProfile = "probe-only-v1";
    await rm(getVaultObjectPath(root, manifest.vault_object!));
    const missing = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );
    expect(missing.items[0]).toMatchObject({
      state: "evidence_missing",
      requiresIngestion: true,
      requiresDistillation: false
    });
  });

  it("detects new restored and complete-inventory removals but never infers partial removals", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-inventory-")
    );
    tempDirs.push(root);
    const identity = `test_inventory_${"d".repeat(64)}`;
    const connector = new ProbeOnlyConnector({
      id: "complete-docs",
      inventoryMode: "complete",
      identity,
      sources: [
        {
          sourceId: "src_existing",
          externalKey: "existing.md",
          content: "已有文档",
          revision: "1",
          pathHash: "d".repeat(64)
        }
      ]
    });
    const registration = (
      await registerConnector(
        root,
        {
          kind: "git",
          connectorId: connector.id,
          redactionPolicy: "secrets-only",
          options: {
            repositoryDir: path.join(root, "repository"),
            ref: "HEAD",
            pathspecs: ["docs"],
            projectKey: "github.com/example/business"
          }
        },
        { inventoryIdentity: identity }
      )
    ).record;
    await runConnectorIngestion(root, connector, {
      vault: { key: vaultKey },
      redactionPolicy: "secrets-only"
    });
    const manifestPath = getSourceManifestPath(root, "src_existing");
    const available = SourceManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        SourceManifestSchema.parse({
          ...available,
          availability: "missing",
          missing_since: "2026-08-09T03:00:00.000Z",
          processing_status: "pending",
          processing_reason: undefined,
          duplicate_of: undefined,
          processed_at: undefined,
          processed_content_hash: undefined,
          refined_knowledge_ids: []
        }),
        null,
        2
      )}\n`,
      "utf8"
    );

    connector.forbidFetch = true;
    connector.sources.push({
      sourceId: "src_new",
      externalKey: "new.md",
      content: "新文档",
      revision: "1",
      pathHash: "e".repeat(64)
    });
    const restoredAndNew = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );
    expect(
      restoredAndNew.items.map((item) => [item.sourceId, item.state])
    ).toEqual([
      ["src_existing", "restored"],
      ["src_new", "new"]
    ]);

    await writeFile(
      manifestPath,
      `${JSON.stringify(available, null, 2)}\n`,
      "utf8"
    );
    connector.sources = [];
    const removed = await checkConnectorSourceUpdates(
      root,
      connector,
      registration
    );
    expect(removed.inventory.removalsEvaluated).toBe(true);
    expect(removed.items).toEqual([
      expect.objectContaining({
        sourceId: "src_existing",
        state: "removed"
      })
    ]);

    const partialConnector = new ProbeOnlyConnector({
      id: connector.id,
      inventoryMode: "complete",
      identity,
      complete: false,
      sources: []
    });
    partialConnector.forbidFetch = true;
    const incomplete = await checkConnectorSourceUpdates(
      root,
      partialConnector,
      registration
    );
    expect(incomplete.inventory.removalsEvaluated).toBe(false);
    expect(incomplete.items).toEqual([]);
  });
});
