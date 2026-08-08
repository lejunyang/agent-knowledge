import {
  mkdir,
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
  exportSourceEvidence,
  listSources,
  markSourceReviewed,
  showSource
} from "../src/storage/sourceReview.js";
import {
  buildSourceManifest,
  SourceManifestSchema
} from "../src/storage/sourceManifest.js";
import { putVaultObject } from "../src/vault/core.js";
import { captureMaterial } from "./helpers/candidate.js";
import { FileSystemConnector } from "../src/ingestion/filesystem.js";
import { runConnectorIngestion } from "../src/ingestion/core.js";
import { registerConnector } from "../src/ingestion/registry.js";
import { checkConnectorSourceUpdates } from "../src/ingestion/sourceUpdates.js";

const tempDirs: string[] = [];
const key = Buffer.alloc(32, 21);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
  tempDirs.length = 0;
});

/** 写入一份带 Vault handle 的待处理 source manifest。 */
async function createSource(root: string) {
  const content = [
    "<h1>账号体系</h1>",
    "<p>商业化 UID 与抖音 UID 属于不同账号组。</p>",
    "<h2>授权关系</h2>",
    "<p>两者只能通过显式 OAuth 授权建立绑定。</p>",
    `<p>${"公开说明。".repeat(150)}</p>`,
    "<p>FULL_EVIDENCE_PRIVATE_TAIL</p>"
  ].join("");
  const stored = await putVaultObject(
    root,
    { bytes: Buffer.from(content, "utf8"), contentType: "application/xml" },
    { key, actor: "source-review-test" }
  );
  const manifest = buildSourceManifest({
    sourceId: "src_account_system",
    connector: "lark",
    externalKey: "wiki:account-system",
    title: "账号体系",
    content,
    observedAt: "2026-08-09T00:00:00.000Z",
    projectKeys: ["github.com/example/business"],
    contentType: "application/xml",
    redactionPolicy: "connector-specific",
    processingProfile: "source-review-fixture-v1",
    upstreamVersion: { revision: "17" },
    vaultObject: stored.id
  });
  const directory = path.join(root, "knowledge", "source-manifests");
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, `${manifest.source_id}.json`);
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return { manifest, manifestPath, content };
}

describe("source review workflow", () => {
  it("lists and shows review metadata without exposing the complete evidence body", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-list-"));
    tempDirs.push(root);
    const { manifest } = await createSource(root);

    const listed = await listSources(root, {
      statuses: ["pending"],
      availability: "available",
      projectKeys: ["github.com/example/business"],
      needsReview: true
    });
    const shown = await showSource(root, manifest.source_id);
    const serialized = JSON.stringify({ listed, shown });

    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      sourceId: manifest.source_id,
      processingStatus: "pending",
      reviewState: "pending",
      availability: "available"
    });
    expect(shown.expectedFingerprint).toBe(manifest.version.fingerprint);
    expect(shown.exportAvailable).toBe(true);
    expect(serialized).not.toContain("FULL_EVIDENCE_PRIVATE_TAIL");
    expect(serialized).not.toContain("ciphertext");
  });

  it("summarizes registered connector update health without treating stale reports as current", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "source-review-update-health-")
    );
    tempDirs.push(root);
    const sourceDir = path.join(root, "upstream");
    const sourceFile = path.join(sourceDir, "guide.md");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(sourceFile, "# Guide\n\nVersion one.\n", "utf8");
    const registrationInput = {
      kind: "files" as const,
      connectorId: "review-business-docs",
      redactionPolicy: "secrets-only" as const,
      options: {
        baseDir: sourceDir,
        patterns: ["**/*.md"],
        artifactKind: "document" as const,
        projectKeys: ["github.com/example/business"]
      }
    };
    const connector = new FileSystemConnector({
      id: registrationInput.connectorId,
      baseDir: sourceDir,
      patterns: registrationInput.options.patterns,
      artifactKind: "document",
      projectKeys: registrationInput.options.projectKeys
    });
    const registration = (
      await registerConnector(root, registrationInput)
    ).record;
    await runConnectorIngestion(root, connector, {
      vault: { key },
      redactionPolicy: "secrets-only"
    });

    const unchecked = await listSources(root);
    expect(unchecked.updateHealth).toMatchObject({
      registeredConnectors: 1,
      uncheckedConnectors: 1,
      staleChecks: 0,
      updatesAvailable: 0,
      verificationRequired: 0
    });

    await checkConnectorSourceUpdates(root, connector, registration);
    const current = await listSources(root);
    expect(current.updateHealth).toMatchObject({
      registeredConnectors: 1,
      uncheckedConnectors: 0,
      staleChecks: 0,
      updatesAvailable: 0,
      verificationRequired: 0
    });

    await writeFile(
      sourceFile,
      "# Guide\n\nVersion two with a changed workflow.\n",
      "utf8"
    );
    await checkConnectorSourceUpdates(root, connector, registration);
    const changed = await listSources(root);
    expect(changed.updateHealth).toMatchObject({
      uncheckedConnectors: 0,
      updatesAvailable: 0,
      verificationRequired: 1
    });
    expect(changed.updateHealth.connectors[0]).toMatchObject({
      connectorId: registration.connectorId,
      state: "current",
      verificationRequired: 1
    });

    await registerConnector(root, registrationInput);
    const stale = await listSources(root);
    expect(stale.updateHealth).toMatchObject({
      uncheckedConnectors: 1,
      staleChecks: 1,
      updatesAvailable: 0,
      verificationRequired: 0
    });
    expect(stale.updateHealth.connectors[0]?.state).toBe("stale");
  });

  it("exports decrypted evidence only to an explicit restricted file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-export-"));
    tempDirs.push(root);
    const { manifest, content } = await createSource(root);
    const output = path.join(
      path.dirname(root),
      `${path.basename(root)}-review`,
      "source.xml"
    );

    const result = await exportSourceEvidence(
      root,
      {
        sourceId: manifest.source_id,
        expectedFingerprint: manifest.version.fingerprint,
        outputPath: output
      },
      { key, actor: "source-distiller" }
    );

    expect(result).toMatchObject({
      sourceId: manifest.source_id,
      fingerprint: manifest.version.fingerprint,
      outputPath: output
    });
    expect(await readFile(output, "utf8")).toBe(content);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(content);
    await expect(
      exportSourceEvidence(
        root,
        {
          sourceId: manifest.source_id,
          expectedFingerprint: manifest.version.fingerprint,
          outputPath: output
        },
        { key }
      )
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      exportSourceEvidence(
        root,
        {
          sourceId: manifest.source_id,
          expectedFingerprint: manifest.version.fingerprint,
          outputPath: path.join(root, "knowledge", "unsafe-source.xml")
        },
        { key }
      )
    ).rejects.toThrow(/outside the knowledge workspace/);
  });

  it("uses the source fingerprint as an optimistic review lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-lock-"));
    tempDirs.push(root);
    const { manifest, manifestPath } = await createSource(root);
    const before = await readFile(manifestPath, "utf8");
    const shown = await showSource(root, manifest.source_id);

    await expect(
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expectedReviewToken: shown.reviewToken,
        status: "blocked",
        reason: "领域术语意义不明"
      })
    ).rejects.toThrow(/fingerprint changed/);

    expect(await readFile(manifestPath, "utf8")).toBe(before);
  });

  it("marks refined only when active knowledge links current source evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-refined-"));
    tempDirs.push(root);
    const { manifest, manifestPath } = await createSource(root);
    const firstSection = manifest.sections[0]!;
    const initial = await showSource(root, manifest.source_id);

    await expect(
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint: manifest.version.fingerprint,
        expectedReviewToken: initial.reviewToken,
        status: "refined",
        knowledgeIds: ["k_missing_knowledge"]
      })
    ).rejects.toThrow(/active knowledge/);

    await captureMaterial(
      root,
      [
        {
          id: "k_account_identity_boundary",
          title: "账号身份边界",
          kind: "semantic",
          layer: "knowledge",
          domain: "business/account",
          related_domains: [],
          scenarios: [
            {
              id: "account-identity",
              role: "primary",
              weight: 1
            }
          ],
          tags: [],
          confidence: 0.95,
          source_authority: "documented",
          synopsis: "商业化 UID 与抖音 UID 属于不同账号组，必须通过显式授权建立关系。",
          aliases: [],
          claims: [
            {
              id: "claim_account_identity_boundary",
              statement: "商业化 UID 与抖音 UID 属于不同账号组。",
              status: "supported",
              confidence: 0.95,
              evidence: [
                {
                  source_id: manifest.source_id,
                  section_id: firstSection.section_id,
                  quote_hash: firstSection.text_hash
                }
              ]
            }
          ],
          evidence: [`source:${manifest.source_id}`],
          project_keys: ["github.com/example/business"]
        }
      ],
      { target: "active", rebuild: false }
    );

    const result = await markSourceReviewed(root, {
      sourceId: manifest.source_id,
      expectedFingerprint: manifest.version.fingerprint,
      expectedReviewToken: initial.reviewToken,
      status: "refined",
      knowledgeIds: ["k_account_identity_boundary"]
    });
    const updated = SourceManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );

    expect(result).toMatchObject({
      sourceId: manifest.source_id,
      processingStatus: "refined",
      reviewState: "current",
      refinedKnowledgeIds: ["k_account_identity_boundary"]
    });
    expect(updated.processing_status).toBe("refined");
    expect(updated.processed_content_hash).toBe(
      manifest.version.content_hash
    );
    expect(updated.processed_at).toBeDefined();
  });

  it("validates duplicate targets and records non-knowledge review outcomes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-outcomes-"));
    tempDirs.push(root);
    const { manifest } = await createSource(root);
    const initial = await showSource(root, manifest.source_id);

    await expect(
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint: manifest.version.fingerprint,
        expectedReviewToken: initial.reviewToken,
        status: "duplicate",
        duplicateOf: "src_unknown",
        reason: "与另一来源重复"
      })
    ).rejects.toThrow(/Duplicate source/);

    const blocked = await markSourceReviewed(root, {
      sourceId: manifest.source_id,
      expectedFingerprint: manifest.version.fingerprint,
      expectedReviewToken: initial.reviewToken,
      status: "blocked",
      reason: "等待业务 owner 确认术语"
    });

    expect(blocked).toMatchObject({
      processingStatus: "blocked",
      processingReason: "等待业务 owner 确认术语",
      reviewState: "current"
    });
  });

  it("reports a reviewed source as stale when its current content hash changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-stale-"));
    tempDirs.push(root);
    const { manifest, manifestPath } = await createSource(root);
    const initial = await showSource(root, manifest.source_id);
    await markSourceReviewed(root, {
      sourceId: manifest.source_id,
      expectedFingerprint: manifest.version.fingerprint,
      expectedReviewToken: initial.reviewToken,
      status: "blocked",
      reason: "等待业务 owner 确认"
    });
    const reviewed = SourceManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8"))
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...reviewed,
          version: {
            ...reviewed.version,
            content_hash:
              "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          }
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const listed = await listSources(root, { needsReview: true });

    expect(listed.items[0]?.reviewState).toBe("stale");
  });

  it("rejects a second reviewer after the review receipt changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-race-"));
    tempDirs.push(root);
    const { manifest } = await createSource(root);
    const shown = await showSource(root, manifest.source_id);
    await markSourceReviewed(root, {
      sourceId: manifest.source_id,
      expectedFingerprint: shown.expectedFingerprint,
      expectedReviewToken: shown.reviewToken,
      status: "blocked",
      reason: "第一位审阅者等待业务确认"
    });

    await expect(
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint: shown.expectedFingerprint,
        expectedReviewToken: shown.reviewToken,
        status: "no_long_term_value",
        reason: "第二位审阅者认为无长期价值"
      })
    ).rejects.toThrow(/review receipt changed/);
  });

  it("serializes simultaneous reviewers so only one receipt update succeeds", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "source-review-concurrent-"));
    tempDirs.push(root);
    const { manifest } = await createSource(root);
    const shown = await showSource(root, manifest.source_id);
    const attempts = await Promise.allSettled([
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint: shown.expectedFingerprint,
        expectedReviewToken: shown.reviewToken,
        status: "blocked",
        reason: "审阅者 A 等待业务确认"
      }),
      markSourceReviewed(root, {
        sourceId: manifest.source_id,
        expectedFingerprint: shown.expectedFingerprint,
        expectedReviewToken: shown.reviewToken,
        status: "no_long_term_value",
        reason: "审阅者 B 判断没有长期价值"
      })
    ]);

    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1);
  });
});
