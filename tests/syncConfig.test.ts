import { describe, expect, it } from "vitest";
import { createConfiguredSyncBackend } from "../src/sync/configured.js";
import { resolveUserConfig } from "../src/core/config.js";

describe("configured sync backend", () => {
  it("builds WebDAV from config and resolves the password environment variable at runtime", () => {
    const config = resolveUserConfig({
      sync: {
        provider: "webdav",
        webdav: {
          url: "https://dav.example.com/memory",
          username: "bot",
          passwordEnv: "BOT_DAV_PASSWORD"
        }
      }
    });

    const backend = createConfiguredSyncBackend(config.sync, {
      BOT_DAV_PASSWORD: "runtime-secret"
    });

    expect(backend.id).toBe("webdav:https://dav.example.com/memory");
  });

  it("rejects missing providers and missing runtime credentials", () => {
    const none = resolveUserConfig({ sync: { provider: "none" } });
    expect(() => createConfiguredSyncBackend(none.sync, {})).toThrow("not configured");

    const s3 = resolveUserConfig({
      sync: {
        provider: "s3",
        s3: {
          bucket: "knowledge",
          region: "us-east-1",
          accessKeyIdEnv: "BOT_ACCESS",
          secretAccessKeyEnv: "BOT_SECRET"
        }
      }
    });
    expect(() => createConfiguredSyncBackend(s3.sync, {})).toThrow("BOT_ACCESS");
  });
});
