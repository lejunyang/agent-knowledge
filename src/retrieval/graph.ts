/**
 * Graph retrieval augments lexical/hybrid seeds with bounded typed traversal.
 *
 * The graph only proposes candidate IDs. Expanded documents are reloaded through query's security
 * boundary, and conflict/supersedes edges are excluded from normal context expansion.
 */
import { buildKnowledgeGraph } from "../graph/build.js";
import { readKnowledgeGraph } from "../graph/query.js";
import type { GraphEdgeType, KnowledgeGraph } from "../graph/types.js";
import type { MemoryQueryRequest, RankedMemory } from "../core/types.js";
import {
  loadAccessibleMemoriesByIds,
  queryMemoriesHybridWithDebug,
  queryMemoriesWithDebug,
  type QueryMemoriesDebugResult
} from "./query.js";
import type { EmbeddingProvider } from "./embeddings.js";

export type GraphExpansion = {
  memoryId: string;
  depth: number;
  graphScore: number;
  relation: GraphEdgeType;
};

const TRAVERSABLE_RELATIONS = new Set<GraphEdgeType>([
  "depends_on",
  "refines",
  "supports",
  "often_used_with"
]);

/** Traverses allowed knowledge-to-knowledge edges with exponential depth decay. */
export function expandGraphCandidates(
  graph: KnowledgeGraph,
  seedMemoryIds: string[],
  options: { depth: number; decay: number }
): GraphExpansion[] {
  const maxDepth = Math.max(0, Math.min(2, options.depth));
  const seen = new Set(seedMemoryIds.map((id) => `knowledge:${id}`));
  let frontier = seedMemoryIds.map((id) => `knowledge:${id}`);
  const expansions = new Map<string, GraphExpansion>();

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const next = new Set<string>();
    for (const edge of graph.edges) {
      if (!TRAVERSABLE_RELATIONS.has(edge.type)) {
        continue;
      }
      let candidateNode: string | undefined;
      if (frontier.includes(edge.source) && edge.target.startsWith("knowledge:")) {
        candidateNode = edge.target;
      } else if (
        frontier.includes(edge.target) &&
        edge.source.startsWith("knowledge:")
      ) {
        candidateNode = edge.source;
      }
      if (!candidateNode || seen.has(candidateNode)) {
        continue;
      }
      seen.add(candidateNode);
      next.add(candidateNode);
      expansions.set(candidateNode, {
        memoryId: candidateNode.slice("knowledge:".length),
        depth,
        graphScore: roundScore(options.decay ** depth),
        relation: edge.type
      });
    }
    frontier = [...next];
  }

  return [...expansions.values()].sort(
    (left, right) =>
      left.depth - right.depth ||
      right.graphScore - left.graphScore ||
      left.memoryId.localeCompare(right.memoryId)
  );
}

/** Runs lexical or hybrid seed retrieval, then merges secure graph-expanded memories. */
export async function queryMemoriesGraphWithDebug(
  rootDir: string,
  rawRequest: unknown,
  options: {
    baseMode: "lexical" | "hybrid";
    depth?: number;
    decay?: number;
    embeddingProvider?: EmbeddingProvider;
    embeddingTopK?: number;
  }
): Promise<QueryMemoriesDebugResult> {
  const request = rawRequest as MemoryQueryRequest;
  const base =
    options.baseMode === "hybrid"
      ? await queryMemoriesHybridWithDebug(rootDir, rawRequest, {
          embeddingProvider:
            options.embeddingProvider ??
            (() => {
              throw new Error("hybrid-graph requires an embedding provider");
            })(),
          embeddingTopK: options.embeddingTopK
        })
      : queryMemoriesWithDebug(rootDir, rawRequest);
  let graph: KnowledgeGraph;
  try {
    graph = readKnowledgeGraph(rootDir);
  } catch {
    graph = await buildKnowledgeGraph(rootDir);
  }
  const seedIds = base.ranked.map((memory) => memory.document.frontmatter.id);
  const expansion = expandGraphCandidates(graph, seedIds, {
    depth: options.depth ?? 1,
    decay: options.decay ?? 0.6
  });
  const baseIds = new Set(seedIds);
  const expansionById = new Map(expansion.map((item) => [item.memoryId, item]));
  const expanded = loadAccessibleMemoriesByIds(
    rootDir,
    request,
    expansion.map((item) => item.memoryId)
  )
    .filter((memory) => !baseIds.has(memory.document.frontmatter.id))
    .map((memory) => {
      const graphItem = expansionById.get(memory.document.frontmatter.id)!;
      return {
        ...memory,
        relationScore: graphItem.graphScore,
        finalScore: Math.max(
          memory.finalScore,
          roundScore(0.7 * graphItem.graphScore + 0.3 * memory.finalScore)
        )
      };
    });
  const ranked = [...base.ranked, ...expanded].sort(
    (left, right) =>
      right.finalScore - left.finalScore ||
      left.document.frontmatter.id.localeCompare(right.document.frontmatter.id)
  );
  const baseScores = new Map(
    base.debug.resultScores.map((score) => [score.id, score])
  );
  return {
    ranked,
    debug: {
      ...base.debug,
      retrievalMode:
        options.baseMode === "hybrid" ? "hybrid-graph" : "graph",
      resultIds: ranked.map((memory) => memory.document.frontmatter.id),
      // Graph expansion changes the final result set, so debug scores must be rebuilt from that
      // final set rather than retaining the seed query's stale score snapshot.
      resultScores: ranked.map((memory) => {
        const id = memory.document.frontmatter.id;
        return {
          id,
          lexicalScore: memory.lexicalScore,
          embeddingScore: memory.embeddingScore,
          scenarioScore: memory.scenarioScore,
          confidenceScore: memory.confidenceScore,
          sourceAuthorityScore: memory.sourceAuthorityScore,
          relationScore: memory.relationScore,
          rrfScore: memory.rrfScore,
          ...(baseScores.get(id)?.rerankerScore === undefined
            ? {}
            : { rerankerScore: baseScores.get(id)?.rerankerScore }),
          finalScore: memory.finalScore
        };
      }),
      graphExpansion: expanded.map((memory) => {
        const item = expansionById.get(memory.document.frontmatter.id)!;
        return {
          id: item.memoryId,
          depth: item.depth,
          graphScore: item.graphScore,
          relation: item.relation
        };
      })
    }
  };
}

/** Avoids floating-point noise in debug output and deterministic tests. */
function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
