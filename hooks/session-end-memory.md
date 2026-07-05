# Hook: session-end-memory

## 触发时机

一轮会话结束后。

## 目的

从会话中提取候选长期知识。适合沉淀明确偏好、稳定业务事实和可复用经验；不适合保存完整聊天记录。

## 推荐流程

1. 汇总本轮会话，不包含 secret 和隐私原文。
2. 调用 `memory-writer` subagent，生成 candidate JSON。
3. 如果 `should_store` 是 `false`，停止。
4. 保存 candidate JSON 到临时文件。
5. 调用 `agent-knowledge write-candidate` 写入 `_inbox`。

## candidate 输入建议

```json
{
  "event_type": "session_end",
  "task": "$CURRENT_TASK",
  "summary": "$SESSION_SUMMARY",
  "evidence": ["conversation:current-session"],
  "domains": ["$CURRENT_DOMAIN"],
  "scenarios": ["$CURRENT_SCENARIO"],
  "user_confirmed": false
}
```

## 写入命令

```bash
agent-knowledge write-candidate \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --input candidate.json
```

## 注意

会话结束总结默认来源权威性较低，通常应写入 `status: proposed`，等待人工审阅。
