# Agent Knowledge

Agent Knowledge 是一个本地知识持久化工具包，用来让多个 agent 共享一套可读、可审计、可检索的项目知识库。

它的核心设计是：

- Markdown 是唯一事实源，便于人类阅读、审阅和 git diff。
- SQLite FTS5 是可重建索引，负责全文检索和 BM25 排序。
- `.memory/embeddings/index.jsonl` 与 `manifest.json` 是可重建本地向量缓存，可由 Transformers.js 或 deterministic local provider 生成。
- CLI 输出结构化 `context packet`，供其他 agent 注入上下文。
- 自动沉淀先写入 `knowledge/_inbox`，避免模型总结直接污染长期知识。
- Git project ID、WebDAV/S3 同步和 proactive-memory staging 都只扩展治理与接入，不改变 Markdown 事实源地位。

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
~/.agent_knowledge/.memory/embeddings/manifest.json
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

索引只读取 `status: active` 的正式 Markdown 知识文件。`knowledge/_inbox/**` 和 `knowledge/_archive/**` 会按路径硬排除；即使候选误写成 `status: active`，也不会进入索引或注入。

## 构建本地 embedding 缓存

`embed-index` 会读取 active Markdown 知识，使用本地 provider 生成向量，并重写：

```text
<workspace root>/.memory/embeddings/index.jsonl
<workspace root>/.memory/embeddings/manifest.json
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

默认 Transformers profile 是 multilingual E5 small q8：

```bash
agent-knowledge embed-index \
  --root /path/to/workspace \
  --provider transformers
```

默认仍禁止联网下载模型。可以传本地模型路径，或选择中文资源优先的 BGE profile：

```bash
agent-knowledge embed-index \
  --provider transformers \
  --profile bge-small-zh-v1.5
```

只有人工调试时才使用 `--allow-remote-models`。测试和离线 smoke test 使用 deterministic local provider：

```bash
agent-knowledge embed-index --root /path/to/workspace --provider local
```

构建 embedding 缓存后，可以用 hybrid 查询把 FTS 候选和 embedding topK 合并：

```bash
agent-knowledge query \
  --task "用户自然语言任务" \
  --retrieval hybrid \
  --provider transformers \
  --debug
```

如果只想离线验证流程，可以使用 deterministic local provider：

```bash
agent-knowledge query --task "用户自然语言任务" --retrieval hybrid --provider local --debug
```

缓存 manifest 会校验 provider、model、revision、dtype、dimensions、pooling、prefix、max length 和 normalization。Query profile 不兼容时会明确失败，不能按较短向量静默计算 cosine。

Embedding rebuild 使用 `contentHash` 复用未变化记录，并删除失效记录。输出中的 `generated`、`reused`、`removed` 可用于确认增量行为。

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
- CJK 2/3-gram 辅助召回，避免中文整句被当成一个 token。

查询在排序前执行：

- `valid_from` / `valid_until`。
- `visibility` 与 `sensitivity` clearance。
- `project_ids`。
- `includeTypes`、domain 和 scenario。

一跳关系扩展也执行同一安全过滤。CLI 可显式限制调用方权限：

```bash
agent-knowledge query \
  --task "回答客服业务问题" \
  --visibility project team \
  --sensitivity-clearance internal \
  --project-id project_xxx
```

调试检索链路：

```bash
agent-knowledge query \
  --root /path/to/workspace \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration \
  --debug
```

`--debug` 输出 `{ "packet": ..., "debug": ... }`，其中包含 FTS tokens、fallback、候选行数、关系扩展、dense candidate、`queryRunId`、scorer/reranker，以及 lexical、真实 dense cosine、metadata/RRF 和最终分数。

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

Lexical、dense 和 metadata 先按 rank 做 RRF，避免直接混合 BM25 与 cosine 的不同量纲。默认 reranker 再综合 RRF、lexical、dense、scenario、confidence、source authority 和 relation；TypeScript API 仍可替换 reranker。

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

`maxTokens` 使用保守中英文 token 估算逐项装包，不再只按条数截断。

## 检索评测

评测 YAML 支持 expected rank、graded relevance、forbidden、abstain、language 和 domain：

```bash
agent-knowledge eval \
  --root tests/fixtures/basic-knowledge \
  --input eval/cases/retrieval-baseline.yaml
```

输出包括 Recall@1/3/5、MRR、nDCG、false injection rate、abstention precision、latency 和 packet tokens。自动测试只使用 deterministic provider。

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
  "capture_mode": "verified_task",
  "actor_type": "system",
  "corroboration_count": 1,
  "project_ids": ["project_example"],
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

`actor_type: customer` 或 `capture_mode: automated_session` 永远保持 `proposed`。外部客户即使要求“记住”，也不能把自己提升为 `user_confirmed`；相关候选会降级为 `model_inferred`，等待 owner、受信文档或独立证据确认。

直接材料写入 active 或 `_inbox` 晋升 active 时，`domain` 会映射为分层目录。例如 `bytedance/business/account` 会写入：

```text
knowledge/semantic/bytedance/business/ocean-account/
```

## 给其他 agents 使用

查看支持的产品和可选组件：

```bash
agent-knowledge integration list
```

当前支持：

- `trae`：hooks、agents、skills、可选 plugin bundle。
- `claude-code`：hooks、agents、skills。

安装 TRAE 用户级接入：

```bash
agent-knowledge integration install \
  --product trae \
  --scope user \
  --components hooks,agents,skills
```

项目级安装：

```bash
agent-knowledge integration install \
  --product trae \
  --scope project
```

安装器使用普通文件，不创建 symlink。已有 JSON 配置会结构化 merge，只替换 command 中的 Agent Knowledge 自有 hook；保留其他 hook group、handler 和顶层字段。同名但不是安装器管理的 agent/skill 会报告 conflict，不覆盖。

检查和卸载：

```bash
agent-knowledge integration doctor --product trae --scope user
agent-knowledge integration uninstall --product trae --scope user
```

卸载只移除 manifest 记录且未被用户改写的自有资源，以及 JSON 中的 Agent Knowledge hook。旧 `link-trae-templates` 仅作为 deprecated 兼容包装，内部也使用同一托管安装器。

主要模板：

- `templates/trae/agents/memory-reader.md`：按需检索、调试召回和记录反馈的 Subagent 模板。
- `templates/trae/agents/memory-writer.md`：显式记忆、验证成功或稳定证据出现时生成 candidate JSON。
- `templates/trae/hooks.json`：项目级 Hook 模板，使用官方 `version: 1` / `hooks` 配置格式。
- `.trae/skills/knowledge-organizer`：整理 inbox 和用户直接材料。
- `.trae/skills/memory-maintainer`：审阅 staging/log 并生成保守候选。
- `templates/trae/plugin/`：可选 TRAE 原生 plugin bundle。
- `templates/claude-code/`：Claude Code 产品输出。

Hook 输出会包含 runtime context，便于确认 TRAE 实际执行目录和项目 Git 信息：

```bash
agent-knowledge hook doctor
```

该命令会输出 `cwd`、`isGit`、`gitRoot`、`gitOrigin` 和当前知识库 root。Git 项目会自动注册 project ID，并把它用于 Hook query 的 `project_ids` 过滤：

```bash
agent-knowledge project detect
```

`UserPromptSubmit` 没有命中可注入知识时，只返回粗粒度 catalog（total、status/type 分布、domains、scenarios），不注入 aliases 和 items，避免无关 prompt 被大量知识库词表污染。命中知识时才会附带较细 catalog 和 context packet。

模板按平台选择命令：macOS/Linux 使用 `bash -lc 'agent-knowledge hook ...'`，Windows 使用 `agent-knowledge.cmd hook ...`。

通用接入顺序：

1. 任务开始：运行 `agent-knowledge index`。
2. 任务开始：运行 `agent-knowledge query`，把 `context packet` 注入主 agent。
3. 任务中途需要历史约定、SOP、debug 或 hybrid 检索时，调用 `memory-reader` Subagent。
4. 显式记忆、验证成功、失败恢复产生稳定经验或反复出现的可靠证据时，调用 `memory-writer`。
5. 写入候选：运行 `agent-knowledge write-candidate`。
6. 人类审阅：把 `_inbox` 中的候选移动到正式目录并改为 `status: active`。
7. 审阅后：再次运行 `agent-knowledge index`。

## 主动整理知识

主动记忆不只依赖用户说“记住”。`memory-writer` 的 description 会提示主 Agent 在显式记忆、验证成功、稳定项目/业务证据出现时主动委派。当前 TRAE command hook 不能直接执行 Subagent，因此 Hook 只异步记录脱敏 staging：

- `SubagentStart`
- `SubagentStop`
- `Stop`
- `SessionEnd`

Staging 只保存 hash、长度、agent type、reason 和 project ID，不保存完整 prompt、response、tool payload 或 transcript。

```bash
agent-knowledge staging status
agent-knowledge staging drain --limit 100
```

使用 `memory-maintainer` Skill 审阅 drain 结果、结合已验证证据调用 `memory-writer`，再写入 `_inbox`。Hook 不会自动把 staging 变成 active knowledge，也不会在 Stop 时强制模型续跑。

机器人部署应固定低权限查询与写入身份，避免模型在 JSON 中伪造 actor 或读取个人知识：

```bash
export AGENT_KNOWLEDGE_ACTOR_TYPE=customer
export AGENT_KNOWLEDGE_CAPTURE_MODE=automated_session
export AGENT_KNOWLEDGE_VISIBILITY_SCOPES=project,team
export AGENT_KNOWLEDGE_SENSITIVITY_CLEARANCE=internal
```

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
.trae/skills/memory-maintainer/SKILL.md
```

## WebDAV / S3 同步

同步只处理正式目录中的非生成型 `knowledge/**/*.md`，不上传 `_inbox`、`_archive`、SQLite、embedding、logs、staging 或凭据。默认共享策略只包含 `project/team`，最高 `internal`；个人 `private` 和 `confidential/secret` 不会默认上传。

WebDAV：

```bash
export WEBDAV_USERNAME=alice
export WEBDAV_PASSWORD=...
agent-knowledge sync webdav \
  --url https://dav.example.com/agent-knowledge \
  --visibility project team \
  --sensitivity-clearance internal
```

S3 或 S3-compatible endpoint 使用环境变量中的 SigV4 凭据：

```bash
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
export AWS_SESSION_TOKEN=... # 可选

agent-knowledge sync s3 \
  --bucket my-agent-knowledge \
  --region us-east-1 \
  --prefix shared/
```

可用 `--endpoint` 和 `--force-path-style` 接入 MinIO 等兼容服务。同步使用 local/base/remote 三方比较；双端都改动时写 `.memory/sync/conflicts/*.json`，不静默覆盖。Pull 后自动重建 SQLite，并把 embedding 标记为 stale。

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
- `docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md`
- `docs/research/2026-07-19-project-memory-sync-and-poisoning.md`
- `docs/superpowers/specs/2026-07-19-agent-knowledge-evolution-design.md`
- `docs/superpowers/plans/2026-07-19-agent-knowledge-evolution.md`
