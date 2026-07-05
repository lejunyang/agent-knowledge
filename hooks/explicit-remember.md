# Hook: explicit-remember

## 触发时机

用户明确表达记忆意图，例如：

- “记住这个”
- “以后都按这个”
- “这是这个项目的约定”
- “这个业务知识要沉淀下来”

## 目的

把用户显式确认的知识写入候选队列。由于来源是用户确认，`source_authority` 应为 `user_confirmed`，治理策略可以给更高优先级。

## 推荐流程

1. 提取用户明确要求记住的内容。
2. 不要扩写成用户没有确认过的额外推断。
3. 调用 `memory-writer` subagent 生成 candidate JSON。
4. 调用 `agent-knowledge write-candidate` 写入 `_inbox`。

## candidate 输入建议

```json
{
  "event_type": "explicit_remember",
  "task": "$CURRENT_TASK",
  "summary": "$USER_CONFIRMED_MEMORY",
  "evidence": ["conversation:current-session", "user:explicit-remember"],
  "domains": ["$CURRENT_DOMAIN"],
  "scenarios": ["$CURRENT_SCENARIO"],
  "user_confirmed": true
}
```

## 写入命令

```bash
agent-knowledge write-candidate \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --input candidate.json
```

## 注意

即使用户明确要求记住，也不能保存 token、cookie、私钥或其他 secret。
