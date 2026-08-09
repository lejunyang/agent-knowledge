# AGENTS.md

本文件给后续接手本项目的 agent 使用。目标是让 agent 明确项目边界、命令、默认知识库位置、写入规则和安全要求。

## 项目目标

本项目实现一个本地 agent 知识持久化工具：

- `knowledge/` 中排除 generated、`_inbox`、`_archive`、`_inbox-skills` 后的 `schema_version: 2` KnowledgeDocument Markdown 是人类可读事实源。
- `.memory/index.sqlite` 是可重建索引。
- `.memory/embeddings/index.jsonl` 是可重建本地 embedding 缓存，不是事实源。
- `.memory/embeddings/manifest.json` 保存 embedding profile/generation，不是事实源。
- `.memory/logs/*.jsonl` 是可重建运行日志，只用于调试和审计摘要。
- `.memory/staging/*.json*` 是脱敏 hook staging 与 watermark，不是事实源。
- `.memory/subagents/*.jsonl` 是本地完整 Subagent 调试日志，不是事实源，不参与同步或上下文注入。
- `.memory/observations/*.jsonl` 和 `.memory/proposals/*.json` 是自动维护的中间审阅产物，不是事实源。
- `.memory/graph.json` 是从 Markdown/proposal 重建的知识关系图索引，不是事实源。
- `.vault/objects` 保存 AES-256-GCM 客户端加密的完整 evidence；`.vault/tombstones` 和 `.vault/access-log` 保存删除与访问审计。Vault 不进入 Git、Markdown 同步或普通 query。
- `events/support/*.jsonl` 与 `events/projects/*.jsonl` 是 Git 可跟踪的脱敏 append-only hash-chain 时间线；完整 event payload 只在 Vault，Event 不是 active business fact。
- `.memory/events/locks` 是事件 append 互斥状态，不是事实源。
- `.memory/ingestion/connectors` 保存 0600 本机 Connector 登记，`.memory/ingestion/update-checks` 保存 0600 probe-only 最近报告；二者不进 Git/同步且不是事实源。`.memory/ingestion/jobs` 保存每次 Connector 尝试的有界审计，`.memory/ingestion/checkpoints` 保存增量水位，`.memory/ingestion/locks` 防止同一 Connector 并发覆盖 checkpoint；三者也不是事实源。
- `knowledge/source-manifests/*.json` 是严格 `schema_version: 5` 的 Git 可跟踪 evidence 导航，保存稳定 source 身份、上游/本地版本、availability、section heading/hash/range、review receipt、脱敏与处理 profile、project keys 和 Vault handle，不保存正文 preview 或完整原文；旧 manifest 不迁移，应从原始 evidence 重建。
- `agent-knowledge ingest files|transcripts` 通过统一 Connector core 执行 probe、抓取、规范化、脱敏、Vault、manifest、job 和 checkpoint；failed 不推进 checkpoint。
- `agent-knowledge source check` 从本机登记恢复 Connector，只执行本地/离线 inventory/discover/probe，不抓正文、不需要 Vault key、不写 manifest/Vault/checkpoint。
- `agent-knowledge source refresh` 是日常增量入口：从登记恢复完整 scope，执行 check -> conditional ingestion -> recheck；无变化时不读取 Vault key。
- `agent-knowledge query` 输出主 agent 可注入的 Context Packet 2.0，默认只含 synopsis 与 evidence handles；`--debug` 附带 scorer/reranker 和分项分数。
- `agent-knowledge knowledge audit` 检查正文密度、metadata 膨胀、source 处理状态、claim evidence 和 project registry；`knowledge show/evidence` 执行安全过滤后显式展开。
- `agent-knowledge embed-index` 使用本地 provider 生成 embedding 缓存；`agent-knowledge suggest-aliases` 只输出 dry-run JSON 建议。
- `agent-knowledge write-candidate` 只写候选知识到 `knowledge/_inbox/`。
- `agent-knowledge integration` 为 TRAE、TRAE CN 和 Claude Code 安装可选 hooks/agents/skills/plugin bundle，使用普通托管文件和结构化 merge，不创建 symlink。
- `agent-knowledge sync run|watch` 通过配置的 WebDAV/S3 backend 只同步正式 Markdown，冲突不自动覆盖。
- `agent-knowledge maintenance` 从 SubagentStop 日志抽取 observation 并生成可审阅 proposal，不直接修改 active 知识。
- `agent-knowledge graph` 构建、查询和导出轻量知识关系图；`query --retrieval graph|hybrid-graph` 才会让图遍历参与检索。
- V2 frontmatter 使用 `kind` + `layer`：`kind` 表达 profile/semantic/procedural/episodic/principle/skill/source，`layer` 表达 synopsis/knowledge/evidence。
- `aliases`、`scenarios`、`tags` 是带 `weight/source` 的结构化 metadata，不替代规范 `domain`；supported claim 必须包含 source/section/hash evidence anchor。
- 项目作用域使用规范化 Git remote `project_keys`，例如 `github.com/lejunyang/agent-knowledge`；hash 只允许作为可重建 registry 文件名内部实现。

不要把索引当成事实源。任何知识更新都应先落到 Markdown，再重建索引。

## 默认位置

CLI 的 workspace root 解析优先级：

1. 命令参数 `--root <dir>`。
2. 项目 local 配置 `.agent-knowledge.local.json`。
3. 项目共享配置 `.agent-knowledge.json`。
4. 用户配置文件中的 `knowledgeRoot`。
5. 环境变量 `AGENT_KNOWLEDGE_ROOT`（兼容旧部署）。
6. 默认路径 `~/.agent_knowledge`。

用户配置默认位于：

```text
~/.config/agent-knowledge/config.json
```

`XDG_CONFIG_HOME` 会替换 `~/.config`；`AGENT_KNOWLEDGE_CONFIG` 或全局 `--config <file>` 可指定用户配置层。项目共享配置位于 Git root `.agent-knowledge.json`，项目 local 位于 `.agent-knowledge.local.json` 并应忽略。其他设置遵循“命令行显式参数 > 项目 local > 项目共享 > 用户配置 > 兼容环境变量 > 内置默认值”。

项目配置对象递归合并，数组整体替换。`AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG=1` 仅供测试和故障诊断临时关闭自动发现。

配置文件可以保存 root、actor/capture policy、检索与 embedding、integration、同步 provider、定时间隔和 `vault.keyEnv`，但只能保存凭据所在的环境变量名，禁止写入密码、access key、secret key、Vault key 或 session token。

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

如果需要项目级或租户级隔离知识库，优先在 `.agent-knowledge.local.json` 设置 `knowledgeRoot`；也可使用共享项目配置、`--root`、用户配置或兼容环境变量。否则多个项目会共享 `~/.agent_knowledge`。

## 常用命令

```bash
pnpm test
pnpm typecheck
pnpm build
npm install -g .
npm uninstall -g agent-knowledge
node dist/cli.js --help
node dist/cli.js configure --help
node dist/cli.js config show
node dist/cli.js config sources
node dist/cli.js catalog --root tests/fixtures/basic-knowledge --no-write
node dist/cli.js embed-index --root tests/fixtures/basic-knowledge --provider local
node dist/cli.js suggest-aliases --root tests/fixtures/basic-knowledge --provider local
node dist/cli.js eval --root tests/fixtures/basic-knowledge --input eval/cases/retrieval-baseline.yaml
node dist/cli.js graph build --root tests/fixtures/basic-knowledge
node dist/cli.js graph export --root tests/fixtures/basic-knowledge --format html --output /tmp/agent-knowledge-graph.html
node dist/cli.js maintenance run --root tests/fixtures/basic-knowledge
node dist/cli.js ingest files --root /tmp/agent-knowledge-data --connector-id smoke-docs --base-dir /tmp/source-docs --pattern '**/*.md'
node dist/cli.js ingest transcripts --root /tmp/agent-knowledge-data --connector-id smoke-sessions --base-dir /tmp/session-jsonl
node dist/cli.js ingest git --root /tmp/agent-knowledge-data --connector-id smoke-repo --repository /tmp/source-repo --pathspec README.md docs
node dist/cli.js ingest lark-export --root /tmp/agent-knowledge-data --connector-id smoke-lark --export-dir /tmp/lark-export --project-key github.com/example/business
node dist/cli.js source check --root /tmp/agent-knowledge-data
node dist/cli.js source refresh --root /tmp/agent-knowledge-data
node dist/cli.js source list --root /tmp/agent-knowledge-data --needs-review
node dist/cli.js source show src_example --root /tmp/agent-knowledge-data
node dist/cli.js event status --root /tmp/agent-knowledge-data
node dist/cli.js event list --root /tmp/agent-knowledge-data --stream-type support
node dist/cli.js integration install --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js integration doctor --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js project detect
node dist/cli.js subagents status
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
src/storage/          Markdown 事实源、workspace、source manifest/review、SQLite 索引和 catalog
src/retrieval/        CJK 召回、query、scoring、embedding、reranker、graph retrieval、context packet、eval 和 feedback
src/memory/           候选治理、inbox 写入、主动整理、observation、maintenance proposal 和审阅动作
src/graph/            可重建知识关系图的类型、构建、查询、导出和 HTML 可视化
src/integration/      产品安装、模板兼容入口和 Git project registry
src/sync/             Markdown 三方同步及 WebDAV/S3 backend
src/hooks/            Hook runtime context、静默相关性门控、脱敏 staging 和详细 Subagent 日志
src/vault/            完整 evidence 的客户端加密、读取、删除与访问审计
src/events/           客服 case 与需求 initiative 的 hash-chain timeline 和 Vault payload
src/ingestion/        Connector 契约、本地文件/transcript adapter、登记、probe-only 更新检查、脱敏、job/checkpoint/lock 编排
src/i18n/             中文默认、英文可选的 CLI/Hook 文案
src/index.ts          公共 TypeScript API re-export
src/cli.ts            命令行入口和各模块编排
```

## 代码修改原则

- 优先保持小文件和清晰边界，不要把多个职责合并到一个模块。
- 新增行为必须优先加测试。
- 每完成一个可独立验证的功能或重构项，先运行对应聚焦测试和必要的 typecheck/build，再立即创建一个只包含该项的 Git commit；不要把多个无关改动堆到会话末尾一次提交。
- 提交前检查 `git diff --cached`，确保暂存区只包含当前功能；提交信息使用 `feat:`、`fix:`、`refactor:`、`docs:`、`test:` 或 `chore:` 前缀。
- 修改代码时必须同步补充解释“设计意图、兼容性原因、安全边界、失败策略和非显然算法”的注释；详细要求见文末“注释约定”。
- 新增对外 CLI 命令、配置项、同步策略或治理规则时，入口模块应说明优先级、默认值和为什么不能绕过对应边界；复杂模块的文件头注释应说明职责和明确非职责。
- 用户配置 schema 变化时同步更新 `src/core/config.ts`、配置向导、README、AGENTS 和配置测试；配置不得持久化 secret 值。
- 项目配置行为变化时同步更新 `src/core/projectConfig.ts`、CLI source/scope 测试、`.gitignore` 和配置指南；`.agent-knowledge.local.json` 不得提交。
- CLI/Hook 人类文案统一通过 `src/i18n/`；首发支持 `zh-CN` 和 `en`，默认 `auto`，未知系统语言回退中文。JSON 字段、frontmatter key 和知识 ID 不翻译。
- 四阶段路线的完成证据维护在 `docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md`；新增检索、reranker 或 maintenance 行为时同步更新对应勾选项和证据。
- 修改 schema 时同步更新 README、AGENTS 和测试夹具。V2 是 breaking schema，不提供 V1 Markdown fallback 或 migration；旧知识从原始 evidence 重建。`aliases` 默认空数组，每项必须写 kind/weight/source；`scenarios` 区分 primary/secondary 并带 weight；`tags` 可用 retrieval=false 保留纯 provenance。`related_knowledge` 只有能指向明确已有或同批可生成的知识 ID 时才填写。`project_keys`、`capture_mode`、`actor_type`、`corroboration_count` 用于适用范围和来源治理。
- 修改 CLI root 行为时同步更新 README 的“默认位置”章节、AGENTS 的“默认位置”章节和相关测试。
- active 知识落盘目录必须保留 domain 的层级结构，例如 `bytedance/business/account` 写到 `knowledge/semantic/bytedance/business/account/`，不要压平成 `bytedance-business-account`。
- 正式知识数据应放在独立 private Git 仓库，使用 `workspace git-init --root <separate-dir>` 初始化；不得把私域知识嵌入当前代码仓库。初始化命令不得自动添加 remote、commit 或 push。
- `layer: knowledge` 的非 profile candidate 正文少于 300 字时必须保持 proposed，review reason 为 `knowledge_body_too_thin`；不能用高 confidence、documented 或 user_confirmed 绕过正文充分性门禁。
- 用户直接材料中的垂直领域知识若意义不明、需要专业判断、与受信知识冲突或疑似错误/过期，必须一次汇总具体疑点找用户确认；确认前不得写入 active 或 inbox，不能用低 confidence 绕过。
- 修改检索排序时同步更新 eval case 或增加新的 eval case。
- 完整检索基线位于 `eval/cases/retrieval-complete.yaml`，包含 17 个 active 主题和 hard-negative/no-answer/temporal/cross-language case；修改检索或治理策略时必须保持 forbidden injection 为 0。
- Eval 不得把 synthetic query 写入 `.memory/logs`；真实 query/Hook 日志才可参与 alias 建议、反馈和运行指标。
- 测试不得依赖网络或远程模型；embedding 相关测试必须使用 `DeterministicLocalEmbeddingProvider` 或 CLI `--provider local`。
- Transformers.js provider 默认禁止远程模型下载；只有人工 CLI 调试时才显式传 `--allow-remote-models`。
- 普通检索、Hook、`embed-index` 和 model status 禁止自动联网；`agent-knowledge embedding download` 是显式模型下载入口。模型缓存默认位于 `~/.cache/agent-knowledge/models`，可由用户配置覆盖。
- `embedding status/download`、Transformers embedding provider、hybrid query 和 reranker 必须统一使用 `embeddings.cacheDir`；不得出现状态检查命中专用缓存、运行时却回退到 `node_modules` 或其他默认目录的分叉。
- `query` 不应在缺少 domain/scenario 且 FTS 无命中时回退全表；如修改 fallback 策略，必须更新 debug 输出和测试。
- FTS5 BM25 必须按单次查询内相关度归一化并显式排序，不能使用固定绝对值缩放或依赖无 `ORDER BY` 的 SQLite 返回顺序；dense/graph/related-only 候选不得获得 lexical 分。
- Alias 排序加分必须考虑其对完整任务的覆盖率；短通用 alias 只能作为弱证据，不能在长查询中自动获得满分并压过具体知识。
- direct result 和 related expansion 必须执行相同的 validity、visibility、sensitivity、project 和 type 过滤。
- Context packet 必须过滤低相关 direct 长尾，同时保留 query debug 候选；显式关系扩展可越过相对分数门槛，但不能越过安全过滤。
- 普通 `query` 未传 `--project` 时必须自动发现当前 Git remote 的规范 project key；显式参数完全优先，非 Git、无 remote 或探测失败回退空项目作用域。无 remote 项目必须由 `project detect --project-key local/...` 显式命名。
- `_inbox` / `_archive` 必须按路径硬排除，不能只依赖 status。
- `_inbox-skills` 保存 Skill proposal 草稿，使用 Skill frontmatter 而不是 KnowledgeDocument schema；index、embedding、catalog、graph、list 和同步必须在解析前按路径硬排除。
- embedding query 必须校验 manifest/profile，不能对不同模型、维度、pooling 或 prefix 的向量静默 cosine。
- `kind: source` / `layer: evidence` 保存证据引用或受治理的 evidence，不属于默认 query includeTypes，也不得进入 SQLite/FTS 或 embedding 缓存；检索内容应由 organizer 拆成 semantic/procedural/episodic/profile/principle。
- 图谱 HTML 默认只展示精炼 active 知识；结构邻居、source memory/source evidence 只能通过点击展开、证据或全图模式按需显示，不能恢复为全量节点首次布局。
- source 原始证据导入前必须移除临时下载 URL，并遮蔽测试账号、验证码、密码、token、用户标识和个人信息；禁止把内部测试账号表原样写入长期知识。
- 完整会话、工具轨迹和附件只能进入授权范围内的加密 Vault；凭据原值仍禁止保存。Vault key 必须从环境/KMS/密码管理器注入，CLI 不得把解密正文输出到 stdout。
- Lifecycle event payload 只能从文件输入，summary/payload 都执行 secret/PII 治理；Git timeline 可保留脱敏语义摘要，但不得保存完整 conversation/tool payload。
- Event stream ID 必须稳定且不含 PII/路径；客服和需求 stage 分别使用固定枚举。append 必须有 hash chain、并发锁与可选 idempotency key。
- Event payload export 必须写 workspace 外 0600 文件；retention 删除后 `missingPayloads` 必须可见，timeline 仍不应被删除或伪装完整。
- 客户/automated event 不是业务事实；只能经过独立 case、documented/owner/verified evidence 和 proposal/inbox 审阅后进入 active knowledge。
- 所有 source manifest 都不得保存 section 正文 preview，只保留 heading/hash/range、脱敏计数和 Vault handle；`ingest transcripts` 还必须强制内置 `secrets-and-pii`。内置确定性 detector 不是完整 DLP，姓名、地址、业务 UID 等领域 PII 必须由专用 Connector 在 normalize 阶段继续清洗并版本化 processing profile。
- Connector 是运行时不可信边界：descriptor 必须校验 source ID、connector ID、project key 和 probe；规范化 bytes 必须与用于 manifest 的 UTF-8 文本一致，不能让 Vault 内容和 hash/section 分叉。
- 文件系统 Connector 只读取显式 baseDir 下 UTF-8 普通文件，不跟随 symlink；PDF/Office/二进制附件必须使用专用 Connector，不能静默 UTF-8 解码。
- Git Connector 只读取本地 object database 中指定 ref 的 committed UTF-8 blob，不读取 dirty/untracked 文件、不 checkout、不自动 fetch/pull；origin remote 是默认 project key，无 remote 时必须显式 `local/...`。
- Lark export Connector 只读取离线 `manifest.json + content.xml`，校验 content SHA-256，并强制 Lark 用户身份/临时句柄清洗与 `secrets-and-pii`；不得自动联网。partial export 可摄入成功文档，但必须持久化 incomplete/unresolved inventory 并禁用删除对账。
- `build-lark-source-candidates.mjs` 的直接 CLI 和 npm script 已禁用；仅保留导出函数做历史审计合约测试。正式流程不得把完整 XML 转成 source Markdown。
- Complete inventory Connector 必须提供稳定 inventory identity；Git identity 绑定 project key、解析后的 symbolic ref/分支和 pathspec。范围变化不得复用旧 Connector ID，否则必须在任何 removed 写入前失败。
- Lark inventory identity 绑定 roots 与 project keys；移动同一离线快照不改变 identity，改变知识空间根或 project scope 必须使用新 Connector ID。`--limit` 运行不得做删除对账。
- 每次 CLI ingestion 必须在抓取前写/更新严格 Connector 登记；files/transcripts 登记 scope 绑定 base directory、glob、artifact kind、project keys 和 content type，漏传原 project key 也属于危险 scope 降级并失败。Git/Lark 本地路径只有 inventory identity 不变时可更新。
- Connector 登记只能保存内置 adapter 的非凭据参数，文件权限 0600；禁止保存 Vault key、token、cookie 或正文，也禁止进入 Git/WebDAV/S3。
- Vault 删除必须物理移除密文并写 tombstone，不能只删除 source manifest 或对象引用；默认不得静默复活同 ID 对象。
- 每个可更新 source 必须记录稳定 `source_id/external_key` 和版本信息。优先保存上游 revision、ETag、commit SHA、更新时间或 provider version ID，并始终保存抓取后的 content hash；没有上游版本信号时只能回退到重新抓取后比较 content hash。
- Source review 必须通过 `source show/export/mark`：export 只写 knowledge workspace 之外的显式 0600 文件，mark 必须携带 current fingerprint 和 review token；reason 进入 Git 前执行 secret/PII 检查。
- Source export/mark 必须与 ingestion 复用同一 Connector lock，避免 fingerprint 校验后被并发摄入覆盖；仅靠先读后写不够。
- `refined` receipt 必须记录 active knowledge IDs，且每个 ID 至少有一个 supported claim anchor 命中当前 source section/hash。不能仅因候选已写 inbox 就标 refined。
- metadata-only 更新保留 review receipt；content changed/restored 清空 receipt 并回 pending；removed/missing 先回 pending，人工分析历史 Vault evidence 后再标 obsolete/blocked。
- `source check` 必须是 probe-only：只调用 inventory/discover/probe，禁止调用 fetch/normalize、写 Vault/manifest/checkpoint 或要求 Vault key。检查显式 `networkAccess: none`；Git 只看登记的本地 ref，飞书只看 offline export，远端刷新必须由用户或受控自动化显式执行。
- `source refresh` 必须复用严格登记输入，不能要求用户重复填写或自行推断 project key/glob/pathspec/redaction policy；默认仅对确定更新或 update_unknown 执行 ingestion，`--force` 才允许无变化强制摄入。它同样不得自动 fetch Git 或访问在线飞书。
- 更新报告必须绑定当前 Connector registration snapshot。重新登记/摄入后旧报告为 stale，不能继续贡献 `sourceUpdatesAvailable/sourceUpdatesUnknown`。报告只保存在 0600 `.memory`，不得同步。
- Connector 更新检查应先做轻量 probe：共同版本信号未变且 processing profile 未变时为 unchanged；`path_hash` 变化可标 content_changed，只有 revision/ETag/mtime 等变化但无内容 identity 时必须标 update_unknown，不能虚构确定性。显式 ingestion 抓取后，上游 metadata 或处理 profile 变化但 content hash 不变不得触发重蒸馏并应保留 source 已分类状态；content hash 变化才重新切 section、失效受影响 claim 并生成更新 proposal。
- 同一 workspace/Connector 禁止并发摄入；lock 归活进程时失败，死 PID 锁可恢复。每次尝试使用独立 job ID，failed 不推进 checkpoint，不能覆盖上次失败或成功的审计记录。
- Git source 使用 blob SHA `path_hash` 优先判断单文档更新，commit SHA 记录仓库版本；无关 commit 只允许 metadata-only，不应重读正文。
- 只有 `inventoryMode: complete` 且未被 `--limit` 截断的运行才能把缺失 source 标记 removed/missing；missing manifest 必须使 claim anchor 失效，恢复后回到 pending。
- 质量审计必须分别报告 source 分类、上游 availability、Vault evidence、上游版本、脱敏策略、Connector 检查 freshness、确定/unknown 更新和 claim anchor 覆盖率；missing source 保留历史分类与 Vault coverage，但 availability 为 0，且不能支撑 active claim。manifest 无 Vault handle 或指向丢失密文属于 error。
- 质量审计还必须把 processed content hash 不匹配视为 stale warning，把 refined knowledge ID/anchor 无效视为 error。
- Connector inventory health 必须持久化到 checkpoint；`source list` 和 quality audit 必须统计 complete/unresolved。零成功文档的失败 Connector 也不能从审计中消失。
- 单 source fetch/normalize/Vault 失败必须写脱敏 checkpoint failure ledger；source list/audit 必须持续报告，成功重试或 complete inventory 确认 source 已移除后才清除。
- `capture-material --replace-source` 只能刷新同 ID、active、documented 的 source 原始证据；不得覆盖 semantic/procedural/profile/episodic，精炼知识更新必须使用新知识和 `supersedes`。
- Batch reranker 默认只在显式 `query --rerank` 或 reranked eval 中启用；Hook 热路径不得加载 cross-encoder。默认 pipeline 是融合 top 30 -> batch rerank -> threshold -> top 8。
- Calibration 只能输出 dry-run 参数建议，不得自动改用户配置；目标函数必须优先惩罚 forbidden injection、abstention failure 和 not_useful feedback。
- 共享同步默认不包含 `private` 或高于 `internal` 的知识；当前实现会同步允许范围内的正式 `kind: source` Markdown，且不提供客户端加密，因此不能把它当作完整会话/附件 Evidence Vault。修改同步范围或加密策略时必须更新威胁模型和测试。
- 定时同步使用前台 `agent-knowledge sync watch` 循环；不要在安装或配置命令中静默创建 cron、launchd 或 systemd 任务。需要后台常驻时由用户显式交给系统进程管理器托管。
- `sync.intervalMinutes: 0` 表示禁用定时同步；`sync watch` 要求正数间隔，并在单次失败后记录错误、等待下一周期重试。
- Maintenance worker 只能写 `.memory/proposals` 和 watermark/lock，禁止直接修改 active Markdown。Skill proposal 必须满足至少 3 个独立 session、trusted authority、positive feedback、无 unresolved conflict，并且不得自动写入或安装 `.trae/skills`。
- Proposal accept 默认只写知识 `_inbox` 或 Skill `_inbox-skills`；项目/用户 Skill 安装必须显式指定 target，并拒绝覆盖已有文件。
- 自动/客户 candidate 默认不得批量晋升；只有人工审阅后通过 `organize-inbox --approve <id...> --apply` 明确列出的 ID 才能激活。指定未知 ID 时必须在任何写入前失败。
- Skill 推荐使用两阶段流程：先 `maintenance accept` 写 `_inbox-skills`，审阅后再 `maintenance install-skill --skill-target project|user`；不得自动安装或覆盖已有 Skill。
- 正常 maintenance 流程必须能从 `.memory/subagents` 自动抽取 `.memory/observations/events.jsonl`；不得要求普通用户手写 `observations.json`。`--input` 仅保留为高级导入模式。
- 任何流程变动、行为优化、默认值调整或推荐方式变化，都必须完成“流程联动审视”，不能只改实现：
  - 检查主 README 的首次、日常、周期维护、机器人和人工审阅推荐流程。
  - 检查 `docs/guides/configuration.md`、`retrieval.md`、`memory-governance.md`、`integrations.md` 和 `synchronization.md` 中受影响的说明。
  - Hook 行为、事件、命令或注入上下文变化时，检查 TRAE、TRAE plugin、Claude Code 及 Windows Hook 模板。
  - 检查 `templates/trae/agents/*.md` 和 `templates/claude-code/agents/*.md` 的触发条件、输入输出、工具权限和命令。
  - 检查项目 `.trae/skills/*/SKILL.md`，确保 Skill 使用真实且推荐的 CLI 流程。
  - 检查 `templates/trae/plugin/agents/*.md` 和 `templates/trae/plugin/skills/*/SKILL.md`，避免 plugin bundle 落后于散装模板。
  - 检查 `templates/trae/README.md` 和 integration 安装/卸载/merge 测试。
  - 审视后确实无需修改某类模板时保持文件不动，并在进度或提交说明中明确“已检查、无需变化”，不要制造无意义 churn。
  - Subagent 模板必须遵循宿主要求的 Markdown + YAML frontmatter；TRAE Hook 必须保持 `version: 1` JSON 格式。
- `UserPromptSubmit` 无命中、低于阈值或异常时默认静默；普通命中只能注入最小 Context Packet 2.0 synopsis。禁止自动展开 knowledge/evidence、恢复全量 catalog、runtime context 或无命中说明。知识目录仅在显式 catalog intent 下返回配置上限内的相关条目（默认 5）。
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
4. 人类审阅后使用 `organize-inbox`；自动/客户候选必须通过 `--approve <id...>` 明确批准。
5. 运行 `agent-knowledge index`。

主动整理流程：

1. `agent-knowledge list` 查看知识库状态。
2. `agent-knowledge organize-inbox` 预览 `_inbox` 归档。
3. 普通受信候选用 `agent-knowledge organize-inbox --apply`；自动/客户候选用 `agent-knowledge organize-inbox --approve <id...> --apply`。
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

任务开始前通常不需要每次重建全部索引。Markdown 发生变化时运行 `index`；启用 hybrid/graph 时分别维护对应可重建索引：

```bash
agent-knowledge index --root "$AGENT_KNOWLEDGE_ROOT"
agent-knowledge embed-index --root "$AGENT_KNOWLEDGE_ROOT"
agent-knowledge graph build --root "$AGENT_KNOWLEDGE_ROOT"
```

普通任务让 Hook 高相关时自动注入；Hook 不足或任务依赖历史/业务知识时调用 `agent-knowledge-reader`，其基础查询为：

```bash
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

依赖显式知识关系时可使用 `--retrieval graph`；只有复杂人工查询才升级为 `hybrid-graph` 或 `--rerank`。Hook 模板不默认运行本地模型、graph 或 reranker，避免会话启动或提交 prompt 时增加延迟和权限问题。

Hook 命令会探测 runtime context：`process.cwd()`、是否处于 Git 工作树、Git root 和 `remote.origin.url`。可用 `agent-knowledge hook doctor` 在当前环境中确认 TRAE 实际执行 hook 的目录。Hook 安装按平台选择模板：macOS/Linux 使用 `bash -lc 'agent-knowledge hook ...'`，Windows 使用 `agent-knowledge.cmd hook ...`，避免 Windows 依赖 Bash，也避免写死 Node 绝对路径。

`UserPromptSubmit` 无命中、低于阈值或异常时必须完全静默。可靠命中只注入最小 `context_packet`；只有显式 catalog intent 才返回与 prompt 相关的有限知识菜单，避免无关 prompt 被知识库词表污染。

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
如果使用 graph 浏览或 graph retrieval，也重新运行 `agent-knowledge graph build`。

使用 `agent-knowledge integration install --product trae|trae-cn|claude-code --scope user|project` 安装产品接入。安装器不使用 symlink；hooks 结构化 merge 且只管理 `agent-knowledge hook` handler，agents/skills/plugin bundle 由本地 manifest 记录所有权。
`knowledge-organizer`、`source-distiller`、`lifecycle-recorder` 和 `memory-maintainer` Skills 位于项目 `.trae/skills/`，这是本仓库自身的开发/测试资源，不代表已安装到用户产品目录。它们分别整理直接材料/inbox、蒸馏 versioned source、记录客服/需求事件、维护 observation/proposal。

Hook 主动记忆边界：

- `SubagentStart` / `SubagentStop` 同时写本地完整 `.memory/subagents` 调试日志和脱敏 staging；`Stop` / `SessionEnd` 只写脱敏 staging。
- 详细 Subagent 日志默认不脱敏，供本机所有者调试；不得同步、注入模型上下文或直接作为事实。
- Staging 只保存 hash、长度、agent type、reason、project key，不保存完整文本。
- 当前 command hook 不直接调用 Subagent；语义抽取由主 Agent 委派 `agent-knowledge-writer` 或触发 `memory-maintainer`。
- 不在 Stop hook 中强制续跑模型。

`templates/` 是对外安装源；项目 `.trae/skills/` 是本仓库开发时实际启用的 Skills。不要把模板目录误认为已安装用户配置，也不要删除项目 Skills。

## 注释约定

源码注释应解释“背景、意图和约束”，不要只翻译代码表面含义。

- 源码注释统一使用中文；函数名、字段名、协议名和必要技术术语可保留英文，避免生硬翻译影响准确性。
- 每个具名 function、class method、constructor、exported class/function 和承担公共契约的 type/interface 都应有相邻 JSDoc，说明用途、调用背景、重要边界或外部副作用。
- 内部函数也必须有中文注释。优先说明“为什么存在、输入为何可信或不可信、返回值如何被下游使用”，而不只是复述函数名。
- 简单 getter、纯字段映射、显然的一行 wrapper 也应至少用一句话说明职责；只有审计脚本中范围严格且写明理由的例外才能省略。
- 函数内部的关键操作和判断必须在附近说明“为什么”，尤其是：
  - 安全过滤、权限、visibility、sensitivity、project/tenant 隔离。
  - fallback、阈值、token budget、abstention 和静默失败。
  - lock、watermark、幂等、去重、原子写入和冲突处理。
  - temporal invalidation、`supersedes`、`conflicts_with` 和有效期。
  - lexical/dense/metadata/RRF/reranker/graph 的排序融合、深度和衰减。
  - symlink、覆盖、网络、模型下载、远端同步和其他外部副作用。
- 模块文件头应说明职责与非职责，特别是 `.memory` 产物为何不是事实源、自动流程为何不能绕过 inbox/人工审阅。
- 新增或修改函数时必须同步检查注释；不能以“以后统一补注释”为由留下无说明的关键逻辑。
- 注释审计脚本只做最低限度提示，不能替代人工判断；通过审计不代表注释质量充分。
