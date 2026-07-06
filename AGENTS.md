# AGENTS.md

本文件给后续接手本项目的 agent 使用。目标是让 agent 明确项目边界、命令、默认知识库位置、写入规则和安全要求。

## 项目目标

本项目实现一个本地 agent 知识持久化工具：

- `knowledge/**/*.md` 是人类可读事实源。
- `.memory/index.sqlite` 是可重建索引。
- `.memory/embeddings/index.jsonl` 是可重建本地 embedding 缓存，不是事实源。
- `.memory/logs/*.jsonl` 是可重建运行日志，只用于调试和审计摘要。
- `agent-knowledge query` 输出主 agent 可注入的 `context packet`，`--debug` 附带 scorer/reranker 和分项分数。
- `agent-knowledge embed-index` 使用本地 provider 生成 embedding 缓存；`agent-knowledge suggest-aliases` 只输出 dry-run JSON 建议。
- `agent-knowledge write-candidate` 只写候选知识到 `knowledge/_inbox/`。
- 知识 frontmatter 支持可选 `aliases`，用于查询别名扩展和 catalog registry 暴露，不替代规范 `domain` / `scenario`。

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

运行日志固定在：

```text
<workspace root>/.memory/logs/YYYY-MM-DD.jsonl
```

embedding 缓存固定在：

```text
<workspace root>/.memory/embeddings/index.jsonl
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
node dist/cli.js catalog --root tests/fixtures/basic-knowledge --no-write
node dist/cli.js embed-index --root tests/fixtures/basic-knowledge --provider local
node dist/cli.js suggest-aliases --root tests/fixtures/basic-knowledge --provider local
node dist/cli.js link-trae-templates --target-dir /tmp/agent-knowledge-link-smoke
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

CLI debug：

```bash
node dist/cli.js query \
  --root tests/fixtures/basic-knowledge \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration \
  --debug
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
src/scoring.ts        可插拔 embedding scorer 和默认 reranker
src/embeddings.ts     本地 embedding provider、JSONL store 和 aliases dry-run 建议
src/contextPacket.ts  将检索结果组装成 context packet
src/catalog.ts        生成 catalog API 和 knowledge/_catalog.md
src/logging.ts        写入 .memory/logs JSONL 运行摘要
src/governance.ts     候选知识治理策略和 secret-like 扫描
src/inbox.ts          写入 knowledge/_inbox
src/feedback.ts       记录 memory usefulness 反馈到 JSONL 日志
src/organizer.ts      主动整理 inbox 和用户直接提供的材料
src/eval.ts           检索评估 harness
src/cli.ts            命令行入口
```

## 代码修改原则

- 优先保持小文件和清晰边界，不要把多个职责合并到一个模块。
- 新增行为必须优先加测试。
- 修改 schema 时同步更新 README、AGENTS 和测试夹具。`aliases` 字段是可选数组，默认空数组；新增知识如有常用简称、旧称或用户自然说法，应写入 `aliases`，但不要把它当作事实来源。`related_knowledge` 可用于候选输入和直接材料捕获，只有能指向明确已有或同批可生成的知识 ID 时才填写。
- 修改 CLI root 行为时同步更新 README 的“默认位置”章节、AGENTS 的“默认位置”章节和相关测试。
- active 知识落盘目录必须保留 domain 的层级结构，例如 `bytedance/business/account` 写到 `knowledge/semantic/bytedance/business/account/`，不要压平成 `bytedance-business-account`。
- 修改检索排序时同步更新 eval case 或增加新的 eval case。
- 测试不得依赖网络或远程模型；embedding 相关测试必须使用 `DeterministicLocalEmbeddingProvider` 或 CLI `--provider local`。
- Transformers.js provider 默认禁止远程模型下载；只有人工 CLI 调试时才显式传 `--allow-remote-models`。
- `query` 不应在缺少 domain/scenario 且 FTS 无命中时回退全表；如修改 fallback 策略，必须更新 debug 输出和测试。
- 任何会影响对外 agent 使用流程的改动，都必须 review `templates/trae/`：
  - Hook 行为、事件、命令或注入上下文变化时，检查 `templates/trae/hooks.json` 和 `templates/trae/README.md`。
  - Subagent 输入、输出、frontmatter、工具权限或候选 JSON 字段变化时，检查 `templates/trae/agents/memory-writer.md`。
  - 模板必须遵循 TRAE 官方 Subagent Markdown + YAML frontmatter 格式和 Hook `version: 1` JSON 配置格式。
- 不要提交 `dist/`、`.memory/`、`node_modules/` 或 `.superpowers/`。

## 知识写入规则

其他 agent 不应直接写 `knowledge/semantic`、`knowledge/procedural` 等正式目录。默认流程：

1. 生成 candidate JSON。
2. 调用 `agent-knowledge write-candidate`。
3. 写入 `knowledge/_inbox/`。
4. 人类审阅后再移动到正式目录并改成 `status: active`。
5. 运行 `agent-knowledge index`。

主动整理流程：

1. `agent-knowledge list` 查看知识库状态。
2. `agent-knowledge organize-inbox` 预览 `_inbox` 归档。
3. `agent-knowledge organize-inbox --apply` 应用移动、激活并重建索引。
4. 用户直接提供材料时，由 `.trae/skills/knowledge-organizer/SKILL.md` 拆分成 JSON，再运行 `agent-knowledge capture-material --input material.json --target active`。

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
# 需要 alias 建议或离线 embedding 分析时再运行；自动化测试必须使用 --provider local。
agent-knowledge embed-index --root "$AGENT_KNOWLEDGE_ROOT" --provider local
agent-knowledge query \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --task "$CURRENT_TASK" \
  --domain "$CURRENT_DOMAIN" \
  --scenario "$CURRENT_SCENARIO"
```

如果已构建 embedding 缓存，可显式使用 hybrid 查询：

```bash
agent-knowledge query \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --task "$CURRENT_TASK" \
  --retrieval hybrid \
  --provider transformers \
  --model /path/to/local/model
```

Hook 模板不默认运行本地模型，避免会话启动或提交 prompt 时加载模型导致延迟和权限问题。

Hook 命令会探测 runtime context：`process.cwd()`、是否处于 Git 工作树、Git root 和 `remote.origin.url`。可用 `agent-knowledge hook doctor` 在当前环境中确认 TRAE 实际执行 hook 的目录。Hook 模板通过 `bash -lc 'agent-knowledge hook ...'` 执行，避免 TRAE host hook 的非交互 PATH 找不到 nvm/npm 全局安装的 `agent-knowledge`。

别名建议只看 dry-run JSON，不会修改 Markdown：

```bash
agent-knowledge suggest-aliases --root "$AGENT_KNOWLEDGE_ROOT" --provider local
```

如果使用 `query --debug`，可把 `debug.queryRunId` 与结果 ID 一起记录有用性反馈：

```bash
agent-knowledge feedback \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --memory-id "$MEMORY_ID" \
  --usefulness useful \
  --query-run-id "$QUERY_RUN_ID"
```

任务结束后：

```bash
agent-knowledge write-candidate \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --input candidate.json
```

候选知识被人类审阅并激活后，重新运行 `agent-knowledge index`；如果使用 embedding 缓存，也重新运行 `agent-knowledge embed-index`。

将 `templates/trae/agents/memory-reader.md` 复制到目标项目的 `.trae/agents/memory-reader.md`，用于任务中途按需检索、调试召回、hybrid 查询和反馈记录建议。
将 `templates/trae/agents/memory-writer.md` 复制到目标项目的 `.trae/agents/memory-writer.md`，用于任务结束或显式记忆时生成候选知识 JSON。
将 `templates/trae/hooks.json` 复制到目标项目的 `.trae/hooks.json`。
用户级安装可运行 `agent-knowledge link-trae-templates`，它会把 `templates/trae/agents/*.md` 以符号链接写入 `~/.trae-cn/agents/`，把 `templates/trae/hooks.json` 写入 `~/.trae-cn/hooks.json`，并把本项目 `.trae/skills/*` 链接到 `~/.trae-cn/skills/*`。如果用户写成 `~/.tran-cn`，优先按笔误处理为官方目录 `~/.trae-cn`；确实要写其他目录时使用 `--target-dir`。
`knowledge-organizer` Skill 已放在 `.trae/skills/knowledge-organizer/SKILL.md`，用于用户主动要求整理知识库或整理输入材料时触发。

这些模板是官方格式，仓库内不直接放 `.trae/`，避免把模板误认为当前项目已安装配置。

## 注释约定

源码注释应解释“背景和意图”，不要重复代码表面含义。优先说明：

- 为什么某个模块存在。
- 为什么某个边界不能被绕过。
- 为什么某种安全或治理规则必要。
- 为什么某处是确定性 fallback，而不是完整智能能力。
