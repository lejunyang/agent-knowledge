# 候选知识与主动记忆

其他 Agent 默认只能写 `_inbox`：

```bash
agent-knowledge write-candidate --input candidate.json
```

候选会经过 secret-like 扫描、来源治理、去重和 schema 校验。

## 客服与自动会话

`actor_type: customer` 或 `capture_mode: automated_session` 永远保持 `proposed`。机器人部署建议在配置向导中设置：

- `actorType = customer`
- `captureMode = automated_session`
- visibility 为 `project,team`
- sensitivity 为 `internal`

## 主动记忆

TRAE Hook 会异步记录脱敏事件：

```bash
agent-knowledge staging status
agent-knowledge staging drain --limit 100
```

Staging 只保存 hash、长度、agent type、reason 和 project ID，不保存完整 prompt、response 或 tool payload。`memory-maintainer` Skill 负责审阅并生成保守候选。

## 整理

```bash
agent-knowledge list
agent-knowledge organize-inbox
agent-knowledge organize-inbox --apply
```

Customer/automated candidate 不会被批量晋升。受信 replacement 可通过 `supersedes` 把旧知识标记为 deprecated。
