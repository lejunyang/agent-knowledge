import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditKnowledgeQuality } from "../src/storage/qualityAudit.js";
import { buildSourceManifest } from "../src/storage/sourceManifest.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

/** 在 fixture 工作区写 source manifest，并返回首个 section 供 claim 引用。 */
async function writeManifest(
  root: string,
  processingStatus: "pending" | "refined"
) {
  const manifest = buildSourceManifest({
    sourceId: "src_lint_design",
    connector: "file",
    externalKey: "file:lint-design",
    title: "Lint design",
    content: "<h1>Vue SFC</h1><p>Vue SFC template needs ESLint fallback.</p>",
    observedAt: "2026-08-09T00:00:00.000Z",
    processingStatus
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
    expect(report.summary.claimEvidenceCoverage).toBe(0);
    expect(codes).toContain("knowledge_body_too_thin");
    expect(codes).toContain("source_without_refined_knowledge");
    expect(codes).toContain("unknown_evidence_anchor");
    expect(codes).toContain("unknown_project_key");
  });

  it("reports complete source and claim coverage for grounded knowledge", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "agent-knowledge-quality-grounded-")
    );
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const manifest = await writeManifest(root, "refined");
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
    expect(report.summary.claimEvidenceCoverage).toBe(1);
    expect(
      report.findings.filter((finding) => finding.severity === "error")
    ).toEqual([]);
  });
});
