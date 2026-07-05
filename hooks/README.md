# Agent Knowledge Hooks

这些文件是通用 hook 模板，不绑定某个具体 agent 平台。把它们安装到目标 agent 时，需要按目标平台的 hook 格式改写触发条件和变量名。

推荐安装：

- `pre-task-query.md`：任务开始前查询知识并注入 context packet。
- `session-end-memory.md`：会话结束后提取候选知识。
- `task-success-memory.md`：任务成功后沉淀流程、约定和验证经验。
- `task-failure-recovered-memory.md`：失败后修复成功时沉淀排障经验。
- `explicit-remember.md`：用户明确要求“记住”时生成高权威候选。

## 默认 root

所有 hook 都应设置或传入 workspace root：

```bash
export AGENT_KNOWLEDGE_ROOT=/path/to/workspace
```

如果目标平台不方便设置环境变量，则每条命令显式传：

```bash
agent-knowledge query --root /path/to/workspace --task "$CURRENT_TASK"
```

## 安全要求

- hooks 只能写 `_inbox` 候选，不直接写正式目录。
- hooks 不能保存 secret、token、cookie、私钥和隐私原文。
- hooks 产生的候选 JSON 必须经过 `agent-knowledge write-candidate`。
