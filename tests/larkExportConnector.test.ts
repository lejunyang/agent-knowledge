import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
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
  media?: Array<{
    kind: "image" | "attachment" | "whiteboard";
    token: string;
    name: string;
    alt?: string;
    contentType: string;
    bytes: Buffer;
  }>;
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
  const media: Record<string, Record<string, unknown>> = {};
  const mediaReferences: Array<Record<string, unknown>> = [];
  for (const [ordinal, item] of (options.media ?? []).entries()) {
    const referenceId = `media_ref_${String(ordinal + 1).padStart(12, "0")}`;
    const mediaDirectory = path.join(directory, "media", referenceId);
    const extension = path.extname(item.name) || ".bin";
    const relativePath = path.join(
      mediaDirectory,
      `${path.basename(item.name, extension)}${extension}`
    );
    await mkdir(path.join(exportDir, mediaDirectory), { recursive: true });
    await writeFile(path.join(exportDir, relativePath), item.bytes);
    mediaReferences.push({
      referenceId,
      kind: item.kind,
      token: item.token,
      ordinal,
      name: item.name,
      alt: item.alt,
      mime: item.contentType,
      source:
        item.kind === "image"
          ? "img"
          : item.kind === "attachment"
            ? "source"
            : "whiteboard"
    });
    media[`wiki:account#${referenceId}`] = {
      referenceId,
      parent: "wiki:account",
      kind: item.kind,
      token: item.token,
      ordinal,
      name: item.name,
      alt: item.alt,
      mime: item.contentType,
      contentType: item.contentType,
      relativePath,
      sha256: createHash("sha256").update(item.bytes).digest("hex"),
      bytes: item.bytes.length,
      downloadMethod: "download",
      observedAt: "2026-08-09T00:00:00.000Z"
    };
  }
  await writeFile(
    path.join(exportDir, "manifest.json"),
    `${JSON.stringify(
      {
        version: 2,
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
            contentHash: options.manifestContentHash ?? hash,
            mediaReferences
          }
        },
        resources: {},
        media,
        mediaFailures: {},
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

  it("ingests Lark media as binary attachments and replaces document handles with safe asset references", async () => {
    const imageBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80
    ]);
    const content = [
      "<h1>部署指南</h1>",
      '<img src="img-private-token" href="https://internal-api-drive-stream.example/temp" name="diagram.png" alt="部署拓扑" mime="image/png"/>'
    ].join("");
    const { exportDir } = await createExport({
      content,
      media: [
        {
          kind: "image",
          token: "img-private-token",
          name: "diagram.png",
          alt: "部署拓扑",
          contentType: "image/png",
          bytes: imageBytes
        }
      ]
    });
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-media-")
    );
    tempDirs.push(knowledgeRoot);

    const result = await runConnectorIngestion(
      knowledgeRoot,
      connector(exportDir),
      {
        vault: { key, actor: "lark-media-test" },
        redactionPolicy: "secrets-and-pii"
      }
    );
    const manifests = await Promise.all(
      result.jobs
        .filter((job) => job.status === "completed")
        .map(async (job) => ({
          job,
          manifest: SourceManifestSchema.parse(
            JSON.parse(await readFile(job.sourceManifestPath!, "utf8"))
          )
        }))
    );
    const document = manifests.find(
      ({ manifest }) => manifest.artifact_kind === "document"
    )!;
    const attachment = manifests.find(
      ({ manifest }) => manifest.artifact_kind === "attachment"
    )!;
    const documentEvidence = (
      await getVaultObject(knowledgeRoot, document.job.vaultObject!, {
        key,
        actor: "test"
      })
    ).bytes.toString("utf8");
    const attachmentEvidence = await getVaultObject(
      knowledgeRoot,
      attachment.job.vaultObject!,
      {
        key,
        actor: "test"
      }
    );

    expect(result).toMatchObject({
      discovered: 2,
      completed: 2,
      failed: 0
    });
    expect(attachment.manifest).toMatchObject({
      connector: "lark-business",
      artifact_kind: "attachment",
      external_key: "wiki:account#media:media_ref_000000000001",
      content_type: "image/png",
      content_bytes: imageBytes.length,
      redaction_policy: "connector-specific"
    });
    expect(attachment.manifest.title).toBe("diagram.png");
    expect(attachment.manifest.version.content_hash).toBe(
      `sha256:${createHash("sha256").update(imageBytes).digest("hex")}`
    );
    expect(attachmentEvidence.bytes).toEqual(imageBytes);
    expect(attachmentEvidence.contentType).toBe("image/png");
    expect(documentEvidence).toContain(
      `<asset-ref source-id="${attachment.manifest.source_id}"`
    );
    expect(documentEvidence).toContain('alt="部署拓扑"');
    expect(documentEvidence).not.toContain("img-private-token");
    expect(documentEvidence).not.toContain("internal-api-drive-stream");
  });

  it("rejects media bytes that do not match the export manifest without losing the document", async () => {
    const imageBytes = Buffer.from("original-image");
    const content =
      '<h1>撕裂测试</h1><img src="img-token" name="diagram.png" mime="image/png"/>';
    const { exportDir, directory } = await createExport({
      content,
      media: [
        {
          kind: "image",
          token: "img-token",
          name: "diagram.png",
          contentType: "image/png",
          bytes: imageBytes
        }
      ]
    });
    await writeFile(
      path.join(
        exportDir,
        directory,
        "media",
        "media_ref_000000000001",
        "diagram.png"
      ),
      Buffer.from("tampered-image")
    );
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-media-hash-")
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

    expect(result).toMatchObject({
      discovered: 2,
      completed: 1,
      failed: 1,
      unresolvedFailures: 1
    });
    expect(
      result.jobs.find((job) => job.status === "failed")?.error
    ).toMatch(/media hash mismatch/);
    expect(
      result.jobs.find((job) => job.status === "completed")?.externalKey
    ).toBe("wiki:account");
  });

  it("includes unresolved media exports in inventory health and disables removal reconciliation", async () => {
    const { exportDir } = await createExport();
    const manifestPath = path.join(exportDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          mediaFailures: {
            "wiki:account#media_ref_failed": {
              referenceId: "media_ref_failed",
              parent: "wiki:account",
              kind: "attachment",
              ordinal: 0,
              name: "failed.pdf",
              message: "media_download_failed",
              updatedAt: "2026-08-09T00:00:00.000Z"
            }
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const knowledgeRoot = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-lark-media-failure-")
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
    expect(result.inventory).toEqual({
      mode: "complete",
      complete: false,
      unresolved: 1,
      reconciled: false,
      reason: "lark_export_partial:pending=0,failures=0,media_failures=1"
    });
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
      reason:
        "lark_export_partial:pending=0,failures=1,media_failures=0"
    });
    expect(
      (await readConnectorCheckpoint(knowledgeRoot, "lark-business"))
        ?.inventoryStatus
    ).toEqual({
      mode: "complete",
      complete: false,
      unresolved: 1,
      reason:
        "lark_export_partial:pending=0,failures=1,media_failures=0"
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
