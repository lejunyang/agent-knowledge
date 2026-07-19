import { describe, expect, it } from "vitest";
import { renderKnowledgeGraphHtml } from "../src/graph/html.js";
import type { KnowledgeGraph } from "../src/graph/types.js";

describe("knowledge graph HTML", () => {
  it("renders a self-contained interactive graph with embedded data and filters", () => {
    const graph: KnowledgeGraph = {
      version: 1,
      generatedAt: "2026-07-19T00:00:00.000Z",
      nodes: [
        {
          id: "knowledge:k_one",
          type: "knowledge",
          label: "Refund rule",
          metadata: {
            status: "active",
            domain: "support/refund",
            projectIds: ["project-1"],
            summary: "Refunds require review."
          }
        },
        {
          id: "domain:support/refund",
          type: "domain",
          label: "support/refund",
          metadata: {}
        }
      ],
      edges: [
        {
          id: "edge-1",
          source: "knowledge:k_one",
          target: "domain:support/refund",
          type: "belongs_to_domain",
          metadata: {}
        },
        {
          id: "edge-2",
          source: "knowledge:k_one",
          target: "knowledge:k_old",
          type: "supersedes",
          metadata: {}
        }
      ]
    };

    const html = renderKnowledgeGraphHtml(graph);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="search"');
    expect(html).toContain('id="type-filter"');
    expect(html).toContain('id="status-filter"');
    expect(html).toContain('id="domain-filter"');
    expect(html).toContain('id="project-filter"');
    expect(html).toContain('id="details"');
    expect(html).toContain("Refund rule");
    expect(html).toContain("supersedes");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<script src=");
  });
});
