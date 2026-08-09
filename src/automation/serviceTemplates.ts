/**
 * 常驻服务 renderer 只生成 launchd/systemd/Docker 配置，不自动安装或启动系统服务。
 *
 * 具体 Agent CLI 的参数由用户提供的 runner wrapper 决定；本项目只传 profile、系统提示词、
 * workspace 和通知投递命令，避免绑定某一个宿主或把凭据写入模板。
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "expected an absolute path");

export const AutomationServiceOptionsSchema = z
  .object({
    manager: z.enum(["launchd", "systemd", "docker"]),
    label: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    profilePath: AbsolutePathSchema,
    runnerPath: AbsolutePathSchema,
    intervalMinutes: z.number().int().min(1).max(30 * 24 * 60),
    outputDir: AbsolutePathSchema,
    workspacePath: AbsolutePathSchema.optional(),
    systemPromptPath: AbsolutePathSchema.optional()
  })
  .strict();

export type AutomationServiceOptions = z.input<
  typeof AutomationServiceOptionsSchema
>;

export type AutomationServiceResult = {
  manager: "launchd" | "systemd" | "docker";
  label: string;
  files: string[];
  installCommands: string[];
  uninstallCommands: string[];
};

/** XML attribute/text 最小转义，防止路径中的特殊字符破坏 plist。 */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** systemd Environment 值使用双引号并转义反斜杠/双引号。 */
function systemdValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** YAML 双引号值最小转义。 */
function yamlValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** 统一生成外部 runner 需要的环境变量。 */
function runnerEnvironment(options: {
  profilePath: string;
  systemPromptPath: string;
  workspacePath?: string;
  intervalMinutes: number;
}): Record<string, string> {
  return {
    AGENT_KNOWLEDGE_AUTOMATION_PROFILE: options.profilePath,
    AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT: options.systemPromptPath,
    AGENT_KNOWLEDGE_NOTIFICATION_COMMAND:
      `agent-knowledge notifications deliver --profile ${options.profilePath}`,
    AGENT_KNOWLEDGE_INTERVAL_MINUTES: String(options.intervalMinutes),
    ...(options.workspacePath
      ? { AGENT_KNOWLEDGE_ROOT: options.workspacePath }
      : {})
  };
}

/** 原子性不是系统模板的核心，但权限必须 owner-only，避免本地路径/策略被其他用户修改。 */
async function writeServiceFile(
  target: string,
  content: string
): Promise<string> {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

/** 生成 launchd plist；StartInterval 按秒执行，服务本身不常驻。 */
async function renderLaunchd(
  options: z.output<typeof AutomationServiceOptionsSchema>,
  promptPath: string
): Promise<AutomationServiceResult> {
  const label = `com.agent-knowledge.${options.label}`;
  const environment = runnerEnvironment({
    profilePath: options.profilePath,
    systemPromptPath: promptPath,
    workspacePath: options.workspacePath,
    intervalMinutes: options.intervalMinutes
  });
  const environmentXml = Object.entries(environment)
    .map(
      ([key, value]) =>
        `      <key>${escapeXml(key)}</key>\n      <string>${escapeXml(value)}</string>`
    )
    .join("\n");
  const target = path.join(options.outputDir, `${label}.plist`);
  await writeServiceFile(
    target,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${escapeXml(options.runnerPath)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>StartInterval</key>
    <integer>${options.intervalMinutes * 60}</integer>
    <key>StandardOutPath</key>
    <string>${escapeXml(path.join(options.outputDir, `${options.label}.out.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(path.join(options.outputDir, `${options.label}.err.log`))}</string>
  </dict>
</plist>
`
  );
  return {
    manager: "launchd",
    label: options.label,
    files: [target],
    installCommands: [
      `mkdir -p "$HOME/Library/LaunchAgents"`,
      `cp ${JSON.stringify(target)} "$HOME/Library/LaunchAgents/${label}.plist"`,
      `launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/${label}.plist"`
    ],
    uninstallCommands: [
      `launchctl bootout gui/$(id -u) "$HOME/Library/LaunchAgents/${label}.plist"`,
      `rm "$HOME/Library/LaunchAgents/${label}.plist"`
    ]
  };
}

/** 生成 systemd user oneshot service 和 persistent timer。 */
async function renderSystemd(
  options: z.output<typeof AutomationServiceOptionsSchema>,
  promptPath: string
): Promise<AutomationServiceResult> {
  const unit = `agent-knowledge-${options.label}`;
  const environment = runnerEnvironment({
    profilePath: options.profilePath,
    systemPromptPath: promptPath,
    workspacePath: options.workspacePath,
    intervalMinutes: options.intervalMinutes
  });
  const environmentLines = Object.entries(environment)
    .map(([key, value]) => `Environment=${systemdValue(`${key}=${value}`)}`)
    .join("\n");
  const servicePath = path.join(options.outputDir, `${unit}.service`);
  const timerPath = path.join(options.outputDir, `${unit}.timer`);
  await writeServiceFile(
    servicePath,
    `[Unit]
Description=Agent Knowledge bounded automation (${options.label})
After=network-online.target

[Service]
Type=oneshot
ExecStart=${options.runnerPath}
${environmentLines}

[Install]
WantedBy=default.target
`
  );
  await writeServiceFile(
    timerPath,
    `[Unit]
Description=Schedule Agent Knowledge automation (${options.label})

[Timer]
OnBootSec=1min
OnUnitActiveSec=${options.intervalMinutes}min
Persistent=true
Unit=${unit}.service

[Install]
WantedBy=timers.target
`
  );
  return {
    manager: "systemd",
    label: options.label,
    files: [servicePath, timerPath],
    installCommands: [
      `mkdir -p "$HOME/.config/systemd/user"`,
      `cp ${JSON.stringify(servicePath)} ${JSON.stringify(timerPath)} "$HOME/.config/systemd/user/"`,
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${unit}.timer`
    ],
    uninstallCommands: [
      `systemctl --user disable --now ${unit}.timer`,
      `rm "$HOME/.config/systemd/user/${unit}.service" "$HOME/.config/systemd/user/${unit}.timer"`,
      "systemctl --user daemon-reload"
    ]
  };
}

/** 生成容器循环模板；runner/profile/workspace 都由 host 显式只读或读写挂载。 */
async function renderDocker(
  options: z.output<typeof AutomationServiceOptionsSchema>,
  promptPath: string
): Promise<AutomationServiceResult> {
  if (!options.workspacePath) {
    throw new Error("Docker automation service requires workspacePath");
  }
  const composePath = path.join(options.outputDir, "compose.yaml");
  const dockerfilePath = path.join(options.outputDir, "Dockerfile");
  const entrypointPath = path.join(options.outputDir, "entrypoint.sh");
  await writeServiceFile(
    composePath,
    `services:
  knowledge-automation:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    environment:
      AGENT_KNOWLEDGE_AUTOMATION_PROFILE: "/config/profile.json"
      AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT: "/config/system-prompt.md"
      AGENT_KNOWLEDGE_NOTIFICATION_COMMAND: "agent-knowledge notifications deliver --profile /config/profile.json"
      AGENT_KNOWLEDGE_INTERVAL_MINUTES: ${yamlValue(String(options.intervalMinutes))}
      AGENT_KNOWLEDGE_ROOT: "/data/agent-knowledge"
    volumes:
      - ${yamlValue(`${options.profilePath}:/config/profile.json:ro`)}
      - ${yamlValue(`${promptPath}:/config/system-prompt.md:ro`)}
      - ${yamlValue(`${options.runnerPath}:/runner/external-agent:ro`)}
      - ${yamlValue(`${options.workspacePath}:/data/agent-knowledge`)}
`
  );
  await writeServiceFile(
    dockerfilePath,
    `FROM node:22-bookworm-slim
WORKDIR /app
COPY entrypoint.sh /entrypoint.sh
RUN chmod 0755 /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
`
  );
  await writeServiceFile(
    entrypointPath,
    `#!/bin/sh
set -eu
while true; do
  /runner/external-agent
  sleep "$((AGENT_KNOWLEDGE_INTERVAL_MINUTES * 60))"
done
`
  );
  await chmod(entrypointPath, 0o700);
  return {
    manager: "docker",
    label: options.label,
    files: [composePath, dockerfilePath, entrypointPath],
    installCommands: [
      `docker compose -f ${JSON.stringify(composePath)} up -d --build`
    ],
    uninstallCommands: [
      `docker compose -f ${JSON.stringify(composePath)} down`
    ]
  };
}

/** 渲染指定 manager 模板；不会执行返回的 installCommands。 */
export async function renderAutomationService(
  rawOptions: AutomationServiceOptions
): Promise<AutomationServiceResult> {
  const options = AutomationServiceOptionsSchema.parse(rawOptions);
  const promptPath =
    options.systemPromptPath ??
    path.resolve(
      process.cwd(),
      "templates",
      "automation",
      "knowledge-automation-system-prompt.md"
    );
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  switch (options.manager) {
    case "launchd":
      return renderLaunchd(options, promptPath);
    case "systemd":
      return renderSystemd(options, promptPath);
    case "docker":
      return renderDocker(options, promptPath);
  }
}
