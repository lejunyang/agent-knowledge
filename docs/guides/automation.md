# 后台 Agent、通知回调与常驻运行

## 架构

后台自动化分成两层：

```text
确定性 runner
  -> allowlist 在线刷新
  -> source refresh / audit / maintenance / eval
  -> job + notification outbox

外部 Agent CLI
  -> 读取系统提示词和 profile
  -> 解释 findings
  -> 一次汇总确认问题
  -> enqueue + deliver callback
```

确定性 runner 控制范围、限流、重试、timeout、幂等和不允许的写入。外部 Agent 负责语义
判断，但不能修改 active knowledge、批准 inbox 或接受 proposal。

## Automation Profile

示例：

```json
{
  "version": 1,
  "id": "business-refresh",
  "knowledgeRoot": "/secure/agent-knowledge-data",
  "sources": [
    {
      "kind": "lark",
      "connectorId": "lark-business",
      "roots": [
        "https://example.larkoffice.com/wiki/root-token"
      ],
      "exportDir": "/secure/exports/lark-business",
      "identity": "user",
      "maxDocuments": 500,
      "rateLimit": {
        "minIntervalMs": 250
      },
      "retry": {
        "maxAttempts": 3,
        "baseDelayMs": 1000,
        "maxDelayMs": 30000
      }
    },
    {
      "kind": "git",
      "connectorId": "business-repository",
      "repositoryDir": "/projects/business",
      "remote": "origin",
      "refs": [
        "main"
      ],
      "retry": {
        "maxAttempts": 2,
        "baseDelayMs": 1000,
        "maxDelayMs": 10000
      }
    }
  ],
  "tasks": {
    "refreshSources": true,
    "maintenance": true,
    "audit": true,
    "evalFiles": [
      "/secure/eval/business.yaml"
    ],
    "sidecarComparisons": [
      {
        "configs": [
          "/secure/sidecars/hindsight/sidecar.json",
          "/secure/sidecars/mem0/sidecar.json"
        ],
        "evalFile": "/secure/eval/business.yaml",
        "outputDir": "/secure/reports/sidecars"
      }
    ],
    "deliverNotifications": true
  },
  "agent": {
    "maxRuntimeMinutes": 30,
    "maxQuestions": 20,
    "systemPrompt": "/opt/agent-knowledge/templates/automation/knowledge-automation-system-prompt.md"
  },
  "callback": {
    "url": "https://notify.example.com/agent-knowledge",
    "tokenEnv": "AGENT_KNOWLEDGE_CALLBACK_TOKEN",
    "headerName": "Authorization",
    "headerPrefix": "Bearer ",
    "timeoutMs": 10000,
    "retry": {
      "maxAttempts": 4,
      "baseDelayMs": 1000,
      "maxDelayMs": 30000
    }
  }
}
```

Profile 只能保存凭据环境变量名，不保存 token、Cookie、密码或 key 原值。

## 运行

先检查计划：

```bash
agent-knowledge automation validate --profile /secure/profile.json
agent-knowledge automation inspect --profile /secure/profile.json
```

手工执行：

```bash
agent-knowledge automation run \
  --profile /secure/profile.json \
  --idempotency-key 2026-08-09T12 \
  --no-deliver
```

查看状态：

```bash
agent-knowledge automation status --profile /secure/profile.json
agent-knowledge notifications list --root /secure/agent-knowledge-data
```

`idempotency-key` 应使用 scheduler window 或外部 task ID，同一 key 重试会复用同一个 job。

## 外部 Agent CLI

系统提示词位于：

```text
templates/automation/knowledge-automation-system-prompt.md
```

Skill 位于：

```text
.trae/skills/knowledge-automation-operator/
```

外部 Agent CLI wrapper 契约见：

```text
templates/automation/runner-contract.md
```

Wrapper 负责把 profile/system prompt 传给所选 Agent CLI。本项目不假设 Claude、Codex、
TRAE 或其他 CLI 的参数完全一致。

## 通知回调

Runner 会生成：

- `confirmation_required`
- `source_updates_found`
- `source_refresh_failed`
- `inventory_incomplete`
- `maintenance_proposals_ready`
- `eval_regression`
- `sidecar_regression`
- `automation_failed`

外部 Agent 可写一次汇总问题包：

```bash
agent-knowledge notifications enqueue \
  --root /secure/agent-knowledge-data \
  --input questions.json
```

投递：

```bash
agent-knowledge notifications deliver --profile /secure/profile.json
```

Callback 请求包含 `Idempotency-Key: <notification-id>`。408、429 和 5xx 会有界重试；
其他 4xx 视为配置或权限问题。Callback envelope 不包含 Vault evidence、完整会话或凭据。
请求体固定为：

```json
{
  "version": 1,
  "notification": {
    "id": "notification_...",
    "type": "confirmation_required",
    "severity": "warning",
    "title": "需要确认",
    "summary": "发现待确认项。",
    "details": {
      "questionCount": 1
    },
    "createdAt": "2026-08-09T00:00:00.000Z"
  }
}
```

接收方应按 `notification.type` 路由，用 header 中的 `Idempotency-Key` 去重；处理完成后由可信
流程调用本地 `notifications ack`，不要让公网 callback 直接修改知识库。

处理后：

```bash
agent-knowledge notifications ack \
  --root /secure/agent-knowledge-data \
  <notification-id>
```

## launchd

```bash
agent-knowledge automation service render \
  --manager launchd \
  --label business-refresh \
  --profile /secure/profile.json \
  --runner /opt/agent-runners/run-knowledge-agent \
  --environment-file /secure/agent-knowledge/automation.env \
  --interval-minutes 30 \
  --output /secure/generated/launchd
```

命令只生成 plist 和 install/uninstall 命令，不调用 `launchctl`。launchd 没有原生
`EnvironmentFile`，生成的 plist 会逐行校验并导出该文件中的 `KEY=value`，但不会
`source` 或执行文件内容，然后再 `exec` 外部 runner。

## systemd

```bash
agent-knowledge automation service render \
  --manager systemd \
  --label business-refresh \
  --profile /secure/profile.json \
  --runner /opt/agent-runners/run-knowledge-agent \
  --environment-file /secure/agent-knowledge/automation.env \
  --interval-minutes 30 \
  --output /secure/generated/systemd
```

生成 user oneshot service + persistent timer，并用 `EnvironmentFile=` 加载凭据；不调用
`systemctl`。

## Docker

```bash
agent-knowledge automation service render \
  --manager docker \
  --label business-refresh \
  --profile /secure/profile.json \
  --runner /opt/agent-runners/run-knowledge-agent \
  --environment-file /secure/agent-knowledge/automation.env \
  --container-image registry.example.com/agent-knowledge:v1.2.3 \
  --container-readonly-mount /secure/eval /secure/sidecars \
  --container-readwrite-mount /projects/business /secure/exports /secure/reports \
  --interval-minutes 30 \
  --workspace /secure/agent-knowledge-data \
  --output /secure/generated/docker
```

生成 compose、entrypoint 和系统提示词快照，不构建镜像、不拉镜像、不启动容器：

- `--container-image` 必须是固定 tag 或 digest，不能是 `latest`；镜像必须已安装
  `agent-knowledge`、选定的外部 Agent CLI、Git、Lark CLI 及 wrapper 需要的运行时。
- Profile、runner 和系统提示词按同一绝对路径只读挂载；knowledge workspace 按同一绝对路径
  读写挂载。这样 profile 内的路径在 host/container 中含义一致。
- `--container-readonly-mount` 用于 eval、sidecar config 等只读输入。
- `--container-readwrite-mount` 用于需要 `git fetch` 的 repo、Lark export 和 sidecar report
  输出目录。不要为了省事把整个 host 根目录挂入容器。
- Compose 使用 `env_file` 注入凭据；生产环境也可在审阅生成文件后替换成容器平台的 secret
  manager。
- 循环按“本轮开始时间 + interval”调度；单轮超过 interval 时下一轮至少等待一秒，不并发重叠。
- 容器收到 TERM/INT 时会把信号转发给当前 wrapper，保留有界退出机会。

## 生成文件生命周期

三类 renderer 都会把实际使用的系统提示词复制为输出目录中的 `system-prompt.md`，并返回
`files`、`installCommands` 和 `uninstallCommands`：

- 安装前审阅所有文件和命令；renderer 本身不执行这些命令。
- 安装后不要删除、移动或让其他用户修改输出目录；launchd/systemd/Docker 都会继续引用其中的
  提示词、日志或 entrypoint。
- 修改 profile、wrapper、提示词、interval、镜像或挂载后，重新 render 并按返回命令重装。
- `--system-prompt` 可指定自定义输入；renderer 仍会保存 0600 快照，避免全局 npm 包升级后路径
  漂移。

## 凭据环境文件

`--environment-file` 是可选参数；需要在线飞书、callback 或 sidecar 认证时建议显式提供。文件
使用简单 `KEY=value`，例如：

```dotenv
AGENT_KNOWLEDGE_CALLBACK_TOKEN=replace-me
LARK_CLI_USER_ACCESS_TOKEN=replace-me
MEM0_API_KEY=replace-me
```

- 文件必须位于受控绝对路径，并设置 `chmod 600`。
- 不要提交到 Git，不要放在 workspace、生成模板目录或同步目录。
- 为兼容三类 manager，只使用不带 `export` 的单行 `KEY=value`，不要依赖 shell 展开、多行值或
  manager-specific quoting。
- launchd 只接受合法变量名和含 `=` 的单行值，不执行其中的 shell 命令；仍应只允许 owner
  修改。
- systemd 和 Docker 要求文件存在；缺失时任务应明确失败，不能静默匿名降级。
- Profile 和 sidecar config 继续只保存变量名，不保存凭据原值。
- 使用云端 secret manager 时，可不传该参数，改由平台在启动 runner 前注入同名环境变量。

## 安全与恢复

- Lark 只遍历 profile roots 的引用图。
- Git/GitHub 仓库只通过已有 checkout 执行 allowlist remote/refs 的 `git fetch`，不
  pull/checkout/merge/reset/push；GitHub issue、PR/MR API 不在当前 runner 范围。
- 达到 timeout/retry/runtime/maxQuestions 后停止。
- Inventory incomplete 保留告警。
- Eval regression 不自动调阈值或切换 pipeline。
- Sidecar 低于 native baseline 时生成 `sidecar_regression`，不自动替换 backend。
- Maintenance proposal 不自动接受。
- Callback 失败不会删除 outbox。
- 凭据环境文件缺失或变量未注入时明确失败，不回退匿名访问。
- 所有 job/notification/delivery 状态只在 `.memory`，不进入 Git 或同步。
