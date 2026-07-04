# Agent Knowledge Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local TypeScript knowledge persistence toolkit for agents, with human-readable Markdown as the fact source and SQLite/FTS-backed retrieval that returns structured context packets.

**Architecture:** The MVP is a local CLI/library named `agent-knowledge` that manages `knowledge/**/*.md`, validates frontmatter, rebuilds a SQLite metadata + FTS5 index, queries knowledge with metadata filters and BM25 ranking, and writes auto-extracted candidate memories to `knowledge/_inbox`. Embeddings and graph expansion are represented by stable interfaces and deterministic local fallbacks so the system is testable without external services.

**Tech Stack:** Node.js 20+, TypeScript, pnpm, Vitest, Zod, gray-matter, better-sqlite3, fast-glob, commander, tsx.

---

## Scope

This plan implements a working MVP from the approved spec:

- Markdown knowledge directory and schema validation.
- Human-readable knowledge files with YAML frontmatter.
- SQLite metadata index and FTS5 lexical search.
- One-hop related-domain and related-knowledge expansion.
- Context packet query API and CLI.
- `_inbox` candidate-memory writer and governance checks.
- Evaluation fixtures for retrieval regressions.

This plan does not implement a real LLM writer subagent, cloud storage, team permissions service, or Graphiti/Zep temporal graph. It leaves stable interfaces for those later additions.

## File Structure

Create these files:

```text
package.json
pnpm-workspace.yaml
tsconfig.json
vitest.config.ts
src/cli.ts
src/index.ts
src/types.ts
src/schema.ts
src/paths.ts
src/markdown.ts
src/workspace.ts
src/indexer.ts
src/query.ts
src/contextPacket.ts
src/governance.ts
src/inbox.ts
src/eval.ts
tests/fixtures/basic-knowledge/knowledge/semantic/frontend-lint/2026-07-05-vue-sfc-eslint-fallback.md
tests/fixtures/basic-knowledge/knowledge/procedural/code-review/2026-07-05-lint-validation-flow.md
tests/schema.test.ts
tests/markdown.test.ts
tests/workspace.test.ts
tests/indexer.test.ts
tests/query.test.ts
tests/inbox.test.ts
tests/eval.test.ts
eval/cases/lint-migration-code-review.yaml
knowledge/README.md
```

Responsibilities:

- `src/types.ts`: Shared TypeScript types and enums.
- `src/schema.ts`: Zod schema for frontmatter and request/response objects.
- `src/paths.ts`: Safe path helpers and knowledge file discovery.
- `src/markdown.ts`: Markdown parse/serialize utilities.
- `src/workspace.ts`: Initialize `knowledge/` and generated catalog files.
- `src/indexer.ts`: SQLite schema, FTS5 table, rebuild index from Markdown.
- `src/query.ts`: Metadata filtering, FTS/BM25 lexical search, one-hop expansion, scoring.
- `src/contextPacket.ts`: Convert ranked memories into a token-budgeted context packet.
- `src/governance.ts`: Candidate validation, secret scanning, activation policy.
- `src/inbox.ts`: Write proposed candidate memories to `knowledge/_inbox`.
- `src/eval.ts`: Run retrieval eval cases.
- `src/cli.ts`: CLI commands: `init`, `validate`, `index`, `query`, `write-candidate`, `eval`.

---

### Task 1: Scaffold TypeScript Project

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/index.ts`

- [ ] **Step 1: Create package metadata**

Create `package.json`:

```json
{
  "name": "agent-knowledge",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "bin": {
    "agent-knowledge": "./dist/cli.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "better-sqlite3": "^11.9.1",
    "commander": "^12.1.0",
    "fast-glob": "^3.3.3",
    "gray-matter": "^4.0.3",
    "js-yaml": "^4.1.0",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create workspace file**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "."
```

- [ ] **Step 3: Create TypeScript config**

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Create Vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 10000
  }
});
```

- [ ] **Step 5: Create public module placeholder**

Create `src/index.ts`:

```ts
export * from "./types.js";
export * from "./schema.js";
export * from "./markdown.js";
export * from "./workspace.js";
export * from "./indexer.js";
export * from "./query.js";
export * from "./contextPacket.js";
export * from "./governance.js";
export * from "./inbox.js";
export * from "./eval.js";
```

- [ ] **Step 6: Install dependencies**

Run: `pnpm install`

Expected: command exits with code 0 and creates `pnpm-lock.yaml`.

- [ ] **Step 7: Run baseline checks**

Run: `pnpm typecheck`

Expected: FAIL with missing module errors for files exported by `src/index.ts`. This confirms later tasks must create the modules.

- [ ] **Step 8: Commit scaffold**

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json vitest.config.ts src/index.ts
git commit -m "chore: scaffold agent knowledge package"
```

---

### Task 2: Define Core Types and Schemas

**Files:**
- Create: `src/types.ts`
- Create: `src/schema.ts`
- Create: `tests/schema.test.ts`

- [ ] **Step 1: Write failing schema tests**

Create `tests/schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { KnowledgeFrontmatterSchema, MemoryQueryRequestSchema } from "../src/schema.js";

describe("KnowledgeFrontmatterSchema", () => {
  it("accepts a valid semantic memory frontmatter", () => {
    const parsed = KnowledgeFrontmatterSchema.parse({
      id: "k_20260705_frontend_lint_vue_sfc",
      type: "semantic",
      title: "Vue SFC lint 迁移约束",
      domain: "frontend/lint",
      related_domains: ["ci/performance", "monorepo/tooling"],
      scenario: ["code-review", "lint-migration"],
      tags: ["oxlint", "eslint", "vue-sfc"],
      status: "active",
      confidence: 0.86,
      source_authority: "user_confirmed",
      source: ["conversation:2026-07-05-agent-memory-design"],
      related_knowledge: [
        {
          id: "k_20260705_ci_three_stage_validation",
          relation: "depends_on",
          reason: "当前规则依赖 CI 三阶段校验链路"
        }
      ],
      supersedes: [],
      conflicts_with: [],
      visibility: "project",
      sensitivity: "internal",
      created_at: "2026-07-05",
      updated_at: "2026-07-05",
      valid_from: "2026-07-05",
      valid_until: null
    });

    expect(parsed.type).toBe("semantic");
    expect(parsed.related_domains).toEqual(["ci/performance", "monorepo/tooling"]);
  });

  it("rejects invalid confidence values", () => {
    expect(() =>
      KnowledgeFrontmatterSchema.parse({
        id: "k_bad",
        type: "semantic",
        title: "Bad",
        domain: "frontend/lint",
        scenario: ["code-review"],
        status: "active",
        confidence: 1.5,
        source_authority: "model_inferred",
        source: [],
        created_at: "2026-07-05",
        updated_at: "2026-07-05",
        valid_from: "2026-07-05"
      })
    ).toThrow();
  });
});

describe("MemoryQueryRequestSchema", () => {
  it("defaults maxTokens and includeTypes", () => {
    const parsed = MemoryQueryRequestSchema.parse({
      task: "审查 lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"]
    });

    expect(parsed.maxTokens).toBe(4500);
    expect(parsed.includeTypes).toEqual(["profile", "semantic", "episodic", "procedural"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/schema.test.ts`

Expected: FAIL with `Cannot find module '../src/schema.js'`.

- [ ] **Step 3: Implement shared types**

Create `src/types.ts`:

```ts
export type MemoryType = "profile" | "semantic" | "episodic" | "procedural" | "source";
export type MemoryStatus = "proposed" | "active" | "deprecated" | "rejected";
export type SourceAuthority = "user_confirmed" | "model_inferred" | "documented" | "verified_task";
export type Visibility = "private" | "project" | "team";
export type Sensitivity = "public" | "internal" | "confidential" | "secret";

export type KnowledgeRelation =
  | "depends_on"
  | "refines"
  | "supports"
  | "conflicts_with"
  | "supersedes"
  | "often_used_with";

export type RelatedKnowledge = {
  id: string;
  relation: KnowledgeRelation;
  reason: string;
};

export type KnowledgeFrontmatter = {
  id: string;
  type: MemoryType;
  title: string;
  domain: string;
  related_domains: string[];
  scenario: string[];
  tags: string[];
  status: MemoryStatus;
  confidence: number;
  source_authority: SourceAuthority;
  source: string[];
  related_knowledge: RelatedKnowledge[];
  supersedes: string[];
  conflicts_with: string[];
  visibility: Visibility;
  sensitivity: Sensitivity;
  created_at: string;
  updated_at: string;
  valid_from: string;
  valid_until: string | null;
};

export type KnowledgeDocument = {
  filePath: string;
  frontmatter: KnowledgeFrontmatter;
  body: string;
};

export type MemoryQueryRequest = {
  task: string;
  agentRole: "main" | "reviewer" | "writer" | "planner" | string;
  paths: string[];
  domains: string[];
  scenarios: string[];
  maxTokens: number;
  includeTypes: Array<"profile" | "semantic" | "episodic" | "procedural">;
};

export type ContextPacketItem = {
  id: string;
  title: string;
  content: string;
  confidence: number;
  source: string[];
};

export type ContextPacket = {
  context_version: "1.0";
  scene: {
    task_type: string;
    domains: string[];
    scenarios: string[];
  };
  always_apply: ContextPacketItem[];
  relevant_facts: ContextPacketItem[];
  procedures: ContextPacketItem[];
  examples: ContextPacketItem[];
  warnings: Array<{ type: string; message: string; source?: string }>;
  sources: string[];
};

export type RankedMemory = {
  document: KnowledgeDocument;
  lexicalScore: number;
  scenarioScore: number;
  confidenceScore: number;
  sourceAuthorityScore: number;
  relationScore: number;
  finalScore: number;
};
```

- [ ] **Step 4: Implement Zod schemas**

Create `src/schema.ts`:

```ts
import { z } from "zod";

export const MemoryTypeSchema = z.enum(["profile", "semantic", "episodic", "procedural", "source"]);
export const MemoryStatusSchema = z.enum(["proposed", "active", "deprecated", "rejected"]);
export const SourceAuthoritySchema = z.enum(["user_confirmed", "model_inferred", "documented", "verified_task"]);
export const VisibilitySchema = z.enum(["private", "project", "team"]);
export const SensitivitySchema = z.enum(["public", "internal", "confidential", "secret"]);
export const KnowledgeRelationSchema = z.enum([
  "depends_on",
  "refines",
  "supports",
  "conflicts_with",
  "supersedes",
  "often_used_with"
]);

const DateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const RelatedKnowledgeSchema = z.object({
  id: z.string().min(1),
  relation: KnowledgeRelationSchema,
  reason: z.string().min(1)
});

export const KnowledgeFrontmatterSchema = z.object({
  id: z.string().regex(/^k_[a-zA-Z0-9_]+$/),
  type: MemoryTypeSchema,
  title: z.string().min(1),
  domain: z.string().min(1),
  related_domains: z.array(z.string().min(1)).default([]),
  scenario: z.array(z.string().min(1)).min(1),
  tags: z.array(z.string().min(1)).default([]),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  source_authority: SourceAuthoritySchema,
  source: z.array(z.string()).default([]),
  related_knowledge: z.array(RelatedKnowledgeSchema).default([]),
  supersedes: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default("project"),
  sensitivity: SensitivitySchema.default("internal"),
  created_at: DateStringSchema,
  updated_at: DateStringSchema,
  valid_from: DateStringSchema,
  valid_until: DateStringSchema.nullable().default(null)
});

export const KnowledgeDocumentSchema = z.object({
  filePath: z.string().min(1),
  frontmatter: KnowledgeFrontmatterSchema,
  body: z.string()
});

export const MemoryQueryRequestSchema = z.object({
  task: z.string().min(1),
  agentRole: z.string().default("main"),
  paths: z.array(z.string()).default([]),
  domains: z.array(z.string()).default([]),
  scenarios: z.array(z.string()).default([]),
  maxTokens: z.number().int().positive().default(4500),
  includeTypes: z.array(z.enum(["profile", "semantic", "episodic", "procedural"])).default([
    "profile",
    "semantic",
    "episodic",
    "procedural"
  ])
});
```

- [ ] **Step 5: Run schema tests**

Run: `pnpm test tests/schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit types and schemas**

```bash
git add src/types.ts src/schema.ts tests/schema.test.ts
git commit -m "feat: define knowledge memory schema"
```

---

### Task 3: Parse and Serialize Markdown Knowledge

**Files:**
- Create: `src/markdown.ts`
- Create: `tests/markdown.test.ts`

- [ ] **Step 1: Write failing Markdown tests**

Create `tests/markdown.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseKnowledgeMarkdown, serializeKnowledgeMarkdown } from "../src/markdown.js";

describe("parseKnowledgeMarkdown", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseKnowledgeMarkdown(
      "knowledge/semantic/frontend-lint/example.md",
      `---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
related_domains:
  - ci/performance
scenario:
  - code-review
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
---

# Vue SFC lint 迁移约束

## 结论

Vue SFC template 仍需要 ESLint fallback。
`
    );

    expect(parsed.frontmatter.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(parsed.frontmatter.related_domains).toEqual(["ci/performance"]);
    expect(parsed.body).toContain("Vue SFC template");
  });
});

describe("serializeKnowledgeMarkdown", () => {
  it("round-trips a knowledge document", () => {
    const document = parseKnowledgeMarkdown(
      "knowledge/semantic/frontend-lint/example.md",
      `---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
scenario:
  - code-review
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
---

# Vue SFC lint 迁移约束
`
    );

    const markdown = serializeKnowledgeMarkdown(document);
    expect(markdown).toContain("id: k_20260705_frontend_lint_vue_sfc");
    expect(markdown).toContain("# Vue SFC lint 迁移约束");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/markdown.test.ts`

Expected: FAIL with `Cannot find module '../src/markdown.js'`.

- [ ] **Step 3: Implement Markdown utilities**

Create `src/markdown.ts`:

```ts
import matter from "gray-matter";
import yaml from "js-yaml";
import { KnowledgeDocumentSchema } from "./schema.js";
import type { KnowledgeDocument } from "./types.js";

export function parseKnowledgeMarkdown(filePath: string, markdown: string): KnowledgeDocument {
  const parsed = matter(markdown);

  return KnowledgeDocumentSchema.parse({
    filePath,
    frontmatter: parsed.data,
    body: parsed.content.trimStart()
  });
}

export function serializeKnowledgeMarkdown(document: KnowledgeDocument): string {
  const frontmatter = yaml.dump(document.frontmatter, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false
  });

  return `---\n${frontmatter}---\n\n${document.body.trimStart()}`;
}

export function extractSummary(body: string, maxLength = 500): string {
  const normalized = body
    .replace(/^# .+$/m, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}
```

- [ ] **Step 4: Run Markdown tests**

Run: `pnpm test tests/markdown.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit Markdown utilities**

```bash
git add src/markdown.ts tests/markdown.test.ts
git commit -m "feat: parse knowledge markdown"
```

---

### Task 4: Initialize Knowledge Workspace and Discover Files

**Files:**
- Create: `src/paths.ts`
- Create: `src/workspace.ts`
- Create: `tests/workspace.test.ts`
- Create: `knowledge/README.md`

- [ ] **Step 1: Write failing workspace tests**

Create `tests/workspace.test.ts`:

```ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverKnowledgeFiles, initKnowledgeWorkspace } from "../src/workspace.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("initKnowledgeWorkspace", () => {
  it("creates the expected knowledge directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-"));
    tempDirs.push(root);

    await initKnowledgeWorkspace(root);

    await expect(stat(path.join(root, "knowledge", "_inbox"))).resolves.toBeDefined();
    await expect(stat(path.join(root, "knowledge", "semantic"))).resolves.toBeDefined();
    await expect(stat(path.join(root, "knowledge", "procedural"))).resolves.toBeDefined();
  });
});

describe("discoverKnowledgeFiles", () => {
  it("returns markdown files outside generated catalogs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-"));
    tempDirs.push(root);

    await initKnowledgeWorkspace(root);
    const files = await discoverKnowledgeFiles(root);

    expect(files.every((file) => file.endsWith(".md"))).toBe(true);
    expect(files.some((file) => file.endsWith("_catalog.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/workspace.test.ts`

Expected: FAIL with `Cannot find module '../src/workspace.js'`.

- [ ] **Step 3: Implement path helpers**

Create `src/paths.ts`:

```ts
import path from "node:path";

export const KNOWLEDGE_DIRS = [
  "knowledge/_inbox",
  "knowledge/_archive",
  "knowledge/profile",
  "knowledge/semantic",
  "knowledge/episodic",
  "knowledge/procedural",
  "knowledge/sources"
] as const;

export function resolveWorkspacePath(rootDir: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);

  if (!resolvedTarget.startsWith(resolvedRoot)) {
    throw new Error(`Refusing to access path outside workspace: ${resolvedTarget}`);
  }

  return resolvedTarget;
}

export function toPosixRelativePath(rootDir: string, filePath: string): string {
  return path.relative(rootDir, filePath).split(path.sep).join("/");
}
```

- [ ] **Step 4: Implement workspace initialization**

Create `src/workspace.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import fg from "fast-glob";
import { KNOWLEDGE_DIRS, resolveWorkspacePath, toPosixRelativePath } from "./paths.js";

const README = `# Knowledge Base

This directory is the human-readable fact source for agent memory.

- \`profile/\`: stable preferences and project rules.
- \`semantic/\`: business facts, concepts, system boundaries.
- \`episodic/\`: historical tasks, incidents, lessons.
- \`procedural/\`: reusable procedures and SOPs.
- \`sources/\`: source summaries and provenance.
- \`_inbox/\`: proposed memories awaiting review.
- \`_archive/\`: deprecated or rejected memories.
`;

export async function initKnowledgeWorkspace(rootDir: string): Promise<void> {
  for (const dir of KNOWLEDGE_DIRS) {
    await mkdir(resolveWorkspacePath(rootDir, dir), { recursive: true });
  }

  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "README.md"), README, "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_catalog.md"), "# Knowledge Catalog\n", "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_conflicts.md"), "# Knowledge Conflicts\n", "utf8");
  await writeFile(resolveWorkspacePath(rootDir, "knowledge", "_review_queue.md"), "# Review Queue\n", "utf8");
}

export async function discoverKnowledgeFiles(rootDir: string): Promise<string[]> {
  const entries = await fg("knowledge/**/*.md", {
    cwd: rootDir,
    absolute: true,
    ignore: [
      "knowledge/README.md",
      "knowledge/_catalog.md",
      "knowledge/_conflicts.md",
      "knowledge/_review_queue.md"
    ]
  });

  return entries.sort().map((file) => toPosixRelativePath(rootDir, file));
}
```

- [ ] **Step 5: Create repository README for knowledge directory**

Create `knowledge/README.md`:

```md
# Knowledge Base

This directory is the human-readable fact source for agent memory.

- `profile/`: stable preferences and project rules.
- `semantic/`: business facts, concepts, system boundaries.
- `episodic/`: historical tasks, incidents, lessons.
- `procedural/`: reusable procedures and SOPs.
- `sources/`: source summaries and provenance.
- `_inbox/`: proposed memories awaiting review.
- `_archive/`: deprecated or rejected memories.
```

- [ ] **Step 6: Run workspace tests**

Run: `pnpm test tests/workspace.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit workspace initialization**

```bash
git add src/paths.ts src/workspace.ts tests/workspace.test.ts knowledge/README.md
git commit -m "feat: initialize knowledge workspace"
```

---

### Task 5: Add Fixture Knowledge Documents

**Files:**
- Create: `tests/fixtures/basic-knowledge/knowledge/semantic/frontend-lint/2026-07-05-vue-sfc-eslint-fallback.md`
- Create: `tests/fixtures/basic-knowledge/knowledge/procedural/code-review/2026-07-05-lint-validation-flow.md`

- [ ] **Step 1: Create semantic fixture**

Create `tests/fixtures/basic-knowledge/knowledge/semantic/frontend-lint/2026-07-05-vue-sfc-eslint-fallback.md`:

```md
---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
related_domains:
  - ci/performance
  - monorepo/tooling
scenario:
  - code-review
  - lint-migration
tags:
  - oxlint
  - eslint
  - vue-sfc
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:2026-07-05-agent-memory-design
related_knowledge:
  - id: k_20260705_lint_validation_flow
    relation: often_used_with
    reason: Lint 迁移约束通常需要配合验证流程使用。
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
valid_until:
---

# Vue SFC lint 迁移约束

## 结论

Oxlint 负责 TS/JS 快速检查，Vue SFC template 仍需要 ESLint fallback。

## 适用场景

用于 lint 迁移、代码审查、CI 性能优化相关任务。
```

- [ ] **Step 2: Create procedural fixture**

Create `tests/fixtures/basic-knowledge/knowledge/procedural/code-review/2026-07-05-lint-validation-flow.md`:

```md
---
id: k_20260705_lint_validation_flow
type: procedural
title: Lint 迁移验证流程
domain: frontend/lint
related_domains:
  - ci/performance
scenario:
  - lint-migration
  - code-review
tags:
  - oxlint
  - eslint
  - oxfmt
status: active
confidence: 0.8
source_authority: verified_task
source:
  - conversation:2026-07-05-agent-memory-design
related_knowledge: []
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
valid_until:
---

# Lint 迁移验证流程

## 结论

迁移 lint 配置后，应按 Oxlint -> ESLint fallback -> Oxfmt 的顺序验证。

## 适用场景

用于 lint 迁移、CI 性能优化和代码审查任务。
```

- [ ] **Step 3: Verify fixture schemas by running existing tests**

Run: `pnpm test tests/schema.test.ts tests/markdown.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit fixtures**

```bash
git add tests/fixtures/basic-knowledge
git commit -m "test: add knowledge fixtures"
```

---

### Task 6: Build SQLite Metadata and FTS Indexer

**Files:**
- Create: `src/indexer.ts`
- Create: `tests/indexer.test.ts`

- [ ] **Step 1: Write failing indexer tests**

Create `tests/indexer.test.ts`:

```ts
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/indexer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("rebuildIndex", () => {
  it("indexes active knowledge files into SQLite and FTS", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-index-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const result = rebuildIndex(root);

    expect(result.indexed).toBe(2);
    expect(result.dbPath.endsWith(".memory/index.sqlite")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/indexer.test.ts`

Expected: FAIL with `Cannot find module '../src/indexer.js'`.

- [ ] **Step 3: Implement indexer**

Create `src/indexer.ts`:

```ts
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseKnowledgeMarkdown, extractSummary } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { discoverKnowledgeFiles } from "./workspace.js";
import type { KnowledgeDocument } from "./types.js";

export type RebuildIndexResult = {
  dbPath: string;
  indexed: number;
};

function openIndexDatabase(rootDir: string): Database.Database {
  const memoryDir = resolveWorkspacePath(rootDir, ".memory");
  mkdirSync(memoryDir, { recursive: true });
  const dbPath = path.join(memoryDir, "index.sqlite");
  const db = new Database(dbPath);

  db.exec(`
    DROP TABLE IF EXISTS memories;
    DROP TABLE IF EXISTS memory_fts;

    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      domain TEXT NOT NULL,
      related_domains TEXT NOT NULL,
      scenario TEXT NOT NULL,
      tags TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      source_authority TEXT NOT NULL,
      source TEXT NOT NULL,
      related_knowledge TEXT NOT NULL,
      supersedes TEXT NOT NULL,
      conflicts_with TEXT NOT NULL,
      visibility TEXT NOT NULL,
      sensitivity TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      valid_until TEXT,
      summary TEXT NOT NULL,
      body TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE memory_fts USING fts5(
      id UNINDEXED,
      title,
      domain,
      scenario,
      tags,
      summary,
      body
    );
  `);

  return db;
}

function insertDocument(db: Database.Database, document: KnowledgeDocument): void {
  const frontmatter = document.frontmatter;
  const summary = extractSummary(document.body);

  db.prepare(`
    INSERT INTO memories (
      id, file_path, type, title, domain, related_domains, scenario, tags, status,
      confidence, source_authority, source, related_knowledge, supersedes,
      conflicts_with, visibility, sensitivity, updated_at, valid_until, summary, body
    ) VALUES (
      @id, @file_path, @type, @title, @domain, @related_domains, @scenario, @tags, @status,
      @confidence, @source_authority, @source, @related_knowledge, @supersedes,
      @conflicts_with, @visibility, @sensitivity, @updated_at, @valid_until, @summary, @body
    )
  `).run({
    id: frontmatter.id,
    file_path: document.filePath,
    type: frontmatter.type,
    title: frontmatter.title,
    domain: frontmatter.domain,
    related_domains: JSON.stringify(frontmatter.related_domains),
    scenario: JSON.stringify(frontmatter.scenario),
    tags: JSON.stringify(frontmatter.tags),
    status: frontmatter.status,
    confidence: frontmatter.confidence,
    source_authority: frontmatter.source_authority,
    source: JSON.stringify(frontmatter.source),
    related_knowledge: JSON.stringify(frontmatter.related_knowledge),
    supersedes: JSON.stringify(frontmatter.supersedes),
    conflicts_with: JSON.stringify(frontmatter.conflicts_with),
    visibility: frontmatter.visibility,
    sensitivity: frontmatter.sensitivity,
    updated_at: frontmatter.updated_at,
    valid_until: frontmatter.valid_until,
    summary,
    body: document.body
  });

  db.prepare(`
    INSERT INTO memory_fts (id, title, domain, scenario, tags, summary, body)
    VALUES (@id, @title, @domain, @scenario, @tags, @summary, @body)
  `).run({
    id: frontmatter.id,
    title: frontmatter.title,
    domain: frontmatter.domain,
    scenario: frontmatter.scenario.join(" "),
    tags: frontmatter.tags.join(" "),
    summary,
    body: document.body
  });
}

export function getIndexDbPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "index.sqlite");
}

export async function loadKnowledgeDocuments(rootDir: string): Promise<KnowledgeDocument[]> {
  const files = await discoverKnowledgeFiles(rootDir);

  return files.map((relativePath) => {
    const absolutePath = resolveWorkspacePath(rootDir, relativePath);
    return parseKnowledgeMarkdown(relativePath, readFileSync(absolutePath, "utf8"));
  });
}

export function rebuildIndex(rootDir: string): RebuildIndexResult {
  const db = openIndexDatabase(rootDir);
  const files = require("node:fs").readdirSync(resolveWorkspacePath(rootDir, "knowledge"), { recursive: true });
  let indexed = 0;

  for (const file of files) {
    const relativePath = `knowledge/${String(file).split(path.sep).join("/")}`;
    if (!relativePath.endsWith(".md")) continue;
    if (["knowledge/README.md", "knowledge/_catalog.md", "knowledge/_conflicts.md", "knowledge/_review_queue.md"].includes(relativePath)) {
      continue;
    }

    const absolutePath = resolveWorkspacePath(rootDir, relativePath);
    const document = parseKnowledgeMarkdown(relativePath, readFileSync(absolutePath, "utf8"));
    insertDocument(db, document);
    indexed += 1;
  }

  db.close();
  return { dbPath: getIndexDbPath(rootDir), indexed };
}
```

- [ ] **Step 4: Run indexer test**

Run: `pnpm test tests/indexer.test.ts`

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit indexer**

```bash
git add src/indexer.ts tests/indexer.test.ts
git commit -m "feat: index markdown knowledge with sqlite fts"
```

---

### Task 7: Implement Query and Context Packet Assembly

**Files:**
- Create: `src/query.ts`
- Create: `src/contextPacket.ts`
- Create: `tests/query.test.ts`

- [ ] **Step 1: Write failing query tests**

Create `tests/query.test.ts`:

```ts
import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/indexer.js";
import { queryMemories } from "../src/query.js";
import { buildContextPacket } from "../src/contextPacket.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("queryMemories", () => {
  it("retrieves lint migration knowledge with related procedures", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-query-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "审查 Vue SFC lint 迁移方案，需要关注 ESLint fallback",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_lint_validation_flow");
  });
});

describe("buildContextPacket", () => {
  it("groups semantic and procedural memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-packet-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const ranked = queryMemories(root, {
      task: "审查 lint 迁移方案",
      agentRole: "main",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      paths: [],
      maxTokens: 4500,
      includeTypes: ["semantic", "procedural", "profile", "episodic"]
    });

    const packet = buildContextPacket({
      request: {
        task: "审查 lint 迁移方案",
        agentRole: "main",
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"],
        paths: [],
        maxTokens: 4500,
        includeTypes: ["semantic", "procedural", "profile", "episodic"]
      },
      ranked
    });

    expect(packet.relevant_facts[0]?.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(packet.procedures[0]?.id).toBe("k_20260705_lint_validation_flow");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/query.test.ts`

Expected: FAIL with `Cannot find module '../src/query.js'`.

- [ ] **Step 3: Implement query pipeline**

Create `src/query.ts`:

```ts
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { parseKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { MemoryQueryRequestSchema } from "./schema.js";
import type { KnowledgeDocument, MemoryQueryRequest, RankedMemory } from "./types.js";
import { getIndexDbPath } from "./indexer.js";

type MemoryRow = {
  id: string;
  file_path: string;
  type: string;
  title: string;
  domain: string;
  related_domains: string;
  scenario: string;
  status: string;
  confidence: number;
  source_authority: string;
  rank_score?: number;
};

const AUTHORITY_SCORE: Record<string, number> = {
  user_confirmed: 1,
  verified_task: 0.85,
  documented: 0.75,
  model_inferred: 0.45
};

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^\p{L}\p{N}_/-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 12);
}

function loadDocument(rootDir: string, filePath: string): KnowledgeDocument {
  return parseKnowledgeMarkdown(filePath, readFileSync(resolveWorkspacePath(rootDir, filePath), "utf8"));
}

function intersects(left: string[], right: string[]): boolean {
  return left.some((item) => right.includes(item));
}

function rowMatchesRequest(row: MemoryRow, request: MemoryQueryRequest): boolean {
  const relatedDomains = JSON.parse(row.related_domains) as string[];
  const scenarios = JSON.parse(row.scenario) as string[];
  const domainPool = [row.domain, ...relatedDomains];
  const domainOk = request.domains.length === 0 || intersects(domainPool, request.domains);
  const scenarioOk = request.scenarios.length === 0 || intersects(scenarios, request.scenarios);
  const typeOk = request.includeTypes.includes(row.type as MemoryQueryRequest["includeTypes"][number]);

  return row.status === "active" && domainOk && scenarioOk && typeOk;
}

function scoreRow(row: MemoryRow, request: MemoryQueryRequest, relationScore: number): Omit<RankedMemory, "document"> {
  const scenarios = JSON.parse(row.scenario) as string[];
  const scenarioScore = request.scenarios.length > 0 && intersects(scenarios, request.scenarios) ? 1 : 0.3;
  const lexicalScore = Math.max(0, Math.min(1, 1 - Math.abs(row.rank_score ?? 0) / 20));
  const confidenceScore = row.confidence;
  const sourceAuthorityScore = AUTHORITY_SCORE[row.source_authority] ?? 0.4;
  const finalScore =
    0.3 * lexicalScore +
    0.15 * scenarioScore +
    0.1 * confidenceScore +
    0.1 * sourceAuthorityScore +
    0.05 * relationScore;

  return {
    lexicalScore,
    scenarioScore,
    confidenceScore,
    sourceAuthorityScore,
    relationScore,
    finalScore
  };
}

export function queryMemories(rootDir: string, rawRequest: unknown): RankedMemory[] {
  const request = MemoryQueryRequestSchema.parse(rawRequest);
  const db = new Database(getIndexDbPath(rootDir), { readonly: true });
  const query = tokenize([request.task, ...request.domains, ...request.scenarios, ...request.paths].join(" ")).join(" OR ");
  const rows = db
    .prepare(
      query.length > 0
        ? `SELECT memories.*, bm25(memory_fts) AS rank_score
           FROM memory_fts JOIN memories ON memory_fts.id = memories.id
           WHERE memory_fts MATCH @query`
        : `SELECT memories.*, 0 AS rank_score FROM memories`
    )
    .all({ query }) as MemoryRow[];

  const directRows = rows.filter((row) => rowMatchesRequest(row, request));
  const directIds = new Set(directRows.map((row) => row.id));
  const relatedIds = new Set<string>();

  for (const row of directRows) {
    const document = loadDocument(rootDir, row.file_path);
    for (const relation of document.frontmatter.related_knowledge) {
      if (["depends_on", "refines", "supports", "often_used_with"].includes(relation.relation)) {
        relatedIds.add(relation.id);
      }
    }
  }

  const relatedRows =
    relatedIds.size === 0
      ? []
      : (db
          .prepare(`SELECT memories.*, 0 AS rank_score FROM memories WHERE id IN (${[...relatedIds].map(() => "?").join(",")})`)
          .all(...relatedIds) as MemoryRow[]).filter((row) => row.status === "active" && !directIds.has(row.id));

  db.close();

  return [...directRows.map((row) => ({ row, relationScore: 0 })), ...relatedRows.map((row) => ({ row, relationScore: 1 }))]
    .map(({ row, relationScore }) => ({
      document: loadDocument(rootDir, row.file_path),
      ...scoreRow(row, request, relationScore)
    }))
    .sort((a, b) => b.finalScore - a.finalScore);
}
```

- [ ] **Step 4: Implement context packet builder**

Create `src/contextPacket.ts`:

```ts
import { extractSummary } from "./markdown.js";
import type { ContextPacket, ContextPacketItem, MemoryQueryRequest, RankedMemory } from "./types.js";

type BuildContextPacketInput = {
  request: MemoryQueryRequest;
  ranked: RankedMemory[];
};

function toItem(memory: RankedMemory): ContextPacketItem {
  const document = memory.document;

  return {
    id: document.frontmatter.id,
    title: document.frontmatter.title,
    content: extractSummary(document.body, 360),
    confidence: document.frontmatter.confidence,
    source: document.frontmatter.source
  };
}

export function buildContextPacket(input: BuildContextPacketInput): ContextPacket {
  const packet: ContextPacket = {
    context_version: "1.0",
    scene: {
      task_type: input.request.agentRole,
      domains: input.request.domains,
      scenarios: input.request.scenarios
    },
    always_apply: [],
    relevant_facts: [],
    procedures: [],
    examples: [],
    warnings: [],
    sources: []
  };

  for (const ranked of input.ranked) {
    const type = ranked.document.frontmatter.type;
    const item = toItem(ranked);

    if (type === "profile") packet.always_apply.push(item);
    if (type === "semantic") packet.relevant_facts.push(item);
    if (type === "procedural") packet.procedures.push(item);
    if (type === "episodic") packet.examples.push(item);

    for (const conflict of ranked.document.frontmatter.conflicts_with) {
      packet.warnings.push({
        type: "conflict",
        message: `${ranked.document.frontmatter.title} 与 ${conflict} 存在冲突，需要人工确认。`,
        source: ranked.document.frontmatter.id
      });
    }

    packet.sources.push(...ranked.document.frontmatter.source);
  }

  packet.always_apply = packet.always_apply.slice(0, 5);
  packet.relevant_facts = packet.relevant_facts.slice(0, 8);
  packet.procedures = packet.procedures.slice(0, 5);
  packet.examples = packet.examples.slice(0, 2);
  packet.sources = [...new Set(packet.sources)].slice(0, 10);

  return packet;
}
```

- [ ] **Step 5: Run query tests**

Run: `pnpm test tests/query.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit query and context packet**

```bash
git add src/query.ts src/contextPacket.ts tests/query.test.ts
git commit -m "feat: query knowledge context packets"
```

---

### Task 8: Implement Governance and Inbox Candidate Writer

**Files:**
- Create: `src/governance.ts`
- Create: `src/inbox.ts`
- Create: `tests/inbox.test.ts`

- [ ] **Step 1: Write failing inbox tests**

Create `tests/inbox.test.ts`:

```ts
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeCandidateMemory } from "../src/inbox.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("writeCandidateMemory", () => {
  it("writes safe model-inferred memories to _inbox as proposed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-"));
    tempDirs.push(root);

    const result = await writeCandidateMemory(root, {
      title: "Lint 迁移验证流程",
      memory_type: "procedural",
      domain: "frontend/lint",
      related_domains: ["ci/performance"],
      scenario: ["lint-migration"],
      tags: ["oxlint"],
      confidence: 0.72,
      source_authority: "model_inferred",
      summary: "迁移 lint 配置后应按 Oxlint -> ESLint fallback -> Oxfmt 顺序验证。",
      evidence: ["conversation:test"]
    });

    expect(result.status).toBe("proposed");
    const content = await readFile(result.filePath, "utf8");
    expect(content).toContain("status: proposed");
    expect(content).toContain("Lint 迁移验证流程");
  });

  it("rejects candidates containing API keys", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-inbox-secret-"));
    tempDirs.push(root);

    await expect(
      writeCandidateMemory(root, {
        title: "Leaked token",
        memory_type: "semantic",
        domain: "security",
        related_domains: [],
        scenario: ["debugging"],
        tags: ["secret"],
        confidence: 0.9,
        source_authority: "model_inferred",
        summary: "OPENAI_API_KEY=sk-1234567890abcdef1234567890abcdef",
        evidence: ["conversation:test"]
      })
    ).rejects.toThrow("Candidate contains secret-like content");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/inbox.test.ts`

Expected: FAIL with `Cannot find module '../src/inbox.js'`.

- [ ] **Step 3: Implement governance**

Create `src/governance.ts`:

```ts
import type { MemoryStatus, SourceAuthority } from "./types.js";

export type CandidateMemoryInput = {
  title: string;
  memory_type: "profile" | "semantic" | "episodic" | "procedural" | "source";
  domain: string;
  related_domains: string[];
  scenario: string[];
  tags: string[];
  confidence: number;
  source_authority: SourceAuthority;
  summary: string;
  evidence: string[];
};

export type GovernanceDecision = {
  status: MemoryStatus;
  review_required: boolean;
  review_reason: string;
};

const SECRET_PATTERNS = [
  /api[_-]?key\s*=\s*["']?[a-z0-9_-]{20,}/i,
  /token\s*=\s*["']?[a-z0-9_.-]{20,}/i,
  /sk-[a-z0-9]{20,}/i,
  /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/
];

export function assertNoSecretLikeContent(input: CandidateMemoryInput): void {
  const haystack = JSON.stringify(input);
  if (SECRET_PATTERNS.some((pattern) => pattern.test(haystack))) {
    throw new Error("Candidate contains secret-like content");
  }
}

export function decideCandidateStatus(input: CandidateMemoryInput): GovernanceDecision {
  assertNoSecretLikeContent(input);

  if (input.source_authority === "user_confirmed") {
    return {
      status: "active",
      review_required: false,
      review_reason: "user_confirmed"
    };
  }

  if (input.source_authority === "verified_task" && input.memory_type === "procedural" && input.confidence >= 0.75) {
    return {
      status: "active",
      review_required: false,
      review_reason: "verified_task_procedural_memory"
    };
  }

  return {
    status: "proposed",
    review_required: true,
    review_reason: "model_or_document_inferred_memory"
  };
}
```

- [ ] **Step 4: Implement inbox writer**

Create `src/inbox.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { serializeKnowledgeMarkdown } from "./markdown.js";
import { resolveWorkspacePath } from "./paths.js";
import { decideCandidateStatus, type CandidateMemoryInput } from "./governance.js";
import type { KnowledgeDocument } from "./types.js";

export type WriteCandidateResult = {
  id: string;
  status: "proposed" | "active" | "deprecated" | "rejected";
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

function idFromCandidate(input: CandidateMemoryInput): string {
  const date = today().replaceAll("-", "");
  return `k_${date}_${slugify(input.domain).replaceAll("-", "_")}_${slugify(input.title).replaceAll("-", "_")}`;
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

  await writeFile(absolutePath, serializeKnowledgeMarkdown(document), "utf8");

  return {
    id,
    status: decision.status,
    filePath: absolutePath
  };
}
```

- [ ] **Step 5: Run inbox tests**

Run: `pnpm test tests/inbox.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit governance and inbox**

```bash
git add src/governance.ts src/inbox.ts tests/inbox.test.ts
git commit -m "feat: write governed candidate memories"
```

---

### Task 9: Add CLI Commands

**Files:**
- Create: `src/cli.ts`

- [ ] **Step 1: Create CLI**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { initKnowledgeWorkspace } from "./workspace.js";
import { rebuildIndex } from "./indexer.js";
import { queryMemories } from "./query.js";
import { buildContextPacket } from "./contextPacket.js";
import { writeCandidateMemory } from "./inbox.js";
import { MemoryQueryRequestSchema } from "./schema.js";

const program = new Command();

program.name("agent-knowledge").description("Local human-readable memory toolkit for agents").version("0.1.0");

program
  .command("init")
  .option("--root <dir>", "workspace root", process.cwd())
  .action(async (options) => {
    await initKnowledgeWorkspace(options.root);
    console.log(`Initialized knowledge workspace at ${options.root}`);
  });

program
  .command("index")
  .option("--root <dir>", "workspace root", process.cwd())
  .action((options) => {
    const result = rebuildIndex(options.root);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command("query")
  .requiredOption("--task <task>", "task text")
  .option("--root <dir>", "workspace root", process.cwd())
  .option("--domain <domain...>", "domains")
  .option("--scenario <scenario...>", "scenarios")
  .option("--agent-role <role>", "agent role", "main")
  .action((options) => {
    const request = MemoryQueryRequestSchema.parse({
      task: options.task,
      agentRole: options.agentRole,
      domains: options.domain ?? [],
      scenarios: options.scenario ?? []
    });
    const ranked = queryMemories(options.root, request);
    const packet = buildContextPacket({ request, ranked });
    console.log(JSON.stringify(packet, null, 2));
  });

program
  .command("write-candidate")
  .requiredOption("--input <file>", "candidate JSON file")
  .option("--root <dir>", "workspace root", process.cwd())
  .action(async (options) => {
    const input = JSON.parse(await readFile(options.input, "utf8"));
    const result = await writeCandidateMemory(options.root, input);
    console.log(JSON.stringify(result, null, 2));
  });

await program.parseAsync(process.argv);
```

- [ ] **Step 2: Build CLI**

Run: `pnpm build`

Expected: PASS and creates `dist/cli.js`.

- [ ] **Step 3: Run CLI help**

Run: `node dist/cli.js --help`

Expected: output contains `Local human-readable memory toolkit for agents`.

- [ ] **Step 4: Run CLI query against fixture**

Run:

```bash
node dist/cli.js index --root tests/fixtures/basic-knowledge
node dist/cli.js query --root tests/fixtures/basic-knowledge --task "审查 Vue SFC lint 迁移方案" --domain frontend/lint --scenario lint-migration
```

Expected: output JSON includes `k_20260705_frontend_lint_vue_sfc`.

- [ ] **Step 5: Commit CLI**

```bash
git add src/cli.ts
git commit -m "feat: add agent knowledge cli"
```

---

### Task 10: Add Retrieval Evaluation Harness

**Files:**
- Create: `src/eval.ts`
- Create: `tests/eval.test.ts`
- Create: `eval/cases/lint-migration-code-review.yaml`

- [ ] **Step 1: Write failing eval test**

Create `tests/eval.test.ts`:

```ts
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildIndex } from "../src/indexer.js";
import { runEvalCase } from "../src/eval.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("runEvalCase", () => {
  it("reports expected memories and forbidden misses", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-eval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const result = await runEvalCase(root, {
      task: "审查 lint 迁移方案",
      domains: ["frontend/lint"],
      scenarios: ["lint-migration"],
      expected_memories: ["k_20260705_frontend_lint_vue_sfc"],
      forbidden_memories: ["k_20260601_deprecated_lint_flow"]
    });

    expect(result.passed).toBe(true);
    expect(result.missingExpected).toEqual([]);
    expect(result.presentForbidden).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm test tests/eval.test.ts`

Expected: FAIL with `Cannot find module '../src/eval.js'`.

- [ ] **Step 3: Implement eval harness**

Create `src/eval.ts`:

```ts
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { queryMemories } from "./query.js";

export type EvalCase = {
  task: string;
  domains: string[];
  scenarios: string[];
  expected_memories: string[];
  forbidden_memories: string[];
};

export type EvalResult = {
  passed: boolean;
  matchedIds: string[];
  missingExpected: string[];
  presentForbidden: string[];
};

export async function loadEvalCase(filePath: string): Promise<EvalCase> {
  return yaml.load(await readFile(filePath, "utf8")) as EvalCase;
}

export async function runEvalCase(rootDir: string, evalCase: EvalCase): Promise<EvalResult> {
  const ranked = queryMemories(rootDir, {
    task: evalCase.task,
    agentRole: "main",
    domains: evalCase.domains,
    scenarios: evalCase.scenarios,
    paths: [],
    maxTokens: 4500,
    includeTypes: ["profile", "semantic", "episodic", "procedural"]
  });
  const matchedIds = ranked.map((item) => item.document.frontmatter.id);
  const missingExpected = evalCase.expected_memories.filter((id) => !matchedIds.includes(id));
  const presentForbidden = evalCase.forbidden_memories.filter((id) => matchedIds.includes(id));

  return {
    passed: missingExpected.length === 0 && presentForbidden.length === 0,
    matchedIds,
    missingExpected,
    presentForbidden
  };
}
```

- [ ] **Step 4: Create eval case file**

Create `eval/cases/lint-migration-code-review.yaml`:

```yaml
task: "审查 lint 迁移方案"
domains:
  - frontend/lint
scenarios:
  - lint-migration
expected_memories:
  - k_20260705_frontend_lint_vue_sfc
  - k_20260705_lint_validation_flow
forbidden_memories:
  - k_20260601_deprecated_lint_flow
```

- [ ] **Step 5: Run eval tests**

Run: `pnpm test tests/eval.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit eval harness**

```bash
git add src/eval.ts tests/eval.test.ts eval/cases/lint-migration-code-review.yaml
git commit -m "feat: add retrieval evaluation harness"
```

---

### Task 11: Final Validation and Documentation Commit

**Files:**
- Modify: `docs/superpowers/specs/2026-07-05-agent-knowledge-persistence-design.md`
- Modify: `docs/superpowers/plans/2026-07-05-agent-knowledge-persistence.md`

- [x] **Step 1: Run full test suite**

Run: `pnpm test`

Expected: PASS for all tests.

- [x] **Step 2: Run typecheck**

Run: `pnpm typecheck`

Expected: PASS.

- [x] **Step 3: Run production build**

Run: `pnpm build`

Expected: PASS and emits `dist/`.

- [x] **Step 4: Run CLI smoke test**

Run:

```bash
node dist/cli.js index --root tests/fixtures/basic-knowledge
node dist/cli.js query --root tests/fixtures/basic-knowledge --task "审查 Vue SFC lint 迁移方案" --domain frontend/lint --scenario lint-migration
```

Expected: the query output contains both `k_20260705_frontend_lint_vue_sfc` and `k_20260705_lint_validation_flow`.

- [x] **Step 5: Update spec implementation note**

Append this section to `docs/superpowers/specs/2026-07-05-agent-knowledge-persistence-design.md`:

```md

## MVP Implementation Note

The first implementation ships as a local TypeScript CLI/library. It uses Markdown as the only fact source and SQLite FTS5 as the initial lexical retrieval backend. Embedding and graph retrieval remain pluggable interfaces for later versions.
```

- [x] **Step 6: Commit final validation note**

```bash
git add docs/superpowers/specs/2026-07-05-agent-knowledge-persistence-design.md docs/superpowers/plans/2026-07-05-agent-knowledge-persistence.md
git commit -m "docs: finalize agent knowledge implementation plan"
```

---

## Self-Review

### Spec coverage

- Markdown schema and human-readable fact source: Task 2, Task 3, Task 4, Task 5.
- Directory structure and generated human-readable views: Task 4.
- SQLite metadata and FTS/BM25 indexing: Task 6.
- Query API, metadata filtering, FTS retrieval, relation expansion: Task 7.
- Context packet assembly: Task 7.
- Candidate writing, governance, secret scanning, `_inbox`: Task 8.
- CLI integration: Task 9.
- Retrieval evaluation: Task 10.
- Final validation and documentation: Task 11.

### Placeholder scan

The plan contains no `TBD`, `TODO`, “implement later”, or unspecified validation steps. Each code-changing step includes concrete file content or exact code to append.

### Type consistency

The shared types in `src/types.ts` define the names used by `src/schema.ts`, `src/query.ts`, `src/contextPacket.ts`, `src/governance.ts`, `src/inbox.ts`, and `src/eval.ts`. `MemoryQueryRequest`, `KnowledgeDocument`, `RankedMemory`, and `ContextPacket` are consistently referenced across tasks.
