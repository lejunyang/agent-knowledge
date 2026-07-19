/** In-memory graph search and bounded breadth-first traversal. */
import { existsSync, readFileSync } from "node:fs";
import { getKnowledgeGraphPath } from "./build.js";
import type { KnowledgeGraph } from "./types.js";

/** Queries text/id seeds and returns the induced graph up to depth two. */
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

/** Reads a previously built graph index. */
export function readKnowledgeGraph(rootDir: string): KnowledgeGraph {
  const target = getKnowledgeGraphPath(rootDir);
  if (!existsSync(target)) {
    throw new Error("Knowledge graph is missing; run `agent-knowledge graph build`");
  }
  return JSON.parse(readFileSync(target, "utf8")) as KnowledgeGraph;
}
