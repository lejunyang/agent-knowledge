/**
 * 常驻服务 renderer 只生成 launchd/systemd/Docker 配置，不自动安装或启动系统服务。
 *
 * 具体 Agent CLI 的参数由用户提供的 runner wrapper 决定；本项目只传 profile、系统提示词、
 * workspace 和通知投递命令，避免绑定某一个宿主或把凭据写入模板。
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { z } from "zod";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .refine((value) => path.isAbsolute(value), "expected an absolute path")
  .refine(
    (value) => !/[\0\r\n]/.test(value),
    "absolute path must not contain NUL or line breaks"
  );

const PinnedContainerImageSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/,
    "container image contains unsupported characters"
  )
  .refine(
    (value) =>
      /@sha256:[a-f0-9]{64}$/.test(value) ||
      (/:[A-Za-z0-9_.-]+$/.test(value) && !value.endsWith(":latest")),
    "expected a pinned container image tag or sha256 digest"
  );

export const AutomationServiceOptionsSchema = z
  .object({
    manager: z.enum(["launchd", "systemd", "docker"]),
    label: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    profilePath: AbsolutePathSchema,
    runnerPath: AbsolutePathSchema,
    intervalMinutes: z.number().int().min(1).max(30 * 24 * 60),
    outputDir: AbsolutePathSchema,
    workspacePath: AbsolutePathSchema.optional(),
    systemPromptPath: AbsolutePathSchema.optional(),
    environmentFilePath: AbsolutePathSchema.optional(),
    containerImage: PinnedContainerImageSchema.optional(),
    containerReadOnlyMountPaths: z.array(AbsolutePathSchema).default([]),
    containerReadWriteMountPaths: z.array(AbsolutePathSchema).default([])
  })
  .strict()
  .superRefine((value, context) => {
    if (value.manager === "docker" && !value.workspacePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workspacePath"],
        message: "Docker automation service requires workspacePath"
      });
    }
    if (value.manager === "docker" && !value.containerImage) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["containerImage"],
        message:
          "Docker automation service requires a pinned containerImage"
      });
    }
  });

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

/** POSIX shell 单引号转义，用于返回给用户显式执行的 install/uninstall 命令。 */
function shellValue(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** YAML 双引号值最小转义。 */
function yamlValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Compose 使用长格式 bind mount，避免路径中的冒号或空格破坏 short syntax。 */
function composeBindMount(
  source: string,
  target: string,
  readOnly: boolean
): string {
  return `      - type: bind
        source: ${yamlValue(source)}
        target: ${yamlValue(target)}
${readOnly ? "        read_only: true\n" : ""}`;
}

/** 默认系统提示词相对已安装模块定位，避免从其他工作目录调用时生成失效路径。 */
function defaultSystemPromptPath(): string {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "templates",
    "automation",
    "knowledge-automation-system-prompt.md"
  );
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
      `agent-knowledge notifications deliver --profile ${shellValue(options.profilePath)}`,
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
  // launchd 没有 EnvironmentFile；逐行校验并 export，不能 source 任意 shell 内容。
  const programArguments = options.environmentFilePath
    ? `    <array>
      <string>/bin/sh</string>
      <string>-c</string>
      <string>${escapeXml(`set -eu
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in ""|"#"*) continue ;; esac
  case "$line" in *=*) ;; *) echo "Invalid environment entry without = separator" >&2; exit 64 ;; esac
  key=\${line%%=*}
  case "$key" in ""|[0-9]*|*[!A-Za-z0-9_]*) echo "Invalid environment variable name: $key" >&2; exit 64 ;; esac
  export "$line"
done < "$1"
exec "$2"`)}</string>
      <string>agent-knowledge-environment-loader</string>
      <string>${escapeXml(options.environmentFilePath)}</string>
      <string>${escapeXml(options.runnerPath)}</string>
    </array>`
    : `    <array>
      <string>${escapeXml(options.runnerPath)}</string>
    </array>`;
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
${programArguments}
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
      `cp ${shellValue(target)} "$HOME/Library/LaunchAgents/${label}.plist"`,
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
${options.environmentFilePath ? `EnvironmentFile=${systemdValue(options.environmentFilePath)}\n` : ""}ExecStart=${systemdValue(options.runnerPath)}
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
      `cp ${shellValue(servicePath)} ${shellValue(timerPath)} "$HOME/.config/systemd/user/"`,
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
  // schema 已在任何文件写入前保证 Docker 的 workspace 和 pinned image 都存在。
  const workspacePath = options.workspacePath!;
  const containerImage = options.containerImage!;
  const composePath = path.join(options.outputDir, "compose.yaml");
  const entrypointPath = path.join(options.outputDir, "entrypoint.sh");
  const managedMounts = new Set([
    options.profilePath,
    promptPath,
    options.runnerPath,
    workspacePath
  ]);
  const readWriteMounts = new Set(
    options.containerReadWriteMountPaths.filter(
      (mountPath) => !managedMounts.has(mountPath)
    )
  );
  const additionalMounts = [
    ...[...new Set(options.containerReadOnlyMountPaths)]
      .filter(
        (mountPath) =>
          !managedMounts.has(mountPath) && !readWriteMounts.has(mountPath)
      )
      .map((mountPath) => composeBindMount(mountPath, mountPath, true)),
    ...[...readWriteMounts].map((mountPath) =>
      composeBindMount(mountPath, mountPath, false)
    )
  ].join("\n");
  await writeServiceFile(
    composePath,
    `services:
  knowledge-automation:
    image: ${yamlValue(containerImage)}
    restart: unless-stopped
    stop_grace_period: 30s
${options.environmentFilePath ? `    env_file:\n      - ${yamlValue(options.environmentFilePath)}\n` : ""}    environment:
      AGENT_KNOWLEDGE_AUTOMATION_PROFILE: ${yamlValue(options.profilePath)}
      AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT: ${yamlValue(promptPath)}
      AGENT_KNOWLEDGE_NOTIFICATION_COMMAND: ${yamlValue(`agent-knowledge notifications deliver --profile ${shellValue(options.profilePath)}`)}
      AGENT_KNOWLEDGE_INTERVAL_MINUTES: ${yamlValue(String(options.intervalMinutes))}
      AGENT_KNOWLEDGE_ROOT: ${yamlValue(workspacePath)}
    volumes:
${composeBindMount(options.profilePath, options.profilePath, true)}${composeBindMount(promptPath, promptPath, true)}${composeBindMount(options.runnerPath, options.runnerPath, true)}${composeBindMount(workspacePath, workspacePath, false)}${composeBindMount(entrypointPath, "/automation/entrypoint.sh", true)}${additionalMounts ? `${additionalMounts}\n` : ""}    entrypoint:
      - "/bin/sh"
      - "/automation/entrypoint.sh"
`
  );
  await writeServiceFile(
    entrypointPath,
    `#!/bin/sh
set -u
child_pid=""
stop() {
  if [ -n "$child_pid" ]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
  exit 0
}
trap stop TERM INT

case "$AGENT_KNOWLEDGE_INTERVAL_MINUTES" in
  ""|0|*[!0-9]*) echo "AGENT_KNOWLEDGE_INTERVAL_MINUTES must be a positive integer" >&2; exit 64 ;;
esac

while true; do
  started_at="$(date +%s)"
  ${shellValue(options.runnerPath)} &
  child_pid="$!"
  if wait "$child_pid"; then
    status=0
  else
    status="$?"
    echo "Agent Knowledge automation runner exited with status $status" >&2
  fi
  child_pid=""
  finished_at="$(date +%s)"
  delay="$((AGENT_KNOWLEDGE_INTERVAL_MINUTES * 60 - finished_at + started_at))"
  if [ "$delay" -lt 1 ]; then delay=1; fi
  sleep "$delay" &
  child_pid="$!"
  wait "$child_pid" || true
  child_pid=""
done
`
  );
  await chmod(entrypointPath, 0o700);
  return {
    manager: "docker",
    label: options.label,
    files: [composePath, entrypointPath],
    installCommands: [
      `docker compose -f ${shellValue(composePath)} up -d`
    ],
    uninstallCommands: [
      `docker compose -f ${shellValue(composePath)} down`
    ]
  };
}

/** 渲染指定 manager 模板；不会执行返回的 installCommands。 */
export async function renderAutomationService(
  rawOptions: AutomationServiceOptions
): Promise<AutomationServiceResult> {
  const options = AutomationServiceOptionsSchema.parse(rawOptions);
  const promptSourcePath =
    options.systemPromptPath ?? defaultSystemPromptPath();
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  // 生成目录保存不可变提示词快照，避免 package 更新或临时安装路径让常驻服务失效。
  const promptPath = await writeServiceFile(
    path.join(options.outputDir, "system-prompt.md"),
    await readFile(promptSourcePath, "utf8")
  );
  const result = await (async (): Promise<AutomationServiceResult> => {
    switch (options.manager) {
      case "launchd":
        return renderLaunchd(options, promptPath);
      case "systemd":
        return renderSystemd(options, promptPath);
      case "docker":
        return renderDocker(options, promptPath);
    }
  })();
  return { ...result, files: [...result.files, promptPath] };
}
