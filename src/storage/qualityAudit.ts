/**
 * 质量审计模块对 V2 Markdown、source manifest 和 project registry 做确定性检查。
 *
 * 它只读事实源和可重建 registry，不调用 LLM、不修改知识。审计结果用于 CI、人工 review
 * 和正式使用门禁，不能被当作新的知识事实。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { discoverKnowledgeFiles } from "./workspace.js";
import { resolveWorkspacePath } from "../core/paths.js";
import {
  SourceManifestSchema,
  type SourceManifest
} from "./sourceManifest.js";
import type { KnowledgeDocument } from "../core/types.js";
import { getVaultObjectPath } from "../vault/core.js";
import { listConnectorCheckpoints } from "../ingestion/core.js";
import { getSourceUpdateHealth } from "../ingestion/sourceUpdates.js";
import { getEventLedgerStatus } from "../events/ledger.js";

export type KnowledgeQualityFindingCode =
  | "knowledge_body_too_thin"
  | "metadata_frontmatter_dominates"
  | "too_many_aliases"
  | "too_many_scenarios"
  | "too_many_tags"
  | "source_without_refined_knowledge"
  | "source_review_stale"
  | "invalid_refined_knowledge"
  | "invalid_duplicate_source"
  | "source_inventory_incomplete"
  | "source_ingestion_failed"
  | "source_connector_unchecked"
  | "source_update_check_stale"
  | "source_update_available"
  | "source_update_verification_required"
  | "event_payload_missing"
  | "event_timeline_invalid"
  | "source_missing_upstream"
  | "source_without_vault_object"
  | "missing_vault_object"
  | "source_without_upstream_version"
  | "source_redaction_not_recorded"
  | "missing_source_manifest"
  | "unknown_evidence_anchor"
  | "unknown_project_key";

export type KnowledgeQualityFinding = {
  code: KnowledgeQualityFindingCode;
  severity: "error" | "warning" | "info";
  documentId?: string;
  filePath?: string;
  sourceId?: string;
  message: string;
};

export type KnowledgeQualityPolicy = {
  minimumKnowledgeBodyChars: number;
  maximumFrontmatterShare: number;
  maximumAliases: number;
  maximumScenarios: number;
  maximumTags: number;
};

export type KnowledgeQualityReport = {
  generatedAt: string;
  policy: KnowledgeQualityPolicy;
  summary: {
    sourceDocuments: number;
    classifiedSources: number;
    knowledgeDocuments: number;
    synopsisDocuments: number;
    sourceCoverage: number;
    sourceAvailabilityCoverage: number;
    incompleteSourceConnectors: number;
    unresolvedSourceInventory: number;
    failedSourceIngestions: number;
    registeredSourceConnectors: number;
    uncheckedSourceConnectors: number;
    staleSourceUpdateChecks: number;
    sourceUpdatesAvailable: number;
    sourceUpdatesUnknown: number;
    eventStreams: number;
    lifecycleEvents: number;
    missingEventPayloads: number;
    vaultEvidenceCoverage: number;
    upstreamVersionCoverage: number;
    redactionPolicyCoverage: number;
    claimEvidenceCoverage: number;
    medianKnowledgeBodyChars: number;
    medianFrontmatterShare: number;
  };
  findings: KnowledgeQualityFinding[];
};

export const DEFAULT_QUALITY_POLICY: KnowledgeQualityPolicy = {
  minimumKnowledgeBodyChars: 600,
  maximumFrontmatterShare: 0.65,
  maximumAliases: 8,
  maximumScenarios: 6,
  maximumTags: 8
};

type LoadedKnowledge = {
  document: KnowledgeDocument;
  rawLength: number;
};

/** 计算中位数；空数组返回 0，避免空库审计出现 NaN。 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** 读取正式 V2 Markdown，同时保留 raw length 供 frontmatter 占比审计。 */
async function loadKnowledge(rootDir: string): Promise<LoadedKnowledge[]> {
  const loaded: LoadedKnowledge[] = [];
  for (const filePath of await discoverKnowledgeFiles(rootDir)) {
    const raw = await readFile(resolveWorkspacePath(rootDir, filePath), "utf8");
    loaded.push({
      document: parseKnowledgeMarkdown(filePath, raw),
      rawLength: raw.length
    });
  }
  return loaded;
}

/** 读取 Git 可跟踪 source manifest；非法 JSON/schema 必须让审计失败而不是静默跳过。 */
async function loadSourceManifests(rootDir: string): Promise<SourceManifest[]> {
  const paths = await fg("knowledge/source-manifests/**/*.json", {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true
  });
  const manifests: SourceManifest[] = [];
  for (const filePath of paths.sort()) {
    manifests.push(
      SourceManifestSchema.parse(
        JSON.parse(await readFile(resolveWorkspacePath(rootDir, filePath), "utf8"))
      )
    );
  }
  return manifests;
}

/** 从可重建 project registry 收集 canonical key 和 alias。 */
async function loadKnownProjectKeys(rootDir: string): Promise<Set<string>> {
  const paths = await fg(".memory/projects/*.json", {
    cwd: rootDir,
    absolute: false,
    onlyFiles: true
  });
  const keys = new Set<string>();
  for (const filePath of paths.sort()) {
    const parsed = JSON.parse(
      await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")
    ) as { key?: unknown; aliases?: unknown };
    if (typeof parsed.key === "string") {
      keys.add(parsed.key);
    }
    if (Array.isArray(parsed.aliases)) {
      for (const alias of parsed.aliases) {
        if (typeof alias === "string") {
          keys.add(alias);
        }
      }
    }
  }
  return keys;
}

/** 从 source 引用字符串提取规范 source ID；其他 provenance 字符串忽略。 */
function sourceIdFromReference(reference: string): string | null {
  return reference.startsWith("source:") ? reference.slice("source:".length) : null;
}

/** 检查一个 evidence anchor 是否命中当前 manifest 的真实 section。 */
function anchorResolves(
  manifestsById: Map<string, SourceManifest>,
  input: { source_id: string; section_id: string; quote_hash: string }
): boolean {
  const manifest = manifestsById.get(input.source_id);
  if (!manifest || manifest.availability !== "available") {
    return false;
  }
  return manifest.sections.some(
    (section) =>
      section.section_id === input.section_id &&
      section.text_hash === input.quote_hash
  );
}

/** 追加 finding，并保持调用点信息完整，最终统一稳定排序。 */
function addFinding(
  findings: KnowledgeQualityFinding[],
  finding: KnowledgeQualityFinding
): void {
  findings.push(finding);
}

/**
 * 审计整个 V2 workspace。
 *
 * source coverage 把 refined/duplicate/obsolete/no_long_term_value/blocked 都视为已分类；
 * pending 表示尚未处理。claim evidence coverage 要求每个 supported claim 的全部 anchor
 * 都能解析到 source manifest 中相同 section/hash，不能只检查数组非空。
 */
export async function auditKnowledgeQuality(
  rootDir: string,
  policy: KnowledgeQualityPolicy = DEFAULT_QUALITY_POLICY
): Promise<KnowledgeQualityReport> {
  const loaded = await loadKnowledge(rootDir);
  const manifests = await loadSourceManifests(rootDir);
  const manifestsById = new Map(
    manifests.map((manifest) => [manifest.source_id, manifest])
  );
  const knownProjectKeys = await loadKnownProjectKeys(rootDir);
  const activeKnowledgeById = new Map(
    loaded
      .filter(({ document }) => document.frontmatter.status === "active")
      .map(({ document }) => [document.frontmatter.id, document])
  );
  const findings: KnowledgeQualityFinding[] = [];
  const activeKnowledge = loaded.filter(
    ({ document }) =>
      document.frontmatter.status === "active" &&
      document.frontmatter.layer === "knowledge"
  );
  const bodyLengths: number[] = [];
  const frontmatterShares: number[] = [];
  let supportedClaims = 0;
  let groundedClaims = 0;
  let eventStreams = 0;
  let lifecycleEvents = 0;
  let missingEventPayloads = 0;

  try {
    const eventStatus = await getEventLedgerStatus(rootDir);
    eventStreams = eventStatus.streams;
    lifecycleEvents = eventStatus.events;
    missingEventPayloads = eventStatus.missingPayloads;
    if (missingEventPayloads > 0) {
      addFinding(findings, {
        code: "event_payload_missing",
        severity: "warning",
        message: `Lifecycle events reference ${missingEventPayloads} Vault payload(s) removed or missing by retention.`
      });
    }
  } catch (error) {
    addFinding(findings, {
      code: "event_timeline_invalid",
      severity: "error",
      message: `Lifecycle event integrity check failed: ${error instanceof Error ? error.message : String(error)}`
    });
  }

  for (const { document, rawLength } of activeKnowledge) {
    const frontmatter = document.frontmatter;
    const bodyLength = document.body.trim().length;
    const frontmatterShare =
      rawLength === 0 ? 0 : Math.max(0, (rawLength - document.body.length) / rawLength);
    bodyLengths.push(bodyLength);
    frontmatterShares.push(frontmatterShare);

    if (
      frontmatter.kind !== "profile" &&
      bodyLength < policy.minimumKnowledgeBodyChars
    ) {
      addFinding(findings, {
        code: "knowledge_body_too_thin",
        severity: "warning",
        documentId: frontmatter.id,
        filePath: document.filePath,
        message: `Knowledge body has ${bodyLength} characters; expected at least ${policy.minimumKnowledgeBodyChars}.`
      });
    }
    if (frontmatterShare > policy.maximumFrontmatterShare) {
      addFinding(findings, {
        code: "metadata_frontmatter_dominates",
        severity: "warning",
        documentId: frontmatter.id,
        filePath: document.filePath,
        message: `Frontmatter share ${frontmatterShare.toFixed(3)} exceeds ${policy.maximumFrontmatterShare}.`
      });
    }
    if (frontmatter.aliases.length > policy.maximumAliases) {
      addFinding(findings, {
        code: "too_many_aliases",
        severity: "warning",
        documentId: frontmatter.id,
        filePath: document.filePath,
        message: `Knowledge has ${frontmatter.aliases.length} aliases; expected at most ${policy.maximumAliases}.`
      });
    }
    if (frontmatter.scenarios.length > policy.maximumScenarios) {
      addFinding(findings, {
        code: "too_many_scenarios",
        severity: "warning",
        documentId: frontmatter.id,
        filePath: document.filePath,
        message: `Knowledge has ${frontmatter.scenarios.length} scenarios; expected at most ${policy.maximumScenarios}.`
      });
    }
    if (frontmatter.tags.length > policy.maximumTags) {
      addFinding(findings, {
        code: "too_many_tags",
        severity: "warning",
        documentId: frontmatter.id,
        filePath: document.filePath,
        message: `Knowledge has ${frontmatter.tags.length} tags; expected at most ${policy.maximumTags}.`
      });
    }

    for (const projectKey of frontmatter.project_keys) {
      if (!knownProjectKeys.has(projectKey)) {
        addFinding(findings, {
          code: "unknown_project_key",
          severity: "warning",
          documentId: frontmatter.id,
          filePath: document.filePath,
          message: `Project key is not present in the local registry: ${projectKey}.`
        });
      }
    }

    for (const reference of frontmatter.source) {
      const sourceId = sourceIdFromReference(reference);
      if (sourceId && !manifestsById.has(sourceId)) {
        addFinding(findings, {
          code: "missing_source_manifest",
          severity: "error",
          documentId: frontmatter.id,
          filePath: document.filePath,
          sourceId,
          message: `Knowledge references a missing source manifest: ${sourceId}.`
        });
      }
    }

    for (const claim of frontmatter.claims) {
      if (claim.status !== "supported") {
        continue;
      }
      supportedClaims += 1;
      const grounded = claim.evidence.every((anchor) =>
        anchorResolves(manifestsById, anchor)
      );
      if (grounded) {
        groundedClaims += 1;
      } else {
        addFinding(findings, {
          code: "unknown_evidence_anchor",
          severity: "error",
          documentId: frontmatter.id,
          filePath: document.filePath,
          message: `Supported claim does not resolve to current source section/hash: ${claim.id}.`
        });
      }
    }
  }

  const classifiedSources = manifests.filter(
    (manifest) =>
      manifest.processing_status !== "pending" &&
      manifest.processed_content_hash === manifest.version.content_hash
  ).length;
  const availableSources = manifests.filter(
    (manifest) => manifest.availability === "available"
  ).length;
  let vaultBackedSources = 0;
  let versionedSources = 0;
  let redactionGovernedSources = 0;
  let incompleteSourceConnectors = 0;
  let unresolvedSourceInventory = 0;
  let failedSourceIngestions = 0;
  const sourceUpdateHealth = await getSourceUpdateHealth(rootDir);
  for (const connector of sourceUpdateHealth.connectors) {
    if (connector.state === "unchecked") {
      addFinding(findings, {
        code: "source_connector_unchecked",
        severity: "warning",
        message: `Registered source connector has no update check report: ${connector.connectorId}.`
      });
    } else if (connector.state === "stale") {
      addFinding(findings, {
        code: "source_update_check_stale",
        severity: "warning",
        message: `Source update check predates the current connector registration or ingestion: ${connector.connectorId}.`
      });
    }
    if (connector.state !== "current") {
      continue;
    }
    if (connector.updatesAvailable > 0) {
      addFinding(findings, {
        code: "source_update_available",
        severity: "warning",
        message: `Source connector has ${connector.updatesAvailable} deterministic update(s): ${connector.connectorId}.`
      });
    }
    if (connector.verificationRequired > 0) {
      addFinding(findings, {
        code: "source_update_verification_required",
        severity: "warning",
        message: `Source connector has ${connector.verificationRequired} version change(s) that require ingestion to verify content: ${connector.connectorId}.`
      });
    }
  }
  for (const checkpoint of await listConnectorCheckpoints(rootDir)) {
    const inventory = checkpoint?.inventoryStatus;
    if (
      inventory &&
      inventory.mode === "complete" &&
      !inventory.complete
    ) {
      incompleteSourceConnectors += 1;
      unresolvedSourceInventory += inventory.unresolved;
      addFinding(findings, {
        code: "source_inventory_incomplete",
        severity: "warning",
        message: `Source connector inventory is incomplete: ${checkpoint.connectorId}; unresolved=${inventory.unresolved}; reason=${inventory.reason ?? "unknown"}.`
      });
    }
    for (const failure of Object.values(checkpoint.failures ?? {})) {
      failedSourceIngestions += 1;
      addFinding(findings, {
        code: "source_ingestion_failed",
        severity: "error",
        sourceId: failure.sourceId,
        message: `Source ingestion remains failed: connector=${checkpoint.connectorId}; externalKey=${failure.externalKey}; error=${failure.error}.`
      });
    }
  }
  for (const manifest of manifests) {
    if (manifest.availability === "missing") {
      addFinding(findings, {
        code: "source_missing_upstream",
        severity: "warning",
        sourceId: manifest.source_id,
        message: `Source is missing upstream and cannot support active claims: ${manifest.title}.`
      });
    }
    if (manifest.processing_status === "pending") {
      addFinding(findings, {
        code: "source_without_refined_knowledge",
        severity: "warning",
        sourceId: manifest.source_id,
        message: `Source has not been classified or refined: ${manifest.title}.`
      });
    } else if (
      manifest.processed_content_hash !== manifest.version.content_hash
    ) {
      addFinding(findings, {
        code: "source_review_stale",
        severity: "warning",
        sourceId: manifest.source_id,
        message: `Source review receipt does not match the current content hash: ${manifest.title}.`
      });
    }
    if (manifest.processing_status === "refined") {
      const sections = new Map(
        manifest.sections.map((section) => [
          section.section_id,
          section.text_hash
        ])
      );
      for (const knowledgeId of manifest.refined_knowledge_ids) {
        const knowledge = activeKnowledgeById.get(knowledgeId);
        const currentAnchor = knowledge?.frontmatter.claims.some(
          (claim) =>
            claim.status === "supported" &&
            claim.evidence.some(
              (anchor) =>
                anchor.source_id === manifest.source_id &&
                sections.get(anchor.section_id) === anchor.quote_hash
            )
        );
        if (!currentAnchor) {
          addFinding(findings, {
            code: "invalid_refined_knowledge",
            severity: "error",
            sourceId: manifest.source_id,
            documentId: knowledgeId,
            message: `Refined source does not resolve to active knowledge with a current claim anchor: ${knowledgeId}.`
          });
        }
      }
    }
    if (manifest.processing_status === "duplicate") {
      const duplicateTarget = manifest.duplicate_of
        ? manifestsById.get(manifest.duplicate_of)
        : undefined;
      if (
        !duplicateTarget ||
        duplicateTarget.availability !== "available" ||
        duplicateTarget.processing_status === "duplicate" ||
        duplicateTarget.source_id === manifest.source_id
      ) {
        addFinding(findings, {
          code: "invalid_duplicate_source",
          severity: "error",
          sourceId: manifest.source_id,
          message: `Duplicate source target is missing, unavailable, another duplicate, or self-referential: ${manifest.duplicate_of ?? "undefined"}.`
        });
      }
    }
    if (!manifest.vault_object) {
      addFinding(findings, {
        code: "source_without_vault_object",
        severity: "error",
        sourceId: manifest.source_id,
        message: `Source manifest has no encrypted Vault evidence handle: ${manifest.title}.`
      });
    } else if (!existsSync(getVaultObjectPath(rootDir, manifest.vault_object))) {
      addFinding(findings, {
        code: "missing_vault_object",
        severity: "error",
        sourceId: manifest.source_id,
        message: `Source manifest references a missing Vault object: ${manifest.vault_object}.`
      });
    } else {
      vaultBackedSources += 1;
    }

    if (Object.keys(manifest.version.upstream).length === 0) {
      addFinding(findings, {
        code: "source_without_upstream_version",
        severity: "warning",
        sourceId: manifest.source_id,
        message: `Source has no cheap upstream version signal and must be fully fetched for update checks: ${manifest.title}.`
      });
    } else {
      versionedSources += 1;
    }

    if (manifest.redaction_policy === "not-applied") {
      addFinding(findings, {
        code: "source_redaction_not_recorded",
        severity: "warning",
        sourceId: manifest.source_id,
        message: `Source does not record an applied redaction policy: ${manifest.title}.`
      });
    } else {
      redactionGovernedSources += 1;
    }

    for (const projectKey of manifest.project_keys) {
      if (!knownProjectKeys.has(projectKey)) {
        addFinding(findings, {
          code: "unknown_project_key",
          severity: "warning",
          sourceId: manifest.source_id,
          message: `Source project key is not present in the local registry: ${projectKey}.`
        });
      }
    }
  }

  findings.sort(
    (left, right) =>
      left.severity.localeCompare(right.severity) ||
      left.code.localeCompare(right.code) ||
      (left.filePath ?? left.sourceId ?? "").localeCompare(
        right.filePath ?? right.sourceId ?? ""
      )
  );

  return {
    generatedAt: new Date().toISOString(),
    policy,
    summary: {
      sourceDocuments: manifests.length,
      classifiedSources,
      knowledgeDocuments: activeKnowledge.length,
      synopsisDocuments: loaded.filter(
        ({ document }) =>
          document.frontmatter.status === "active" &&
          document.frontmatter.layer === "synopsis"
      ).length,
      sourceCoverage:
        manifests.length === 0 ? 1 : classifiedSources / manifests.length,
      sourceAvailabilityCoverage:
        manifests.length === 0 ? 1 : availableSources / manifests.length,
      incompleteSourceConnectors,
      unresolvedSourceInventory,
      failedSourceIngestions,
      registeredSourceConnectors:
        sourceUpdateHealth.registeredConnectors,
      uncheckedSourceConnectors:
        sourceUpdateHealth.uncheckedConnectors,
      staleSourceUpdateChecks: sourceUpdateHealth.staleChecks,
      sourceUpdatesAvailable: sourceUpdateHealth.updatesAvailable,
      sourceUpdatesUnknown: sourceUpdateHealth.verificationRequired,
      eventStreams,
      lifecycleEvents,
      missingEventPayloads,
      vaultEvidenceCoverage:
        manifests.length === 0 ? 1 : vaultBackedSources / manifests.length,
      upstreamVersionCoverage:
        manifests.length === 0 ? 1 : versionedSources / manifests.length,
      redactionPolicyCoverage:
        manifests.length === 0
          ? 1
          : redactionGovernedSources / manifests.length,
      claimEvidenceCoverage:
        supportedClaims === 0 ? 1 : groundedClaims / supportedClaims,
      medianKnowledgeBodyChars: median(bodyLengths),
      medianFrontmatterShare: median(frontmatterShares)
    },
    findings
  };
}
