import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicLocalEmbeddingProvider,
  embedKnowledgeIndex,
  getEmbeddingsManifestPath,
  getEmbeddingsJsonlPath,
  readEmbeddingManifest,
  readEmbeddingRecords,
  suggestAliases,
  type EmbeddingProvider
} from "../src/retrieval/embeddings.js";
import { rebuildIndex } from "../src/storage/indexer.js";
import { appendJsonlLog } from "../src/core/logging.js";
import { queryMemoriesHybridWithDebug } from "../src/retrieval/query.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

describe("embedding index", () => {
  it("writes active Markdown document embeddings to a JSONL store without network providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-embed-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });

    const provider = new DeterministicLocalEmbeddingProvider(32);
    const result = await embedKnowledgeIndex(root, { provider });
    const records = readEmbeddingRecords(root);

    expect(result).toMatchObject({
      embeddingsPath: getEmbeddingsJsonlPath(root),
      provider: "deterministic-local",
      model: "token-hash-v1",
      indexed: 2,
      dimensions: 32,
      embedded: true,
      generated: 2,
      reused: 0,
      removed: 0
    });
    expect(records).toHaveLength(2);
    expect(records[0]?.vector).toHaveLength(32);
    expect(records.map((record) => record.id)).toContain("k_20260705_frontend_lint_vue_sfc");

    const raw = await readFile(getEmbeddingsJsonlPath(root), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
    expect(readEmbeddingManifest(root)).toMatchObject({
      version: 1,
      profile: {
        provider: "deterministic-local",
        model: "token-hash-v1",
        dimensions: 32
      },
      recordCount: 2
    });
    await expect(readFile(getEmbeddingsManifestPath(root), "utf8")).resolves.toContain('"version": 1');
  });

  it("reuses unchanged embeddings and only regenerates changed documents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-embed-incremental-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    let embeddedTexts = 0;
    const base = new DeterministicLocalEmbeddingProvider(16);
    const provider: EmbeddingProvider = {
      ...base,
      name: base.name,
      model: base.model,
      dimensions: base.dimensions,
      profile: base.profile,
      async embed(texts, purpose) {
        embeddedTexts += texts.length;
        return base.embed(texts, purpose);
      }
    };

    const first = await embedKnowledgeIndex(root, { provider });
    const second = await embedKnowledgeIndex(root, { provider });

    expect(first.generated).toBe(2);
    expect(second).toMatchObject({ generated: 0, reused: 2, removed: 0 });
    expect(embeddedTexts).toBe(2);
  });

  it("produces dry-run alias suggestions from embeddings, logs, and documents", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-alias-suggest-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    const provider = new DeterministicLocalEmbeddingProvider(32);
    await embedKnowledgeIndex(root, { provider });
    appendJsonlLog(root, {
      event: "query",
      domains: ["frontend/lint"],
      scenarios: ["migration-review"],
      debug: { resultIds: ["k_20260705_frontend_lint_vue_sfc"] }
    });

    const result = await suggestAliases(root, {
      provider,
      minScore: 0.1,
      maxSuggestionsPerMemory: 3
    });
    const target = result.suggestions.find((item) => item.id === "k_20260705_frontend_lint_vue_sfc");

    expect(result.dryRun).toBe(true);
    expect(result.provider).toBe("deterministic-local");
    expect(target?.suggestions.length).toBeGreaterThan(0);
    expect(target?.suggestions.some((suggestion) => suggestion.alias === "migration-review")).toBe(true);
    expect(target?.existingAliases).toEqual(["vue-lint", "sfc-lint"]);
  });

  it("reports a clear skipped reason when no active documents exist", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-empty-embed-"));
    tempDirs.push(root);
    const provider: EmbeddingProvider = {
      name: "must-not-run",
      model: "test",
      dimensions: 3,
      async embed() {
        throw new Error("provider should not be called without active documents");
      }
    };

    const result = await embedKnowledgeIndex(root, { provider });

    expect(result).toMatchObject({
      indexed: 0,
      embedded: false,
      skippedReason: "no_active_documents"
    });
  });
});

describe("hybrid query", () => {
  it("uses embedding candidates when lexical retrieval has no unconstrained match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-hybrid-query-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);

    const provider: EmbeddingProvider = {
      name: "test-semantic-provider",
      model: "test-v1",
      dimensions: 2,
      async embed(texts: string[]) {
        return texts.map((text) =>
          text.includes("Vue SFC") || text.includes("自然语言里完全不出现索引关键词")
            ? [1, 0]
            : [0, 1]
        );
      }
    };

    await embedKnowledgeIndex(root, { provider });
    const result = await queryMemoriesHybridWithDebug(
      root,
      {
        task: "自然语言里完全不出现索引关键词",
        agentRole: "main",
        domains: [],
        scenarios: []
      },
      { embeddingProvider: provider, embeddingTopK: 1 }
    );

    expect(result.debug.retrievalMode).toBe("hybrid");
    expect(result.debug.embeddingRecordCount).toBe(2);
    expect(result.debug.fallbackSuppressedReason).toBe("missing_domain_or_scenario");
    expect(result.debug.embeddingCandidateIds).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(result.ranked.map((item) => item.document.frontmatter.id)).toContain("k_20260705_frontend_lint_vue_sfc");
    expect(
      result.debug.resultScores.find((item) => item.id === "k_20260705_frontend_lint_vue_sfc")?.embeddingScore
    ).toBe(1);
    expect(result.debug.resultScores[0]?.rrfScore).toBeGreaterThan(0);
  });

  it("rejects hybrid queries when the provider is incompatible with the embedding manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-knowledge-hybrid-mismatch-"));
    tempDirs.push(root);
    await cp("tests/fixtures/basic-knowledge", root, { recursive: true });
    rebuildIndex(root);
    await embedKnowledgeIndex(root, { provider: new DeterministicLocalEmbeddingProvider(16) });

    await expect(
      queryMemoriesHybridWithDebug(
        root,
        {
          task: "Vue SFC lint",
          agentRole: "main",
          domains: [],
          scenarios: []
        },
        {
          embeddingProvider: new DeterministicLocalEmbeddingProvider(32)
        }
      )
    ).rejects.toThrow("Embedding profile mismatch");
  });
});
