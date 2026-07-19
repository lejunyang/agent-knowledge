/** Deterministic graph exports for machines and lightweight human inspection. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeGraph } from "./types.js";
import { renderKnowledgeGraphHtml } from "./html.js";

/** Exports JSON or Mermaid to a caller-selected path. */
export async function exportKnowledgeGraph(
  graph: KnowledgeGraph,
  options: { format: "json" | "mermaid" | "html"; output: string }
): Promise<void> {
  const content =
    options.format === "json"
      ? `${JSON.stringify(graph, null, 2)}\n`
      : options.format === "mermaid"
        ? renderMermaid(graph)
        : renderKnowledgeGraphHtml(graph);
  await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
  await writeFile(path.resolve(options.output), content, "utf8");
}

/** Renders a stable Mermaid flowchart with sanitized labels. */
function renderMermaid(graph: KnowledgeGraph): string {
  const nodeIds = new Map(
    graph.nodes.map((node, index) => [node.id, `n${index + 1}`])
  );
  const lines = ["```mermaid", "flowchart LR"];
  for (const node of graph.nodes) {
    lines.push(`  ${nodeIds.get(node.id)}[\"${escapeLabel(node.label)}\"]`);
  }
  for (const edge of graph.edges) {
    const source = nodeIds.get(edge.source);
    const target = nodeIds.get(edge.target);
    if (source && target) {
      lines.push(`  ${source} -->|${escapeLabel(edge.type)}| ${target}`);
    }
  }
  lines.push("```", "");
  return lines.join("\n");
}

/** Escapes text used inside Mermaid quoted labels. */
function escapeLabel(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}
