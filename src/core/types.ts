/**
 * 全局类型定义是项目内部共享的领域语言。
 *
 * 知识事实类型由 `knowledgeV2.ts` 的 Zod schema 单点生成；这里仅补充 query、排序和
 * context packet 等运行时协议，避免 TypeScript 类型与外部输入校验再次分叉。
 */
export type {
  ActorType,
  CaptureMode,
  EpisodeProvenance,
  EvidenceAnchor,
  KnowledgeClaim,
  KnowledgeDocument,
  KnowledgeFrontmatter,
  KnowledgeKind,
  KnowledgeLayer,
  KnowledgeRelation,
  MemoryStatus,
  RelatedKnowledge,
  Sensitivity,
  SourceAuthority,
  Visibility,
  WeightedAlias,
  WeightedScenario,
  WeightedTag
} from "./knowledgeV2.js";

import type {
  KnowledgeDocument,
  KnowledgeKind,
  Sensitivity,
  Visibility
} from "./knowledgeV2.js";

/**
 * 内部模块暂用该别名表达知识 kind；它不代表旧 Markdown `type` 字段兼容。
 */
export type MemoryType = KnowledgeKind;

/**
 * 查询请求是其他 agent 调用本工具时的核心输入。
 *
 * `domains` 和 `scenarios` 参与硬过滤，避免单靠语义相似度召回业务无关知识。
 */
export type MemoryQueryRequest = {
  task: string;
  agentRole: "main" | "reviewer" | "writer" | "planner" | string;
  paths: string[];
  domains: string[];
  scenarios: string[];
  maxTokens: number;
  includeTypes: Array<
    "profile" | "semantic" | "episodic" | "procedural" | "principle"
  >;
  now: string;
  visibilityScopes: Visibility[];
  sensitivityClearance: Sensitivity;
  projectKeys: string[];
};

/**
 * 注入给主 agent 的最小上下文单元。
 *
 * 这里只保留 summary 级内容，不把完整 Markdown 原文塞给 agent，避免 token 膨胀。
 */
export type ContextPacketItem = {
  id: string;
  title: string;
  content: string;
  confidence: number;
  projectKeys: string[];
  source: string[];
};

export type ContextEvidenceHandle = {
  knowledgeId: string;
  claimId: string;
  sourceId: string;
  sectionId: string;
  quoteHash: string;
};

/**
 * ContextPacket 是本项目对外最重要的输出协议。
 *
 * 默认只注入 synopsis，并提供显式 knowledge/evidence 展开命令。完整正文和 evidence
 * 不能因为检索命中就自动进入 Hook 上下文。
 */
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
  evidence_handles: ContextEvidenceHandle[];
  warnings: Array<{ type: string; message: string; source?: string }>;
  sources: string[];
  expansion: {
    available: boolean;
    commands: string[];
  };
};

/**
 * 排序后的检索结果保留分项分数，方便后续 debug、评估和调参。
 */
export type RankedMemory = {
  document: KnowledgeDocument;
  lexicalScore: number;
  embeddingScore: number;
  metadataScore: number;
  scenarioScore: number;
  confidenceScore: number;
  sourceAuthorityScore: number;
  relationScore: number;
  rrfScore: number;
  queryCoverageScore: number;
  matchedTechnicalTerms: number;
  finalScore: number;
};
