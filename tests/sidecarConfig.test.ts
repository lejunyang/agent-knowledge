import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SidecarConfigSchema,
  createSidecarPreset,
  readSidecarConfig,
  writeSidecarConfig
} from "../src/sidecar/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("shadow sidecar configuration", () => {
  it("creates editable Hindsight, memU, and Mem0 presets", () => {
    const hindsight = createSidecarPreset("hindsight", {
      id: "hindsight-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });
    const memu = createSidecarPreset("memu", {
      id: "memu-cloud",
      baseUrl: "https://api.memu.so",
      scope: "merchant-center"
    });
    const mem0 = createSidecarPreset("mem0", {
      id: "mem0-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });

    expect(hindsight.endpoints).toMatchObject({
      ingest: "/v1/default/banks/{scope}/memories",
      search: "/v1/default/banks/{scope}/memories/recall"
    });
    expect(memu.endpoints).toMatchObject({
      ingest: "/api/v3/memory/memorize",
      search: "/api/v3/memory/retrieve",
      status: "/api/v3/memory/memorize/status/{task_id}"
    });
    expect(mem0.endpoints).toMatchObject({
      ingest: "/memories",
      search: "/search"
    });
    expect(hindsight.mode).toBe("shadow");
    expect(memu.auth?.tokenEnv).toBe("MEMU_API_KEY");
    expect(mem0.scope).toBe("merchant-center");
  });

  it("persists owner-only config and rejects embedded credentials", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ak-sidecar-config-"));
    tempDirs.push(root);
    const target = path.join(root, "hindsight.json");
    const preset = createSidecarPreset("hindsight", {
      id: "hindsight-local",
      baseUrl: "http://localhost:8888",
      scope: "merchant-center"
    });

    await writeSidecarConfig(target, preset);

    expect((await stat(target)).mode & 0o777).toBe(0o600);
    await expect(readSidecarConfig(target)).resolves.toEqual(preset);
    expect(await readFile(target, "utf8")).not.toContain("actual-secret");
    expect(() =>
      SidecarConfigSchema.parse({
        ...preset,
        auth: { token: "actual-secret" }
      })
    ).toThrow();
  });
});
