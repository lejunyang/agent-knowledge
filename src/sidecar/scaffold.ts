/** Sidecar scaffold 生成部署/配置起点，不自动拉镜像、启动容器或写凭据。 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SidecarProviderSchema,
  type SidecarProvider
} from "./types.js";

export type SidecarScaffoldResult = {
  provider: SidecarProvider;
  outputDir: string;
  files: string[];
  nextCommands: string[];
};

/** 写 owner-only 模板文件。 */
async function writeTemplate(
  target: string,
  content: string,
  executable = false
): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await chmod(target, executable ? 0o700 : 0o600);
  return target;
}

/** 为 Hindsight/memU/Mem0 生成一键接入骨架；上游版本和模型配置仍需用户审阅。 */
export async function scaffoldSidecar(
  providerInput: SidecarProvider,
  outputDir: string
): Promise<SidecarScaffoldResult> {
  const provider = SidecarProviderSchema.parse(providerInput);
  const output = path.resolve(outputDir);
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (provider === "memu") {
    const envPath = await writeTemplate(
      path.join(output, "memu.env.example"),
      `# Copy to a secure environment file and replace values.
MEMU_BASE_URL=https://api.memu.so
MEMU_API_KEY=
MEMU_SCOPE=agent-knowledge-shadow
`
    );
    const configPath = await writeTemplate(
      path.join(output, "sidecar.json"),
      `${JSON.stringify(
        {
          version: 1,
          id: "memu-shadow",
          provider: "memu",
          mode: "shadow",
          baseUrl: "https://api.memu.so",
          scope: "agent-knowledge-shadow",
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
          },
          timeoutMs: 30000,
          retry: {
            maxAttempts: 3,
            baseDelayMs: 1000,
            maxDelayMs: 30000
          },
          polling: { intervalMs: 1000, maxAttempts: 30 },
          metadata: { deployment: "cloud" }
        },
        null,
        2
      )}\n`
    );
    return {
      provider,
      outputDir: output,
      files: [envPath, configPath],
      nextCommands: [
        `agent-knowledge sidecar doctor --config ${JSON.stringify(configPath)}`
      ]
    };
  }

  const port = 8888;
  const baseUrl = new URL(`http:localhost:${port}`).toString().replace(/\/$/, "");
  const serviceName =
    provider === "hindsight" ? "hindsight" : "mem0";
  const image =
    provider === "hindsight"
      ? "${HINDSIGHT_IMAGE:?Set a pinned HINDSIGHT_IMAGE}"
      : "${MEM0_IMAGE:?Set a pinned MEM0_IMAGE}";
  const composePath = await writeTemplate(
    path.join(output, "compose.yaml"),
    `services:
  ${serviceName}:
    image: "${image}"
    restart: unless-stopped
    ports:
      - "${port}:${port}"
    env_file:
      - .env
    volumes:
      - "./data:/data"
`
  );
  const envPath = await writeTemplate(
    path.join(output, ".env.example"),
    `# Pin an upstream image tag before production use.
${provider === "hindsight" ? "HINDSIGHT_IMAGE" : "MEM0_IMAGE"}=
# Add provider-specific model/API settings here. Do not commit the real .env.
`
  );
  const config = provider === "hindsight"
    ? {
        version: 1,
        id: "hindsight-shadow",
        provider: "hindsight",
        mode: "shadow",
        baseUrl,
        scope: "agent-knowledge-shadow",
        endpoints: {
          health: "/health",
          ingest: "/v1/default/banks/{scope}/memories",
          search: "/v1/default/banks/{scope}/memories/recall"
        }
      }
    : {
        version: 1,
        id: "mem0-shadow",
        provider: "mem0",
        mode: "shadow",
        baseUrl,
        scope: "agent-knowledge-shadow",
        endpoints: {
          health: "/docs",
          ingest: "/memories",
          search: "/search"
        }
      };
  const configPath = await writeTemplate(
    path.join(output, "sidecar.json"),
    `${JSON.stringify(
      {
        ...config,
        timeoutMs: 30000,
        retry: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30000
        },
        polling: { intervalMs: 1000, maxAttempts: 30 },
        metadata: {
          deployment: "docker-compose",
          upstreamVersion: "pin-before-production"
        }
      },
      null,
      2
    )}\n`
  );
  return {
    provider,
    outputDir: output,
    files: [composePath, envPath, configPath],
    nextCommands: [
      `cp ${JSON.stringify(envPath)} ${JSON.stringify(path.join(output, ".env"))}`,
      `docker compose -f ${JSON.stringify(composePath)} up -d`,
      `agent-knowledge sidecar doctor --config ${JSON.stringify(configPath)}`
    ]
  };
}
