/** 内存 graph 搜索和有界 breadth-first traversal。 */
import { existsSync, readFileSync } from "node:fs";
import { getKnowledgeGraphPath } from "./build.js";
import type { KnowledgeGraph } from "./types.js";

/** 按文本或 ID 找 seed，并返回最多两跳的诱导子图，避免可视化查询无界扩张。 */
export async function queryKnowledgeGraph(
  rootDir: string,
  options: { text?: string; id?: string; depth?: number }
): Promise<KnowledgeGraph> {
  const graph = readKnowledgeGraph(rootDir);
  const depth = Math.max(0, Math.min(2, options.depth ?? 1));
  const normalizedText = options.text?.toLowerCase().trim();
  const seeds = graph.nodes
    .filter((node) => {
      if (options.id && (node.id === options.id || node.metadata.memoryId === options.id)) {
        return true;
      }
      if (!normalizedText) {
        return false;
      }
      return `${node.label}\n${JSON.stringify(node.metadata)}`
        .toLowerCase()
        .includes(normalizedText);
    })
    .map((node) => node.id);
  const selected = new Set(seeds);
  let frontier = seeds;
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (frontier.includes(edge.source)) {
        next.add(edge.target);
      }
      if (frontier.includes(edge.target)) {
        next.add(edge.source);
      }
    }
    frontier = [...next].filter((id) => !selected.has(id));
    frontier.forEach((id) => selected.add(id));
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((node) => selected.has(node.id)),
    edges: graph.edges.filter(
      (edge) => selected.has(edge.source) && selected.has(edge.target)
    )
  };
}

/** 读取已经构建的 graph 索引；缺失时明确要求先构建，避免静默使用空图。 */
export function readKnowledgeGraph(rootDir: string): KnowledgeGraph {
  const target = getKnowledgeGraphPath(rootDir);
  if (!existsSync(target)) {
    throw new Error("Knowledge graph is missing; run `agent-knowledge graph build`");
  }
  return JSON.parse(readFileSync(target, "utf8")) as KnowledgeGraph;
}
