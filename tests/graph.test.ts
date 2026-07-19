import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureMaterial } from "../src/memory/organizer.js";
import { buildKnowledgeGraph } from "../src/graph/build.js";
import { queryKnowledgeGraph } from "../src/graph/query.js";
import { exportKnowledgeGraph } from "../src/graph/export.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("knowledge graph", () => {
  it("builds typed knowledge, domain, scenario, episode, source, and relation nodes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "Account model",
          memory_type: "semantic",
          domain: "business/account",
          related_domains: [],
          scenario: ["business-knowledge"],
          tags: ["account"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Accounts have owners and authorized operators.",
          evidence: ["doc:account"],
          episodes: [
            {
              episode_id: "episode-1",
              session_hash: "session-1",
              project_id: "project-1",
              observed_at: "2026-07-19T00:00:00.000Z",
              evidence_refs: ["doc:account"]
            }
          ]
        },
        {
          title: "Account authorization",
          memory_type: "procedural",
          domain: "business/account",
          related_domains: [],
          scenario: ["business-knowledge"],
          tags: ["authorization"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Grant operators explicit authorization.",
          evidence: ["doc:authorization"]
        }
      ],
      { target: "active", rebuild: false }
    );

    const graph = await buildKnowledgeGraph(root);

    expect(graph.nodes.some((node) => node.type === "knowledge" && node.label === "Account model")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "domain" && node.label === "business/account")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "scenario" && node.label === "business-knowledge")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "episode" && node.label === "episode-1")).toBe(true);
    expect(graph.nodes.some((node) => node.type === "source" && node.label === "doc:account")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "belongs_to_domain")).toBe(true);
    expect(graph.edges.some((edge) => edge.type === "observed_in_episode")).toBe(true);
  });

  it("queries graph seeds by text and traverses deterministic depth", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-query-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "Refund approval",
          aliases: ["refund review"],
          memory_type: "semantic",
          domain: "support/refund",
          related_domains: [],
          scenario: ["customer-support"],
          tags: ["refund"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Refunds require reviewer approval.",
          evidence: ["doc:refund"]
        }
      ],
      { target: "active", rebuild: false }
    );
    await buildKnowledgeGraph(root);

    const result = await queryKnowledgeGraph(root, {
      text: "refund review",
      depth: 1
    });

    expect(result.nodes.some((node) => node.label === "Refund approval")).toBe(true);
    expect(result.nodes.some((node) => node.label === "support/refund")).toBe(true);
  });

  it("exports deterministic JSON and Mermaid representations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-export-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "Release process",
          memory_type: "procedural",
          domain: "delivery/release",
          related_domains: [],
          scenario: ["release"],
          tags: ["delivery"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Run tests before release.",
          evidence: ["doc:release"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const graph = await buildKnowledgeGraph(root);
    const jsonPath = path.join(root, "graph.json");
    const mermaidPath = path.join(root, "graph.md");

    await exportKnowledgeGraph(graph, { format: "json", output: jsonPath });
    await exportKnowledgeGraph(graph, { format: "mermaid", output: mermaidPath });

    await expect(readFile(jsonPath, "utf8")).resolves.toContain('"type": "knowledge"');
    await expect(readFile(mermaidPath, "utf8")).resolves.toContain("flowchart LR");
  });

  it("ignores Skill review drafts when building the knowledge graph", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-skill-draft-"));
    tempDirs.push(root);
    await captureMaterial(
      root,
      [
        {
          title: "Release process",
          memory_type: "procedural",
          domain: "delivery/release",
          related_domains: [],
          scenario: ["release"],
          tags: ["delivery"],
          confidence: 0.9,
          source_authority: "user_confirmed",
          summary: "Run tests before release.",
          evidence: ["doc:release"]
        }
      ],
      { target: "active", rebuild: false }
    );
    const skillDir = path.join(
      root,
      "knowledge",
      "_inbox-skills",
      "release-validation"
    );
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: release-validation\ndescription: Review draft\n---\n",
      "utf8"
    );

    const graph = await buildKnowledgeGraph(root);

    expect(
      graph.nodes.filter((node) => node.type === "knowledge")
    ).toHaveLength(1);
  });
});
