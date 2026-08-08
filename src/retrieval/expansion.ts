/**
 * 渐进展开模块提供 synopsis -> knowledge -> evidence 的显式读取边界。
 *
 * 展开不能绕过 query 安全过滤：即使调用方知道知识 ID 或 claim ID，也必须重新通过
 * active、validity、visibility、sensitivity、project 和 include-kind 检查。Evidence
 * 当前只返回 source/section/hash anchor；完整原文由后续 Evidence Vault 实现。
 */
import { readFile } from "node:fs/promises";
import { MemoryQueryRequestSchema } from "../core/schema.js";
import type {
  EvidenceAnchor,
  MemoryQueryRequest
} from "../core/types.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { discoverKnowledgeFiles } from "../storage/workspace.js";
import { parseKnowledgeMarkdown } from "../storage/markdown.js";
import { loadAccessibleMemoriesByIds } from "./query.js";

export type KnowledgeExpansionLayer = "synopsis" | "knowledge";

export type ExpandedKnowledge = {
  id: string;
  title: string;
  kind: string;
  layer: KnowledgeExpansionLayer;
  content: string;
  claims: Array<{
    id: string;
    statement: string;
    status: string;
    confidence: number;
    evidenceCount: number;
  }>;
  source: string[];
};

export type ExpandedEvidence = {
  knowledgeId: string;
  claimId: string;
  statement: string;
  anchors: EvidenceAnchor[];
};

/** 把调用方 query 请求规范化；task 只用于 scorer，不影响 ID 安全过滤。 */
function expansionRequest(
  rawRequest: unknown,
  task: string
): MemoryQueryRequest {
  return MemoryQueryRequestSchema.parse({
    ...(rawRequest && typeof rawRequest === "object" ? rawRequest : {}),
    task
  });
}

/** 返回指定 ID 的可访问 active knowledge；不可访问与不存在使用相同错误，避免泄漏。 */
function accessibleKnowledgeById(
  rootDir: string,
  id: string,
  rawRequest: unknown
) {
  const request = expansionRequest(rawRequest, `expand knowledge ${id}`);
  const memory = loadAccessibleMemoriesByIds(rootDir, request, [id])[0];
  if (!memory) {
    throw new Error(`Accessible active knowledge not found: ${id}`);
  }
  return memory.document;
}

/** 显式展开 synopsis 或完整 knowledge 正文。 */
export function expandKnowledge(
  rootDir: string,
  input: {
    id: string;
    layer: KnowledgeExpansionLayer;
    request?: unknown;
  }
): ExpandedKnowledge {
  const document = accessibleKnowledgeById(rootDir, input.id, input.request);
  return {
    id: document.frontmatter.id,
    title: document.frontmatter.title,
    kind: document.frontmatter.kind,
    layer: input.layer,
    content:
      input.layer === "synopsis"
        ? document.frontmatter.synopsis
        : document.body,
    claims: document.frontmatter.claims.map((claim) => ({
      id: claim.id,
      statement: claim.statement,
      status: claim.status,
      confidence: claim.confidence,
      evidenceCount: claim.evidence.length
    })),
    source: document.frontmatter.source
  };
}

/** 扫描 Markdown 找到 claim 所属知识；后续仍通过 accessibleKnowledgeById 做安全过滤。 */
async function findClaimOwner(
  rootDir: string,
  claimId: string
): Promise<string | null> {
  for (const filePath of await discoverKnowledgeFiles(rootDir)) {
    const document = parseKnowledgeMarkdown(
      filePath,
      await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")
    );
    if (document.frontmatter.claims.some((claim) => claim.id === claimId)) {
      return document.frontmatter.id;
    }
  }
  return null;
}

/** 显式展开 claim 的 evidence handles；不读取 Vault 原文。 */
export async function expandEvidence(
  rootDir: string,
  input: { claimId: string; request?: unknown }
): Promise<ExpandedEvidence> {
  const ownerId = await findClaimOwner(rootDir, input.claimId);
  if (!ownerId) {
    throw new Error(`Accessible active claim not found: ${input.claimId}`);
  }
  const document = accessibleKnowledgeById(rootDir, ownerId, input.request);
  const claim = document.frontmatter.claims.find(
    (item) => item.id === input.claimId
  );
  if (!claim) {
    // 不可访问与不存在仍保持同一错误，不能通过 claim ID 探测隔离知识。
    throw new Error(`Accessible active claim not found: ${input.claimId}`);
  }
  return {
    knowledgeId: document.frontmatter.id,
    claimId: claim.id,
    statement: claim.statement,
    anchors: claim.evidence
  };
}
