/**
 * Graph building converts current Markdown/proposal metadata into a deterministic adjacency index.
 *
 * It never invents entities or relationships with an LLM. All edges are explicit frontmatter,
 * project/episode/source membership, or proposal targets.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolveWorkspacePath } from "../core/paths.js";
import { discoverKnowledgeFiles } from "../storage/workspace.js";
import { parseKnowledgeMarkdown, extractSummary } from "../storage/markdown.js";
import { readMaintenanceProposals } from "../memory/proposals.js";
import type {
  GraphEdge,
  GraphEdgeType,
  GraphNode,
  KnowledgeGraph
} from "./types.js";

/** Builds and atomically persists `.memory/graph.json`. */
export async function buildKnowledgeGraph(rootDir: string): Promise<KnowledgeGraph> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const files = await discoverKnowledgeFiles(rootDir);

  for (const filePath of files) {
    const document = parseKnowledgeMarkdown(
      filePath,
      await readFile(resolveWorkspacePath(rootDir, filePath), "utf8")
    );
    const knowledgeId = `knowledge:${document.frontmatter.id}`;
    addNode(nodes, {
      id: knowledgeId,
      type: "knowledge",
      label: document.frontmatter.title,
      metadata: {
        memoryId: document.frontmatter.id,
        memoryType: document.frontmatter.type,
        status: document.frontmatter.status,
        domain: document.frontmatter.domain,
        scenarios: document.frontmatter.scenario,
        aliases: document.frontmatter.aliases,
        summary: extractSummary(document.body),
        confidence: document.frontmatter.confidence,
        visibility: document.frontmatter.visibility,
        sensitivity: document.frontmatter.sensitivity,
        projectIds: document.frontmatter.project_ids,
        validFrom: document.frontmatter.valid_from,
        validUntil: document.frontmatter.valid_until,
        filePath
      }
    });

    const domainId = `domain:${document.frontmatter.domain}`;
    addNode(nodes, {
      id: domainId,
      type: "domain",
      label: document.frontmatter.domain,
      metadata: {}
    });
    addEdge(edges, knowledgeId, domainId, "belongs_to_domain");

    for (const scenario of document.frontmatter.scenario) {
      const scenarioId = `scenario:${scenario}`;
      addNode(nodes, {
        id: scenarioId,
        type: "scenario",
        label: scenario,
        metadata: {}
      });
      addEdge(edges, knowledgeId, scenarioId, "used_in_scenario");
    }
    for (const projectId of document.frontmatter.project_ids) {
      const graphProjectId = `project:${projectId}`;
      addNode(nodes, {
        id: graphProjectId,
        type: "project",
        label: projectId,
        metadata: {}
      });
      addEdge(edges, knowledgeId, graphProjectId, "belongs_to_project");
    }
    for (const episode of document.frontmatter.episodes) {
      const episodeId = `episode:${episode.episode_id}`;
      addNode(nodes, {
        id: episodeId,
        type: "episode",
        label: episode.episode_id,
        metadata: episode
      });
      addEdge(edges, knowledgeId, episodeId, "observed_in_episode");
    }
    for (const source of document.frontmatter.source) {
      const sourceId = `source:${source}`;
      addNode(nodes, {
        id: sourceId,
        type: "source",
        label: source,
        metadata: {}
      });
      addEdge(edges, knowledgeId, sourceId, "sourced_from");
    }
    for (const relation of document.frontmatter.related_knowledge) {
      addEdge(
        edges,
        knowledgeId,
        `knowledge:${relation.id}`,
        relation.relation,
        { reason: relation.reason }
      );
    }
    for (const target of document.frontmatter.supersedes) {
      addEdge(edges, knowledgeId, `knowledge:${target}`, "supersedes");
    }
    for (const target of document.frontmatter.conflicts_with) {
      addEdge(edges, knowledgeId, `knowledge:${target}`, "conflicts_with");
    }
  }

  for (const proposal of await readMaintenanceProposals(rootDir)) {
    const proposalId = `proposal:${proposal.id}`;
    addNode(nodes, {
      id: proposalId,
      type: "proposal",
      label: proposal.title,
      metadata: proposal
    });
    for (const target of proposal.targetMemoryIds) {
      addEdge(edges, proposalId, `knowledge:${target}`, "proposes_change_to");
    }
  }

  const graph: KnowledgeGraph = {
    version: 1,
    generatedAt: new Date().toISOString(),
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
  };
  const target = getKnowledgeGraphPath(rootDir);
  await mkdir(resolveWorkspacePath(rootDir, ".memory"), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(temporary, target);
  return graph;
}

/** Returns the rebuildable graph index path. */
export function getKnowledgeGraphPath(rootDir: string): string {
  return resolveWorkspacePath(rootDir, ".memory", "graph.json");
}

/** Adds one node if another source has not already emitted it. */
function addNode(nodes: Map<string, GraphNode>, node: GraphNode): void {
  if (!nodes.has(node.id)) {
    nodes.set(node.id, node);
  }
}

/** Adds one deterministic typed edge. */
function addEdge(
  edges: Map<string, GraphEdge>,
  source: string,
  target: string,
  type: GraphEdgeType,
  metadata: Record<string, unknown> = {}
): void {
  const id = `edge_${createHash("sha256")
    .update(`${source}\0${type}\0${target}`)
    .digest("hex")
    .slice(0, 20)}`;
  edges.set(id, { id, source, target, type, metadata });
}
