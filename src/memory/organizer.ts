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
import {
  isGeneratedKnowledgeFile,
  isSkillReviewDraft
} from "../storage/knowledgePaths.js";

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
  replaceExistingSources?: boolean;
};

export type CaptureMaterialResult = {
  target: "active" | "inbox";
  written: Array<{
    id: string;
    status: MemoryStatus;
    filePath: string;
    deduplicated?: boolean;
    replaced?: boolean;
  }>;
  indexed?: number;
};

/** 生成归档文件名和 frontmatter 使用的 UTC 日期。 */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 生成保留 Unicode 的人类可读文件名片段。 */
function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "knowledge";
}

/** 生成满足知识 ID schema 的 ASCII 片段。 */
function idSlugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  return slug || "memory";
}

/** 根据日期、domain 和标题生成直接材料的知识 ID。 */
function idFromInput(input: CandidateMemoryInput): string {
  if (input.id) {
    return input.id;
  }
  return `k_${today().replaceAll("-", "")}_${idSlugify(input.domain)}_${idSlugify(input.title)}`;
}

/** 保留 domain 层级生成目录路径，避免把业务层级压平成单段名称。 */
function domainDirectory(domain: string): string {
  return domain
    .split("/")
    .map((segment) => slugify(segment))
    .join("/");
}

/** 用 access 探测路径存在性，不把权限/缺失差异暴露给命名循环。 */
async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** 为同名知识追加数字后缀，避免覆盖已有 Markdown 事实。 */
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

/** 根据知识类型、完整 domain 层级和标题生成 active 相对路径。 */
function activeRelativePath(frontmatter: KnowledgeFrontmatter): string {
  const date = frontmatter.created_at || today();
  return path.posix.join(
    "knowledge",
    frontmatter.type,
    domainDirectory(frontmatter.domain),
    `${date}-${slugify(frontmatter.title)}.md`
  );
}

/** 读取所有可审阅 Markdown，包括 inbox/archive，但排除生成式导航文件。 */
async function readAllKnowledgeDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const fg = (await import("fast-glob")).default;
  const files = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: false
  });

  const documents: KnowledgeDocument[] = [];
  for (const filePath of files
    .filter(
      (filePath) =>
        !isGeneratedKnowledgeFile(filePath) && !isSkillReviewDraft(filePath)
    )
    .sort()) {
    const absolutePath = resolveWorkspacePath(rootDir, filePath);
    documents.push(parseKnowledgeMarkdown(filePath, await readFile(absolutePath, "utf8")));
  }

  return documents;
}

/** 返回批量晋升阻断原因；客户和自动会话必须经过精确 ID 人工批准。 */
function promotionBlockedReason(document: KnowledgeDocument): string | null {
  if (document.frontmatter.actor_type === "customer") {
    return "customer_observation_requires_trusted_review";
  }
  if (document.frontmatter.capture_mode === "automated_session") {
    return "automated_session_requires_trusted_review";
  }
  return null;
}

/**
 * 在受信 replacement 激活时把被替代知识标为 deprecated 并设置 valid_until。
 * 先保留旧 Markdown 供审计，而不是删除历史事实。
 */
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

/** 汇总知识状态、类型、domain 和 inbox，供人工审阅流程选择精确候选 ID。 */
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

/**
 * 预览或应用 inbox 晋升，并可用 `approvedIds` 把操作范围收窄为人工白名单。
 *
 * 不传白名单时，客户和 automated session 候选保持硬阻断；传入白名单表示人类已经审阅
 * 对应证据，因此只允许这些 ID 越过批量阻断。所有 ID 必须在写入前一次性校验，避免半批生效。
 */
export async function organizeInbox(
  rootDir: string,
  options: { apply: boolean; rebuild: boolean; approvedIds?: string[] }
): Promise<OrganizeInboxResult> {
  await initKnowledgeWorkspace(rootDir);
  const documents = (await readAllKnowledgeDocuments(rootDir)).filter((document) =>
    document.filePath.startsWith("knowledge/_inbox/")
  );
  const approvedIds =
    options.approvedIds === undefined ? undefined : new Set(options.approvedIds);
  if (approvedIds) {
    const existingIds = new Set(
      documents.map((document) => document.frontmatter.id)
    );
    const missingIds = [...approvedIds].filter((id) => !existingIds.has(id));
    if (missingIds.length > 0) {
      throw new Error(
        `Inbox knowledge IDs not found: ${missingIds.sort().join(", ")}`
      );
    }
  }
  const allDocuments = await readAllKnowledgeDocuments(rootDir);
  const moved: OrganizeInboxItem[] = [];
  const blocked: OrganizeInboxResult["blocked"] = [];

  for (const document of documents) {
    // 提供显式 ID 后，本次操作从批量整理变为人工审阅白名单；未列出的候选即使本可晋升也必须保持不动。
    if (approvedIds && !approvedIds.has(document.frontmatter.id)) {
      continue;
    }
    const blockedReason = promotionBlockedReason(document);
    // 只有精确列入人工白名单的候选才能越过不可信来源阻断，不能由状态或置信度隐式放行。
    if (blockedReason && !approvedIds?.has(document.frontmatter.id)) {
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

/** 把已结构化材料转换为 Markdown 文档，并复用候选治理决定初始状态。 */
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
      episodes: input.episodes ?? [],
      created_at: date,
      updated_at: date,
      valid_from: date,
      valid_until: null
    },
    body:
      input.content ??
      `# ${input.title}

## 结论

${input.summary}
`
  });
}

/**
 * 把 Skill 已结构化的用户材料写入 active 或 inbox，并按需重建 lexical 索引。
 *
 * CLI 不理解自然语言，材料拆分和来源判断由上游 Skill 完成；本函数只执行 schema、治理和落盘边界。
 */
export async function captureMaterial(
  rootDir: string,
  inputs: CandidateMemoryInput[],
  options: CaptureMaterialOptions
): Promise<CaptureMaterialResult> {
  await initKnowledgeWorkspace(rootDir);
  const written: CaptureMaterialResult["written"] = [];
  const existingDocuments = await readAllKnowledgeDocuments(rootDir);
  const existingById = new Map(
    existingDocuments.map((document) => [document.frontmatter.id, document])
  );

  for (const input of inputs) {
    const existing = input.id ? existingById.get(input.id) : undefined;
    if (existing) {
      const contentMatches = input.content
        ? existing.body === input.content.trimStart()
        : existing.body.includes(input.summary);
      if (contentMatches) {
        written.push({
          id: existing.frontmatter.id,
          status: existing.frontmatter.status,
          filePath: resolveWorkspacePath(rootDir, existing.filePath),
          deduplicated: true
        });
        continue;
      }
      if (!options.replaceExistingSources) {
        throw new Error(
          `Knowledge with explicit ID already exists but content differs: ${input.id}`
        );
      }
      // 原始证据会随上游文档或脱敏规则变化，允许显式刷新；精炼知识仍必须通过 supersedes 演进。
      if (
        options.target !== "active" ||
        existing.frontmatter.type !== "source" ||
        existing.frontmatter.status !== "active" ||
        existing.frontmatter.source_authority !== "documented" ||
        input.memory_type !== "source" ||
        input.source_authority !== "documented"
      ) {
        throw new Error(
          `Only documented active source knowledge can be replaced: ${input.id}`
        );
      }
      const replacement = documentFromMaterialInput(input);
      if (
        replacement.frontmatter.status !== "active" ||
        promotionBlockedReason(replacement)
      ) {
        throw new Error(
          `Only documented active source knowledge can be replaced: ${input.id}`
        );
      }
      const replacementDocument = KnowledgeDocumentSchema.parse({
        ...replacement,
        filePath: existing.filePath,
        frontmatter: {
          ...replacement.frontmatter,
          created_at: existing.frontmatter.created_at,
          valid_from: existing.frontmatter.valid_from
        }
      });
      const existingPath = resolveWorkspacePath(rootDir, existing.filePath);
      await writeFile(
        existingPath,
        serializeKnowledgeMarkdown(replacementDocument),
        "utf8"
      );
      written.push({
        id: replacementDocument.frontmatter.id,
        status: replacementDocument.frontmatter.status,
        filePath: existingPath,
        replaced: true
      });
      continue;
    }
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
