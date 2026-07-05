# Hook: task-failure-recovered-memory

## 触发时机

任务中出现失败，并且后续已经定位原因、修复成功、验证通过。

## 目的

沉淀排障路径、失败原因、避免方式和可复用修复经验。这类知识通常属于 `episodic` 或 `procedural`。

## 推荐流程

1. 记录失败现象、根因、修复动作和验证结果。
2. 删除 secret、隐私原文和过长日志。
3. 调用 `memory-writer` subagent 生成候选 JSON。
4. 调用 `agent-knowledge write-candidate` 写入 `_inbox`。

## candidate 输入建议

```json
{
  "event_type": "task_failure_recovered",
  "task": "$CURRENT_TASK",
  "summary": "失败现象：...；根因：...；修复：...；验证：...",
  "evidence": ["conversation:current-session", "verification:pnpm test"],
  "domains": ["$CURRENT_DOMAIN"],
  "scenarios": ["debugging"],
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

不要保存完整报错日志。只保存最小必要错误特征、根因和修复方法。
