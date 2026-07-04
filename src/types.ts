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
