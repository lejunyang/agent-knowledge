import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareSidecars,
  createSidecarPreset,
  listSidecarRuns,
  scaffoldSidecar
} from "../src/sidecar/index.js";
import type { EvalCase } from "../src/retrieval/eval.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("sidecar scaffold and comparison", () => {
  it("scaffolds provider-specific setup files without credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-scaffold-"));
    tempDirs.push(root);

    const hindsight = await scaffoldSidecar("hindsight", path.join(root, "h"));
    const memu = await scaffoldSidecar("memu", path.join(root, "u"));
    const mem0 = await scaffoldSidecar("mem0", path.join(root, "m"));

    expect(hindsight.files.some((file) => file.endsWith("compose.yaml"))).toBe(
      true
    );
    expect(mem0.files.some((file) => file.endsWith("compose.yaml"))).toBe(true);
    expect(memu.files.some((file) => file.endsWith(".env.example"))).toBe(true);
    for (const file of [...hindsight.files, ...memu.files, ...mem0.files]) {
      expect(await readFile(file, "utf8")).not.toContain("actual-secret");
    }
  });

  it("creates a customized one-command setup bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-setup-"));
    tempDirs.push(root);

    const result = await scaffoldSidecar("hindsight", root, {
      id: "business-hindsight",
      scope: "merchant-center",
      baseUrl: "http://127.0.0.1:9999"
    });
    const config = JSON.parse(
      await readFile(path.join(root, "sidecar.json"), "utf8")
    ) as Record<string, unknown>;
    const compose = await readFile(path.join(root, "compose.yaml"), "utf8");

    expect(config).toMatchObject({
      id: "business-hindsight",
      scope: "merchant-center",
      baseUrl: "http://127.0.0.1:9999",
      mode: "shadow"
    });
    expect(compose).toContain('"9999:8888"');
    expect(result.nextCommands.join("\n")).toContain("sidecar doctor");
  });

  it("compares native and sidecar results with forbidden and abstention metrics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-compare-"));
    tempDirs.push(root);
    const output = path.join(root, "reports");
    const config = createSidecarPreset("hindsight", {
      id: "hindsight-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });
    const cases: EvalCase[] = [
      {
        task: "账号注销后能恢复吗",
        domains: [],
        scenarios: [],
        project_keys: [],
        expected_memories: ["k_delete"],
        forbidden_memories: ["k_recovery"],
        abstain: false,
        language: "zh-CN",
        domain: "account-deletion"
      },
      {
        task: "Vue SFC lint 怎么迁移",
        domains: [],
        scenarios: [],
        project_keys: [],
        expected_memories: [],
        forbidden_memories: ["k_delete"],
        abstain: true,
        language: "zh-CN",
        domain: "no-answer"
      }
    ];

    const report = await compareSidecars({
      rootDir: root,
      cases,
      configs: [config],
      outputDir: output,
      nativeSearch: async (task) =>
        task.includes("注销")
          ? { ids: ["k_delete"], latencyMs: 5 }
          : { ids: [], latencyMs: 3 },
      sidecarSearch: async (_config, task) =>
        task.includes("注销")
          ? {
              provider: "hindsight",
              sidecarId: "hindsight-local",
              query: task,
              latencyMs: 20,
              results: [
                {
                  text: "delete",
                  score: 0.9,
                  nativeMemoryId: "k_delete",
                  metadata: {}
                },
                {
                  text: "recovery",
                  score: 0.7,
                  nativeMemoryId: "k_recovery",
                  metadata: {}
                }
              ]
            }
          : {
              provider: "hindsight",
              sidecarId: "hindsight-local",
              query: task,
              latencyMs: 18,
              results: [
                {
                  text: "unmapped candidate",
                  score: 0.4,
                  metadata: {}
                }
              ]
            }
    });

    expect(report.providers.native).toMatchObject({
      passed: 2,
      failed: 0,
      falseInjectionRate: 0,
      abstentionPrecision: 1,
      abstentionFailureRate: 0
    });
    expect(report.providers["hindsight-local"]).toMatchObject({
      passed: 0,
      failed: 2,
      falseInjectionRate: 1,
      abstentionPrecision: 1,
      abstentionFailureRate: 1,
      unmappedResults: 1
    });
    expect(report.jsonPath).toMatch(/sidecar-comparison\.json$/);
    expect(report.markdownPath).toMatch(/sidecar-comparison\.md$/);
    expect(await readFile(report.markdownPath, "utf8")).toContain(
      "hindsight-local"
    );
    expect((await listSidecarRuns(root))[0]?.provider).toBe("comparison");
  });
});
