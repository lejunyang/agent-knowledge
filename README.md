# Agent Knowledge

Agent Knowledge 是一个本地知识持久化工具包，用来让多个 agent 共享一套可读、可审计、可检索的项目知识库。

它的核心设计是：

- Markdown 是唯一事实源，便于人类阅读、审阅和 git diff。
- SQLite FTS5 是可重建索引，负责全文检索和 BM25 排序。
- CLI 输出结构化 `context packet`，供其他 agent 注入上下文。
- 自动沉淀先写入 `knowledge/_inbox`，避免模型总结直接污染长期知识。

## 默认位置

默认情况下，CLI 把当前工作目录当作 workspace root：

```bash
agent-knowledge query --task "审查 lint 迁移方案"
```

这时默认知识库位置是：

```text
<当前工作目录>/knowledge/
```

默认索引位置是：

```text
<当前工作目录>/.memory/index.sqlite
```

可以用两种方式指定位置：

```bash
# 方式 1：每次命令显式指定 workspace root
agent-knowledge query --root /path/to/workspace --task "审查 lint 迁移方案"

# 方式 2：给 agent 进程设置环境变量
export AGENT_KNOWLEDGE_ROOT=/path/to/workspace
agent-knowledge query --task "审查 lint 迁移方案"
```

`--root` 优先级高于 `AGENT_KNOWLEDGE_ROOT`。如果两者都没有提供，则使用命令执行时的当前目录。

## 安装与构建

```bash
pnpm install
pnpm build
```

本地开发时也可以直接运行源码：

```bash
pnpm dev -- --help
```

构建后 CLI 入口是：

```bash
node dist/cli.js --help
```

## 初始化知识库

```bash
agent-knowledge init --root /path/to/workspace
```

会创建：

```text
knowledge/
  README.md
  _catalog.md
  _conflicts.md
  _review_queue.md
  _inbox/
  _archive/
  profile/
  semantic/
  episodic/
  procedural/
  sources/
```

## 重建索引

每次知识文件新增、删除或修改后，先重建索引：

```bash
agent-knowledge index --root /path/to/workspace
```

索引只读取 `status: active` 的 Markdown 知识文件。`_inbox` 中的候选知识默认不会参与注入。

## 查询上下文

其他 agent 在开始任务前，应先查询相关知识：

```bash
agent-knowledge query \
  --root /path/to/workspace \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration
```

输出是 `context packet`：

```json
{
  "context_version": "1.0",
  "scene": {
    "task_type": "main",
    "domains": ["frontend/lint"],
    "scenarios": ["lint-migration"]
  },
  "always_apply": [],
  "relevant_facts": [],
  "procedures": [],
  "examples": [],
  "warnings": [],
  "sources": []
}
```

建议注入规则：

- `always_apply`：放到高优先级上下文，作为稳定规则。
- `relevant_facts`：放到任务背景，作为当前任务应知道的事实。
- `procedures`：放到执行提示，作为建议流程。
- `examples`：最多选 1-2 条，作为相似案例。
- `warnings`：作为风险提示，不要忽略冲突或过期提醒。
- `sources`：保留给审计和追溯，不必全部塞进 prompt。

## 写入候选知识

其他 agent 不应直接写正式知识目录。需要沉淀知识时，先写候选 JSON：

```json
{
  "title": "Lint 迁移验证流程",
  "memory_type": "procedural",
  "domain": "frontend/lint",
  "related_domains": ["ci/performance"],
  "scenario": ["lint-migration"],
  "tags": ["oxlint", "eslint"],
  "confidence": 0.72,
  "source_authority": "model_inferred",
  "summary": "迁移 lint 配置后应按 Oxlint -> ESLint fallback -> Oxfmt 顺序验证。",
  "evidence": ["conversation:current-session"]
}
```

然后运行：

```bash
agent-knowledge write-candidate --root /path/to/workspace --input candidate.json
```

工具会：

- 扫描 secret-like 内容。
- 计算默认治理状态。
- 生成合法 Markdown。
- 写入 `knowledge/_inbox/`。

## 给其他 agents 使用

推荐安装以下文件到对应 agent：

- `agents/memory-writer.subagent.md`：用于把事件摘要转成候选知识 JSON。
- `hooks/pre-task-query.md`：任务开始前查询知识并生成注入上下文。
- `hooks/session-end-memory.md`：会话结束后提取候选知识。
- `hooks/task-success-memory.md`：任务成功后沉淀流程和项目约定。
- `hooks/task-failure-recovered-memory.md`：失败后修复成功时沉淀排障经验。
- `hooks/explicit-remember.md`：用户明确说“记住”时沉淀高权威候选。

通用接入顺序：

1. 任务开始：运行 `agent-knowledge index`。
2. 任务开始：运行 `agent-knowledge query`，把 `context packet` 注入主 agent。
3. 任务结束：由 hooks 生成事件摘要。
4. 需要沉淀：调用 memory-writer subagent 生成 candidate JSON。
5. 写入候选：运行 `agent-knowledge write-candidate`。
6. 人类审阅：把 `_inbox` 中的候选移动到正式目录并改为 `status: active`。
7. 审阅后：再次运行 `agent-knowledge index`。

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/cli.js --help
```

## 设计文档

- `docs/superpowers/specs/2026-07-05-agent-knowledge-persistence-design.md`
- `docs/superpowers/specs/2026-07-05-agent-memory-research.md`
- `docs/superpowers/plans/2026-07-05-agent-knowledge-persistence.md`
