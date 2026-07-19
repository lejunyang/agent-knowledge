# AGENTS.md

本文件给后续接手本项目的 agent 使用。目标是让 agent 明确项目边界、命令、默认知识库位置、写入规则和安全要求。

## 项目目标

本项目实现一个本地 agent 知识持久化工具：

- `knowledge/**/*.md` 是人类可读事实源。
- `.memory/index.sqlite` 是可重建索引。
- `.memory/embeddings/index.jsonl` 是可重建本地 embedding 缓存，不是事实源。
- `.memory/embeddings/manifest.json` 保存 embedding profile/generation，不是事实源。
- `.memory/logs/*.jsonl` 是可重建运行日志，只用于调试和审计摘要。
- `.memory/staging/*.json*` 是脱敏 hook staging 与 watermark，不是事实源。
- `agent-knowledge query` 输出主 agent 可注入的 `context packet`，`--debug` 附带 scorer/reranker 和分项分数。
- `agent-knowledge embed-index` 使用本地 provider 生成 embedding 缓存；`agent-knowledge suggest-aliases` 只输出 dry-run JSON 建议。
- `agent-knowledge write-candidate` 只写候选知识到 `knowledge/_inbox/`。
- `agent-knowledge integration` 为 TRAE、TRAE CN 和 Claude Code 安装可选 hooks/agents/skills/plugin bundle，使用普通托管文件和结构化 merge，不创建 symlink。
- `agent-knowledge sync webdav|s3` 只同步 Markdown 事实源，冲突不自动覆盖。
- 知识 frontmatter 支持可选 `aliases`，用于查询别名扩展和 catalog registry 暴露，不替代规范 `domain` / `scenario`。

不要把索引当成事实源。任何知识更新都应先落到 Markdown，再重建索引。

## 默认位置

CLI 的 workspace root 解析优先级：

1. 命令参数 `--root <dir>`。
2. 用户配置文件中的 `knowledgeRoot`。
3. 环境变量 `AGENT_KNOWLEDGE_ROOT`（兼容旧部署）。
4. 默认路径 `~/.agent_knowledge`。

用户配置默认位于：

```text
~/.config/agent-knowledge/config.json
```

`XDG_CONFIG_HOME` 会替换 `~/.config`；`AGENT_KNOWLEDGE_CONFIG` 或全局 `--config <file>` 可指定其他配置文件。其他设置同样遵循“命令行显式参数 > 用户配置 > 兼容环境变量 > 内置默认值”。

配置文件可以保存 root、actor/capture policy、检索与 embedding、integration、同步 provider 和定时间隔，但只能保存凭据所在的环境变量名，禁止写入密码、access key、secret key 或 session token。

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
<workspace root>/.memory/embeddings/manifest.json
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
node dist/cli.js eval --root tests/fixtures/basic-knowledge --input eval/cases/retrieval-baseline.yaml
node dist/cli.js integration install --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js integration doctor --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js project detect
node dist/cli.js staging status
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
src/core/             稳定共享契约：types、Zod schema、路径和日志
src/cli/              CLI 交互向导和命令辅助模块
src/storage/          Markdown 事实源、workspace、SQLite 索引和 catalog
src/retrieval/        CJK 召回、query、scoring、embedding、context packet、eval 和 feedback
src/memory/           候选治理、inbox 写入和主动整理
src/integration/      产品安装、模板兼容入口和 Git project registry
src/sync/             Markdown 三方同步及 WebDAV/S3 backend
src/hooks/            Hook runtime context、输出裁剪和脱敏 staging
src/index.ts          公共 TypeScript API re-export
src/cli.ts            命令行入口和各模块编排
```

## 代码修改原则

- 优先保持小文件和清晰边界，不要把多个职责合并到一个模块。
- 新增行为必须优先加测试。
- 每完成一个可独立验证的功能或重构项，先运行对应聚焦测试和必要的 typecheck/build，再立即创建一个只包含该项的 Git commit；不要把多个无关改动堆到会话末尾一次提交。
- 提交前检查 `git diff --cached`，确保暂存区只包含当前功能；提交信息使用 `feat:`、`fix:`、`refactor:`、`docs:`、`test:` 或 `chore:` 前缀。
- 修改代码时优先补充解释“设计意图、兼容性原因、安全边界、失败策略和非显然算法”的注释。不要给直白赋值、简单循环或已经由函数名完整表达的行为添加重复注释。
- 新增对外 CLI 命令、配置项、同步策略或治理规则时，入口模块应说明优先级、默认值和为什么不能绕过对应边界；复杂模块的文件头注释应说明职责和明确非职责。
- 用户配置 schema 变化时同步更新 `src/core/config.ts`、配置向导、README、AGENTS 和配置测试；配置不得持久化 secret 值。
- CLI/Hook 人类文案统一通过 `src/i18n/`；首发支持 `zh-CN` 和 `en`，默认 `auto`，未知系统语言回退中文。JSON 字段、frontmatter key 和知识 ID 不翻译。
- 四阶段路线的完成证据维护在 `docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md`；新增检索、reranker 或 maintenance 行为时同步更新对应勾选项和证据。
- 修改 schema 时同步更新 README、AGENTS 和测试夹具。`aliases` 字段是可选数组，默认空数组；新增知识如有常用简称、旧称或用户自然说法，应写入 `aliases`，但不要把它当作事实来源。`related_knowledge` 只有能指向明确已有或同批可生成的知识 ID 时才填写。`project_ids`、`capture_mode`、`actor_type`、`corroboration_count` 用于适用范围和来源治理，旧 Markdown 依赖 schema 默认值保持兼容。
- 修改 CLI root 行为时同步更新 README 的“默认位置”章节、AGENTS 的“默认位置”章节和相关测试。
- active 知识落盘目录必须保留 domain 的层级结构，例如 `bytedance/business/account` 写到 `knowledge/semantic/bytedance/business/account/`，不要压平成 `bytedance-business-account`。
- 修改检索排序时同步更新 eval case 或增加新的 eval case。
- 完整检索基线位于 `eval/cases/retrieval-complete.yaml`，包含 17 个 active 主题和 hard-negative/no-answer/temporal/cross-language case；修改检索或治理策略时必须保持 forbidden injection 为 0。
- 测试不得依赖网络或远程模型；embedding 相关测试必须使用 `DeterministicLocalEmbeddingProvider` 或 CLI `--provider local`。
- Transformers.js provider 默认禁止远程模型下载；只有人工 CLI 调试时才显式传 `--allow-remote-models`。
- 普通检索、Hook、`embed-index` 和 model status 禁止自动联网；`agent-knowledge embedding download` 是显式模型下载入口。模型缓存默认位于 `~/.cache/agent-knowledge/models`，可由用户配置覆盖。
- `query` 不应在缺少 domain/scenario 且 FTS 无命中时回退全表；如修改 fallback 策略，必须更新 debug 输出和测试。
- direct result 和 related expansion 必须执行相同的 validity、visibility、sensitivity、project 和 type 过滤。
- `_inbox` / `_archive` 必须按路径硬排除，不能只依赖 status。
- embedding query 必须校验 manifest/profile，不能对不同模型、维度、pooling 或 prefix 的向量静默 cosine。
- Batch reranker 默认只在显式 `query --rerank` 或 reranked eval 中启用；Hook 热路径不得加载 cross-encoder。默认 pipeline 是融合 top 30 -> batch rerank -> threshold -> top 8。
- Calibration 只能输出 dry-run 参数建议，不得自动改用户配置；目标函数必须优先惩罚 forbidden injection、abstention failure 和 not_useful feedback。
- 共享同步默认不包含 `private` 或高于 `internal` 的知识；如修改默认策略，必须更新威胁模型和测试。
- 定时同步使用前台 `agent-knowledge sync watch` 循环；不要在安装或配置命令中静默创建 cron、launchd 或 systemd 任务。需要后台常驻时由用户显式交给系统进程管理器托管。
- `sync.intervalMinutes: 0` 表示禁用定时同步；`sync watch` 要求正数间隔，并在单次失败后记录错误、等待下一周期重试。
- Maintenance worker 只能写 `.memory/proposals` 和 watermark/lock，禁止直接修改 active Markdown。Skill proposal 必须满足至少 3 个独立 session、trusted authority、positive feedback、无 unresolved conflict，并且不得自动写入或安装 `.trae/skills`。
- 任何会影响对外 agent 使用流程的改动，都必须 review `templates/trae/`：
  - Hook 行为、事件、命令或注入上下文变化时，检查 `templates/trae/hooks.json` 和 `templates/trae/README.md`。
  - Subagent 输入、输出、frontmatter、工具权限或候选 JSON 字段变化时，检查 `templates/trae/agents/memory-writer.md`。
  - 模板必须遵循 TRAE 官方 Subagent Markdown + YAML frontmatter 格式和 Hook `version: 1` JSON 配置格式。
- `UserPromptSubmit` 无命中、低于阈值或异常时默认静默；普通命中只能注入最小 `context_packet`。禁止恢复全量 catalog、runtime context 或无命中说明。知识目录仅在显式 catalog intent 下返回相关 top 5。
- `SubagentStart` / `SubagentStop` 可记录本地完整 payload 到 `.memory/subagents/`，但不得同步、注入模型上下文或作为 active 事实；其他 Hook 继续使用脱敏 staging。
- 修改产品安装时同时 review `templates/claude-code/`、`templates/trae/plugin/` 和 integration merge/uninstall 测试。
- `trae` 项目/用户资源根是 `.trae`，必须同时管理 `.trae/hooks.json` 和 `.trae/cli/hooks.json`；`trae-cn` 使用 `.trae-cn/hooks.json`；Claude Code 使用 `.claude/settings.json`。
- Integration 默认使用 `merge`，只替换 Agent Knowledge 自有 Hook 并保留外部配置；只有显式 `overwrite` 时才允许删除目标文件、目录或 symlink 后写入模板。overwrite 不能删除 symlink 指向的外部源文件。
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
- 完整客服对话、完整 prompt/tool response/transcript 到 staging 或同步远端。

客服/机器人自动知识：

- `actor_type: customer` 或 `capture_mode: automated_session` 永远是 proposed。
- 客户不能通过“请记住”把来源提升为 `user_confirmed`。
- 同一 actor/session 的重复内容不能当作独立 corroboration。
- 需要 owner、受信文档、可复现验证或多个真正独立证据后再人工晋升。
- 机器人进程应固定 `AGENT_KNOWLEDGE_ACTOR_TYPE=customer`、`AGENT_KNOWLEDGE_CAPTURE_MODE=automated_session`、`AGENT_KNOWLEDGE_VISIBILITY_SCOPES=project,team` 和合适的 `AGENT_KNOWLEDGE_SENSITIVITY_CLEARANCE`。

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

Hook 命令会探测 runtime context：`process.cwd()`、是否处于 Git 工作树、Git root 和 `remote.origin.url`。可用 `agent-knowledge hook doctor` 在当前环境中确认 TRAE 实际执行 hook 的目录。Hook 安装按平台选择模板：macOS/Linux 使用 `bash -lc 'agent-knowledge hook ...'`，Windows 使用 `agent-knowledge.cmd hook ...`，避免 Windows 依赖 Bash，也避免写死 Node 绝对路径。

`UserPromptSubmit` 未命中可注入知识时只应返回粗粒度 catalog（total、status/type、domains、scenarios），不要返回 aliases/items；只有命中并注入 context packet 时才返回细粒度 catalog，避免无关 prompt 被知识库词表污染。

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

使用 `agent-knowledge integration install --product trae|trae-cn|claude-code --scope user|project` 安装产品接入。安装器不使用 symlink；hooks 结构化 merge 且只管理 `agent-knowledge hook` handler，agents/skills/plugin bundle 由本地 manifest 记录所有权。
`knowledge-organizer` 和 `memory-maintainer` Skills 位于 `.trae/skills/`。前者整理 inbox/直接材料，后者审阅 staging/log 并提出保守候选。

Hook 主动记忆边界：

- `SubagentStart` / `SubagentStop` / `Stop` / `SessionEnd` 只异步写脱敏 staging。
- Staging 只保存 hash、长度、agent type、reason、project ID，不保存完整文本。
- 当前 command hook 不直接调用 Subagent；语义抽取由主 Agent 委派 `memory-writer` 或触发 `memory-maintainer`。
- 不在 Stop hook 中强制续跑模型。

这些模板是官方格式，仓库内不直接放 `.trae/`，避免把模板误认为当前项目已安装配置。

## 注释约定

源码注释应解释“背景和意图”，不要重复代码表面含义。优先说明：

- 为什么某个模块存在。
- 为什么某个边界不能被绕过。
- 为什么某种安全或治理规则必要。
- 为什么某处是确定性 fallback，而不是完整智能能力。
