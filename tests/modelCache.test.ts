import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadRetrievalModel,
  getRetrievalModelStatus,
  resolveRetrievalModelDescriptor,
  type ModelCacheAdapter,
  type RetrievalModelDescriptor
} from "../src/retrieval/modelCache.js";
import { resolveUserConfig } from "../src/core/config.js";

let tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs = [];
});

class FakeModelCacheAdapter implements ModelCacheAdapter {
  cached = false;
  downloads: Array<{ task: string; model: string; cacheDir: string }> = [];

  async status(): Promise<{ cached: boolean; files: Array<{ path: string; cached: boolean }> }> {
    return {
      cached: this.cached,
      files: [
        { path: "config.json", cached: true },
        { path: "onnx/model_q8.onnx", cached: this.cached }
      ]
    };
  }

  async download(options: {
    task: string;
    model: string;
    cacheDir: string;
    onProgress?: (progress: { status?: string; file?: string; progress?: number }) => void;
  }): Promise<void> {
    this.downloads.push({
      task: options.task,
      model: options.model,
      cacheDir: options.cacheDir
    });
    options.onProgress?.({ status: "progress", file: "onnx/model_q8.onnx", progress: 50 });
    this.cached = true;
  }
}

describe("retrieval model cache", () => {
  it("resolves embedding and reranker descriptors from user config", async () => {
    const cacheDir = await mkdtemp(path.join(tmpdir(), "agent-knowledge-model-cache-"));
    tempDirs.push(cacheDir);
    const config = resolveUserConfig({
      embeddings: {
        profile: "bge-small-zh-v1.5",
        cacheDir,
        rerankerProfile: "bge-reranker-large"
      }
    });

    expect(resolveRetrievalModelDescriptor(config.embeddings, "embedding")).toMatchObject({
      kind: "embedding",
      task: "feature-extraction",
      model: "Xenova/bge-small-zh-v1.5",
      cacheDir
    });
    expect(resolveRetrievalModelDescriptor(config.embeddings, "reranker")).toMatchObject({
      kind: "reranker",
      task: "text-classification",
      model: "Xenova/bge-reranker-large",
      cacheDir
    });
  });

  it("checks local cache status without downloading", async () => {
    const adapter = new FakeModelCacheAdapter();
    const descriptor: RetrievalModelDescriptor = {
      kind: "embedding" as const,
      task: "feature-extraction",
      model: "Xenova/multilingual-e5-small",
      cacheDir: "/tmp/cache",
      dtype: "q8"
    };

    const status = await getRetrievalModelStatus(descriptor, adapter);

    expect(status.cached).toBe(false);
    expect(status.missingFiles).toEqual(["onnx/model_q8.onnx"]);
    expect(adapter.downloads).toEqual([]);
  });

  it("downloads explicitly, reports progress, and verifies final status", async () => {
    const adapter = new FakeModelCacheAdapter();
    const progress: number[] = [];
    const descriptor: RetrievalModelDescriptor = {
      kind: "reranker" as const,
      task: "text-classification",
      model: "Xenova/bge-reranker-large",
      cacheDir: "/tmp/cache",
      dtype: "q8"
    };

    const result = await downloadRetrievalModel(descriptor, adapter, (event) => {
      if (typeof event.progress === "number") {
        progress.push(event.progress);
      }
    });

    expect(adapter.downloads).toEqual([
      {
        task: "text-classification",
        model: "Xenova/bge-reranker-large",
        cacheDir: "/tmp/cache"
      }
    ]);
    expect(progress).toEqual([50]);
    expect(result.cached).toBe(true);
    expect(result.missingFiles).toEqual([]);
  });
});
