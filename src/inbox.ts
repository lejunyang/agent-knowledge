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

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

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
