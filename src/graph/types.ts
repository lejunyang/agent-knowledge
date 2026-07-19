/** Rebuildable knowledge-graph index types. Markdown and proposal files remain the fact sources. */
export type GraphNodeType =
  | "knowledge"
  | "domain"
  | "scenario"
  | "project"
  | "episode"
  | "source"
  | "proposal";

export type GraphEdgeType =
  | "depends_on"
  | "refines"
  | "supports"
  | "often_used_with"
  | "supersedes"
  | "conflicts_with"
  | "belongs_to_domain"
  | "used_in_scenario"
  | "belongs_to_project"
  | "observed_in_episode"
  | "sourced_from"
  | "proposes_change_to";

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  label: string;
  metadata: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  type: GraphEdgeType;
  metadata: Record<string, unknown>;
};

export type KnowledgeGraph = {
  version: 1;
  generatedAt: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};
