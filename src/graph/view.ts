/**
 * 图视图投影把完整知识图转换为适合人类浏览的默认子图。
 *
 * `.memory/graph.json` 仍保留全部节点和边；这里只计算默认可见集合、证据集合和筛选项，
 * 避免 HTML renderer 重复理解 knowledge/source 语义，也避免为了可视化修改图索引。
 */
import type {
  GraphNode,
  GraphNodeType,
  KnowledgeGraph
} from "./types.js";

export type KnowledgeGraphView = {
  graph: KnowledgeGraph;
  defaultNodeIds: string[];
  evidenceNodeIds: string[];
  sourceMemoryNodeIds: string[];
  summary: {
    totalNodes: number;
    totalEdges: number;
    refinedKnowledge: number;
    sourceMemories: number;
    defaultNodes: number;
  };
  filters: {
    nodeTypes: GraphNodeType[];
    statuses: string[];
    domains: string[];
    projects: string[];
  };
};

const EVIDENCE_NEIGHBOR_TYPES = new Set<GraphNodeType>([
  "domain",
  "scenario",
  "project",
  "source",
  "episode",
  "proposal"
]);

/** 判断节点是不是完整原文对应的 source knowledge。 */
function isSourceMemory(node: GraphNode): boolean {
  return (
    node.type === "knowledge" &&
    node.metadata.memoryType === "source"
  );
}

/** 判断节点是不是默认可浏览的 active 精炼知识。 */
function isRefinedKnowledge(node: GraphNode): boolean {
  return (
    node.type === "knowledge" &&
    !isSourceMemory(node) &&
    node.metadata.status === "active"
  );
}

/** 从 metadata 数组字段提取非空字符串。 */
function metadataStrings(node: GraphNode, field: string): string[] {
  const value = node.metadata[field];
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && item.length > 0
      )
    : [];
}

/** 返回排序去重后的字符串数组。 */
function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right)
  );
}

/**
 * 计算默认精炼知识视图和按需证据视图。
 *
 * 默认视图只加入精炼知识；证据视图再加入与精炼知识直接相连的 domain/scenario/project、
 * source/episode/proposal。source memory 本身只在“全部节点”模式显示，避免 656 份原文淹没图。
 */
export function buildKnowledgeGraphView(
  graph: KnowledgeGraph
): KnowledgeGraphView {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const refinedIds = new Set(
    graph.nodes.filter(isRefinedKnowledge).map((node) => node.id)
  );
  const sourceMemoryNodeIds = graph.nodes
    .filter(isSourceMemory)
    .map((node) => node.id)
    .sort((left, right) => left.localeCompare(right));
  const defaultIds = new Set(refinedIds);
  const evidenceIds = new Set(refinedIds);

  for (const edge of graph.edges) {
    const sourceIsRefined = refinedIds.has(edge.source);
    const targetIsRefined = refinedIds.has(edge.target);
    if (!sourceIsRefined && !targetIsRefined) {
      continue;
    }
    const neighborId = sourceIsRefined ? edge.target : edge.source;
    const neighbor = nodesById.get(neighborId);
    if (!neighbor || isSourceMemory(neighbor)) {
      continue;
    }
    if (EVIDENCE_NEIGHBOR_TYPES.has(neighbor.type)) {
      evidenceIds.add(neighbor.id);
    }
  }

  const defaultNodeIds = [...defaultIds].sort((left, right) =>
    left.localeCompare(right)
  );
  const evidenceNodeIds = [...evidenceIds].sort((left, right) =>
    left.localeCompare(right)
  );
  const statuses = sortedUnique(
    graph.nodes.flatMap((node) =>
      typeof node.metadata.status === "string"
        ? [node.metadata.status]
        : []
    )
  );
  const domains = sortedUnique(
    graph.nodes.flatMap((node) => {
      if (typeof node.metadata.domain === "string") {
        return [node.metadata.domain];
      }
      return node.type === "domain" ? [node.label] : [];
    })
  );
  const projects = sortedUnique(
    graph.nodes.flatMap((node) => [
      ...metadataStrings(node, "projectKeys"),
      ...(node.type === "project" ? [node.label] : [])
    ])
  );

  return {
    graph,
    defaultNodeIds,
    evidenceNodeIds,
    sourceMemoryNodeIds,
    summary: {
      totalNodes: graph.nodes.length,
      totalEdges: graph.edges.length,
      refinedKnowledge: refinedIds.size,
      sourceMemories: sourceMemoryNodeIds.length,
      defaultNodes: defaultNodeIds.length
    },
    filters: {
      nodeTypes: sortedUnique(
        graph.nodes.map((node) => node.type)
      ) as GraphNodeType[],
      statuses,
      domains,
      projects
    }
  };
}
