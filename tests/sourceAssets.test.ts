import { createHash } from "node:crypto";
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
  getPublishedAssetManifestPath,
  publishSourceAsset
} from "../src/storage/sourceAssets.js";
import { buildSourceManifest } from "../src/storage/sourceManifest.js";
import { putVaultObject } from "../src/vault/core.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 29);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

/** 创建一条以二进制 hash 作为版本身份的 attachment source。 */
async function createAttachmentSource(
  rootDir: string,
  options: {
    contentType?: string;
    bytes?: Buffer;
    sourceId?: string;
  } = {}
) {
  const bytes =
    options.bytes ??
    Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff
    ]);
  const contentType = options.contentType ?? "image/png";
  const sourceId = options.sourceId ?? "src_media_diagram";
  const stored = await putVaultObject(
    rootDir,
    { bytes, contentType },
    { key, actor: "source-assets-test" }
  );
  const manifest = buildSourceManifest({
    sourceId,
    connector: "lark-business",
    artifactKind: "attachment",
    externalKey: "wiki:account#media:media_ref_diagram",
    title: "部署拓扑.png",
    content:
      '<attachment parent-source-id="src_parent" kind="image" reference-id="media_ref_diagram"/>',
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    contentBytes: bytes.length,
    observedAt: "2026-08-11T00:00:00.000Z",
    projectKeys: ["github.com/example/business"],
    contentType,
    redactionPolicy: "connector-specific",
    processingProfile: "source-assets-test-v1",
    vaultObject: stored.id
  });
  const directory = path.join(rootDir, "knowledge", "source-manifests");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, `${sourceId}.json`),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return { bytes, manifest };
}

describe("published source assets", () => {
  it("publishes reviewed attachments as content-addressed Git assets idempotently", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-asset-")
    );
    tempDirs.push(rootDir);
    const { bytes, manifest } = await createAttachmentSource(rootDir);

    const first = await publishSourceAsset(
      rootDir,
      {
        sourceId: manifest.source_id,
        expectedFingerprint: manifest.version.fingerprint,
        reviewed: true
      },
      { key, actor: "source-asset-publish-test" }
    );
    const second = await publishSourceAsset(
      rootDir,
      {
        sourceId: manifest.source_id,
        expectedFingerprint: manifest.version.fingerprint,
        reviewed: true
      },
      { key, actor: "source-asset-publish-test" }
    );
    const persistedManifest = JSON.parse(
      await readFile(first.manifestPath, "utf8")
    ) as Record<string, unknown>;

    expect(first.assetId).toMatch(/^asset_sha256_[a-f0-9]{64}$/);
    expect(first.uri).toBe(`asset://${first.assetId}`);
    expect(first.relativePath).toMatch(
      /^knowledge\/assets\/objects\/[a-f0-9]{2}\/asset_sha256_[a-f0-9]{64}\.png$/
    );
    expect(await readFile(path.join(rootDir, first.relativePath))).toEqual(
      bytes
    );
    expect(first.deduplicated).toBe(false);
    expect(second).toMatchObject({
      assetId: first.assetId,
      relativePath: first.relativePath,
      deduplicated: true
    });
    expect(persistedManifest).toMatchObject({
      schema_version: 1,
      asset_id: first.assetId,
      source_id: manifest.source_id,
      source_fingerprint: manifest.version.fingerprint,
      content_hash: manifest.version.content_hash,
      content_type: "image/png",
      content_bytes: bytes.length,
      relative_path: first.relativePath
    });
    expect(getPublishedAssetManifestPath(rootDir, first.assetId)).toBe(
      first.manifestPath
    );
  });

  it("requires an explicit reviewed confirmation before creating Git assets", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-asset-review-")
    );
    tempDirs.push(rootDir);
    const { manifest } = await createAttachmentSource(rootDir);

    await expect(
      publishSourceAsset(
        rootDir,
        {
          sourceId: manifest.source_id,
          expectedFingerprint: manifest.version.fingerprint,
          reviewed: false
        },
        { key, actor: "test" }
      )
    ).rejects.toThrow(/explicit reviewed confirmation/);
    await expect(
      readFile(
        path.join(rootDir, "knowledge", "assets", "manifests"),
        "utf8"
      )
    ).rejects.toThrow();
  });

  it("rejects stale fingerprints before decrypting or publishing the attachment", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-asset-fingerprint-")
    );
    tempDirs.push(rootDir);
    const { manifest } = await createAttachmentSource(rootDir);

    await expect(
      publishSourceAsset(
        rootDir,
        {
          sourceId: manifest.source_id,
          expectedFingerprint: `sha256:${"a".repeat(64)}`,
          reviewed: true
        },
        { key, actor: "test" }
      )
    ).rejects.toThrow(/fingerprint changed/);
  });

  it.each([
    "text/html",
    "image/svg+xml",
    "application/javascript",
    "application/octet-stream"
  ])("rejects unsafe or unknown publish MIME %s", async (contentType) => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-source-asset-unsafe-")
    );
    tempDirs.push(rootDir);
    const { manifest } = await createAttachmentSource(rootDir, {
      contentType,
      sourceId: `src_unsafe_${createHash("sha256")
        .update(contentType)
        .digest("hex")
        .slice(0, 12)}`
    });

    await expect(
      publishSourceAsset(
        rootDir,
        {
          sourceId: manifest.source_id,
          expectedFingerprint: manifest.version.fingerprint,
          reviewed: true
        },
        { key, actor: "test" }
      )
    ).rejects.toThrow(/not safe to publish/);
  });
});
