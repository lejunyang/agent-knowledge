import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSidecarPreset,
  doctorSidecar,
  ingestSidecarItems,
  searchSidecar,
  listSidecarRuns
} from "../src/sidecar/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("shadow sidecar HTTP adapter", () => {
  it("probes health and sends Hindsight retain/recall payloads", async () => {
    const config = createSidecarPreset("hindsight", {
      id: "hindsight-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"status":"ok"}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"accepted":1}', { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [
              {
                text: "Account deletion is irreversible.",
                score: 0.91,
                metadata: { native_memory_id: "k_delete" }
              }
            ]
          }),
          { status: 200 }
        )
      );

    await expect(doctorSidecar(config, { fetch: fetchMock })).resolves.toMatchObject({
      healthy: true,
      provider: "hindsight"
    });
    await ingestSidecarItems(
      config,
      [
        {
          id: "k_delete",
          text: "Account deletion is irreversible.",
          metadata: { domain: "account-deletion" }
        }
      ],
      { fetch: fetchMock }
    );
    const result = await searchSidecar(config, "账号注销能恢复吗", {
      fetch: fetchMock
    });

    expect(result.results[0]).toMatchObject({
      text: "Account deletion is irreversible.",
      score: 0.91,
      nativeMemoryId: "k_delete"
    });
    const [ingestUrl, ingestRequest] = fetchMock.mock.calls[1] as [
      string,
      RequestInit
    ];
    expect(ingestUrl).toContain(
      "/v1/default/banks/merchant-center/memories"
    );
    expect(JSON.stringify(ingestRequest.body)).toContain("k_delete");
    const [searchUrl] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(searchUrl).toContain("/memories/recall");
  });

  it("polls asynchronous memU memorize tasks before searching", async () => {
    const config = createSidecarPreset("memu", {
      id: "memu-cloud",
      baseUrl: "https://api.memu.so",
      scope: "merchant-center"
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"task_id":"task-1"}', { status: 202 })
      )
      .mockResolvedValueOnce(
        new Response('{"status":"running"}', { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response('{"status":"completed"}', { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [{ content: "Merchant account rule", similarity: 0.8 }]
          }),
          { status: 200 }
        )
      );

    const ingested = await ingestSidecarItems(
      config,
      [{ id: "k_rule", text: "Merchant account rule", metadata: {} }],
      {
        fetch: fetchMock,
        environment: { MEMU_API_KEY: "memu-secret" },
        sleep: async () => undefined
      }
    );
    const searched = await searchSidecar(config, "account rule", {
      fetch: fetchMock,
      environment: { MEMU_API_KEY: "memu-secret" }
    });

    expect(ingested.completed).toBe(1);
    expect(searched.results[0]?.text).toBe("Merchant account rule");
    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((request.headers as Record<string, string>).Authorization).toBe(
      "Bearer memu-secret"
    );
    expect(JSON.stringify(request.body)).not.toContain("memu-secret");
  });

  it("records bounded shadow run artifacts without writing knowledge", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-run-"));
    tempDirs.push(root);
    const config = createSidecarPreset("mem0", {
      id: "mem0-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"results":[{"memory":"rule","score":0.7}]}', {
        status: 200
      })
    );

    const result = await searchSidecar(config, "rule", {
      fetch: fetchMock,
      rootDir: root
    });

    expect(result.runId).toMatch(/^sidecar_run_/);
    const runs = await listSidecarRuns(root);
    expect(runs).toHaveLength(1);
    const artifact = await readFile(runs[0]!.artifactPath, "utf8");
    expect(artifact).toContain('"provider": "mem0"');
    expect(artifact).not.toContain('"query": "rule"');
    expect(artifact).not.toContain('"text": "rule"');
    expect(artifact.length).toBeLessThan(100_000);
  });

  it("accepts HTML health endpoints without treating them as search JSON", async () => {
    const config = createSidecarPreset("mem0", {
      id: "mem0-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>Mem0 docs</html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        })
      );

    await expect(
      doctorSidecar(config, { fetch: fetchMock })
    ).resolves.toMatchObject({ healthy: true, status: 200 });
  });
});
