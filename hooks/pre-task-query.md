# Hook: pre-task-query

## 触发时机

主 agent 开始执行用户任务之前。

## 目的

根据当前任务、领域和场景查询长期知识，生成 `context packet`，再把 packet 的不同区域注入主 agent 上下文。

## 输入变量

目标平台应提供：

```text
CURRENT_TASK       当前用户任务
CURRENT_DOMAIN     可选，当前领域，如 frontend/lint
CURRENT_SCENARIO   可选，当前场景，如 lint-migration
AGENT_ROLE         可选，默认 main
AGENT_KNOWLEDGE_ROOT  知识库 workspace root
```

## 执行命令

```bash
agent-knowledge index --root "$AGENT_KNOWLEDGE_ROOT"

agent-knowledge query \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --task "$CURRENT_TASK" \
  --domain "$CURRENT_DOMAIN" \
  --scenario "$CURRENT_SCENARIO" \
  --agent-role "${AGENT_ROLE:-main}"
```

## 注入规则

- `always_apply`：作为稳定规则注入。
- `relevant_facts`：作为任务背景注入。
- `procedures`：作为执行流程建议注入。
- `examples`：最多注入 1-2 条。
- `warnings`：作为风险提示注入。
- `sources`：用于追溯，不必全部进入 prompt。

## 失败处理

如果索引或查询失败，主 agent 应继续执行任务，但要告知“知识检索不可用”。不要因为检索失败阻塞用户请求。
