/** Sidecar presets 提供当前官方常见 endpoint；所有路径仍可在生成配置后显式覆盖。 */
import {
  SidecarConfigSchema,
  SidecarProviderSchema,
  type SidecarConfig,
  type SidecarProvider
} from "./types.js";

type PresetOptions = {
  id: string;
  baseUrl: string;
  scope: string;
};

/** 根据 provider 生成 shadow-only 配置，不启动容器或访问网络。 */
export function createSidecarPreset(
  providerInput: SidecarProvider,
  options: PresetOptions
): SidecarConfig {
  const provider = SidecarProviderSchema.parse(providerInput);
  const common = {
    version: 1 as const,
    id: options.id,
    provider,
    mode: "shadow" as const,
    baseUrl: options.baseUrl.replace(/\/+$/, ""),
    scope: options.scope,
    timeoutMs: 30_000,
    retry: { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    polling: { intervalMs: 1_000, maxAttempts: 30 },
    metadata: {}
  };
  switch (provider) {
    case "hindsight":
      return SidecarConfigSchema.parse({
        ...common,
        endpoints: {
          health: "/health",
          ingest: "/v1/default/banks/{scope}/memories",
          search: "/v1/default/banks/{scope}/memories/recall"
        }
      });
    case "memu":
      return SidecarConfigSchema.parse({
        ...common,
        auth: {
          tokenEnv: "MEMU_API_KEY",
          headerName: "Authorization",
          prefix: "Bearer "
        },
        endpoints: {
          health: "/",
          ingest: "/api/v3/memory/memorize",
          search: "/api/v3/memory/retrieve",
          status: "/api/v3/memory/memorize/status/{task_id}"
        }
      });
    case "mem0":
      return SidecarConfigSchema.parse({
        ...common,
        endpoints: {
          health: "/docs",
          ingest: "/memories",
          search: "/search"
        }
      });
  }
}
