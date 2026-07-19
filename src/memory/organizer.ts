/**
 * organizer 模块负责“主动整理”流程。
 *
 * 这里覆盖两类与会话 hook 不同的主动入口：
 * - organizeInbox：整理 `_inbox` 中已经存在的候选知识。
 * - captureMaterial：接收 Skill 从用户材料中整理出的高置信结构化知识，并写入正式目录或 `_inbox`。
 *
 * 模块保持确定性：它不调用 LLM，不理解自然语言；理解和拆分材料由 Skill 完成。
 */
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { decideCandidateStatus, type CandidateMemoryInput } from "./governance.js";
import { parseKnowledgeMarkdown, serializeKnowledgeMarkdown } from "../storage/markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { KnowledgeDocumentSchema } from "../core/schema.js";
import type { KnowledgeDocument, KnowledgeFrontmatter, MemoryStatus, MemoryType } from "../core/types.js";
import { initKnowledgeWorkspace } from "../storage/workspace.js";
import { rebuildIndex } from "../storage/indexer.js";
import { writeCandidateMemory } from "./inbox.js";

export type KnowledgeListSummary = {
  rootDir: string;
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byDomain: Record<string, number>;
  inbox: Array<{
    id: string;
    title: string;
    status: MemoryStatus;
    type: MemoryType;
    domain: string;
    filePath: string;
  }>;
};

export type OrganizeInboxItem = {
  id: string;
  title: string;
  from: string;
  to: string;
  statusBefore: MemoryStatus;
  statusAfter: "active";
};

export type OrganizeInboxResult = {
  applied: boolean;
  moved: OrganizeInboxItem[];
  blocked: Array<{
    id: string;
    title: string;
    reason: string;
  }>;
  indexed?: number;
};

export type CaptureMaterialOptions = {
  target: "active" | "inbox";
  rebuild: boolean;
};

export type CaptureMaterialResult = {
  target: "active" | "inbox";
  written: Array<{
    id: string;
    status: MemoryStatus;
    filePath: string;
  }>;
  indexed?: number;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "knowledge";
}

function idSlugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  return slug || "memory";
}

function idFromInput(input: CandidateMemoryInput): string {
  return `k_${today().replaceAll("-", "")}_${idSlugify(input.domain)}_${idSlugify(input.title)}`;
}

function domainDirectory(domain: string): string {
  return domain
    .split("/")
    .map((segment) => slugify(segment))
    .join("/");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function uniqueRelativePath(rootDir: string, desiredRelativePath: string): Promise<string> {
  const parsed = path.posix.parse(desiredRelativePath);
  let candidate = desiredRelativePath;
  let suffix = 2;

  while (await pathExists(resolveWorkspacePath(rootDir, candidate))) {
    candidate = path.posix.join(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
    suffix += 1;
  }

  return candidate;
}

function activeRelativePath(frontmatter: KnowledgeFrontmatter): string {
  const date = frontmatter.created_at || today();
  return path.posix.join(
    "knowledge",
    frontmatter.type,
    domainDirectory(frontmatter.domain),
    `${date}-${slugify(frontmatter.title)}.md`
  );
}

async function readAllKnowledgeDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const fg = (await import("fast-glob")).default;
  const files = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: false,
    ignore: [
      "knowledge/README.md",
      "knowledge/_catalog.md",
      "knowledge/_conflicts.md",
      "knowledge/_review_queue.md"
    ]
  });

  const documents: KnowledgeDocument[] = [];
  for (const filePath of files.sort()) {
    const absolutePath = resolveWorkspacePath(rootDir, filePath);
    documents.push(parseKnowledgeMarkdown(filePath, await readFile(absolutePath, "utf8")));
  }

  return documents;
}

function promotionBlockedReason(document: KnowledgeDocument): string | null {
  if (document.frontmatter.actor_type === "customer") {
    return "customer_observation_requires_trusted_review";
  }
  if (document.frontmatter.capture_mode === "automated_session") {
    return "automated_session_requires_trusted_review";
  }
  return null;
}

async function invalidateSupersededDocuments(
  rootDir: string,
  supersededIds: string[],
  documents: KnowledgeDocument[]
): Promise<void> {
  if (supersededIds.length === 0) {
    return;
  }
  const ids = new Set(supersededIds);
  for (const document of documents) {
    if (!ids.has(document.frontmatter.id) || document.frontmatter.status !== "active") {
      continue;
    }
    const updated = KnowledgeDocumentSchema.parse({
      ...document,
      frontmatter: {
        ...document.frontmatter,
        status: "deprecated",
        updated_at: today(),
        valid_until: today()
      }
    });
    await writeFile(
      resolveWorkspacePath(rootDir, document.filePath),
      serializeKnowledgeMarkdown(updated),
      "utf8"
    );
  }
}

export async function listKnowledge(rootDir: string): Promise<KnowledgeListSummary> {
  await initKnowledgeWorkspace(rootDir);
  const documents = await readAllKnowledgeDocuments(rootDir);
  const summary: KnowledgeListSummary = {
    rootDir,
    total: documents.length,
    byStatus: {},
    byType: {},
    byDomain: {},
    inbox: []
  };

  for (const document of documents) {
    const frontmatter = document.frontmatter;
    summary.byStatus[frontmatter.status] = (summary.byStatus[frontmatter.status] ?? 0) + 1;
    summary.byType[frontmatter.type] = (summary.byType[frontmatter.type] ?? 0) + 1;
    summary.byDomain[frontmatter.domain] = (summary.byDomain[frontmatter.domain] ?? 0) + 1;

    if (document.filePath.startsWith("knowledge/_inbox/")) {
      summary.inbox.push({
        id: frontmatter.id,
        title: frontmatter.title,
        status: frontmatter.status,
        type: frontmatter.type,
        domain: frontmatter.domain,
        filePath: document.filePath
      });
    }
  }

  return summary;
}

export async function organizeInbox(
  rootDir: string,
  options: { apply: boolean; rebuild: boolean }
): Promise<OrganizeInboxResult> {
  await initKnowledgeWorkspace(rootDir);
  const documents = (await readAllKnowledgeDocuments(rootDir)).filter((document) =>
    document.filePath.startsWith("knowledge/_inbox/")
  );
  const allDocuments = await readAllKnowledgeDocuments(rootDir);
  const moved: OrganizeInboxItem[] = [];
  const blocked: OrganizeInboxResult["blocked"] = [];

  for (const document of documents) {
    const blockedReason = promotionBlockedReason(document);
    if (blockedReason) {
      blocked.push({
        id: document.frontmatter.id,
        title: document.frontmatter.title,
        reason: blockedReason
      });
      continue;
    }
    const statusBefore = document.frontmatter.status;
    const updatedDocument = KnowledgeDocumentSchema.parse({
      ...document,
      frontmatter: {
        ...document.frontmatter,
        status: "active",
        updated_at: today()
      }
    });
    const targetRelativePath = await uniqueRelativePath(rootDir, activeRelativePath(updatedDocument.frontmatter));

    moved.push({
      id: updatedDocument.frontmatter.id,
      title: updatedDocument.frontmatter.title,
      from: document.filePath,
      to: targetRelativePath,
      statusBefore,
      statusAfter: "active"
    });

    if (!options.apply) {
      continue;
    }

    const targetAbsolutePath = resolveWorkspacePath(rootDir, targetRelativePath);
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await writeFile(targetAbsolutePath, serializeKnowledgeMarkdown({ ...updatedDocument, filePath: targetRelativePath }), "utf8");
    await invalidateSupersededDocuments(rootDir, updatedDocument.frontmatter.supersedes, allDocuments);
    await rename(resolveWorkspacePath(rootDir, document.filePath), resolveWorkspacePath(rootDir, "knowledge", "_archive", path.basename(document.filePath)));
  }

  const indexed = options.apply && options.rebuild ? rebuildIndex(rootDir).indexed : undefined;
  return { applied: options.apply, moved, blocked, indexed };
}

function documentFromMaterialInput(input: CandidateMemoryInput): KnowledgeDocument {
  const decision = decideCandidateStatus(input);
  const date = today();
  const status = decision.status === "rejected" || decision.status === "deprecated" ? "proposed" : decision.status;
  const actorType = input.actor_type ?? "owner";

  return KnowledgeDocumentSchema.parse({
    filePath: "knowledge/_material/pending.md",
    frontmatter: {
      id: idFromInput(input),
      type: input.memory_type,
      title: input.title,
      aliases: input.aliases ?? [],
      domain: input.domain,
      related_domains: input.related_domains,
      scenario: input.scenario,
      tags: input.tags,
      status,
      confidence: input.confidence,
      source_authority: input.source_authority,
      source: input.evidence,
      related_knowledge: input.related_knowledge ?? [],
      supersedes: input.supersedes ?? [],
      conflicts_with: input.conflicts_with ?? [],
      visibility: input.visibility ?? "project",
      sensitivity: input.sensitivity ?? "internal",
      project_ids: input.project_ids ?? [],
      capture_mode: input.capture_mode ?? "direct_material",
      actor_type: actorType,
      corroboration_count: input.corroboration_count ?? 1,
      created_at: date,
      updated_at: date,
      valid_from: date,
      valid_until: null
    },
    body: `# ${input.title}

## 结论

${input.summary}
`
  });
}

export async function captureMaterial(
  rootDir: string,
  inputs: CandidateMemoryInput[],
  options: CaptureMaterialOptions
): Promise<CaptureMaterialResult> {
  await initKnowledgeWorkspace(rootDir);
  const written: CaptureMaterialResult["written"] = [];
  const existingDocuments = await readAllKnowledgeDocuments(rootDir);

  for (const input of inputs) {
    if (options.target === "inbox") {
      const result = await writeCandidateMemory(rootDir, input);
      written.push(result);
      continue;
    }

    const document = documentFromMaterialInput(input);
    if (document.frontmatter.status !== "active" || promotionBlockedReason(document)) {
      const result = await writeCandidateMemory(rootDir, input);
      written.push(result);
      continue;
    }
    const targetRelativePath = await uniqueRelativePath(rootDir, activeRelativePath(document.frontmatter));
    const targetAbsolutePath = resolveWorkspacePath(rootDir, targetRelativePath);
    await mkdir(path.dirname(targetAbsolutePath), { recursive: true });
    await writeFile(targetAbsolutePath, serializeKnowledgeMarkdown({ ...document, filePath: targetRelativePath }), "utf8");
    await invalidateSupersededDocuments(rootDir, document.frontmatter.supersedes, existingDocuments);
    written.push({
      id: document.frontmatter.id,
      status: document.frontmatter.status,
      filePath: targetAbsolutePath
    });
  }

  const indexed = options.rebuild ? rebuildIndex(rootDir).indexed : undefined;
  return { target: options.target, written, indexed };
}
