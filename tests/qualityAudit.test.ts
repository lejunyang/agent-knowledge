import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditKnowledgeQuality } from "../src/storage/qualityAudit.js";
import { buildSourceManifest } from "../src/storage/sourceManifest.js";
import { putVaultObject } from "../src/vault/core.js";
import {
  appendLifecycleEvent,
  getEventTimelinePath
} from "../src/events/ledger.js";
import { getVaultObjectPath } from "../src/vault/core.js";

const tempDirs: string[] = [];
const vaultKey = Buffer.alloc(32, 13);

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

/** 在 fixture 工作区写 source manifest，并返回首个 section 供 claim 引用。 */
async function writeManifest(
  root: string,
  processingStatus: "pending" | "refined",
  options: { persistVault?: boolean } = {}
) {
  const content =
    "<h1>Vue SFC</h1><p>Vue SFC template needs ESLint fallback.</p>";
  const vaultObject = options.persistVault
    ? await putVaultObject(
        root,
        { bytes: Buffer.from(content, "utf8"), contentType: "text/html" },
        { key: vaultKey, actor: "quality-test" }
      )
    : undefined;
  const manifest = buildSourceManifest({
    sourceId: "src_lint_design",
    connector: "file",
    externalKey: "file:lint-design",
    title: "Lint design",
    content,
    observedAt: "2026-08-09T00:00:00.000Z",
    upstreamVersion: { opaque_version: "fixture-v1" },
    redactionPolicy: "connector-specific",
    processingStatus,
    refinedKnowledgeIds:
      processingStatus === "refined"
        ? ["k_20260705_frontend_lint_vue_sfc"]
        : [],
    vaultObject: vaultObject?.id
  });
  const directory = path.join(root, "knowledge", "source-manifests");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "src_lint_design.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifest;
}

describe("auditKnowledgeQuality", () => {
  it("reports thin knowledge, pending sources, stale anchors, and unknown projects", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-findings-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    await writeManifest(root, "pending");
    const target = path.join(
      root,
      "knowledge",
      "semantic",
      "frontend-lint",
      "2026-07-05-vue-sfc-eslint-fallback.md"
    );
    const original = await readFile(target, "utf8");
    await writeFile(
      target,
      original
        .replace(
          "source:\n  - conversation:2026-07-05-agent-memory-design",
          "source:\n  - source:src_lint_design"
        )
        .replace(
          "claims: []",
          `claims:
  - id: claim_stale_anchor
    statement: Vue SFC template needs ESLint fallback.
    status: supported
    confidence: 0.9
    evidence:
      - source_id: src_lint_design
        section_id: sec_missing
        quote_hash: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
        )
        .replace(
          "project_keys: []",
          "project_keys:\n  - github.com/example/unregistered"
        ),
      "utf8"
    );

    const report = await auditKnowledgeQuality(root);
    const codes = report.findings.map((finding) => finding.code);

    expect(report.summary.sourceDocuments).toBe(1);
    expect(report.summary.sourceCoverage).toBe(0);
    expect(report.summary.sourceAvailabilityCoverage).toBe(1);
    expect(report.summary.vaultEvidenceCoverage).toBe(0);
    expect(report.summary.upstreamVersionCoverage).toBe(1);
    expect(report.summary.redactionPolicyCoverage).toBe(1);
    expect(report.summary.claimEvidenceCoverage).toBe(0);
    expect(codes).toContain("knowledge_body_too_thin");
    expect(codes).toContain("source_without_refined_knowledge");
    expect(codes).toContain("source_without_vault_object");
    expect(codes).toContain("unknown_evidence_anchor");
    expect(codes).toContain("unknown_project_key");
  });

  it("reports complete source and claim coverage for grounded knowledge", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-grounded-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const manifest = await writeManifest(root, "refined", {
      persistVault: true
    });
    const section = manifest.sections[0]!;
    const target = path.join(
      root,
      "knowledge",
      "semantic",
      "frontend-lint",
      "2026-07-05-vue-sfc-eslint-fallback.md"
    );
    const original = await readFile(target, "utf8");
    await writeFile(
      target,
      original
        .replace(
          "source:\n  - conversation:2026-07-05-agent-memory-design",
          "source:\n  - source:src_lint_design"
        )
        .replace(
          "claims: []",
          `claims:
  - id: claim_grounded
    statement: Vue SFC template needs ESLint fallback.
    status: supported
    confidence: 0.9
    evidence:
      - source_id: src_lint_design
        section_id: ${section.section_id}
        quote_hash: ${section.text_hash}`
        ),
      "utf8"
    );

    const report = await auditKnowledgeQuality(root, {
      minimumKnowledgeBodyChars: 1,
      maximumFrontmatterShare: 1,
      maximumAliases: 8,
      maximumScenarios: 6,
      maximumTags: 8
    });

    expect(report.summary.sourceCoverage).toBe(1);
    expect(report.summary.sourceAvailabilityCoverage).toBe(1);
    expect(report.summary.vaultEvidenceCoverage).toBe(1);
    expect(report.summary.upstreamVersionCoverage).toBe(1);
    expect(report.summary.redactionPolicyCoverage).toBe(1);
    expect(report.summary.claimEvidenceCoverage).toBe(1);
    expect(
      report.findings.filter((finding) => finding.severity === "error")
    ).toEqual([]);
  });

  it("invalidates claim anchors when the upstream source is marked missing", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-missing-source-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const manifest = await writeManifest(root, "refined", {
      persistVault: true
    });
    const section = manifest.sections[0]!;
    const manifestPath = path.join(
      root,
      "knowledge",
      "source-manifests",
      "src_lint_design.json"
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          availability: "missing",
          missing_since: "2026-08-10T00:00:00.000Z",
          processing_status: "pending",
          processing_reason: undefined,
          processed_at: undefined,
          processed_content_hash: undefined,
          refined_knowledge_ids: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );
    const target = path.join(
      root,
      "knowledge",
      "semantic",
      "frontend-lint",
      "2026-07-05-vue-sfc-eslint-fallback.md"
    );
    const original = await readFile(target, "utf8");
    await writeFile(
      target,
      original
        .replace(
          "source:\n  - conversation:2026-07-05-agent-memory-design",
          "source:\n  - source:src_lint_design"
        )
        .replace(
          "claims: []",
          `claims:
  - id: claim_removed_source
    statement: Vue SFC template needs ESLint fallback.
    status: supported
    confidence: 0.9
    evidence:
      - source_id: src_lint_design
        section_id: ${section.section_id}
        quote_hash: ${section.text_hash}`
        ),
      "utf8"
    );

    const report = await auditKnowledgeQuality(root, {
      minimumKnowledgeBodyChars: 1,
      maximumFrontmatterShare: 1,
      maximumAliases: 8,
      maximumScenarios: 6,
      maximumTags: 8
    });

    expect(report.summary.claimEvidenceCoverage).toBe(0);
    expect(report.summary.sourceCoverage).toBe(0);
    expect(report.summary.sourceAvailabilityCoverage).toBe(0);
    expect(report.summary.vaultEvidenceCoverage).toBe(1);
    expect(
      report.findings.some(
        (finding) => finding.code === "source_missing_upstream"
      )
    ).toBe(true);
    expect(
      report.findings.some(
        (finding) => finding.code === "unknown_evidence_anchor"
      )
    ).toBe(true);
  });

  it("reports stale receipts and invalid duplicate targets", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-source-review-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const manifest = await writeManifest(root, "pending");
    const manifestPath = path.join(
      root,
      "knowledge",
      "source-manifests",
      "src_lint_design.json"
    );
    await writeFile(
      manifestPath,
      `${JSON.stringify(
        {
          ...manifest,
          processing_status: "duplicate",
          processing_reason: "与规范来源重复",
          duplicate_of: "src_missing_canonical",
          processed_at: "2026-08-10T00:00:00.000Z",
          processed_content_hash:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          refined_knowledge_ids: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const report = await auditKnowledgeQuality(root);
    const codes = report.findings.map((finding) => finding.code);

    expect(report.summary.sourceCoverage).toBe(0);
    expect(codes).toContain("source_review_stale");
    expect(codes).toContain("invalid_duplicate_source");
  });

  it("reports missing event payloads and invalid timeline chains", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-events-")
    );
    tempDirs.push(root);
    const event = await appendLifecycleEvent(
      root,
      {
        streamType: "support",
        streamId: "case_audit",
        stage: "intake",
        eventType: "customer_question",
        summary: "客户反馈登录失败。",
        payloadText: "complete payload",
        payloadContentType: "text/plain",
        projectKeys: ["github.com/example/support"],
        actorType: "customer",
        captureMode: "automated_session",
        idempotencyKey: "audit"
      },
      { key: vaultKey }
    );
    await rm(getVaultObjectPath(root, event.payloadObject!));

    const missing = await auditKnowledgeQuality(root);

    expect(missing.summary).toMatchObject({
      eventStreams: 1,
      lifecycleEvents: 1,
      missingEventPayloads: 1
    });
    expect(
      missing.findings.some(
        (finding) => finding.code === "event_payload_missing"
      )
    ).toBe(true);

    const timelinePath = getEventTimelinePath(root, "support", "case_audit");
    const record = JSON.parse(
      (await readFile(timelinePath, "utf8")).trim()
    ) as Record<string, unknown>;
    record.summary = "tampered";
    await writeFile(timelinePath, `${JSON.stringify(record)}\n`, "utf8");
    const tampered = await auditKnowledgeQuality(root);

    expect(
      tampered.findings.some(
        (finding) => finding.code === "event_timeline_invalid"
      )
    ).toBe(true);
  });
});
