# Automation Profile 说明

## 顶层字段

- `version`: 当前固定为 `1`。
- `id`: profile 稳定名称，用于 job 和通知审计。
- `knowledgeRoot`: 绝对 workspace 路径。
- `sources`: Lark/Git allowlist；空数组表示不刷新在线来源。
- `tasks`: 是否 source refresh、audit、maintenance、eval、sidecar compare、callback delivery。
- `agent`: `maxRuntimeMinutes`、`maxQuestions` 和系统提示词绝对路径。
- `callback`: 可选通知 URL、凭据环境变量名、timeout 和 retry。

Profile 不能保存 token、Cookie、密码或 access key 原值。

## Lark source

```json
{
  "kind": "lark",
  "connectorId": "lark-business",
  "roots": ["https://example.larkoffice.com/wiki/token"],
  "exportDir": "/secure/exports/lark-business",
  "identity": "user",
  "maxDocuments": 500,
  "rateLimit": { "minIntervalMs": 250 },
  "retry": {
    "maxAttempts": 3,
    "baseDelayMs": 1000,
    "maxDelayMs": 30000
  }
}
```

- 只访问 roots 引用图。
- 不自行搜索其他知识空间。
- refresh 先轻量 probe，正文变化才重抓。
- 权限失败进入通知，不切换 bot/user 绕过权限。

## Git source

```json
{
  "kind": "git",
  "connectorId": "business-repository",
  "repositoryDir": "/projects/business",
  "remote": "origin",
  "refs": ["main"],
  "retry": {
    "maxAttempts": 2,
    "baseDelayMs": 1000,
    "maxDelayMs": 10000
  }
}
```

Runner 只执行 `git -C <repo> fetch --no-tags <remote> <refs...>`，不 pull、checkout、merge、reset 或 push。

## Callback

```json
{
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
```

Callback 请求体是 `{ "version": 1, "notification": { ... } }`，只含通知 metadata 和脱敏
details。接收方按 `notification.type` 路由；`Idempotency-Key` header 等于 notification ID。

## 定时 Sidecar Compare

```json
{
  "tasks": {
    "sidecarComparisons": [
      {
        "configs": [
          "/secure/sidecars/hindsight/sidecar.json",
          "/secure/sidecars/mem0/sidecar.json"
        ],
        "evalFile": "/secure/eval/business.yaml",
        "outputDir": "/secure/reports/sidecars"
      }
    ]
  }
}
```

Runner 会执行 native lexical baseline 与 sidecar compare。Sidecar 在 passed、false injection
或 abstention failure 上低于 native 时生成 `sidecar_regression` 通知，不会自动替换检索后端。

## 常驻凭据注入

常驻模板可显式传：

```text
--environment-file /secure/agent-knowledge/automation.env
```

文件只使用 `KEY=value`，必须是受控绝对路径、权限 `0600`，不得进入 Git 或 workspace。
launchd 导出文件变量，systemd 使用 `EnvironmentFile=`，Docker Compose 使用 `env_file`。
Profile 和 sidecar config 仍只保存变量名；环境文件缺失或变量未注入时任务应明确失败。

Docker 还必须显式提供固定版本 `--container-image`。镜像需预装 `agent-knowledge`、外部
Agent CLI、Git/Lark CLI 和 wrapper 依赖；profile 引用的 Git repo、export、eval、sidecar
config 和 report 目录要按最小读写权限使用 `--container-readonly-mount` 或
`--container-readwrite-mount` 同路径挂载。
