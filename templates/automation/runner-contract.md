# External Agent Runner Contract

`automation service render` 不知道未来使用的 Agent CLI 参数，因此要求用户提供一个绝对路径
wrapper。Wrapper 必须：

1. 读取环境变量：
   - `AGENT_KNOWLEDGE_AUTOMATION_PROFILE`
   - `AGENT_KNOWLEDGE_AUTOMATION_SYSTEM_PROMPT`
   - `AGENT_KNOWLEDGE_ROOT`
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
