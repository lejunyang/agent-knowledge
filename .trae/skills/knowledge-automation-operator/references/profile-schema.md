# Automation Profile 说明

## 顶层字段

- `version`: 当前固定为 `1`。
- `id`: profile 稳定名称，用于 job 和通知审计。
- `knowledgeRoot`: 绝对 workspace 路径。
- `sources`: Lark/Git allowlist；空数组表示不刷新在线来源。
- `tasks`: 是否 source refresh、audit、maintenance、eval、callback delivery。
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

Callback envelope 只含通知 metadata 和脱敏 details。`Idempotency-Key` 等于 notification ID。
