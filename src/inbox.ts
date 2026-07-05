/**
 * inbox 模块是自动沉淀链路的写入边界。
 *
 * 其他 agent 只能通过这里写候选知识到 `knowledge/_inbox`，不能直接写正式目录。
 * 这样可以保留人工审阅和治理空间，避免自动总结污染长期知识库。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { decideCandidateStatus, type CandidateMemoryInput } from "./governance.js";
import { serializeKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { KnowledgeDocumentSchema } from "./schema.js";
import type { KnowledgeDocument, MemoryStatus } from "./types.js";

export type WriteCandidateResult = {
  id: string;
  status: MemoryStatus;
  filePath: string;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * 文件名 slug 保留 Unicode，方便人类从文件名识别候选知识主题。
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * frontmatter id 只能使用 ASCII，保证满足 schema，也便于其他系统引用。
 */
function idSlugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);

  return slug || "memory";
}

function idFromCandidate(input: CandidateMemoryInput): string {
  const date = today().replaceAll("-", "");
  return `k_${date}_${idSlugify(input.domain)}_${idSlugify(input.title)}`;
}

/**
 * 将候选知识写入 `_inbox`。
 *
 * 写入前会先经过治理决策和 schema 校验；写入结果仍是 Markdown，便于人类审阅。
 */
export async function writeCandidateMemory(rootDir: string, input: CandidateMemoryInput): Promise<WriteCandidateResult> {
  const decision = decideCandidateStatus(input);
  const id = idFromCandidate(input);
  const date = today();
  const relativePath = path.posix.join("knowledge", "_inbox", `${date}-${slugify(input.title)}.md`);
  const absolutePath = resolveWorkspacePath(rootDir, relativePath);

  await mkdir(path.dirname(absolutePath), { recursive: true });

  const document: KnowledgeDocument = {
    filePath: relativePath,
    frontmatter: {
      id,
      type: input.memory_type,
      title: input.title,
      aliases: input.aliases ?? [],
      domain: input.domain,
      related_domains: input.related_domains,
      scenario: input.scenario,
      tags: input.tags,
      status: decision.status,
      confidence: input.confidence,
      source_authority: input.source_authority,
      source: input.evidence,
      related_knowledge: [],
      supersedes: [],
      conflicts_with: [],
      visibility: "project",
      sensitivity: "internal",
      created_at: date,
      updated_at: date,
      valid_from: date,
      valid_until: null
    },
    body: `# ${input.title}

## 结论

${input.summary}

## 审阅

- review_required: ${decision.review_required}
- review_reason: ${decision.review_reason}
`
  };

  const validatedDocument = KnowledgeDocumentSchema.parse(document);
  await writeFile(absolutePath, serializeKnowledgeMarkdown(validatedDocument), "utf8");

  return {
    id,
    status: decision.status,
    filePath: absolutePath
  };
}
