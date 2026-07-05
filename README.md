# Agent Knowledge

Agent Knowledge 是一个本地知识持久化工具包，用来让多个 agent 共享一套可读、可审计、可检索的项目知识库。

它的核心设计是：

- Markdown 是唯一事实源，便于人类阅读、审阅和 git diff。
- SQLite FTS5 是可重建索引，负责全文检索和 BM25 排序。
- `.memory/embeddings/index.jsonl` 是可重建本地向量缓存，可由 Transformers.js 或 deterministic local provider 生成。
- CLI 输出结构化 `context packet`，供其他 agent 注入上下文。
- 自动沉淀先写入 `knowledge/_inbox`，避免模型总结直接污染长期知识。

## 默认位置

默认情况下，CLI 把用户 Home 下的 `~/.agent_knowledge` 当作 workspace root：

```bash
agent-knowledge query --task "审查 lint 迁移方案"
```

这时默认知识库位置是：

```text
~/.agent_knowledge/knowledge/
```

默认索引位置是：

```text
~/.agent_knowledge/.memory/index.sqlite
```

默认 embedding JSONL 缓存位置是：

```text
~/.agent_knowledge/.memory/embeddings/index.jsonl
```

可以用两种方式指定位置：

```bash
# 方式 1：每次命令显式指定 workspace root
agent-knowledge query --root /path/to/workspace --task "审查 lint 迁移方案"

# 方式 2：给 agent 进程设置环境变量
export AGENT_KNOWLEDGE_ROOT=/path/to/workspace
agent-knowledge query --task "审查 lint 迁移方案"
```

`--root` 优先级高于 `AGENT_KNOWLEDGE_ROOT`。如果两者都没有提供，则使用 `~/.agent_knowledge`。

## 安装与构建

```bash
pnpm install
pnpm build
```

本地开发时也可以直接运行源码：

```bash
pnpm dev -- --help
```

把当前目录的本地包安装成全局命令：

```bash
npm install -g .
```

安装后可以直接使用：

```bash
agent-knowledge --help
```

卸载全局命令：

```bash
npm uninstall -g agent-knowledge
```

本地调试构建产物时，可以直接运行：

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

## 构建本地 embedding 缓存

`embed-index` 会读取 active Markdown 知识，使用本地 provider 生成向量，并重写：

```text
<workspace root>/.memory/embeddings/index.jsonl
```

如果输出中出现：

```json
{
  "indexed": 0,
  "embedded": false,
  "skippedReason": "no_active_documents"
}
```

说明当前 root 下没有 `status: active` 的知识文件，因此不会加载模型。先运行 `agent-knowledge list --root <workspace>` 或确认是否把 `--root` 指到了正确知识库。

默认 provider 是 Transformers.js `feature-extraction`，默认不允许联网下载模型，适合使用本机已缓存模型或传入本地模型路径：

```bash
agent-knowledge embed-index \
  --root /path/to/workspace \
  --provider transformers \
  --model /path/to/local/model
```

如需显式允许 Transformers.js 下载模型，可加 `--allow-remote-models`。测试和离线 smoke test 应使用 deterministic local provider，避免网络依赖：

```bash
agent-knowledge embed-index --root /path/to/workspace --provider local
```

构建 embedding 缓存后，可以用 hybrid 查询把 FTS 候选和 embedding topK 合并：

```bash
agent-knowledge query \
  --task "用户自然语言任务" \
  --retrieval hybrid \
  --provider transformers \
  --model /path/to/local/model \
  --debug
```

如果只想离线验证流程，可以使用 deterministic local provider：

```bash
agent-knowledge query --task "用户自然语言任务" --retrieval hybrid --provider local --debug
```

`query --debug` 中的 `debug.embeddingRecordCount` 表示本次 hybrid 查询读取到多少条 embedding 缓存；如果为 `0`，说明需要先运行 `embed-index` 或 root 指向了没有缓存的知识库。

TypeScript API：

```ts
import { embedKnowledgeIndex, DeterministicLocalEmbeddingProvider } from "agent-knowledge";

await embedKnowledgeIndex(root, {
  provider: new DeterministicLocalEmbeddingProvider()
});
```

## 建议 aliases（dry-run）

`suggest-aliases` 使用 `.memory/embeddings/index.jsonl`、`.memory/logs/*.jsonl` 中的查询 metadata，以及 Markdown 文档内容生成别名建议。该命令只输出 dry-run JSON，不会修改 Markdown：

```bash
agent-knowledge suggest-aliases --root /path/to/workspace
```

输出结构包含每条知识的 `existingAliases` 和 `suggestions`。确认后仍应由人类把合适别名写回 Markdown frontmatter，并重新运行 `agent-knowledge index` / `agent-knowledge embed-index`。

## 生成知识目录

刷新 `knowledge/_catalog.md` 并输出结构化 catalog：

```bash
agent-knowledge catalog --root /path/to/workspace
```

如果只想查看 JSON，不刷新 catalog 文件：

```bash
agent-knowledge catalog --root /path/to/workspace --no-write
```

TypeScript API：

```ts
import { catalogKnowledge } from "agent-knowledge";

const catalog = await catalogKnowledge("/path/to/workspace", { write: true });
```

结构化 catalog 会同时返回 `registry.domains`、`registry.scenarios` 和 `registry.aliases`，方便调用方发现可用的规范领域、场景与人类常用别名。`knowledge/_catalog.md` 也会包含同一份 registry 摘要。

## 查询上下文

其他 agent 在开始任务前，应先查询相关知识：

```bash
agent-knowledge query \
  --root /path/to/workspace \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration
```

`query` 只有在提供 `--domain` 或 `--scenario` 时，才会在 FTS 无命中时回退到 metadata 过滤；没有 domain/scenario 的无命中查询会返回空结果，避免整库全表 fallback。domain/scenario 过滤支持：

- `aliases` 别名扩展，例如用 `vue-lint` 命中 `frontend/lint`。
- 层级匹配，例如 `frontend` 可匹配 `frontend/lint`。
- 轻量模糊匹配，例如 `code review` 可匹配 `code-review`。

调试检索链路：

```bash
agent-knowledge query \
  --root /path/to/workspace \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration \
  --debug
```

`--debug` 输出 `{ "packet": ..., "debug": ... }`，其中 `debug` 包含 FTS tokens、fallback 状态、候选行数、关系扩展 ID、最终结果 ID、`queryRunId`、本次使用的 embedding scorer / reranker 名称，以及每条结果的分项分数。

查询排序支持 TypeScript API 插件：

```ts
import { queryMemoriesWithDebug, type EmbeddingScorer, type MemoryReranker } from "agent-knowledge";

const embeddingScorer: EmbeddingScorer = {
  name: "my-local-scorer",
  score: ({ request, document }) => (document.frontmatter.tags.some((tag) => request.task.includes(tag)) ? 1 : 0)
};

const reranker: MemoryReranker = {
  name: "embedding-only",
  rerank: ({ features }) => features.embeddingScore
};

const result = queryMemoriesWithDebug(root, request, { embeddingScorer, reranker });
```

默认 embedding scorer 是本地 deterministic 词项向量 cosine，不调用任何外部 API。默认 reranker 是加权线性公式，综合 lexical、embedding、scenario、confidence、source authority 和 relation 分数。

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

查询和 catalog 会把运行摘要追加到：

```text
<workspace root>/.memory/logs/YYYY-MM-DD.jsonl
```

日志是机器调试产物，不是事实源；不要把它当作知识更新来源。

## 记录记忆有用性反馈

查询结果是否有用可以单独记录到 JSONL 日志，不会修改 Markdown 事实源：

```bash
agent-knowledge feedback \
  --root /path/to/workspace \
  --memory-id k_20260705_frontend_lint_vue_sfc \
  --usefulness useful \
  --query-run-id <debug.queryRunId> \
  --task "审查 Vue SFC lint 迁移方案" \
  --note "命中了正确的 fallback 约束"
```

`--usefulness` 只接受 `useful`、`not_useful` 或 `neutral`。反馈事件写入：

```text
<workspace root>/.memory/logs/YYYY-MM-DD.jsonl
```

## 写入候选知识

其他 agent 不应直接写正式知识目录。需要沉淀知识时，先写候选 JSON：

```json
{
  "title": "Lint 迁移验证流程",
  "aliases": ["lint-checklist"],
  "memory_type": "procedural",
  "domain": "frontend/lint",
  "related_domains": ["ci/performance"],
  "scenario": ["lint-migration"],
  "tags": ["oxlint", "eslint"],
  "confidence": 0.72,
  "source_authority": "model_inferred",
  "summary": "迁移 lint 配置后应按 Oxlint -> ESLint fallback -> Oxfmt 顺序验证。",
  "evidence": ["conversation:current-session"],
  "related_knowledge": [
    {
      "id": "k_20260705_frontend_lint_vue_sfc",
      "relation": "often_used_with",
      "reason": "Vue SFC lint 迁移经常需要结合 fallback 验证流程。"
    }
  ]
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

直接材料写入 active 或 `_inbox` 晋升 active 时，`domain` 会映射为分层目录。例如 `bytedance/business/account` 会写入：

```text
knowledge/semantic/bytedance/business/account/
```

## 给其他 agents 使用

推荐安装 `templates/trae/` 下的 TRAE 官方格式模板：

- `templates/trae/agents/memory-reader.md`：按需检索、调试召回和记录反馈的 Subagent 模板。
- `templates/trae/agents/memory-writer.md`：项目级 Subagent 模板，使用官方 YAML frontmatter。
- `templates/trae/hooks.json`：项目级 Hook 模板，使用官方 `version: 1` / `hooks` 配置格式。
- `.trae/skills/*`：本项目内置 Skills，例如 `knowledge-organizer`。

用户级安装推荐使用符号链接：

```bash
agent-knowledge link-trae-templates
```

该命令会链接到官方 TRAE 用户配置目录：

```text
~/.trae-cn/agents/memory-reader.md
~/.trae-cn/agents/memory-writer.md
~/.trae-cn/hooks.json
~/.trae-cn/skills/knowledge-organizer
```

如果目标文件已存在，默认拒绝覆盖；确认替换时使用：

```bash
agent-knowledge link-trae-templates --force
```

如果需要安装到其他目录：

```bash
agent-knowledge link-trae-templates --target-dir /path/to/.trae-cn
```

项目级安装时，手动链接或复制为：

```text
<project>/.trae/agents/memory-reader.md
<project>/.trae/agents/memory-writer.md
<project>/.trae/hooks.json
```

通用接入顺序：

1. 任务开始：运行 `agent-knowledge index`。
2. 任务开始：运行 `agent-knowledge query`，把 `context packet` 注入主 agent。
3. 任务中途需要历史约定、SOP、debug 或 hybrid 检索时，调用 `memory-reader` Subagent。
4. 需要沉淀：调用 `memory-writer` Subagent 生成 candidate JSON。
5. 写入候选：运行 `agent-knowledge write-candidate`。
6. 人类审阅：把 `_inbox` 中的候选移动到正式目录并改为 `status: active`。
7. 审阅后：再次运行 `agent-knowledge index`。

## 主动整理知识

除了通过会话 hook 被动触发，Agent Knowledge 也支持主动整理。

查看当前知识库状态：

```bash
agent-knowledge list
```

整理 `_inbox` 候选知识，先查看 dry-run：

```bash
agent-knowledge organize-inbox
```

确认后应用移动、激活并重建索引：

```bash
agent-knowledge organize-inbox --apply
```

整理用户直接提供的材料时，先由 `knowledge-organizer` Skill 把材料拆成一个或多个 JSON 对象，再写入知识库：

```bash
agent-knowledge capture-material --input material.json --target active
```

如果希望先进入审阅队列：

```bash
agent-knowledge capture-material --input material.json --target inbox
```

用户直接提供的材料默认可以使用 `source_authority: "user_confirmed"` 和较高 `confidence`。CLI 仍会做 schema 校验和 secret-like 扫描。

Skill 文件位于：

```text
.trae/skills/knowledge-organizer/SKILL.md
```

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
