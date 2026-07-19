/**
 * Graph retrieval 使用有界类型化遍历补充 lexical/hybrid seed。
 *
 * 图只提出 candidate ID；扩展文档必须重新经过 query 安全边界，conflict/supersedes 边不进入
 * 普通上下文扩展。
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

/** 只遍历允许的知识关系，并按深度指数衰减；最大两跳用于限制噪声和成本。 */
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

/** 先运行 lexical/hybrid seed 检索，再合并经过安全过滤的 graph 扩展知识。 */
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
      // Graph 扩展改变了最终结果集，因此必须从最终结果重建 debug 分数，不能保留 seed 查询的旧快照。
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

/** 消除浮点噪声，使 debug 输出和确定性测试稳定。 */
function roundScore(value: number): number {
  return Number(value.toFixed(6));
}
