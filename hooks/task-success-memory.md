# Hook: task-success-memory

## 触发时机

任务完成，并且测试、构建、用户验收或其他验证信号通过后。

## 目的

沉淀成功流程、项目约定、验证步骤和可复用操作方法。相比普通会话总结，成功任务的流程类知识更适合自动进入候选队列。

## 推荐流程

1. 收集任务目标、修改摘要、验证命令和结果。
2. 调用 `memory-writer` subagent。
3. 只允许输出 `procedural`、`episodic` 或明确证据支持的 `semantic`。
4. 调用 `agent-knowledge write-candidate` 写入 `_inbox`。
5. 人类审阅后移动到正式目录。

## candidate 输入建议

```json
{
  "event_type": "task_success",
  "task": "$CURRENT_TASK",
  "summary": "$TASK_SUCCESS_SUMMARY",
  "evidence": ["conversation:current-session", "verification:pnpm test"],
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

不要把“本次刚好成功的临时路径、临时命令输出、一次性环境状态”沉淀为长期知识。
