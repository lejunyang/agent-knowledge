# Production Memory Foundation Breaking V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以不兼容方式建立新的 V2 分层知识基础，严格拒绝旧 Markdown，并提供 weighted metadata、规范 Git remote 项目标识、证据锚点、质量审计、渐进上下文和独立 private Git 数据工作区。

**Architecture:** 删除 V1 KnowledgeDocument 公共契约，所有新事实源必须使用 `schema_version: 2`。V2 把 `kind` 与 `layer` 分离，直接使用规范 Git remote 作为 `project_key`，以 source manifest/section/claim anchor 提供可追溯证据，以 Context Packet 2.0 实现 synopsis -> knowledge -> evidence 渐进读取；当前 `knowledge/` 不转换，只保留为审计样本。正式业务知识在后续 Evidence Vault + Connector + Distillation 计划完成后从原始飞书材料全量重建。

**Tech Stack:** TypeScript 5.7、Zod、Commander、SQLite FTS5、Vitest、Markdown/YAML、Node.js crypto/fs、Git CLI

---

## 范围与非目标

本计划交付：

- breaking V2 schema。
- 严格 V2 Markdown 解析和空工作区。
- canonical `project_key`。
- weighted alias/scenario/tag。
- source manifest、section 和 claim evidence anchor。
- knowledge quality audit。
- Context Packet 2.0 和显式展开。
- 独立 private Git 数据工作区初始化。
- 新 candidate/organizer/reader/writer 契约。
- V2 fixture 和回归评测。

本计划明确不交付：

- V1 兼容 parser。
- V1 -> V2 migration。
- 当前 33 条精炼知识转换。
- 当前 656 份 source Markdown 转换。
- 完整会话 Vault。
- 飞书增量 Connector。
- 客服 case 和 initiative timeline。
- 后台 consolidation agents。
- Hindsight、memU、Mem0、Graphiti adapter。

后续实施顺序：

1. 本计划。
2. Evidence Vault and Connectors。
3. Raw Corpus Distillation and Rebuild。
4. Support and Initiative Memory。
5. Consolidation and Backend Lab。

## 文件结构

### 新增文件

- `src/core/knowledgeV2.ts`
- `src/storage/sourceManifest.ts`
- `src/storage/qualityAudit.ts`
- `src/storage/gitWorkspace.ts`
- `src/retrieval/expansion.ts`
- `src/cli/knowledge.ts`
- `src/cli/workspace.ts`
- `tests/knowledgeV2.test.ts`
- `tests/sourceManifest.test.ts`
- `tests/qualityAudit.test.ts`
- `tests/gitWorkspace.test.ts`
- `tests/progressiveContext.test.ts`
- `tests/fixtures/layered-knowledge/`
- `eval/cases/layered-knowledge.yaml`

### 修改文件

- `src/core/types.ts`
- `src/core/schema.ts`
- `src/core/paths.ts`
- `src/storage/markdown.ts`
- `src/storage/workspace.ts`
- `src/storage/indexer.ts`
- `src/storage/catalog.ts`
- `src/integration/projects.ts`
- `src/retrieval/scoring.ts`
- `src/retrieval/query.ts`
- `src/retrieval/contextPacket.ts`
- `src/memory/governance.ts`
- `src/memory/inbox.ts`
- `src/memory/organizer.ts`
- `src/cli.ts`
- `src/index.ts`
- `tests/schema.test.ts`
- `tests/markdown.test.ts`
- `tests/workspace.test.ts`
- `tests/indexer.test.ts`
- `tests/query.test.ts`
- `tests/projects.test.ts`
- `tests/hookOutput.test.ts`
- `tests/inbox.test.ts`
- `tests/organizer.test.ts`
- `tests/templates.test.ts`
- `README.md`
- `AGENTS.md`
- `docs/guides/configuration.md`
- `docs/guides/retrieval.md`
- `docs/guides/memory-governance.md`
- `docs/guides/integrations.md`
- `templates/trae/agents/agent-knowledge-reader.md`
- `templates/trae/agents/agent-knowledge-writer.md`
- `templates/claude-code/agents/agent-knowledge-reader.md`
- `templates/claude-code/agents/agent-knowledge-writer.md`
- `templates/trae/plugin/agents/agent-knowledge-reader.md`
- `templates/trae/plugin/agents/agent-knowledge-writer.md`
- `.trae/skills/knowledge-organizer/SKILL.md`
- `templates/trae/plugin/skills/knowledge-organizer/SKILL.md`

## Task 1：定义严格 V2 分层知识契约

**Files:**
- Create: `src/core/knowledgeV2.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Test: `tests/knowledgeV2.test.ts`
- Test: `tests/schema.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/knowledgeV2.test.ts` 写：

```ts
import { describe, expect, it } from "vitest";
import { KnowledgeFrontmatterV2Schema } from "../src/core/knowledgeV2.js";

describe("KnowledgeFrontmatterV2Schema", () => {
  it("parses layered knowledge with weighted metadata and evidence", () => {
    const parsed = KnowledgeFrontmatterV2Schema.parse({
      schema_version: 2,
      id: "k_account_identity_boundary",
      kind: "semantic",
      layer: "knowledge",
      title: "商业化 UID 与抖音 UID 的账号组边界",
      synopsis: "两类 UID 属于不同账号组，不能默认相等。",
      aliases: [
        {
          value: "账号组边界",
          kind: "user_phrase",
          weight: 0.9,
          source: "documented"
        }
      ],
      domain: "bytedance/business/account",
      related_domains: [],
      scenarios: [
        {
          id: "support/account-login",
          role: "primary",
          weight: 0.95
        }
      ],
      tags: [
        {
          value: "account",
          weight: 0.8,
          source: "taxonomy",
          retrieval: true
        }
      ],
      status: "active",
      confidence: 0.96,
      source_authority: "documented",
      source: ["source:src_account_guide"],
      claims: [
        {
          id: "claim_uid_group_boundary",
          statement: "商业化 UID 与抖音 UID 属于不同账号组。",
          status: "supported",
          confidence: 0.96,
          evidence: [
            {
              source_id: "src_account_guide",
              section_id: "sec_login_identity",
              quote_hash:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }
          ]
        }
      ],
      related_knowledge: [],
      supersedes: [],
      conflicts_with: [],
      visibility: "project",
      sensitivity: "internal",
      project_keys: ["github.com/lejunyang/agent-knowledge"],
      capture_mode: "direct_material",
      actor_type: "owner",
      corroboration_count: 1,
      episodes: [],
      created_at: "2026-08-09",
      updated_at: "2026-08-09",
      valid_from: "2026-08-09",
      valid_until: null
    });

    expect(parsed.kind).toBe("semantic");
    expect(parsed.layer).toBe("knowledge");
    expect(parsed.project_keys).toEqual([
      "github.com/lejunyang/agent-knowledge"
    ]);
    expect(parsed.claims[0]?.evidence[0]?.section_id).toBe(
      "sec_login_identity"
    );
  });

  it("rejects supported claims without evidence", () => {
    expect(() =>
      KnowledgeFrontmatterV2Schema.parse({
        schema_version: 2,
        id: "k_unsupported",
        kind: "semantic",
        layer: "knowledge",
        title: "Unsupported",
        synopsis: "Unsupported",
        domain: "test/domain",
        scenarios: [{ id: "test", role: "primary", weight: 1 }],
        status: "active",
        confidence: 0.8,
        source_authority: "documented",
        claims: [
          {
            id: "claim_unsupported",
            statement: "No evidence",
            status: "supported",
            confidence: 0.8,
            evidence: []
          }
        ],
        created_at: "2026-08-09",
        updated_at: "2026-08-09",
        valid_from: "2026-08-09"
      })
    ).toThrow(/evidence/i);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/knowledgeV2.test.ts tests/schema.test.ts
```

Expected:

```text
FAIL  Cannot find module '../src/core/knowledgeV2.js'
```

- [ ] **Step 3: 实现 V2 schema**

在 `src/core/knowledgeV2.ts` 创建：

```ts
/**
 * V2 契约把知识内容类型与抽象层级分离。
 *
 * `synopsis` 用于低成本路由，正文用于解释，claim/evidence 用于追溯。
 * Markdown 和 Vault 才是事实源；SQLite、embedding 和外部后端只是投影。
 */
import { z } from "zod";
import {
  ActorTypeSchema,
  CaptureModeSchema,
  KnowledgeRelationSchema,
  MemoryStatusSchema,
  SensitivitySchema,
  SourceAuthoritySchema,
  VisibilitySchema
} from "./schema.js";

const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const KnowledgeKindSchema = z.enum([
  "profile",
  "semantic",
  "episodic",
  "procedural",
  "principle",
  "skill",
  "source"
]);

export const KnowledgeLayerSchema = z.enum([
  "synopsis",
  "knowledge",
  "evidence"
]);

export const ProjectKeySchema = z
  .string()
  .min(3)
  .regex(
    /^(?:[a-z0-9.-]+\/[a-z0-9._/-]+|local\/[a-z0-9._/-]+)$/,
    "expected a normalized Git remote or explicit local key"
  );

export const WeightedAliasSchema = z.object({
  value: z.string().min(1),
  kind: z.enum([
    "abbreviation",
    "translation",
    "previous_name",
    "user_phrase",
    "query_observed",
    "technical_identifier"
  ]),
  weight: z.number().min(0).max(1),
  source: z.enum([
    "documented",
    "user_confirmed",
    "query_observed"
  ]),
  evidence_refs: z.array(z.string().min(1)).default([]),
  positive_hits: z.number().int().nonnegative().default(0),
  negative_hits: z.number().int().nonnegative().default(0)
});

export const WeightedScenarioSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["primary", "secondary"]),
  weight: z.number().min(0).max(1)
});

export const WeightedTagSchema = z.object({
  value: z.string().min(1),
  weight: z.number().min(0).max(1),
  source: z.enum(["taxonomy", "documented", "observed"]),
  retrieval: z.boolean().default(true)
});

export const EvidenceAnchorSchema = z.object({
  source_id: z.string().min(1),
  section_id: z.string().min(1),
  quote_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  char_start: z.number().int().nonnegative().optional(),
  char_end: z.number().int().positive().optional()
});

export const KnowledgeClaimSchema = z
  .object({
    id: z.string().regex(/^claim_[a-zA-Z0-9_]+$/),
    statement: z.string().min(1),
    status: z.enum(["supported", "disputed", "superseded"]),
    confidence: z.number().min(0).max(1),
    evidence: z.array(EvidenceAnchorSchema).default([])
  })
  .superRefine((claim, context) => {
    if (claim.status === "supported" && claim.evidence.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence"],
        message: "supported claim requires evidence"
      });
    }
  });

export const RelatedKnowledgeV2Schema = z.object({
  id: z.string().min(1),
  relation: KnowledgeRelationSchema,
  reason: z.string().min(1)
});

export const EpisodeProvenanceV2Schema = z.object({
  episode_id: z.string().min(1),
  session_hash: z.string().min(1),
  turn_hash: z.string().min(1).optional(),
  project_key: ProjectKeySchema.optional(),
  observed_at: z.string().datetime(),
  evidence_refs: z.array(z.string().min(1)).default([])
});

export const KnowledgeFrontmatterV2Schema = z.object({
  schema_version: z.literal(2),
  id: z.string().regex(/^k_[a-zA-Z0-9_]+$/),
  kind: KnowledgeKindSchema,
  layer: KnowledgeLayerSchema,
  title: z.string().min(1),
  synopsis: z.string().min(1).max(1200),
  aliases: z.array(WeightedAliasSchema).max(16).default([]),
  domain: z.string().min(1),
  related_domains: z.array(z.string().min(1)).default([]),
  scenarios: z.array(WeightedScenarioSchema).min(1).max(6),
  tags: z.array(WeightedTagSchema).max(12).default([]),
  status: MemoryStatusSchema,
  confidence: z.number().min(0).max(1),
  source_authority: SourceAuthoritySchema,
  source: z.array(z.string()).default([]),
  claims: z.array(KnowledgeClaimSchema).default([]),
  related_knowledge: z.array(RelatedKnowledgeV2Schema).default([]),
  supersedes: z.array(z.string()).default([]),
  conflicts_with: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default("project"),
  sensitivity: SensitivitySchema.default("internal"),
  project_keys: z.array(ProjectKeySchema).default([]),
  capture_mode: CaptureModeSchema.default("direct_material"),
  actor_type: ActorTypeSchema.default("owner"),
  corroboration_count: z.number().int().nonnegative().default(1),
  episodes: z.array(EpisodeProvenanceV2Schema).default([]),
  created_at: DateStringSchema,
  updated_at: DateStringSchema,
  valid_from: DateStringSchema,
  valid_until: DateStringSchema.nullable().default(null)
});

export const KnowledgeDocumentV2Schema = z.object({
  filePath: z.string().min(1),
  frontmatter: KnowledgeFrontmatterV2Schema,
  body: z.string()
});

export type KnowledgeFrontmatter = z.output<
  typeof KnowledgeFrontmatterV2Schema
>;
export type KnowledgeDocument = z.output<typeof KnowledgeDocumentV2Schema>;
export type KnowledgeKind = z.output<typeof KnowledgeKindSchema>;
export type KnowledgeLayer = z.output<typeof KnowledgeLayerSchema>;
```

`src/core/types.ts` 直接 re-export V2 类型，不保留 V1 alias。`src/core/schema.ts` 删除旧 `KnowledgeFrontmatterSchema` 和 `KnowledgeDocumentSchema` 定义，重新导出 V2 同名 schema。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/knowledgeV2.test.ts tests/schema.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/core/knowledgeV2.ts src/core/types.ts src/core/schema.ts tests/knowledgeV2.test.ts tests/schema.test.ts
git diff --cached
git commit -m "feat: replace knowledge schema with v2"
```

提交消息末尾必须包含一次：

```text
Co-authored-by: TRAE CLI <noreply@bytedance.com>
```

## Task 2：严格拒绝 V1 Markdown 并初始化 V2 空工作区

**Files:**
- Modify: `src/storage/markdown.ts`
- Modify: `src/core/paths.ts`
- Modify: `src/storage/workspace.ts`
- Test: `tests/markdown.test.ts`
- Test: `tests/workspace.test.ts`
- Modify: `tests/fixtures/basic-knowledge/**`

- [ ] **Step 1: 写失败测试**

在 `tests/markdown.test.ts` 增加：

```ts
it("rejects V1 markdown instead of silently converting it", () => {
  expect(() =>
    parseKnowledgeMarkdown(
      "knowledge/semantic/legacy.md",
      `---
id: k_legacy
type: semantic
title: Legacy
domain: test
scenario:
  - test
status: active
confidence: 0.8
source_authority: documented
created_at: 2026-08-09
updated_at: 2026-08-09
valid_from: 2026-08-09
---

# Legacy
`
    )
  ).toThrow(/schema_version: 2/);
});
```

在 `tests/workspace.test.ts` 增加：

```ts
it("creates the V2 fact-source layout", async () => {
  await initKnowledgeWorkspace(root);
  await expect(
    access(path.join(root, "knowledge", "source-manifests"))
  ).resolves.toBeUndefined();
  await expect(
    access(path.join(root, "knowledge", "principle"))
  ).resolves.toBeUndefined();
  await expect(
    access(path.join(root, "events", "support"))
  ).resolves.toBeUndefined();
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/markdown.test.ts tests/workspace.test.ts
```

Expected:

```text
FAIL  V1 markdown is still accepted
```

- [ ] **Step 3: 实现严格 parser**

`src/storage/markdown.ts`：

```ts
export function parseKnowledgeMarkdown(
  filePath: string,
  markdown: string
): KnowledgeDocument {
  const parsed = matter(markdown);
  const frontmatter = normalizeYamlDates(parsed.data) as Record<string, unknown>;
  if (frontmatter.schema_version !== 2) {
    throw new Error(
      `Unsupported knowledge schema in ${filePath}; expected schema_version: 2. Rebuild this knowledge from original evidence instead of migrating it.`
    );
  }
  return KnowledgeDocumentV2Schema.parse({
    filePath,
    frontmatter,
    body: parsed.content.trimStart()
  });
}
```

`src/core/paths.ts` 的 `KNOWLEDGE_DIRS` 改为：

```ts
export const KNOWLEDGE_DIRS = [
  "knowledge/_inbox",
  "knowledge/_archive",
  "knowledge/profile",
  "knowledge/semantic",
  "knowledge/episodic",
  "knowledge/procedural",
  "knowledge/principle",
  "knowledge/skills",
  "knowledge/source-manifests",
  "events/support",
  "events/projects",
  "events/conversations",
  "proposals",
  "reviews"
] as const;
```

把测试 fixture 全部改成 V2。不得写自动转换脚本；fixture 是测试数据，直接重写为新契约。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/markdown.test.ts tests/workspace.test.ts tests/indexer.test.ts tests/query.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  4 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/storage/markdown.ts src/core/paths.ts src/storage/workspace.ts tests/markdown.test.ts tests/workspace.test.ts tests/fixtures
git diff --cached
git commit -m "refactor: require v2 knowledge documents"
```

## Task 3：用规范 Git remote 替换 hash Project ID

**Files:**
- Modify: `src/integration/projects.ts`
- Modify: `src/hooks/gitContext.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/cli.ts`
- Test: `tests/projects.test.ts`
- Test: `tests/gitContext.test.ts`
- Test: `tests/query.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/projects.test.ts` 改写项目身份测试：

```ts
it("uses the normalized Git remote as the canonical project key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-key-"));
  const knowledgeRoot = path.join(root, "memory-root");
  tempDirs.push(root);
  await mkdir(knowledgeRoot, { recursive: true });
  await execFileAsync("git", ["init"], { cwd: root });
  await execFileAsync(
    "git",
    ["remote", "add", "origin", "git@github.com:Example/Readable-Repo.git"],
    { cwd: root }
  );

  const project = await detectProject(knowledgeRoot, root);

  expect(project.key).toBe("github.com/example/readable-repo");
  expect(project.displayName).toBe("readable-repo");
  expect(project).not.toHaveProperty("id");
  expect(project.aliases).toContain("example/readable-repo");
});

it("requires an explicit local key when a Git remote is absent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "project-local-"));
  const knowledgeRoot = path.join(root, "memory-root");
  tempDirs.push(root);
  await execFileAsync("git", ["init"], { cwd: root });

  await expect(detectProject(knowledgeRoot, root)).rejects.toThrow(
    /explicit project key/i
  );
  const project = await detectProject(knowledgeRoot, root, {
    projectKey: "local/lejunyang/private-prototype"
  });
  expect(project.key).toBe("local/lejunyang/private-prototype");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/projects.test.ts tests/gitContext.test.ts
```

Expected:

```text
FAIL  project still exposes hash id
```

- [ ] **Step 3: 实现 canonical key**

`ProjectRegistry`：

```ts
export type ProjectRegistry = {
  version: 2;
  key: string;
  displayName: string;
  aliases: string[];
  identitySource: "git_remote" | "explicit_local_key";
  gitRoot: string;
  remotes: Array<{
    role: "origin";
    normalized: string;
    rawRedacted: string;
  }>;
  detectedAt: string;
  agentInstructions: ProjectInstructionFingerprint[];
};
```

规则：

- remote 存在：`key = normalizeGitRemote(remote)`。
- remote 缺失：必须显式传 `projectKey`，并通过 `ProjectKeySchema`。
- registry 文件名使用 `sha256(key).slice(0, 16)` 只是文件系统索引，不出现在 registry 内容、Markdown 或 CLI JSON。
- `query --project <key-or-alias...>` 替换 `--project-id`。
- Hook JSON 输出 `projectKey`，删除 `projectId`。
- `MemoryQueryRequest.projectKeys` 替换 `projectIds`。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/projects.test.ts tests/gitContext.test.ts tests/query.test.ts tests/hookCli.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  4 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/integration/projects.ts src/hooks/gitContext.ts src/core/types.ts src/core/schema.ts src/cli.ts tests/projects.test.ts tests/gitContext.test.ts tests/query.test.ts tests/hookCli.test.ts
git diff --cached
git commit -m "refactor: use git remotes as project keys"
```

## Task 4：索引 weighted metadata 并按特异性评分

**Files:**
- Modify: `src/storage/indexer.ts`
- Modify: `src/retrieval/scoring.ts`
- Modify: `src/retrieval/query.ts`
- Test: `tests/indexer.test.ts`
- Test: `tests/query.test.ts`

- [ ] **Step 1: 写失败测试**

在 V2 fixture 中创建：

- `k_qualification_reuse_filter`：高权重 alias `GetCanReuseAccountForDouyinMerchant`。
- `k_generic_internal_document`：低权重 tag `internal-doc`。

测试：

```ts
it("does not let generic low-weight metadata outrank specific aliases", () => {
  const result = queryMemoriesWithDebug(
    root,
    MemoryQueryRequestSchema.parse({
      task: "GetCanReuseAccountForDouyinMerchant 为什么过滤 10246 资质"
    })
  );
  expect(result.ranked[0]?.document.frontmatter.id).toBe(
    "k_qualification_reuse_filter"
  );
  expect(result.ranked[0]?.metadataScore).toBeGreaterThan(0.5);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/indexer.test.ts tests/query.test.ts
```

Expected:

```text
FAIL  metadataScore does not exist
```

- [ ] **Step 3: 修改索引和评分**

SQLite `memories` 保存：

```sql
kind TEXT NOT NULL,
layer TEXT NOT NULL,
synopsis TEXT NOT NULL,
weighted_aliases TEXT NOT NULL,
weighted_scenarios TEXT NOT NULL,
weighted_tags TEXT NOT NULL,
project_keys TEXT NOT NULL,
claims TEXT NOT NULL
```

FTS 仅写：

```ts
const searchableAliases = frontmatter.aliases
  .filter((item) => item.weight >= 0.35)
  .map((item) => item.value)
  .join(" ");
const searchableScenarios = frontmatter.scenarios
  .filter((item) => item.weight >= 0.35)
  .map((item) => item.id)
  .join(" ");
const searchableTags = frontmatter.tags
  .filter((item) => item.retrieval && item.weight >= 0.35)
  .map((item) => item.value)
  .join(" ");
```

在 `src/retrieval/scoring.ts` 增加：

```ts
/** 结合人工权重、query 覆盖率和语料 IDF 计算 metadata 证据。 */
export function weightedMetadataScore(input: {
  query: string;
  values: Array<{ value: string; weight: number }>;
  documentFrequency: Map<string, number>;
  documentCount: number;
}): number {
  const query = input.query.toLowerCase();
  let score = 0;
  for (const item of input.values) {
    const value = item.value.toLowerCase();
    if (!query.includes(value)) {
      continue;
    }
    const coverage = Math.min(1, value.length / Math.max(1, query.length));
    const frequency = input.documentFrequency.get(value) ?? 1;
    const specificity =
      Math.log((input.documentCount + 1) / (frequency + 1)) /
      Math.log(input.documentCount + 1);
    score += item.weight * coverage * Math.max(0.1, specificity);
  }
  return Math.min(1, score);
}
```

把 `metadataScore` 作为独立 feature 写入 debug 和 reranker，不能混入 lexicalScore。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/indexer.test.ts tests/query.test.ts tests/eval.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  3 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/storage/indexer.ts src/retrieval/scoring.ts src/retrieval/query.ts tests/indexer.test.ts tests/query.test.ts
git diff --cached
git commit -m "feat: score weighted knowledge metadata"
```

## Task 5：建立 Source Manifest 与 Evidence Anchor

**Files:**
- Create: `src/storage/sourceManifest.ts`
- Test: `tests/sourceManifest.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  buildSourceManifest,
  sourceSectionId
} from "../src/storage/sourceManifest.js";

describe("source manifests", () => {
  it("creates stable heading-aware sections", () => {
    const content = [
      "<title>账号指南</title>",
      "<h1>登录态</h1>",
      "<h2>账号组</h2>",
      "<p>商业化 UID 与抖音 UID 属于不同账号组。</p>",
      "<h2>OAuth</h2>",
      "<p>两者通过授权关系建立绑定。</p>"
    ].join("");
    const manifest = buildSourceManifest({
      sourceId: "src_account_guide",
      connector: "lark",
      externalKey: "wiki:account",
      title: "账号指南",
      content,
      observedAt: "2026-08-09T00:00:00.000Z"
    });
    expect(manifest.sections).toHaveLength(2);
    expect(manifest.sections[0]?.heading_path).toEqual([
      "登录态",
      "账号组"
    ]);
    expect(manifest.sections[0]?.section_id).toBe(
      sourceSectionId(
        "src_account_guide",
        ["登录态", "账号组"],
        "商业化 UID 与抖音 UID 属于不同账号组。"
      )
    );
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/sourceManifest.test.ts
```

Expected:

```text
FAIL  Cannot find module '../src/storage/sourceManifest.js'
```

- [ ] **Step 3: 实现 manifest**

创建：

```ts
/**
 * Source manifest 把完整证据映射为稳定 section。
 *
 * manifest 只保存导航、hash 和脱敏 preview；完整正文归后续 Vault 管理。
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const SourceSectionSchema = z.object({
  section_id: z.string().regex(/^sec_[a-f0-9]{20}$/),
  heading_path: z.array(z.string().min(1)).min(1),
  text_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
  preview: z.string().max(500)
});

export const SourceManifestSchema = z.object({
  schema_version: z.literal(1),
  source_id: z.string().min(1),
  connector: z.string().min(1),
  external_key: z.string().min(1),
  title: z.string().min(1),
  content_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  version_observed_at: z.string().datetime(),
  vault_object: z.string().min(1).optional(),
  sections: z.array(SourceSectionSchema)
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sourceSectionId(
  sourceId: string,
  headingPath: string[],
  text: string
): string {
  return `sec_${sha256(
    JSON.stringify([sourceId, headingPath, sha256(text.trim())])
  ).slice(0, 20)}`;
}
```

`buildSourceManifest` 必须先接收已脱敏内容，再按 h1-h6 heading path 生成 section；无 heading 的文档生成单个 `["正文"]` section。

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/sourceManifest.test.ts tests/knowledgeV2.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/storage/sourceManifest.ts tests/sourceManifest.test.ts
git diff --cached
git commit -m "feat: define source evidence manifests"
```

## Task 6：增加知识质量与覆盖审计

**Files:**
- Create: `src/storage/qualityAudit.ts`
- Create: `src/cli/knowledge.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `tests/qualityAudit.test.ts`
- Test: `tests/configCli.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("reports thin knowledge, metadata inflation and orphan sources", async () => {
  const report = await auditKnowledgeQuality(root);
  expect(report.findings.map((item) => item.code)).toContain(
    "knowledge_body_too_thin"
  );
  expect(report.findings.map((item) => item.code)).toContain(
    "source_without_refined_knowledge"
  );
  expect(report.summary.claimEvidenceCoverage).toBeLessThan(1);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/qualityAudit.test.ts
```

Expected:

```text
FAIL  Cannot find module '../src/storage/qualityAudit.js'
```

- [ ] **Step 3: 实现审计**

输出：

```ts
export type KnowledgeQualityFinding = {
  code:
    | "knowledge_body_too_thin"
    | "metadata_frontmatter_dominates"
    | "too_many_aliases"
    | "too_many_scenarios"
    | "too_many_tags"
    | "supported_claim_without_evidence"
    | "source_without_refined_knowledge"
    | "missing_source_manifest"
    | "unknown_project_key";
  severity: "error" | "warning" | "info";
  documentId?: string;
  filePath?: string;
  sourceId?: string;
  message: string;
};
```

默认 policy：

```ts
const DEFAULT_QUALITY_POLICY = {
  minimumKnowledgeBodyChars: 600,
  maximumFrontmatterShare: 0.65,
  maximumAliases: 8,
  maximumScenarios: 6,
  maximumTags: 8
} as const;
```

`sourceCoverage` 统计 source manifest，不读取当前旧 `knowledge/source`。每个 source manifest 必须有 `refined|duplicate|obsolete|no_long_term_value|blocked` 处理状态。

CLI：

```text
agent-knowledge knowledge audit --root <dir> --fail-on error|warning|never
```

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/qualityAudit.test.ts tests/configCli.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/storage/qualityAudit.ts src/cli/knowledge.ts src/cli.ts src/index.ts tests/qualityAudit.test.ts tests/configCli.test.ts
git diff --cached
git commit -m "feat: audit v2 knowledge quality"
```

## Task 7：实现 Context Packet 2.0 与显式展开

**Files:**
- Create: `src/retrieval/expansion.ts`
- Modify: `src/core/types.ts`
- Modify: `src/retrieval/contextPacket.ts`
- Modify: `src/retrieval/query.ts`
- Modify: `src/cli/knowledge.ts`
- Test: `tests/progressiveContext.test.ts`
- Test: `tests/query.test.ts`
- Test: `tests/hookOutput.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("injects synopsis and exposes explicit expansion", async () => {
  const query = queryMemoriesWithDebug(root, request);
  const packet = buildContextPacket({ request, ranked: query.ranked });
  expect(packet.context_version).toBe("2.0");
  expect(packet.claims[0]?.content.length).toBeLessThanOrEqual(500);
  expect(packet.evidence_handles).toHaveLength(1);
  expect(packet.expansion.commands[0]).toContain(
    "knowledge show k_account_identity_boundary --layer knowledge"
  );

  const expanded = await expandKnowledge(root, {
    id: "k_account_identity_boundary",
    layer: "knowledge"
  });
  expect(expanded.content).toContain("为什么不能默认相等");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/progressiveContext.test.ts tests/query.test.ts
```

Expected:

```text
FAIL  expected context_version to be "2.0"
```

- [ ] **Step 3: 定义 Packet**

```ts
export type ContextPacket = {
  context_version: "2.0";
  scene: {
    task_type: string;
    domains: string[];
    scenarios: string[];
    project_keys: string[];
  };
  route: ContextPacketItem[];
  claims: ContextPacketItem[];
  procedures: ContextPacketItem[];
  principles: ContextPacketItem[];
  episodes: ContextPacketItem[];
  evidence_handles: Array<{
    claimId: string;
    sourceId: string;
    sectionId: string;
  }>;
  warnings: Array<{ type: string; message: string; source?: string }>;
  sources: string[];
  expansion: { available: boolean; commands: string[] };
};
```

默认注入 `frontmatter.synopsis`，不得用 `extractSummary(body)` 替代。`evidence_handles` 只包含引用，不自动读原文。

- [ ] **Step 4: 实现展开命令**

```text
agent-knowledge knowledge show <id> --layer synopsis|knowledge
agent-knowledge knowledge evidence <claim-id>
```

`show` 只读取 active Markdown。`evidence` 只返回 anchor；完整 Vault 读取由后续计划实现。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
pnpm vitest run tests/progressiveContext.test.ts tests/query.test.ts tests/hookOutput.test.ts tests/eval.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  4 passed
```

Commit:

```bash
git add src/retrieval/expansion.ts src/core/types.ts src/retrieval/contextPacket.ts src/retrieval/query.ts src/cli/knowledge.ts tests/progressiveContext.test.ts tests/query.test.ts tests/hookOutput.test.ts
git diff --cached
git commit -m "feat: add progressive knowledge context"
```

## Task 8：实现独立 private Git 数据工作区

**Files:**
- Create: `src/storage/gitWorkspace.ts`
- Create: `src/cli/workspace.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `tests/gitWorkspace.test.ts`
- Test: `tests/workspace.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("initializes a private-data-safe repository layout", async () => {
  const result = await initializeKnowledgeGitWorkspace(root);
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");
  expect(result.initialized).toBe(true);
  expect(gitignore).toContain(".memory/");
  expect(gitignore).toContain(".vault/");
  expect(gitignore).not.toContain("knowledge/");
});

it("refuses initialization inside an unrelated code repository", async () => {
  await expect(
    initializeKnowledgeGitWorkspace(nested)
  ).rejects.toThrow(/separate directory/i);
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/gitWorkspace.test.ts
```

Expected:

```text
FAIL  Cannot find module '../src/storage/gitWorkspace.js'
```

- [ ] **Step 3: 实现安全初始化**

```ts
const DATA_GITIGNORE = `.memory/
.vault/
local_exports/
*.tmp
.DS_Store
.agent-knowledge.local.json
`;
```

`initializeKnowledgeGitWorkspace`：

- 拒绝在其他 Git repo 子目录初始化。
- 调用 `initKnowledgeWorkspace`。
- 写 `.gitignore` 和 `SECURITY.md`。
- 执行 `git init --initial-branch=main`。
- 不添加 remote。
- 不自动 commit。
- 不删除当前代码仓库中的 `knowledge/`。

CLI：

```text
agent-knowledge workspace git-init --root <separate-dir>
agent-knowledge workspace git-status --root <dir>
```

- [ ] **Step 4: 运行测试**

Run:

```bash
pnpm vitest run tests/gitWorkspace.test.ts tests/workspace.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  2 passed
```

- [ ] **Step 5: 提交**

```bash
git add src/storage/gitWorkspace.ts src/cli/workspace.ts src/cli.ts src/index.ts tests/gitWorkspace.test.ts tests/workspace.test.ts
git diff --cached
git commit -m "feat: initialize knowledge data repositories"
```

## Task 9：更新 candidate、Organizer 与 Agent 模板

**Files:**
- Modify: `src/memory/governance.ts`
- Modify: `src/memory/inbox.ts`
- Modify: `src/memory/organizer.ts`
- Modify: `templates/trae/agents/agent-knowledge-reader.md`
- Modify: `templates/trae/agents/agent-knowledge-writer.md`
- Modify: `templates/claude-code/agents/agent-knowledge-reader.md`
- Modify: `templates/claude-code/agents/agent-knowledge-writer.md`
- Modify: `templates/trae/plugin/agents/agent-knowledge-reader.md`
- Modify: `templates/trae/plugin/agents/agent-knowledge-writer.md`
- Modify: `.trae/skills/knowledge-organizer/SKILL.md`
- Modify: `templates/trae/plugin/skills/knowledge-organizer/SKILL.md`
- Test: `tests/inbox.test.ts`
- Test: `tests/organizer.test.ts`
- Test: `tests/templates.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
it("writes substantive V2 candidates", async () => {
  const result = await writeCandidateMemory(root, {
    title: "账号组排查边界",
    kind: "procedural",
    layer: "knowledge",
    synopsis: "排查登录态时先确认账号组，再检查 UID 和绑定关系。",
    explanation: [
      "## 背景",
      "",
      "商业化 UID 和抖音 UID 属于不同账号组。",
      "",
      "## 步骤",
      "",
      "1. 确认当前域名和 AppID。",
      "2. 确认 agID。",
      "3. 检查 OAuth 绑定。",
      "",
      "## 失败边界",
      "",
      "不能只凭页面已登录判断两类 UID 相等。"
    ].join("\n"),
    domain: "bytedance/business/account",
    aliases: [],
    related_domains: [],
    scenarios: [
      { id: "support/account-login", role: "primary", weight: 0.95 }
    ],
    tags: [],
    claims: [
      {
        id: "claim_account_group_first",
        statement: "登录态排查必须先区分账号组。",
        status: "supported",
        confidence: 0.9,
        evidence: [
          {
            source_id: "src_account_guide",
            section_id: "sec_login",
            quote_hash:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          }
        ]
      }
    ],
    confidence: 0.9,
    source_authority: "documented",
    source: ["source:src_account_guide"],
    project_keys: ["github.com/lejunyang/agent-knowledge"]
  });
  const markdown = await readFile(result.filePath, "utf8");
  expect(markdown).toContain("schema_version: 2");
  expect(markdown).toContain("## 失败边界");
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
pnpm vitest run tests/inbox.test.ts tests/organizer.test.ts tests/templates.test.ts
```

Expected:

```text
FAIL  V2 candidate fields are unsupported
```

- [ ] **Step 3: 更新写入治理**

硬门禁：

- `layer=knowledge` 且正文少于 300 字只能写 `_inbox` 并返回 `knowledge_body_too_thin`。
- active documented/verified knowledge 的 supported claim 必须有 evidence。
- alias 最多 8 个推荐值，超过需要 evidence/query history。
- scenario 最多 2 个 primary。
- customer/automated session 仍只能 proposed。
- `project_keys` 只能使用 registry canonical key 或 alias 解析结果。

- [ ] **Step 4: 更新模板**

Writer 输出必须区分：

```json
{
  "synopsis": "只负责路由和首轮上下文。",
  "explanation": "背景、事实或步骤、条件、例外、失败策略和验证。",
  "claims": [],
  "aliases": [],
  "scenarios": [],
  "tags": []
}
```

Reader 流程：

```text
query -> consume synopsis -> knowledge show -> knowledge evidence
```

Organizer 明确：

- 不读取或转换 V1 knowledge。
- 重建必须从原始 source/evidence 开始。
- 不允许用大量 alias/tag 补偿正文不足。

同步更新 TRAE、Claude Code 和 plugin bundle。Hook 命令未变化，无需修改 hooks JSON。

- [ ] **Step 5: 运行测试并提交**

Run:

```bash
pnpm vitest run tests/inbox.test.ts tests/organizer.test.ts tests/templates.test.ts tests/integrationCli.test.ts
pnpm typecheck
```

Expected:

```text
Test Files  4 passed
```

Commit:

```bash
git add src/memory/governance.ts src/memory/inbox.ts src/memory/organizer.ts templates/trae/agents templates/claude-code/agents templates/trae/plugin/agents .trae/skills/knowledge-organizer/SKILL.md templates/trae/plugin/skills/knowledge-organizer/SKILL.md tests/inbox.test.ts tests/organizer.test.ts tests/templates.test.ts
git diff --cached
git commit -m "feat: require substantive v2 candidates"
```

## Task 10：增加 V2 中文业务评测并更新文档

**Files:**
- Create: `eval/cases/layered-knowledge.yaml`
- Modify: `tests/eval.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/retrieval.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `docs/guides/integrations.md`
- Modify: `templates/trae/README.md`

- [ ] **Step 1: 创建 layered eval**

```yaml
version: 1
cases:
  - id: account-group-synopsis
    task: 商业化 UID 和抖音 UID 是同一个 ID 吗
    expected:
      - k_account_identity_boundary
    forbidden:
      - k_generic_internal_document
    packet:
      must_include:
        - k_account_identity_boundary
      must_not_include_evidence_body: true
  - id: qualification-reuse-procedure
    task: GetCanReuseAccountForDouyinMerchant 为什么过滤 10246 资质
    expected:
      - k_qualification_reuse_filter
  - id: unrelated-abstention
    task: 如何在 Blender 中制作水面材质
    abstain: true
    forbidden:
      - k_account_identity_boundary
      - k_qualification_reuse_filter
```

- [ ] **Step 2: 固定门禁**

```ts
expect(report.metrics.forbiddenInjectionRate).toBe(0);
expect(report.metrics.abstentionFailureRate).toBe(0);
expect(report.metrics.evidenceBodyAutoInjectionRate).toBe(0);
expect(report.metrics.claimEvidenceCoverage).toBe(1);
```

- [ ] **Step 3: 更新文档**

README 和 guides 明确：

- V2 是 breaking change。
- 旧知识不会被读取或迁移。
- 正式使用必须创建独立 private data repo。
- project scope 使用规范 Git remote。
- 普通 query 只注入 synopsis。
- 当前完整 transcript Vault 尚未交付。
- 当前业务语料应等后续 Vault/Connector/Distillation 完成后从原始飞书材料重建。

流程联动审视：

- `docs/guides/synchronization.md`：说明现有 WebDAV/S3 只同步正式 Markdown，不等同于 Git remote 或 Vault。
- `templates/trae/hooks*.json`：命令不变，无需修改。
- `templates/claude-code/settings*.json`：命令不变，无需修改。
- integration merge/uninstall：资源名不变，现有测试必须通过。
- maintenance Skill：补充 quality audit，不得建议迁移 V1。

- [ ] **Step 4: 运行全量验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
node dist/cli.js eval \
  --root tests/fixtures/layered-knowledge \
  --input eval/cases/layered-knowledge.yaml
```

Expected:

```text
All tests passed
forbiddenInjectionRate: 0
abstentionFailureRate: 0
evidenceBodyAutoInjectionRate: 0
claimEvidenceCoverage: 1
```

- [ ] **Step 5: 提交**

```bash
git add eval/cases/layered-knowledge.yaml tests/eval.test.ts README.md AGENTS.md docs/guides templates/trae/README.md
git diff --cached
git commit -m "docs: document breaking v2 knowledge foundation"
```

## Task 11：空库 smoke 和阶段验收

**Files:**
- No source changes expected
- Smoke workspace: `/private/tmp/agent-knowledge-v2-smoke`

- [ ] **Step 1: 初始化空数据仓库**

Run:

```bash
rm -rf /private/tmp/agent-knowledge-v2-smoke
node dist/cli.js workspace git-init \
  --root /private/tmp/agent-knowledge-v2-smoke
```

Expected:

```text
initialized: true
trackedKnowledgeFiles: 0
```

- [ ] **Step 2: 验证 V1 被拒绝**

Run:

```bash
node dist/cli.js index \
  --root tests/fixtures/basic-knowledge-v1-rejected
```

Expected:

```text
Unsupported knowledge schema; expected schema_version: 2
```

- [ ] **Step 3: 验证 V2**

Run:

```bash
node dist/cli.js index \
  --root tests/fixtures/layered-knowledge
node dist/cli.js knowledge audit \
  --root tests/fixtures/layered-knowledge \
  --fail-on error
node dist/cli.js query \
  --root tests/fixtures/layered-knowledge \
  --project github.com/lejunyang/agent-knowledge \
  --task "商业化 UID 和抖音 UID 是同一个 ID 吗" \
  --debug
```

Expected:

```text
schema_version: 2 documents indexed
claimEvidenceCoverage: 1
context_version: 2.0
projectKey: github.com/lejunyang/agent-knowledge
```

- [ ] **Step 4: 检查提交与工作区**

Run:

```bash
git status --short
git diff --check
git log -11 --format='%h %s%n%b' | rg -n \
  'Co-authored-by: TRAE CLI <noreply@bytedance.com>'
```

Expected:

```text
No uncommitted source changes
Every implementation commit contains the trailer exactly once
```

## 自检结果

### 需求覆盖

- 正文过薄：Task 6、Task 9。
- 三层知识：Task 1、Task 5、Task 7。
- tag/alias/scenario 评分：Task 1、Task 4。
- Git remote 作为 project key：Task 3。
- Git 知识库：Task 8。
- 不迁移现有知识：Task 2、Task 10、Task 11。
- 后续从原始材料重建：被明确拆到 Evidence Vault/Connector/Distillation 后续计划。

### 一致性

- 只有 V2 Markdown 能进入 runtime。
- 不存在 legacy parser 或 migrate command。
- project hash 不属于公共 schema。
- 普通 query 不自动加载 evidence。
- Git 初始化不添加 remote、不自动 commit、不写 Vault。
- 当前旧知识库不原地修改。
