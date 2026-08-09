# External Agent Runner Contract

`automation service render` 不知道未来使用的 Agent CLI 参数，因此要求用户提供一个绝对路径
wrapper。Wrapper 必须：

1. 读取环境变量：
   - `AGENT_KNOWLEDGE_AUTOMATION_PROFILE`
   - `AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT`
   - `AGENT_KNOWLEDGE_ROOT`（renderer 传入 `--workspace` 时提供；否则从已校验 profile 的
     `knowledgeRoot` 读取）
   - `AGENT_KNOWLEDGE_NOTIFICATION_COMMAND`
2. 用指定系统提示词启动外部 Agent CLI。
3. 把 profile 和 schedule window 提供给 Agent。
4. 等待 Agent 完成并透传退出码。
5. 不自行执行 inbox approve、proposal accept 或 active knowledge 写入。

示例 wrapper 形状：

```bash
#!/usr/bin/env bash
set -euo pipefail

export PROFILE="$AGENT_KNOWLEDGE_AUTOMATION_PROFILE"
export SCHEDULE_WINDOW="$(date -u +%Y-%m-%dT%H)"

exec your-agent-cli \
  --system-prompt "$AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT" \
  --prompt "Run the configured Agent Knowledge automation profile."
```

具体 flags 由所选 Agent CLI 决定。凭据继续由 launchd/systemd/container 运行环境或 secret
manager 注入，不写进 wrapper、profile 或生成模板。

需要文件注入时，在 `automation service render` 传：

```text
--environment-file /secure/agent-knowledge/automation.env
```

文件只使用不带 `export` 的单行 `KEY=value`，权限应为 `0600`，不得进入 Git 或 workspace。
不要依赖 shell 展开、多行值或 manager-specific quoting。launchd 模板会由
`/bin/sh` 逐行校验并导出变量，但不会 source 或执行文件内容；systemd 使用
`EnvironmentFile=`；Docker Compose 使用 `env_file`。

Docker 运行还要求：

- `--container-image` 使用固定 tag/digest，且镜像预装 `agent-knowledge`、目标 Agent CLI、
  Git/Lark CLI 和 wrapper 运行时。
- Profile、runner、workspace 在容器内保持 host 同一绝对路径。
- Eval/sidecar config 等只读输入用 `--container-readonly-mount`。
- Git repo、Lark export、report 等需要更新的目录用 `--container-readwrite-mount`。
- 不挂载未授权目录，不使用 `latest`，不在生成模板中构建或下载第三方运行时。
