/** Sidecar scaffold 生成部署/配置起点，不自动拉镜像、启动容器或写凭据。 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSidecarPreset } from "./presets.js";
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

/** 一键接入包允许覆盖稳定身份与 endpoint，不接受凭据原值。 */
export type SidecarScaffoldOptions = {
  id?: string;
  scope?: string;
  baseUrl?: string;
};

/** POSIX shell 单引号转义，保证带空格的生成路径可直接用于 nextCommands。 */
function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

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
  outputDir: string,
  options: SidecarScaffoldOptions = {}
): Promise<SidecarScaffoldResult> {
  const provider = SidecarProviderSchema.parse(providerInput);
  const output = path.resolve(outputDir);
  const defaultBaseUrl =
    provider === "memu" ? "https://api.memu.so" : "http://localhost:8888";
  const config = createSidecarPreset(provider, {
    id: options.id ?? `${provider}-shadow`,
    scope: options.scope ?? "agent-knowledge-shadow",
    baseUrl: options.baseUrl ?? defaultBaseUrl
  });
  await mkdir(output, { recursive: true, mode: 0o700 });
  if (provider === "memu") {
    const envPath = await writeTemplate(
      path.join(output, "memu.env.example"),
      `# Copy to a secure environment file and replace values.
MEMU_BASE_URL=${JSON.stringify(config.baseUrl)}
MEMU_API_KEY=
MEMU_SCOPE=${JSON.stringify(config.scope)}
`
    );
    const configPath = await writeTemplate(
      path.join(output, "sidecar.json"),
      `${JSON.stringify(
        {
          ...config,
          metadata: { ...config.metadata, deployment: "cloud" }
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
        `agent-knowledge sidecar doctor --config ${shellValue(configPath)}`
      ]
    };
  }

  const port = 8888;
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
  const configPath = await writeTemplate(
    path.join(output, "sidecar.json"),
    `${JSON.stringify(
      {
        ...config,
        metadata: {
          ...config.metadata,
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
      `cp ${shellValue(envPath)} ${shellValue(path.join(output, ".env"))}`,
      `docker compose -f ${shellValue(composePath)} up -d`,
      `agent-knowledge sidecar doctor --config ${shellValue(configPath)}`
    ]
  };
}
