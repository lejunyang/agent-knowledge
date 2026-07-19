/**
 * 全局类型定义是本项目的领域语言。
 *
 * 这些类型刻意保持为纯 TypeScript type，不包含运行时逻辑：
 * - 运行时校验放在 `schema.ts`，避免类型和校验规则分散。
 * - 业务模块只依赖这里的稳定契约，降低模块之间的耦合。
 * - 字段名使用 Markdown frontmatter 的蛇形命名，方便人类直接阅读文件。
 */
export type MemoryType = "profile" | "semantic" | "episodic" | "procedural" | "source";
export type MemoryStatus = "proposed" | "active" | "deprecated" | "rejected";
export type SourceAuthority = "user_confirmed" | "model_inferred" | "documented" | "verified_task";
export type Visibility = "private" | "project" | "team";
export type Sensitivity = "public" | "internal" | "confidential" | "secret";
export type CaptureMode = "explicit_remember" | "verified_task" | "automated_session" | "direct_material";
export type ActorType = "owner" | "teammate" | "customer" | "agent";

export type KnowledgeRelation =
  | "depends_on"
  | "refines"
  | "supports"
  | "conflicts_with"
  | "supersedes"
  | "often_used_with";

/**
 * 精确知识关系用于一跳扩展。
 *
 * 这里不建完整图谱，只表达 MVP 必需的轻量关系。真正的 temporal graph
 * 可以在未来基于这些字段迁移，而不需要改变 Markdown 事实源。
 */
export type RelatedKnowledge = {
  id: string;
  relation: KnowledgeRelation;
  reason: string;
};

/**
 * 一条 Markdown 知识的 frontmatter。
 *
 * 注意：`related_domains` 是粗粒度领域扩展，`related_knowledge` 是精确条目关系。
 * 二者分开能避免把“领域相关”和“事实依赖”混为一谈。
 */
export type KnowledgeFrontmatter = {
  id: string;
  type: MemoryType;
  title: string;
  aliases: string[];
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
  project_ids: string[];
  capture_mode: CaptureMode;
  actor_type: ActorType;
  corroboration_count: number;
  created_at: string;
  updated_at: string;
  valid_from: string;
  valid_until: string | null;
};

/**
 * Markdown 文件解析后的统一表示。
 *
 * `filePath` 使用 workspace 内相对路径，方便索引可重建，也避免把本机绝对路径写入知识库。
 */
export type KnowledgeDocument = {
  filePath: string;
  frontmatter: KnowledgeFrontmatter;
  body: string;
};

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
  includeTypes: Array<"profile" | "semantic" | "episodic" | "procedural">;
  now: string;
  visibilityScopes: Visibility[];
  sensitivityClearance: Sensitivity;
  projectIds: string[];
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
  source: string[];
};

/**
 * ContextPacket 是本项目对外最重要的输出协议。
 *
 * 调用方应按区域注入：稳定规则、相关事实、流程、案例、风险和来源。
 */
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

/**
 * 排序后的检索结果保留分项分数，方便后续 debug、评估和调参。
 */
export type RankedMemory = {
  document: KnowledgeDocument;
  lexicalScore: number;
  embeddingScore: number;
  scenarioScore: number;
  confidenceScore: number;
  sourceAuthorityScore: number;
  relationScore: number;
  rrfScore: number;
  finalScore: number;
};
