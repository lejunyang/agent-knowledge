import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getConnectorCheckpointPath,
  getConnectorLockPath,
  getIngestionJobPath,
  getSourceManifestPath,
  readConnectorCheckpoint,
  runConnectorIngestion
} from "../src/ingestion/core.js";
import { redactEvidenceText } from "../src/ingestion/redaction.js";
import {
  createTranscriptConnector,
  FileSystemConnector
} from "../src/ingestion/filesystem.js";
import type {
  ConnectorCursor,
  ConnectorSourceDescriptor,
  KnowledgeConnector,
  NormalizedArtifact
} from "../src/ingestion/types.js";
import { SourceManifestSchema } from "../src/storage/sourceManifest.js";
import {
  getVaultObject,
  getVaultObjectPath
} from "../src/vault/core.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 11);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

class MutableTextConnector implements KnowledgeConnector {
  readonly id = "mutable-documents";
  readonly processingProfile = "mutable-text-v1";
  revision = "1";
  content = "第一版业务正文";
  failWith: string | null = null;
  fetchCount = 0;

  async *discover(
    _cursor: ConnectorCursor | null
  ): AsyncIterable<ConnectorSourceDescriptor> {
    yield {
      sourceId: "src_mutable_document",
      connectorId: this.id,
      externalKey: "document:one",
      title: "可更新业务文档",
      artifactKind: "document",
      contentType: "text/plain",
      projectKeys: ["github.com/example/business"],
      probe: {
        observed_at: "2026-08-09T00:00:00.000Z",
        upstream: { revision: this.revision }
      }
    };
  }

  async fetch(_descriptor: ConnectorSourceDescriptor): Promise<Buffer> {
    this.fetchCount += 1;
    if (this.failWith) {
      throw new Error(this.failWith);
    }
    return Buffer.from(this.content, "utf8");
  }

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

describe("connector ingestion", () => {
  it("redacts common structured secrets without treating arbitrary 11-digit values as phones", () => {
    const input = [
      '"password":"private-password"',
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "cookie=session-cookie-value",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue",
      "+86 13800138000",
      "order=12345678901"
    ].join("\n");

    const result = redactEvidenceText(input, "secrets-and-pii");

    expect(result.text).not.toContain("private-password");
    expect(result.text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result.text).not.toContain("session-cookie-value");
    expect(result.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(result.text).not.toContain("13800138000");
    expect(result.text).toContain("order=12345678901");
    expect(result.counts).toMatchObject({
      authorization_header: 1,
      secret_assignment: 2,
      github_token: 1,
      aws_access_key: 1,
      jwt: 1,
      phone: 1
    });
  });

  it("persists versioned evidence and skips unchanged upstream revisions", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-state-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();
    const options = {
      vault: { key, actor: "ingestion-test" },
      redactionPolicy: "secrets-only" as const
    };

    const first = await runConnectorIngestion(root, connector, options);
    const firstManifest = SourceManifestSchema.parse(
      JSON.parse(
        await readFile(
          getSourceManifestPath(root, "src_mutable_document"),
          "utf8"
        )
      )
    );

    expect(first).toMatchObject({
      connectorId: connector.id,
      discovered: 1,
      completed: 1,
      skipped: 0,
      failed: 0
    });
    expect(first.jobs[0]).toMatchObject({
      status: "completed",
      classification: "new",
      vaultObject: firstManifest.vault_object
    });
    expect(firstManifest).toMatchObject({
      artifact_kind: "document",
      content_type: "text/plain",
      project_keys: ["github.com/example/business"],
      redaction_policy: "secrets-only",
      processing_profile:
        "ingestion-core-v1:mutable-text-v1:deterministic-redaction-v1:secrets-only",
      redactions: {}
    });
    expect(firstManifest.content_bytes).toBe(
      Buffer.byteLength(connector.content, "utf8")
    );
    expect(
      JSON.parse(
        await readFile(getIngestionJobPath(root, first.jobs[0]!.id), "utf8")
      )
    ).toMatchObject({ status: "completed", classification: "new" });
    expect(
      JSON.parse(
        await readFile(getConnectorCheckpointPath(root, connector.id), "utf8")
      )
    ).toMatchObject({
      connectorId: connector.id,
      sources: {
        src_mutable_document: {
          sourceId: "src_mutable_document",
          versionFingerprint: firstManifest.version.fingerprint,
          lastClassification: "new"
        }
      }
    });

    const unchanged = await runConnectorIngestion(root, connector, options);

    expect(unchanged).toMatchObject({
      discovered: 1,
      completed: 0,
      skipped: 1,
      failed: 0
    });
    expect(unchanged.jobs[0]).toMatchObject({
      status: "skipped",
      classification: "unchanged",
      skipReason: "upstream_version_unchanged"
    });
    expect(unchanged.jobs[0]?.id).not.toBe(first.jobs[0]?.id);
    expect(connector.fetchCount).toBe(1);

    connector.revision = "2";
    const metadataOnly = await runConnectorIngestion(root, connector, options);
    const secondManifest = SourceManifestSchema.parse(
      JSON.parse(
        await readFile(
          getSourceManifestPath(root, "src_mutable_document"),
          "utf8"
        )
      )
    );

    expect(metadataOnly.jobs[0]).toMatchObject({
      status: "completed",
      classification: "metadata_only",
      vaultObject: firstManifest.vault_object
    });
    expect(secondManifest.version.upstream.revision).toBe("2");
    expect(secondManifest.version.content_hash).toBe(
      firstManifest.version.content_hash
    );

    connector.revision = "3";
    connector.content = "第二版业务正文，新增了更新识别规则。";
    const changed = await runConnectorIngestion(root, connector, options);
    const thirdManifest = SourceManifestSchema.parse(
      JSON.parse(
        await readFile(
          getSourceManifestPath(root, "src_mutable_document"),
          "utf8"
        )
      )
    );

    expect(changed.jobs[0]).toMatchObject({
      status: "completed",
      classification: "content_changed"
    });
    expect(thirdManifest.version.content_hash).not.toBe(
      secondManifest.version.content_hash
    );
    expect(thirdManifest.vault_object).not.toBe(firstManifest.vault_object);
  });

  it("does not advance checkpoints after failure and safely retries the same source", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-retry-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();
    const secret = "api_key=retry-secret-value";
    connector.failWith = `remote failed with ${secret}`;
    const options = {
      vault: { key, actor: "ingestion-test" },
      redactionPolicy: "secrets-only" as const
    };

    const failed = await runConnectorIngestion(root, connector, options);
    const failedJobText = await readFile(
      getIngestionJobPath(root, failed.jobs[0]!.id),
      "utf8"
    );

    expect(failed).toMatchObject({
      completed: 0,
      skipped: 0,
      failed: 1
    });
    expect(failed.jobs[0]?.error).toContain("[REDACTED_SECRET]");
    expect(failedJobText).not.toContain("retry-secret-value");
    expect(await readConnectorCheckpoint(root, connector.id)).toBeNull();
    const failedJobId = failed.jobs[0]!.id;

    connector.failWith = null;
    const retried = await runConnectorIngestion(root, connector, options);

    expect(retried).toMatchObject({
      completed: 1,
      skipped: 0,
      failed: 0
    });
    expect(retried.jobs[0]).toMatchObject({
      status: "completed",
      classification: "new"
    });
    expect(retried.jobs[0]?.id).not.toBe(failedJobId);
    expect(
      JSON.parse(
        await readFile(getIngestionJobPath(root, failedJobId), "utf8")
      )
    ).toMatchObject({ status: "failed" });
    expect(await readConnectorCheckpoint(root, connector.id)).not.toBeNull();
  });

  it("reprocesses unchanged sources after pipeline upgrades and preserves refined status", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-profile-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();
    const options = {
      vault: { key, actor: "ingestion-test" },
      redactionPolicy: "secrets-only" as const
    };
    const first = await runConnectorIngestion(root, connector, options);
    const manifestPath = first.jobs[0]!.sourceManifestPath!;
    const previous = JSON.parse(
      await readFile(manifestPath, "utf8")
    ) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...previous,
          processing_status: "refined",
          processing_profile: "legacy-pipeline-v0"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const upgraded = await runConnectorIngestion(root, connector, options);
    const current = SourceManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );

    expect(upgraded.jobs[0]).toMatchObject({
      status: "completed",
      classification: "metadata_only"
    });
    expect(connector.fetchCount).toBe(2);
    expect(current.processing_status).toBe("refined");
    expect(current.processing_profile).toBe(
      "ingestion-core-v1:mutable-text-v1:deterministic-redaction-v1:secrets-only"
    );
  });

  it("refetches an unchanged source when its referenced Vault object is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-repair-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();
    const options = {
      vault: { key, actor: "ingestion-test" },
      redactionPolicy: "secrets-only" as const
    };
    const first = await runConnectorIngestion(root, connector, options);
    const objectId = first.jobs[0]!.vaultObject!;
    await rm(getVaultObjectPath(root, objectId));

    const repaired = await runConnectorIngestion(root, connector, options);

    expect(repaired.jobs[0]).toMatchObject({
      status: "completed",
      classification: "unchanged",
      vaultObject: objectId
    });
    expect(connector.fetchCount).toBe(2);
    expect(await readFile(getVaultObjectPath(root, objectId), "utf8")).not.toContain(
      connector.content
    );
  });

  it("serializes connector runs and recovers locks owned by dead processes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-lock-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();
    const lockPath = getConnectorLockPath(root, connector.id);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, token: "active" })}\n`,
      "utf8"
    );

    await expect(
      runConnectorIngestion(root, connector, {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).rejects.toThrow(/already locked/);

    await writeFile(
      lockPath,
      `${JSON.stringify({ pid: 99999999, token: "stale" })}\n`,
      "utf8"
    );
    const recovered = await runConnectorIngestion(root, connector, {
      vault: { key },
      redactionPolicy: "secrets-only"
    });

    expect(recovered.completed).toBe(1);
    await expect(readFile(lockPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("rejects invalid redaction policies before fetching or writing Vault data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-policy-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector();

    await expect(
      runConnectorIngestion(root, connector, {
        vault: { key },
        redactionPolicy: "disabled" as never
      })
    ).rejects.toThrow();

    expect(connector.fetchCount).toBe(0);
    await expect(readFile(path.join(root, ".vault", "metadata.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects complete inventory connectors without a stable inventory identity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-inventory-"));
    tempDirs.push(root);
    const connector = new MutableTextConnector() as MutableTextConnector & {
      inventoryMode: "complete";
    };
    connector.inventoryMode = "complete";

    await expect(
      runConnectorIngestion(root, connector, {
        vault: { key },
        redactionPolicy: "secrets-only"
      })
    ).rejects.toThrow(/stable inventory identity/);
    expect(connector.fetchCount).toBe(0);
  });

  it("redacts transcript secrets and PII before writing Vault, manifest, or jobs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-transcript-"));
    const input = path.join(root, "transcripts");
    tempDirs.push(root);
    await mkdir(input, { recursive: true });
    await writeFile(
      path.join(input, "session.jsonl"),
      [
        "{\"role\":\"user\",\"email\":\"owner@example.com\",\"phone\":\"13800138000\"}",
        "{\"role\":\"tool\",\"api_key\":\"sk-abcdefghijklmnopqrstuvwxyz123456\"}",
        "{\"role\":\"user\",\"id\":\"11010519491231002X\"}"
      ].join("\n"),
      "utf8"
    );
    const connector = createTranscriptConnector({
      id: "agent-transcripts",
      baseDir: input,
      projectKeys: ["github.com/example/support"]
    });

    const result = await runConnectorIngestion(root, connector, {
      vault: { key, actor: "transcript-ingestion" },
      redactionPolicy: "secrets-and-pii"
    });
    const job = result.jobs[0]!;
    const restored = await getVaultObject(root, job.vaultObject!, {
      key,
      actor: "test-read"
    });
    const restoredText = restored.bytes.toString("utf8");
    const manifestText = await readFile(job.sourceManifestPath!, "utf8");
    const jobText = await readFile(
      getIngestionJobPath(root, job.id),
      "utf8"
    );
    const serializedGovernance = `${manifestText}\n${jobText}\n${restoredText}`;

    expect(job).toMatchObject({
      status: "completed",
      classification: "new",
      redactions: {
        secret_assignment: 1,
        phone: 1,
        email: 1,
        id_number: 1
      }
    });
    expect(restoredText).toContain("[REDACTED_SECRET]");
    expect(restoredText).toContain("[REDACTED_EMAIL]");
    expect(restoredText).toContain("[REDACTED_PHONE]");
    expect(restoredText).toContain("[REDACTED_ID_NUMBER]");
    expect(serializedGovernance).not.toContain("owner@example.com");
    expect(serializedGovernance).not.toContain("13800138000");
    expect(serializedGovernance).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz123456"
    );
    expect(serializedGovernance).not.toContain("11010519491231002X");
    expect(SourceManifestSchema.parse(JSON.parse(manifestText))).toMatchObject({
      artifact_kind: "transcript",
      content_type: "application/x-ndjson",
      project_keys: ["github.com/example/support"],
      redaction_policy: "secrets-and-pii",
      redactions: {
        secret_assignment: 1,
        phone: 1,
        email: 1,
        id_number: 1
      }
    });
    expect(
      SourceManifestSchema.parse(JSON.parse(manifestText)).sections.every(
        (section) => section.preview === ""
      )
    ).toBe(true);
  });

  it("refuses symlink escapes, traversal descriptors, and invalid UTF-8", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ingestion-filesystem-"));
    const baseDir = path.join(root, "base");
    const outside = path.join(root, "outside.txt");
    tempDirs.push(root);
    await mkdir(baseDir, { recursive: true });
    await writeFile(outside, "outside", "utf8");
    await symlink(outside, path.join(baseDir, "escape.txt"));
    await writeFile(
      path.join(baseDir, "invalid.txt"),
      Buffer.from([0xc3, 0x28])
    );
    const connector = new FileSystemConnector({
      id: "bounded-files",
      baseDir,
      patterns: ["**/*"],
      artifactKind: "document"
    });
    const descriptor: ConnectorSourceDescriptor = {
      sourceId: "src_escape",
      connectorId: connector.id,
      externalKey: "escape.txt",
      title: "escape.txt",
      artifactKind: "document",
      contentType: "text/plain",
      projectKeys: [],
      probe: {
        observed_at: "2026-08-09T00:00:00.000Z",
        upstream: {}
      }
    };

    await expect(connector.fetch(descriptor)).rejects.toThrow(
      /escapes base directory/
    );
    await expect(
      connector.fetch({ ...descriptor, externalKey: "../outside.txt" })
    ).rejects.toThrow(/escapes base directory/);
    await expect(
      connector.normalize(
        { ...descriptor, externalKey: "invalid.txt" },
        await readFile(path.join(baseDir, "invalid.txt"))
      )
    ).rejects.toThrow(/valid UTF-8/);

    const discovered: ConnectorSourceDescriptor[] = [];
    for await (const item of connector.discover(null)) {
      discovered.push(item);
    }
    expect(discovered.map((item) => item.externalKey)).toEqual([
      "invalid.txt"
    ]);
  });
});
