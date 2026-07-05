# AGENTS.md

本文件给后续接手本项目的 agent 使用。目标是让 agent 明确项目边界、命令、默认知识库位置、写入规则和安全要求。

## 项目目标

本项目实现一个本地 agent 知识持久化工具：

- `knowledge/**/*.md` 是人类可读事实源。
- `.memory/index.sqlite` 是可重建索引。
- `agent-knowledge query` 输出主 agent 可注入的 `context packet`。
- `agent-knowledge write-candidate` 只写候选知识到 `knowledge/_inbox/`。

不要把索引当成事实源。任何知识更新都应先落到 Markdown，再重建索引。

## 默认位置

CLI 的 workspace root 解析优先级：

1. 命令参数 `--root <dir>`。
2. 环境变量 `AGENT_KNOWLEDGE_ROOT`。
3. 默认路径 `~/.agent_knowledge`。

知识库固定在：

```text
<workspace root>/knowledge/
```

索引固定在：

```text
<workspace root>/.memory/index.sqlite
```

如果需要项目级隔离知识库，必须设置 `--root` 或 `AGENT_KNOWLEDGE_ROOT`。否则多个项目会共享 `~/.agent_knowledge`。

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm build
npm install -g .
npm uninstall -g agent-knowledge
node dist/cli.js --help
```

CLI smoke test：

```bash
node dist/cli.js index --root tests/fixtures/basic-knowledge
node dist/cli.js query \
  --root tests/fixtures/basic-knowledge \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration
```

期望输出包含：

- `k_20260705_frontend_lint_vue_sfc`
- `k_20260705_lint_validation_flow`

## 目录职责

```text
src/types.ts          共享类型
src/schema.ts         Zod 运行时 schema
src/markdown.ts       Markdown/frontmatter 解析和序列化
src/workspace.ts      初始化 knowledge 目录和发现知识文件
src/indexer.ts        从 Markdown 重建 SQLite/FTS5 索引
src/query.ts          查询、过滤、排序和一跳关联扩展
src/contextPacket.ts  将检索结果组装成 context packet
src/governance.ts     候选知识治理策略和 secret-like 扫描
src/inbox.ts          写入 knowledge/_inbox
src/eval.ts           检索评估 harness
src/cli.ts            命令行入口
```

## 代码修改原则

- 优先保持小文件和清晰边界，不要把多个职责合并到一个模块。
- 新增行为必须优先加测试。
- 修改 schema 时同步更新 README、AGENTS 和测试夹具。
- 修改 CLI root 行为时同步更新 README 的“默认位置”章节、AGENTS 的“默认位置”章节和相关测试。
- 修改检索排序时同步更新 eval case 或增加新的 eval case。
- 不要提交 `dist/`、`.memory/`、`node_modules/` 或 `.superpowers/`。

## 知识写入规则

其他 agent 不应直接写 `knowledge/semantic`、`knowledge/procedural` 等正式目录。默认流程：

1. 生成 candidate JSON。
2. 调用 `agent-knowledge write-candidate`。
3. 写入 `knowledge/_inbox/`。
4. 人类审阅后再移动到正式目录并改成 `status: active`。
5. 运行 `agent-knowledge index`。

禁止保存：

- API key、token、cookie、私钥。
- 个人隐私原文。
- 未授权敏感全文。
- 临时路径、一次性命令输出。
- 未验证的模型推断作为 active 事实。

## 给其他 agent 的接入建议

任务开始前：

```bash
agent-knowledge index --root "$AGENT_KNOWLEDGE_ROOT"
agent-knowledge query \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --task "$CURRENT_TASK" \
  --domain "$CURRENT_DOMAIN" \
  --scenario "$CURRENT_SCENARIO"
```

任务结束后：

```bash
agent-knowledge write-candidate \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --input candidate.json
```

将 `templates/trae/agents/memory-writer.md` 复制到目标项目的 `.trae/agents/memory-writer.md`。
将 `templates/trae/hooks.json` 复制到目标项目的 `.trae/hooks.json`。

这些模板是官方格式，仓库内不直接放 `.trae/`，避免把模板误认为当前项目已安装配置。

## 注释约定

源码注释应解释“背景和意图”，不要重复代码表面含义。优先说明：

- 为什么某个模块存在。
- 为什么某个边界不能被绕过。
- 为什么某种安全或治理规则必要。
- 为什么某处是确定性 fallback，而不是完整智能能力。
