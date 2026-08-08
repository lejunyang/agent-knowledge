import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readConnectorCheckpoint,
  getSourceManifestPath,
  runConnectorIngestion
} from "../src/ingestion/core.js";
import { LarkExportConnector } from "../src/ingestion/larkExport.js";
import type { ConnectorSourceDescriptor } from "../src/ingestion/types.js";
import { auditKnowledgeQuality } from "../src/storage/qualityAudit.js";
import { SourceManifestSchema } from "../src/storage/sourceManifest.js";
import { listSources } from "../src/storage/sourceReview.js";
import { getVaultObject } from "../src/vault/core.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 23);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

/** 写一份最小递归飞书导出及其 manifest。 */
async function createExport(options: {
  complete?: boolean;
  content?: string;
  manifestContentHash?: string;
} = {}) {
  const exportDir = await mkdtemp(
    path.join(tmpdir(), "agent-knowledge-lark-export-")
  );
  tempDirs.push(exportDir);
  const directory = "账号指南-123456789abc";
  const content =
    options.content ??
    [
      "<h1>账号体系</h1>",
      "<p>商业化 UID 与抖音 UID 属于不同账号组。</p>",
      '<p>password=actual-password</p>',
      '<p>负责人：<cite type="user" user-id="ou_private" user-name="张三"></cite></p>'
    ].join("");
  await mkdir(path.join(exportDir, directory), { recursive: true });
  await writeFile(
    path.join(exportDir, directory, "content.xml"),
    content,
    "utf8"
  );
  const hash = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(content).digest("hex")
  );
  await writeFile(
    path.join(exportDir, "manifest.json"),
    `${JSON.stringify(
      {
        version: 1,
        generatedAt: "2026-08-09T00:00:00.000Z",
        roots: ["wiki:root"],
        documents: {
          "wiki:account": {
            key: "wiki:account",
            requestedToken: "account",
            fetchToken: "docx-account",
            objType: "docx",
            title: "账号指南",
            revisionId: 17,
            upstreamUpdatedAt: "2026-08-08T12:00:00.000Z",
            observedAt: "2026-08-09T00:00:00.000Z",
            directory,
            contentHash: options.manifestContentHash ?? hash
          }
        },
        resources: {},
        failures: {},
        complete: options.complete ?? true,
        pending: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  return { exportDir, directory, content };
}

class CountingLarkConnector extends LarkExportConnector {
  fetchCount = 0;

  /** 统计 content.xml 读取次数，验证 revision/hash 未变化时跳过正文读取。 */
  override async fetch(
    descriptor: ConnectorSourceDescriptor
  ): Promise<Buffer> {
    this.fetchCount += 1;
    return super.fetch(descriptor);
  }
}

/** 创建固定 export scope 的新 Connector，模拟每次 CLI 重启。 */
function connector(exportDir: string): CountingLarkConnector {
  return new CountingLarkConnector({
    id: "lark-business",
    exportDir,
    projectKeys: ["github.com/example/business"]
  });
}

describe("LarkExportConnector", () => {
  it("ingests complete exports with stable Lark versions and connector-specific redaction", async () => {
    const { exportDir } = await createExport();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-data-")
    );
    tempDirs.push(knowledgeRoot);
    const firstConnector = connector(exportDir);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      firstConnector,
      {
        vault: { key, actor: "lark-export-test" },
        redactionPolicy: "secrets-and-pii"
      }
    );
    const job = result.jobs[0]!;
    const manifest = SourceManifestSchema.parse(
      JSON.parse(await readFile(job.sourceManifestPath!, "utf8"))
    );
    const restored = await getVaultObject(knowledgeRoot, job.vaultObject!, {
      key,
      actor: "test"
    });
    const evidence = restored.bytes.toString("utf8");

    expect(result).toMatchObject({
      discovered: 1,
      completed: 1,
      skipped: 0,
      failed: 0
    });
    expect(firstConnector.fetchCount).toBe(1);
    expect(manifest).toMatchObject({
      connector: "lark-business",
      artifact_kind: "document",
      external_key: "wiki:account",
      project_keys: ["github.com/example/business"],
      content_type: "application/xml",
      redaction_policy: "secrets-and-pii",
      availability: "available"
    });
    expect(manifest.version.upstream).toMatchObject({
      revision: "17",
      updated_at: "2026-08-08T12:00:00.000Z"
    });
    expect(manifest.version.upstream.path_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence).toContain("[REDACTED_SECRET]");
    expect(evidence).toContain("[REDACTED_PERSON]");
    expect(evidence).not.toContain("actual-password");
    expect(evidence).not.toContain("ou_private");
    expect(evidence).not.toContain("张三");
    expect(JSON.stringify(manifest)).not.toContain("actual-password");

    const secondConnector = connector(exportDir);
    const unchanged = await runConnectorIngestion(
      knowledgeRoot,
      secondConnector,
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );
    expect(unchanged).toMatchObject({
      completed: 0,
      skipped: 1,
      failed: 0
    });
    expect(secondConnector.fetchCount).toBe(0);
  });

  it("ingests successful documents from incomplete exports without removal reconciliation", async () => {
    const { exportDir } = await createExport({ complete: false });
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-incomplete-")
    );
    tempDirs.push(knowledgeRoot);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );

    expect(result.completed).toBe(1);
    expect(result.inventory).toMatchObject({
      mode: "complete",
      complete: false,
      reconciled: false
    });
    expect(
      (await readConnectorCheckpoint(knowledgeRoot, "lark-business"))
        ?.inventoryStatus
    ).toMatchObject({
      mode: "complete",
      complete: false
    });
  });

  it("reports unresolved failures while still ingesting successful documents", async () => {
    const { exportDir } = await createExport();
    const manifestPath = path.join(exportDir, "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          complete: true,
          pending: [],
          failures: {
            "wiki:denied": {
              key: "wiki:denied",
              message: "permission denied"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-failures-")
    );
    tempDirs.push(knowledgeRoot);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );

    expect(result.completed).toBe(1);
    expect(result.inventory).toMatchObject({
      complete: false,
      unresolved: 1,
      reconciled: false,
      reason: "lark_export_partial:pending=0,failures=1"
    });
    expect(
      (await readConnectorCheckpoint(knowledgeRoot, "lark-business"))
        ?.inventoryStatus
    ).toEqual({
      mode: "complete",
      complete: false,
      unresolved: 1,
      reason: "lark_export_partial:pending=0,failures=1"
    });
  });

  it("requires secrets-and-pii before any Lark evidence is fetched", async () => {
    const { exportDir } = await createExport();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-policy-")
    );
    tempDirs.push(knowledgeRoot);
    const lark = connector(exportDir);

    await expect(
      runConnectorIngestion(knowledgeRoot, lark, {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).rejects.toThrow(/requires secrets-and-pii/);
    expect(lark.fetchCount).toBe(0);
  });

  it("keeps zero-success unresolved inventories visible in source list and quality audit", async () => {
    const { exportDir } = await createExport();
    const manifestPath = path.join(exportDir, "manifest.json");
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          documents: {},
          failures: {
            "wiki:denied": {
              key: "wiki:denied",
              message: "permission denied"
            }
          },
          complete: true,
          pending: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-empty-")
    );
    tempDirs.push(knowledgeRoot);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );
    const listed = await listSources(knowledgeRoot, { needsReview: true });
    const audit = await auditKnowledgeQuality(knowledgeRoot);

    expect(result).toMatchObject({
      discovered: 0,
      completed: 0,
      inventory: {
        complete: false,
        unresolved: 1,
        reconciled: false
      }
    });
    expect(listed).toMatchObject({
      total: 0,
      inventory: {
        incompleteConnectors: 1,
        unresolved: 1
      }
    });
    expect(audit.summary).toMatchObject({
      sourceDocuments: 0,
      incompleteSourceConnectors: 1,
      unresolvedSourceInventory: 1
    });
    expect(
      audit.findings.some(
        (finding) => finding.code === "source_inventory_incomplete"
      )
    ).toBe(true);
  });

  it("rejects content.xml that does not match the export manifest hash", async () => {
    const { exportDir } = await createExport({
      manifestContentHash:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    });
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-hash-")
    );
    tempDirs.push(knowledgeRoot);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );

    expect(result.failed).toBe(1);
    expect(result.unresolvedFailures).toBe(1);
    expect(result.jobs[0]?.error).toMatch(/content hash mismatch/);
    const listed = await listSources(knowledgeRoot);
    const audit = await auditKnowledgeQuality(knowledgeRoot);
    expect(listed.inventory.failedSources).toBe(1);
    expect(audit.summary.failedSourceIngestions).toBe(1);
    expect(
      audit.findings.some(
        (finding) => finding.code === "source_ingestion_failed"
      )
    ).toBe(true);
  });

  it("marks removed export documents missing only after a complete manifest run", async () => {
    const { exportDir } = await createExport();
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-removed-")
    );
    tempDirs.push(knowledgeRoot);
    const first = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );
    const sourceId = first.jobs[0]!.sourceId;
    const rawManifest = JSON.parse(
      await readFile(path.join(exportDir, "manifest.json"), "utf8")
    ) as Record<string, unknown>;
    await writeFile(
      path.join(exportDir, "manifest.json"),
      `${JSON.stringify(
        { ...rawManifest, documents: {}, complete: true, pending: [] },
        null,
        2
      )}\n`,
      "utf8"
    );

    const removed = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key },
        redactionPolicy: "secrets-and-pii"
      }
    );
    const manifest = SourceManifestSchema.parse(
      JSON.parse(
        await readFile(getSourceManifestPath(knowledgeRoot, sourceId), "utf8")
      )
    );

    expect(removed.jobs.some((job) => job.classification === "removed")).toBe(
      true
    );
    expect(manifest).toMatchObject({
      availability: "missing",
      processing_status: "pending"
    });
  });
});
