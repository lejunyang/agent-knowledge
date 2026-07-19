import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildKnowledgeGraph } from "../src/graph/build.js";
import {
  expandGraphCandidates,
  queryMemoriesGraphWithDebug
} from "../src/retrieval/graph.js";
import { rebuildIndex } from "../src/storage/indexer.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("graph retrieval", () => {
  it("traverses only allowed relation types with depth decay", async () => {
    const graph = {
      version: 1 as const,
      generatedAt: "2026-07-19T00:00:00.000Z",
      nodes: [
        { id: "knowledge:a", type: "knowledge" as const, label: "A", metadata: { memoryId: "a" } },
        { id: "knowledge:b", type: "knowledge" as const, label: "B", metadata: { memoryId: "b" } },
        { id: "knowledge:c", type: "knowledge" as const, label: "C", metadata: { memoryId: "c" } },
        { id: "knowledge:d", type: "knowledge" as const, label: "D", metadata: { memoryId: "d" } }
      ],
      edges: [
        { id: "1", source: "knowledge:a", target: "knowledge:b", type: "depends_on" as const, metadata: {} },
        { id: "2", source: "knowledge:b", target: "knowledge:c", type: "supports" as const, metadata: {} },
        { id: "3", source: "knowledge:a", target: "knowledge:d", type: "conflicts_with" as const, metadata: {} }
      ]
    };

    const expanded = expandGraphCandidates(graph, ["a"], { depth: 2, decay: 0.6 });

    expect(expanded).toEqual([
      { memoryId: "b", depth: 1, graphScore: 0.6, relation: "depends_on" },
      { memoryId: "c", depth: 2, graphScore: 0.36, relation: "supports" }
    ]);
    expect(expanded.some((item) => item.memoryId === "d")).toBe(false);
  });

  it("expands a direct seed through related_knowledge and keeps direct result first", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-retrieval-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const validationPath = path.join(
      root,
      "knowledge",
      "procedural",
      "code-review",
      "2026-07-05-lint-validation-flow.md"
    );
    const validation = await readFile(validationPath, "utf8");
    await writeFile(
      validationPath,
      validation.replace(
        "related_knowledge: []",
        `related_knowledge:
  - id: k_eval_second_hop_guard
    relation: depends_on
    reason: Validation depends on the CI guard.`
      ),
      "utf8"
    );
    const guardDirectory = path.join(root, "knowledge", "semantic", "ci");
    await mkdir(guardDirectory, { recursive: true });
    await writeFile(
      path.join(guardDirectory, "guard.md"),
      `---
id: k_eval_second_hop_guard
type: semantic
title: CI safety guard
aliases: []
domain: ci/safety
related_domains: []
scenario:
  - release-safety
tags:
  - ci
status: active
confidence: 0.9
source_authority: documented
source:
  - test
related_knowledge:
  - id: k_eval_third_hop_checklist
    relation: supports
    reason: The guard is implemented by the final checklist.
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
project_ids: []
capture_mode: direct_material
actor_type: owner
corroboration_count: 1
episodes: []
created_at: 2026-07-19
updated_at: 2026-07-19
valid_from: 2026-07-19
valid_until:
---

# CI safety guard

Release validation requires an independent CI safety guard.
`,
      "utf8"
    );
    await writeFile(
      path.join(guardDirectory, "checklist.md"),
      `---
id: k_eval_third_hop_checklist
type: semantic
title: Final release checklist
aliases: []
domain: ci/checklist
related_domains: []
scenario:
  - release-safety
tags:
  - checklist
status: active
confidence: 0.9
source_authority: documented
source:
  - test
related_knowledge: []
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
project_ids: []
capture_mode: direct_material
actor_type: owner
corroboration_count: 1
episodes: []
created_at: 2026-07-19
updated_at: 2026-07-19
valid_from: 2026-07-19
valid_until:
---

# Final release checklist

The final checklist validates the CI guard before release.
`,
      "utf8"
    );
    rebuildIndex(root);
    await buildKnowledgeGraph(root);

    const result = await queryMemoriesGraphWithDebug(
      root,
      {
        task: "Vue SFC lint fallback",
        agentRole: "main",
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"]
      },
      {
        baseMode: "lexical",
        depth: 2,
        decay: 0.6
      }
    );

    expect(result.ranked[0]?.document.frontmatter.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(result.ranked.map((item) => item.document.frontmatter.id)).toContain(
      "k_20260705_lint_validation_flow"
    );
    expect(result.ranked.map((item) => item.document.frontmatter.id)).toContain(
      "k_eval_second_hop_guard"
    );
    expect(result.ranked.map((item) => item.document.frontmatter.id)).toContain(
      "k_eval_third_hop_checklist"
    );
    expect(result.debug.graphExpansion?.some((item) => item.id === "k_eval_third_hop_checklist")).toBe(true);
    expect(result.debug.resultScores.some((item) => item.id === "k_eval_third_hop_checklist")).toBe(true);
  });

  it("reapplies sensitivity filtering to graph-expanded memories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-graph-security-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const relatedPath = path.join(
      root,
      "knowledge",
      "procedural",
      "code-review",
      "2026-07-05-lint-validation-flow.md"
    );
    const related = await readFile(relatedPath, "utf8");
    await writeFile(
      relatedPath,
      related.replace("sensitivity: internal", "sensitivity: secret"),
      "utf8"
    );
    rebuildIndex(root);
    await buildKnowledgeGraph(root);

    const result = await queryMemoriesGraphWithDebug(
      root,
      {
        task: "Vue SFC lint fallback",
        agentRole: "main",
        domains: ["frontend/lint"],
        scenarios: ["lint-migration"],
        sensitivityClearance: "internal"
      },
      { baseMode: "lexical", depth: 1, decay: 0.6 }
    );

    expect(result.ranked.map((item) => item.document.frontmatter.id)).not.toContain(
      "k_20260705_lint_validation_flow"
    );
  });
});
