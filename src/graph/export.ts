/** 为机器消费和轻量人工检查提供确定性 graph 导出。 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeGraph } from "./types.js";
import { renderKnowledgeGraphHtml } from "./html.js";

/** 按调用方选择导出 JSON、Mermaid 或自包含 HTML，并覆盖指定输出文件。 */
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

/** 生成稳定 Mermaid flowchart，并为节点分配与原始 ID 解耦的安全标识。 */
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

/** 转义 Mermaid 引号 label，避免反斜杠、引号和换行破坏语法。 */
function escapeLabel(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}
