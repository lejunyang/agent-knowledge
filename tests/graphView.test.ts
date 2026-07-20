import { describe, expect, it } from "vitest";
import { buildKnowledgeGraphView } from "../src/graph/view.js";
import type { KnowledgeGraph } from "../src/graph/types.js";

describe("knowledge graph view", () => {
  it("defaults to refined knowledge and its structural neighbors", () => {
    const graph: KnowledgeGraph = {
      version: 1,
      generatedAt: "2026-07-21T00:00:00.000Z",
      nodes: [
        {
          id: "knowledge:k_refined",
          type: "knowledge",
          label: "Refined procedure",
          metadata: {
            memoryType: "procedural",
            status: "active",
            domain: "support/refund",
            projectIds: ["project-1"]
          }
        },
        {
          id: "knowledge:k_raw",
          type: "knowledge",
          label: "Raw evidence",
          metadata: {
            memoryType: "source",
            status: "active",
            domain: "support/source"
          }
        },
        {
          id: "domain:support/refund",
          type: "domain",
          label: "support/refund",
          metadata: {}
        },
        {
          id: "scenario:customer-support",
          type: "scenario",
          label: "customer-support",
          metadata: {}
        },
        {
          id: "project:project-1",
          type: "project",
          label: "project-1",
          metadata: {}
        },
        {
          id: "source:doc:refund",
          type: "source",
          label: "doc:refund",
          metadata: {}
        },
        {
          id: "episode:one",
          type: "episode",
          label: "one",
          metadata: {}
        }
      ],
      edges: [
        {
          id: "e-domain",
          source: "knowledge:k_refined",
          target: "domain:support/refund",
          type: "belongs_to_domain",
          metadata: {}
        },
        {
          id: "e-scenario",
          source: "knowledge:k_refined",
          target: "scenario:customer-support",
          type: "used_in_scenario",
          metadata: {}
        },
        {
          id: "e-project",
          source: "knowledge:k_refined",
          target: "project:project-1",
          type: "belongs_to_project",
          metadata: {}
        },
        {
          id: "e-source",
          source: "knowledge:k_refined",
          target: "source:doc:refund",
          type: "sourced_from",
          metadata: {}
        },
        {
          id: "e-raw",
          source: "knowledge:k_raw",
          target: "source:doc:refund",
          type: "sourced_from",
          metadata: {}
        },
        {
          id: "e-episode",
          source: "knowledge:k_refined",
          target: "episode:one",
          type: "observed_in_episode",
          metadata: {}
        }
      ]
    };

    const view = buildKnowledgeGraphView(graph);

    expect(view.summary).toEqual({
      totalNodes: 7,
      totalEdges: 6,
      refinedKnowledge: 1,
      sourceMemories: 1,
      defaultNodes: 1
    });
    expect(view.defaultNodeIds).toEqual(["knowledge:k_refined"]);
    expect(view.evidenceNodeIds).toEqual([
      "domain:support/refund",
      "episode:one",
      "knowledge:k_refined",
      "project:project-1",
      "scenario:customer-support",
      "source:doc:refund"
    ]);
    expect(view.defaultNodeIds).not.toContain("knowledge:k_raw");
    expect(view.filters.nodeTypes).toEqual([
      "domain",
      "episode",
      "knowledge",
      "project",
      "scenario",
      "source"
    ]);
    expect(view.filters.domains).toEqual(["support/refund", "support/source"]);
    expect(view.filters.projects).toEqual(["project-1"]);
    expect(view.filters.statuses).toEqual(["active"]);
  });
});
