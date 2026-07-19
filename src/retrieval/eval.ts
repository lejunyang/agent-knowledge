/**
 * eval 模块提供检索质量回归测试。
 *
 * 每个 eval case 除了定义“应该召回”和“不应该召回”的知识 ID，还可以表达：
 * - 期望最高名次和 graded relevance。
 * - 无答案时应该 abstain。
 * - 语言和领域切片。
 *
 * 评测复用真实 query/context packet pipeline，既看召回质量，也记录注入成本和延迟。
 */
import { performance } from "node:perf_hooks";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { z } from "zod";
import {
  KnowledgeDocumentSchema,
  MemoryQueryRequestSchema
} from "../core/schema.js";
import { serializeKnowledgeMarkdown } from "../storage/markdown.js";
import { resolveWorkspacePath } from "../core/paths.js";
import { buildContextPacket, estimateContextPacketTokens } from "./contextPacket.js";
import {
  queryMemories,
  queryMemoriesHybridWithDebug,
  queryMemoriesRerankedWithDebug
} from "./query.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { BatchCandidateReranker } from "./reranker.js";

export type EvalCase = {
  task: string;
  domains: string[];
  scenarios: string[];
  project_ids?: string[];
  expected_memories: string[];
  expected_ranks?: Record<string, number>;
  relevance_grades?: Record<string, number>;
  forbidden_memories: string[];
  abstain?: boolean;
  language?: string;
  domain?: string;
  now?: string;
};

export type EvalSuite = {
  cases: EvalCase[];
};

export type EvalResult = {
  passed: boolean;
  matchedIds: string[];
  missingExpected: string[];
  presentForbidden: string[];
  rankById: Record<string, number>;
  rankViolations: Array<{ id: string; expectedAtMost: number; actual: number | null }>;
  recallAt: Record<1 | 3 | 5, number>;
  reciprocalRank: number;
  ndcg: number;
  falseInjection: boolean;
  abstained: boolean;
  latencyMs: number;
  packetTokens: number;
  language: string;
  domain: string;
};

export type EvalSuiteResult = {
  total: number;
  passed: number;
  failed: number;
  metrics: {
    recallAt: Record<1 | 3 | 5, number>;
    mrr: number;
    ndcg: number;
    falseInjectionRate: number;
    abstentionPrecision: number;
    averageLatencyMs: number;
    averagePacketTokens: number;
  };
  results: EvalResult[];
};

export type EvalPipelineOptions =
  | { pipeline?: "lexical" }
  | {
      pipeline: "hybrid";
      embeddingProvider: EmbeddingProvider;
      embeddingTopK?: number;
    }
  | {
      pipeline: "reranked";
      embeddingProvider: EmbeddingProvider;
      batchReranker: BatchCandidateReranker;
      embeddingTopK?: number;
      candidateLimit?: number;
      resultLimit?: number;
      minScore?: number;
    };

const EvalCaseSchema = z.object({
  task: z.string().min(1),
  domains: z.array(z.string()).default([]),
  scenarios: z.array(z.string()).default([]),
  project_ids: z.array(z.string().min(1)).default([]),
  expected_memories: z.array(z.string()).default([]),
  expected_ranks: z.record(z.number().int().positive()).optional(),
  relevance_grades: z.record(z.number().int().min(0).max(3)).optional(),
  forbidden_memories: z.array(z.string()).default([]),
  abstain: z.boolean().default(false),
  language: z.string().min(1).default("unknown"),
  domain: z.string().min(1).optional(),
  now: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

const EvalSuiteSchema = z.object({
  cases: z.array(EvalCaseSchema).min(1)
});

const EvalFixtureDocumentSchema = z.object({
  id: z.string().regex(/^k_[a-zA-Z0-9_]+$/),
  title: z.string().min(1),
  type: z.enum(["profile", "semantic", "episodic", "procedural"]),
  domain: z.string().min(1),
  scenarios: z.array(z.string().min(1)).min(1),
  aliases: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  project_ids: z.array(z.string().min(1)).default([]),
  body: z.string().min(1),
  status: z.enum(["active", "deprecated"]).default("active"),
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default("2026-01-01"),
  valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null)
});

const EvalCorpusSchema = z.object({
  documents: z.array(EvalFixtureDocumentSchema).min(1),
  cases: z.array(EvalCaseSchema).min(1)
});

export type EvalCorpus = z.output<typeof EvalCorpusSchema>;

/** 把 YAML parser 产生的 Date 递归转换为 schema 使用的日期字符串。 */
function normalizeYamlDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (Array.isArray(value)) {
    return value.map(normalizeYamlDates);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalizeYamlDates(item)])
    );
  }
  return value;
}

/** 读取并校验带文档 fixture 的完整评测语料，同时规范 YAML 日期对象。 */
export async function loadEvalCorpus(filePath: string): Promise<EvalCorpus> {
  return EvalCorpusSchema.parse(
    normalizeYamlDates(yaml.load(await readFile(filePath, "utf8")))
  );
}

/** 把脱敏评测 fixture 写成真实 Markdown，使评测复用生产索引和过滤链路。 */
export async function materializeEvalCorpus(rootDir: string, corpus: EvalCorpus): Promise<void> {
  for (const item of corpus.documents) {
    const relativePath = path.posix.join(
      "knowledge",
      item.type,
      ...item.domain.split("/"),
      `${item.id}.md`
    );
    const absolutePath = resolveWorkspacePath(rootDir, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    const document = KnowledgeDocumentSchema.parse({
      filePath: relativePath,
      frontmatter: {
        id: item.id,
        type: item.type,
        title: item.title,
        aliases: item.aliases,
        domain: item.domain,
        related_domains: [],
        scenario: item.scenarios,
        tags: item.tags,
        status: item.status,
        confidence: 0.9,
        source_authority: "documented",
        source: ["eval:retrieval-complete"],
        related_knowledge: [],
        supersedes: [],
        conflicts_with: [],
        visibility: "project",
        sensitivity: "internal",
        project_ids: item.project_ids,
        capture_mode: "direct_material",
        actor_type: "owner",
        corroboration_count: 1,
        episodes: [],
        created_at: item.valid_from,
        updated_at: item.valid_from,
        valid_from: item.valid_from,
        valid_until: item.valid_until
      },
      body: `# ${item.title}\n\n${item.body}\n`
    });
    await writeFile(absolutePath, serializeKnowledgeMarkdown(document), "utf8");
  }
}

/**
 * 从 YAML 读取单个评估用例。
 *
 * 保留这个入口是为了兼容既有 API；新的多 case 文件使用 loadEvalSuite。
 */
export async function loadEvalCase(filePath: string): Promise<EvalCase> {
  return EvalCaseSchema.parse(yaml.load(await readFile(filePath, "utf8")));
}

/**
 * 从 YAML 读取评估套件。若文件仍是旧的单 case 形状，会自动包装为一个 case。
 */
export async function loadEvalSuite(filePath: string): Promise<EvalSuite> {
  const parsed = yaml.load(await readFile(filePath, "utf8"));
  const suite = EvalSuiteSchema.safeParse(parsed);
  if (suite.success) {
    return suite.data;
  }
  return { cases: [EvalCaseSchema.parse(parsed)] };
}

/** 计算 expected memory 在 top-K 中的覆盖比例。 */
function recallAtK(matchedIds: string[], expectedIds: string[], k: 1 | 3 | 5): number {
  if (expectedIds.length === 0) {
    return 1;
  }
  const topIds = new Set(matchedIds.slice(0, k));
  return expectedIds.filter((id) => topIds.has(id)).length / expectedIds.length;
}

/** 计算首个相关结果的 reciprocal rank；未命中返回 0。 */
function reciprocalRank(matchedIds: string[], relevantIds: Set<string>): number {
  const index = matchedIds.findIndex((id) => relevantIds.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/** 按位置折损 relevance grade，供 nDCG 计算。 */
function discountedCumulativeGain(grades: number[]): number {
  return grades.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0);
}

/** 用理想排序归一化 DCG，评估多级相关性的排序质量。 */
function normalizedDiscountedCumulativeGain(matchedIds: string[], grades: Record<string, number>, k = 5): number {
  const actual = matchedIds.slice(0, k).map((id) => grades[id] ?? 0);
  const ideal = Object.values(grades)
    .sort((left, right) => right - left)
    .slice(0, k);
  const idealScore = discountedCumulativeGain(ideal);
  return idealScore === 0 ? 1 : discountedCumulativeGain(actual) / idealScore;
}

/**
 * 执行单个评估用例。
 *
 * 这里复用真实 query pipeline，而不是 mock 检索结果，确保评估覆盖实际索引和过滤逻辑。
 */
export async function runEvalCase(
  rootDir: string,
  rawEvalCase: EvalCase,
  pipelineOptions: EvalPipelineOptions = {}
): Promise<EvalResult> {
  const evalCase = EvalCaseSchema.parse(rawEvalCase);
  const startedAt = performance.now();
  const now = evalCase.now ?? new Date().toISOString().slice(0, 10);
  const request = MemoryQueryRequestSchema.parse({
    task: evalCase.task,
    agentRole: "main",
    domains: evalCase.domains,
    scenarios: evalCase.scenarios,
    paths: [],
    maxTokens: 4500,
    includeTypes: ["profile", "semantic", "episodic", "procedural"],
    now,
    visibilityScopes: ["private", "project", "team"],
    sensitivityClearance: "internal",
    projectIds: evalCase.project_ids
  });
  let ranked;
  if (pipelineOptions.pipeline === "hybrid") {
    ranked = (
      await queryMemoriesHybridWithDebug(rootDir, request, {
        embeddingProvider: pipelineOptions.embeddingProvider,
        embeddingTopK: pipelineOptions.embeddingTopK
      })
    ).ranked;
  } else if (pipelineOptions.pipeline === "reranked") {
    const baseResult = await queryMemoriesHybridWithDebug(rootDir, request, {
      embeddingProvider: pipelineOptions.embeddingProvider,
      embeddingTopK: pipelineOptions.embeddingTopK
    });
    ranked = (
      await queryMemoriesRerankedWithDebug(rootDir, request, {
        baseResult,
        batchReranker: pipelineOptions.batchReranker,
        candidateLimit: pipelineOptions.candidateLimit,
        resultLimit: pipelineOptions.resultLimit,
        minScore: pipelineOptions.minScore
      })
    ).ranked;
  } else {
    ranked = queryMemories(rootDir, request);
  }
  const packet = buildContextPacket({ request, ranked });
  const matchedIds = ranked.map((item) => item.document.frontmatter.id);
  const missingExpected = evalCase.expected_memories.filter((id) => !matchedIds.includes(id));
  const presentForbidden = evalCase.forbidden_memories.filter((id) => matchedIds.includes(id));
  const rankById = Object.fromEntries(matchedIds.map((id, index) => [id, index + 1]));
  const rankViolations = Object.entries(evalCase.expected_ranks ?? {})
    .map(([id, expectedAtMost]) => ({
      id,
      expectedAtMost,
      actual: rankById[id] ?? null
    }))
    .filter((item) => item.actual === null || item.actual > item.expectedAtMost);
  const grades =
    evalCase.relevance_grades ??
    Object.fromEntries(evalCase.expected_memories.map((id) => [id, 1]));
  const relevantIds = new Set([
    ...evalCase.expected_memories,
    ...Object.entries(grades)
      .filter(([, grade]) => grade > 0)
      .map(([id]) => id)
  ]);
  const abstained = matchedIds.length === 0;
  const falseInjection = presentForbidden.length > 0 || Boolean(evalCase.abstain && !abstained);
  const expectedAbstentionSatisfied = evalCase.abstain ? abstained : true;

  return {
    passed:
      missingExpected.length === 0 &&
      presentForbidden.length === 0 &&
      rankViolations.length === 0 &&
      expectedAbstentionSatisfied,
    matchedIds,
    missingExpected,
    presentForbidden,
    rankById,
    rankViolations,
    recallAt: {
      1: recallAtK(matchedIds, evalCase.expected_memories, 1),
      3: recallAtK(matchedIds, evalCase.expected_memories, 3),
      5: recallAtK(matchedIds, evalCase.expected_memories, 5)
    },
    reciprocalRank: reciprocalRank(matchedIds, relevantIds),
    ndcg: normalizedDiscountedCumulativeGain(matchedIds, grades),
    falseInjection,
    abstained,
    latencyMs: performance.now() - startedAt,
    packetTokens: estimateContextPacketTokens(packet),
    language: evalCase.language,
    domain: evalCase.domain ?? evalCase.domains[0] ?? "unknown"
  };
}

/** 对空集合返回 0 的稳定平均值 helper。 */
function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 顺序运行评测套件并汇总 rank、误注入、abstention、延迟和 token 指标。
 *
 * 顺序执行避免并发模型/SQLite 竞争污染延迟和确定性结果。
 */
export async function runEvalSuite(
  rootDir: string,
  suite: EvalSuite,
  pipelineOptions: EvalPipelineOptions = {}
): Promise<EvalSuiteResult> {
  const validated = EvalSuiteSchema.parse(suite);
  const results: EvalResult[] = [];
  for (const evalCase of validated.cases) {
    results.push(await runEvalCase(rootDir, evalCase, pipelineOptions));
  }

  const answerable = validated.cases
    .map((evalCase, index) => ({ evalCase, result: results[index]! }))
    .filter(({ evalCase }) => evalCase.expected_memories.length > 0)
    .map(({ result }) => result);
  const evaluated = validated.cases.map((evalCase, index) => ({ evalCase, result: results[index]! }));
  const expectedAbstentions = evaluated.filter(({ evalCase }) => evalCase.abstain);
  const predictedAbstentions = evaluated.filter(({ result }) => result.abstained);

  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    failed: results.filter((result) => !result.passed).length,
    metrics: {
      recallAt: {
        1: average(answerable.map((result) => result.recallAt[1])),
        3: average(answerable.map((result) => result.recallAt[3])),
        5: average(answerable.map((result) => result.recallAt[5]))
      },
      mrr: average(answerable.map((result) => result.reciprocalRank)),
      ndcg: average(answerable.map((result) => result.ndcg)),
      falseInjectionRate: average(results.map((result) => Number(result.falseInjection))),
      abstentionPrecision:
        predictedAbstentions.length === 0
          ? expectedAbstentions.length === 0
            ? 1
            : 0
          : predictedAbstentions.filter(({ evalCase }) => evalCase.abstain).length / predictedAbstentions.length,
      averageLatencyMs: average(results.map((result) => result.latencyMs)),
      averagePacketTokens: average(results.map((result) => result.packetTokens))
    },
    results
  };
}
