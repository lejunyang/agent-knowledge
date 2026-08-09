# Agent Knowledge

Agent Knowledge 是一个本地、可审计的 Agent 知识持久化工具。V2 正式 KnowledgeDocument Markdown 是人类可读事实源；SQLite、embedding、graph、日志和 staging 都是可重建的机器产物。`_inbox`、`_archive` 和 `_inbox-skills` 是审阅产物，不属于正式事实。

当前主分支使用不兼容的 `schema_version: 2`：知识类型 `kind` 与抽象层 `layer` 分离，`synopsis` 负责路由，正文负责解释，supported claim 必须带 evidence anchor。旧 KnowledgeDocument 不会被静默读取或迁移，应从原始 evidence 重新提炼。

## 功能目录

- [快速开始](#快速开始)
- [推荐使用方式](#推荐使用方式)
- [候选知识怎么整理](#候选知识怎么整理)
- [如何发现问题并持续改进](#如何发现问题并持续改进)
- [主动记忆何时发生](#主动记忆何时发生)
- [客服机器人怎么部署](#客服机器人怎么部署)
- [知识图谱怎么使用](#知识图谱怎么使用)
- [常用命令](#常用命令)
- [用户配置与全部选项](docs/guides/configuration.md)
- [检索、Embedding、Reranker、图检索与评测](docs/guides/retrieval.md)
- [候选治理、自动维护和 Skill 生命周期](docs/guides/memory-governance.md)
- [TRAE、TRAE CN、Claude Code 与 Codex 接入](docs/guides/integrations.md)
- [WebDAV、S3 与定时同步](docs/guides/synchronization.md)
- [完整文档、会话与工具轨迹的加密 Evidence Vault](docs/guides/evidence-vault.md)
- [研究与设计](#研究与设计)

## 快速开始

```bash
pnpm install
pnpm build
npm install -g .
```

首次使用运行交互式配置：

```bash
agent-knowledge workspace git-init --root ~/agent-knowledge-data
agent-knowledge configure
```

知识数据仓库应是当前代码仓库之外的独立 private Git 目录。`workspace git-init` 只执行本地 `git init`、创建 V2 目录和安全 `.gitignore/SECURITY.md`；不会添加 remote、commit 或 push。用户必须自行创建 private remote 并确认访问范围。

项目可选配置：

```bash
agent-knowledge configure --scope project
agent-knowledge configure --scope project-local
agent-knowledge config sources
```

项目共享配置是 `.agent-knowledge.json`；项目本地配置是 `.agent-knowledge.local.json`，默认被 Git 忽略。生效优先级为用户全局 < 项目共享 < 项目 local < CLI 显式参数。

向导会解释并保存：

- 知识库位置。
- `actor_type`、`capture_mode`、可见性和敏感级别。
- embedding provider、profile 和检索模式。
- TRAE / TRAE CN / Claude Code / Codex integration。
- WebDAV / S3 和定时同步间隔。
- Evidence Vault 密钥所在的环境变量名；不会保存真实密钥。

安装 Agent 产品接入；不传参数时会交互式选择：

```bash
agent-knowledge integration install
```

如果不确定该走哪条流程，可以直接要求 Agent 使用 `agent-knowledge-guide` Skill。它是教程
和诊断路由器，会说明当前任务应使用 reader、source distillation、inbox governance、
lifecycle 或 maintenance 中的哪条流程，并优先运行只读健康检查，不会自动批准候选或启动
后台进程。

初始化并查询：

```bash
agent-knowledge init
agent-knowledge index
agent-knowledge query --task "审查 Vue SFC lint 迁移方案"
agent-knowledge knowledge audit
```

最简文档流程：

```bash
# 首次登记并摄入
agent-knowledge ingest files \
  --connector-id business-docs \
  --base-dir /secure/exports/business-docs \
  --pattern '**/*.md' \
  --project-key github.com/example/business

# 以后每天只需要这一条；无变化时不会读取 Vault key
agent-knowledge source refresh

# 查看需要蒸馏或重新审阅的来源
agent-knowledge source list --needs-review
```

把本地正式文档或完整 Agent 会话增量摄入加密 Vault：

```bash
export AGENT_KNOWLEDGE_VAULT_KEY="<32-byte-key-as-hex-or-base64>"

agent-knowledge ingest files \
  --root ~/agent-knowledge-data \
  --connector-id business-doc-exports \
  --base-dir /secure/exports/business-docs \
  --pattern '**/*.md' '**/*.txt' \
  --project-key github.com/example/business

agent-knowledge ingest transcripts \
  --root ~/agent-knowledge-data \
  --connector-id trae-sessions \
  --base-dir /secure/exports/trae-sessions \
  --project-key github.com/example/business

agent-knowledge ingest git \
  --root ~/agent-knowledge-data \
  --connector-id business-repository \
  --repository /projects/business \
  --pathspec README.md docs

agent-knowledge ingest lark-export \
  --root ~/agent-knowledge-data \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business

# 只检查已登记的本地/离线版本信号，不读取正文、不需要 Vault key
agent-knowledge source check --root ~/agent-knowledge-data

# 日常增量：检查 -> 按需摄入 -> 复查，不再重复填写来源目录/glob/project key
agent-knowledge source refresh --root ~/agent-knowledge-data
```

`ingest` 只输出 job、manifest 和 Vault handle，不输出正文。`files` 默认遮蔽内置规则可识别的
secret；`transcripts` 强制应用内置 secret + PII 规则，且所有 source manifest 都不保存
正文 preview。确定性 detector 目前覆盖私钥、常见 token/key、密码/cookie、邮箱、中国手机号
和身份证号，不等同于完整 DLP；姓名、地址、业务 UID 等领域 PII 应由专用 Connector 在
`normalize` 阶段继续清洗，未确认授权范围的材料不得摄入。
当前文件 Connector 只接受显式目录内的 UTF-8 普通文件，不跟随 symlink；PDF/Office、飞书
在线拉取和 GitHub issue/MR API 使用后续专用 Connector，不能伪装成 UTF-8 文件处理。
`ingest git` 只读取本地 Git object database 中指定 ref（默认 `HEAD`）的 committed UTF-8
blob，不读取 dirty/untracked 文件，也不自动 fetch/pull。它从 origin remote 得到可读
project key，以 commit SHA 记录仓库版本、以 blob SHA (`path_hash`) 判断单个文档是否变化；
无 origin 的仓库必须显式传 `--project-key local/...`。Connector ID 会绑定 project key、
解析后的 symbolic ref/分支和 pathspec inventory；改变这些范围时必须使用新 Connector ID，避免旧 source
被误判为删除。

`ingest lark-export` 只读取 `fetch-lark-corpus.mjs` 生成的离线 `manifest.json + content.xml`，
不调用网络。它校验每份 content hash，并强制 secret+PII 与飞书用户身份/临时资源句柄治理。
有 pending/failures 时仍摄入成功文档，但 `inventory.complete=false`、持久化 unresolved warning，
且绝不做删除对账；清零后才恢复 complete inventory。
Connector ID 绑定 roots 与 project keys；移动同一快照目录不改变 identity，切换知识空间范围
或 project scope 时必须使用新 ID。

单个文档若 content hash、UTF-8、脱敏或 Vault 写入失败，会进入 checkpoint `failures` ledger；
`source list.inventory.failedSources` 和 quality audit 持续报错，成功重试后自动清除。不能只看
本次命令 `failed=0` 就判断历史失败已解决。

执行任一 `ingest` 时会在抓取前把 Connector 的非凭据 scope 登记到
`.memory/ingestion/connectors/`，供后续 `source check` 恢复相同 adapter。登记文件为本机
0600 状态，不进入 Git/WebDAV/S3；不保存 Vault key、token 或正文。同一 Connector ID
再次执行时必须保持 project key、glob/pathspec、artifact kind 和 inventory identity，
防止作用域降级或把另一个来源误判为删除。

`source check` 只执行 discover/probe，报告写入 `.memory/ingestion/update-checks/`，不调用
fetch/normalize，也不修改 Vault、manifest、checkpoint 或审阅 receipt。它明确声明
`networkAccess: none`：Git 只检查登记的本地 ref，飞书只检查登记的离线 export。要判断线上
变化，先显式更新本地 ref 或刷新飞书 export，再运行检查；不会静默 fetch/pull/爬取。

`source refresh` 是推荐的日常入口：它从本机登记恢复完整 Connector scope，先 check，只对
有确定更新或 `update_unknown` 的 Connector 执行 ingestion，再重新 check。无变化时不会读取
Vault key；`--force` 可强制摄入，`--connector-id` 可限制来源，`--limit` 可做小批次验证。

项目作用域使用规范化 Git remote，例如 `github.com/lejunyang/agent-knowledge`。普通 query 会自动发现当前仓库 remote；跨项目诊断使用：

```bash
agent-knowledge query \
  --project github.com/example/project \
  --task "当前任务"
```

没有 Git remote 的本地仓库必须在 `project detect` 时显式提供可读 key：

```bash
agent-knowledge project detect --project-key local/owner/private-prototype
```

默认 `lexical` 检索不需要下载模型。需要语义检索时再执行：

```bash
agent-knowledge embedding download   # 交互选择 embedding
agent-knowledge embed-index
agent-knowledge query --task "当前任务" --retrieval hybrid
```

不要仅因为模型已经下载就把日常或 Hook 默认切到 hybrid。当前本地商家中心验证库的
15-case 评测中，lexical 通过 `15/15`，Recall@1 为 `0.9643`、Recall@3/5 为 `1`、
MRR/nDCG/abstention precision 为 `1`，false injection 为 `0`，平均 context packet 约
668 token；同一批语料的 hybrid 通过 `14/15`，在“账号注销 vs 账号找回”上产生一次
forbidden injection，平均 packet 约 1304 token。推荐 lexical 作为自动路径，hybrid/reranker
仅用于 lexical 未命中后的人工诊断，并先用自己的 eval 校准。

## 推荐使用方式

### 个人电脑

首次配置：

```bash
agent-knowledge configure
agent-knowledge integration install
agent-knowledge init
agent-knowledge index
```

日常不需要在每个任务前手工查询。推荐分工是：

1. `UserPromptSubmit` Hook 只在高相关命中时注入精简 `context_packet`；无命中和低分命中完全静默。
2. Context Packet 2.0 只注入 synopsis 路由层；需要完整条件、例外或来源时，主 Agent 使用 `knowledge show` / `knowledge evidence` 显式展开。
3. Hook 内容不足、任务依赖历史决策或业务规则时，主 Agent 主动调用 `agent-knowledge-reader`；reader 先直接 query，只有不知道领域或用户明确想浏览知识时才看 catalog。
4. 用户明确要求记忆，或任务产生了已验证且可复用的结果时，主 Agent 调用 `agent-knowledge-writer` 生成 candidate JSON。
5. candidate 通过 `write-candidate` 进入 `_inbox`；不会因为 Subagent 输出就直接修改 active 知识。
6. 主 Agent 实际使用或拒绝某条知识时记录 `feedback`，为阈值校准和 Skill 沉淀提供证据。
7. 每周或知识积累较多时运行一次 maintenance 和 inbox 审阅。

客服 case 和需求 initiative 不应直接总结成知识，先由 `lifecycle-recorder` 写 append-only 事件：

```bash
agent-knowledge event append \
  --stream-type support \
  --stream-id case_account_ticket_12345 \
  --stage intake \
  --event-type customer_question \
  --summary "客户反馈登录失败，身份和环境待确认" \
  --payload /secure/tmp/message.json \
  --content-type application/json \
  --project-key github.com/example/support \
  --actor-type customer \
  --capture-mode automated_session \
  --idempotency-key message_98765
```

完整 payload 经 secret/PII 治理后进入 Vault；Git 只保存脱敏摘要和 hash chain。跨多个独立
case 或完整 initiative 后，再由 maintenance/writer 提炼 Diagnostic Path、FAQ、Playbook 和 SOP。

推荐的每周维护：

```bash
agent-knowledge source refresh
agent-knowledge source list --needs-review
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge list
agent-knowledge organize-inbox
```

已经 ingest 的文档不会自动变成长期知识。使用 `source-distiller` Skill 先执行
`source refresh`，再逐条执行
`source show -> source export -> write-candidate/capture-material --target inbox -> source mark`；
完整 evidence 只写受控 0600 临时文件。`source mark` 必须携带 show 返回的 fingerprint，
版本变化时在任何写入前失败。

正式 source 蒸馏还应完成以下质量闭环：

1. 使用同一个 fingerprint 执行 `source show` 和 `source export`，防止阅读期间版本漂移。
2. Evidence 只导出到 workspace 外的 `0600` 私有临时文件。
3. 检查确定性 DLP、source content hash 和目标 section hash，不根据 heading/hash 猜正文。
4. 按主题拆成 L1 `synopsis`、L2 完整解释和 L3 Vault evidence；不能“一篇文档一条短结论”。
5. supported claim 必须引用当前 source section/hash。
6. 运行 `knowledge audit`，拒绝薄正文、metadata 主导和无效 claim anchor。
7. 增加真实 query、hard-negative 和 no-answer eval，避免新增知识破坏已有检索边界。
8. active knowledge 完成后才标记 source receipt，并删除临时 evidence。

`maintenance` 会读取 `.memory/logs` 中的 usefulness feedback。同一 `memoryId + queryRunId` 的重复上报只采用最新一条，不能通过重复日志放大票数；Skill proposal 的净正反馈数量必须至少覆盖独立 session 数。如果 feedback 晚于 observation 到达，下次 `maintenance run/watch` 会重新检查已消费 observation，不需要重置 watermark。

也可以直接要求 AI 使用 `memory-maintainer` Skill：AI 负责运行 maintenance、汇总 proposal/candidate/Skill、清理已消费日志；用户只决定接受、拒绝、批准和安装。清理命令：

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

Cleanup 只在没有待抽取 SubagentStop 时删除已消费 Subagent daily logs，并把 feedback 固化到 ledger 后移除原 feedback 行；query/catalog/Hook 日志与 observations/proposals 保留。

逐条查看并处理自动提案：

```bash
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance accept <proposal-id>
# accept 会返回 candidatePath；检查对应 Markdown 和 agent-knowledge list 中的知识 ID
agent-knowledge organize-inbox --approve <knowledge-id> --apply
```

最后按启用功能刷新可重建索引：

```bash
agent-knowledge index
agent-knowledge graph build        # 使用图浏览或 graph 检索时
agent-knowledge embed-index        # 使用 hybrid / hybrid-graph 时
```

### 是否需要一直运行 maintenance watch

- 个人电脑、低频使用：不需要。每周手工执行 `maintenance run` 即可。
- 持续运行的机器人：建议由 systemd、launchd、容器或其他进程管理器托管 `maintenance watch`。
- `maintenance run/watch` 默认直接读取 `.memory/subagents` 的新 `SubagentStop` 日志并生成 observation；普通用户不需要准备 input JSON。
- `--input observations.json` 只用于导入外部系统已经结构化好的 observation，不是常规流程。
- 即使运行 `watch`，proposal 和 `_inbox` 仍需人工审阅，不会自动激活。

## 候选知识怎么整理

候选分三种来源：

| 来源 | 推荐入口 | 默认结果 |
| --- | --- | --- |
| 用户直接提供的受信材料 | `knowledge-organizer` Skill + `capture-material` | 可按用户意图写 active 或 inbox |
| 显式记忆、验证成功的任务 | `agent-knowledge-writer` + `write-candidate` | 写 `_inbox`，再审阅 |
| 自动会话、客服观察、Subagent 日志 | `maintenance run/watch` | 只生成 proposal / `_inbox` |

普通、受信 candidate 可先运行 `organize-inbox` dry-run，再用 `--apply` 批量整理。自动会话和客户来源默认永久阻止批量晋升；只有人工检查证据后，才能用显式白名单：

```bash
agent-knowledge organize-inbox --approve <knowledge-id> --apply
```

一旦传 `--approve`，该次命令只处理列出的 ID；未知 ID 会在写文件前报错。

`layer: knowledge` 的非 profile 正文少于 300 字时，无论来源看起来多可信，都强制保持 proposed 并标记 `knowledge_body_too_thin`。这防止系统再次退化为“只有一句结论、metadata 很多”的卡片库；人工可以补充背景、条件、例外、失败策略和验证后再批准。

用户指定的正式文档先经 `ingest files|git` 写入加密 Vault 和 versioned source manifest，再由
`source-distiller` 拆成精炼知识候选。候选默认进入 inbox；只有成为 active knowledge 且
current claim anchor 指向 source 当前 section/hash 后，才可 `source mark --status refined`。
旧的 `capture-material --replace-source` 只兼容已有受治理 source Markdown，不是新流程。

`source export` 的输出必须位于 knowledge workspace 之外，防止完整 evidence 被 private Git
或同步误收录；`source mark` 同时要求 `expectedFingerprint` 和 `reviewToken`，分别阻止 source
版本变化和同版本并发 reviewer 覆盖。

用户主动提供材料时也不默认相信其中每个垂直领域结论。术语/关系意义不明、需要专业判断、与受信知识冲突，或 Agent 认为内容疑似错误/过期时，`knowledge-organizer` 会一次汇总具体疑点找用户确认；确认前该条不写 active 或 inbox。明确且不依赖疑点的内容可以分开整理。

批量导入正式文档时使用渐进三层：

1. `synopsis`：只负责低成本路由和首次上下文。
2. knowledge 正文：保存背景、条件、例外、步骤、失败策略和验证方式。
3. evidence：source manifest 保存 source/section/hash、版本、脱敏摘要和 Vault handle；完整
   原文进入客户端加密 Evidence Vault，不进入普通 query 或 Git。

现有 656 份飞书 source 和 33 条旧精炼知识只用于审计问题与构造评测，不会迁移进 V2 正式知识库。使用 Connector、Vault、source manifest v5 和 source-distiller 从原始飞书导出或重新拉取结果全量重建。

可更新来源必须同时记录稳定身份和版本指纹：

- 飞书：document key + `revision_id` + `updated_at/obj_edit_time` + content hash。
- Git/GitHub：规范 remote + commit SHA + relevant blob/path hash。
- HTTP/WebDAV：稳定 URL/object key + ETag/Last-Modified/version ID + content hash。
- 上游不提供版本时：只能重新抓取后比较 content hash，不能把“没有版本信息”当作“没有更新”。

更新检查先比较 revision/ETag/commit SHA 等轻量信号；信号未变可跳过正文下载。抓取后若只有上游 revision 或更新时间变化但 content hash 不变，记为 metadata-only，不触发重蒸馏；只有 content hash 变化才重新切 section、失效相关 claim 并生成更新 proposal。飞书递归脚本可显式执行：

```bash
# 当前离线快照检查；不会联网
agent-knowledge source check --connector-id lark-business

# 需要判断在线飞书文档时，先显式刷新离线快照
node scripts/fetch-lark-corpus.mjs \
  --root-url <wiki-or-doc-url> \
  --output /secure/exports/lark-business \
  --refresh-existing

agent-knowledge ingest lark-export \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business

agent-knowledge source refresh --connector-id lark-business
agent-knowledge source list --needs-review
```

Git/GitHub 同理：`source check` 只观察登记的本地 ref。需要远端新鲜度时先显式
`git fetch origin`，并让 Connector 使用希望检查的本地或 remote-tracking ref；工具本身不会
联网。`source check` 状态中：

- `metadata_only/content_changed/new/removed/restored` 是当前 probe 可确定的变化。
- `update_unknown` 表示 revision/ETag/mtime 已变化，但必须重新 ingest 比较脱敏 content hash。
- `processing_profile_changed/evidence_missing` 表示处理规则或本地证据需要重新摄入。
- 摄入会更新 Connector 登记，使旧检查报告变为 stale；再次 `source check` 才恢复 current，
  避免已处理更新继续误报。

正式流程不再使用 `build-lark-source-candidates.mjs` 把完整 XML 写成 source Markdown；该脚本只保留
旧审计/合约测试兼容。完整正文进入 Vault，manifest v5 不含正文 preview，再由
`source-distiller` 提炼候选。

当前仓库保存的历史 `local_exports/lark-business` 快照实测有 656 份成功文档与 2242 个
unresolved failure。可以先用 `--limit` 或完整命令摄入成功文档，但 quality audit 会持续告警，
且不能把该快照当作 100% source coverage；应继续 `--retry-failures --refresh-existing`。

Connector 还会把 normalize/脱敏规则版本写入 `processing_profile`。即使上游 revision 没变，
处理规则升级也会强制重抓；正文 hash 未变时仍归类为 `metadata_only`，并保留已有
`refined/duplicate/obsolete/no_long_term_value/blocked` 状态。每次尝试独立写入
`.memory/ingestion/jobs/`，failed 不推进 checkpoint；同一 Connector 并发运行由本地锁拒绝，
进程崩溃留下的死 PID 锁可在下次运行时恢复。

Source manifest v5 保存 review receipt：`processed_at`、`processed_content_hash` 和
`refined_knowledge_ids`。metadata-only 更新保留 current receipt；content change/restored
清空 receipt 并回 pending；完整 inventory 删除生成 missing+pending，人工审查后再标
obsolete/blocked。`source list --needs-review` 会列出 pending、stale 和尚未处理的 missing。

完整 inventory Connector（当前为 `ingest git`）在未传 `--limit` 的完整运行中还会对账删除：
上次存在而本次 ref/pathspec 中缺失的 source 标记为 `availability: missing` 和 `obsolete`，
其 claim anchor 立即失效；同路径恢复后归类 `restored` 并重新进入 pending。带 `--limit`
的截断运行不会做删除对账，避免把未扫描部分误判为删除。

## 如何发现问题并持续改进

正式使用时不只检查“有没有存进去”，还要检查“是否在正确问题上使用了正确记忆”。
`agent-knowledge-guide` 把这些机制路由成一套健康检查：

| 问题 | 发现机制 | 改进路径 |
| --- | --- | --- |
| 正文太短、metadata 太多、claim 失效 | `knowledge audit` | 回到 evidence 补 L2、修 claim 或阻断旧知识 |
| 文档、Git 或飞书版本变化 | `source check` / `source refresh` | content change 后重新蒸馏；metadata-only 保留 receipt |
| 召回错误、无答案却注入、相邻主题串扰 | `query --debug`、真实 eval、`feedback` | 增加 hard-negative/forbidden/abstain case，再做 dry-run calibration |
| 知识常被正确或错误使用 | `feedback --query-run-id` | maintenance 读取去重后的 useful/not_useful 反馈 |
| 多次任务出现重复、更新、冲突或稳定流程 | `maintenance run/watch` | 生成 proposal、inbox 或严格门槛的 Skill 草稿 |
| Hook/Subagent 没触发或重复触发 | `hook doctor`、`subagents status/logs` | 修宿主接入、事件配对或模板，不把日志当事实 |
| 安装资源缺失、被改写或与外部配置冲突 | `integration doctor` | 默认 merge 重装；保留用户修改和第三方资源 |
| 关系孤立、冲突或来源覆盖不足 | graph HTML + audit | 人工补可解释关系、处理 conflict/source 队列 |

这对应 MetaMem 所强调的“会不会用记忆”：

- Query debug 记录候选、注入结果、覆盖率和 scorer。
- `queryRunId` 把实际使用结果与 useful/not_useful feedback 关联。
- Eval 使用 hard-negative、forbidden 和 abstention 衡量错误使用，而不是只看 Recall。
- Calibration 优先惩罚 forbidden injection、abstention failure 和负反馈，只输出建议。
- Maintenance 结合独立 session、可信来源、冲突和反馈判断是否形成知识或 Skill。

当前这些机制不会训练一个外部 meta-memory 模型，但已经形成可审计的
“检索 -> 使用 -> 反馈 -> 评测 -> proposal -> 人工治理”闭环。未来若接入 MetaMem、
Hindsight、memU 或 Mem0，它们只能以 shadow/sidecar 输出 proposal，不能替代 Git Markdown
事实源或绕过人工审阅。

## 主动记忆何时发生

主动记忆不是“所有对话自动写入”：

- Hook 会记录生命周期信号和 Subagent 调试日志，但不会调用 LLM 总结，也不会写 active 知识。
- `agent-knowledge-writer` 的 description 会指导主 Agent 在“显式要求记忆、已验证可复用结果、重复且有证据的业务观察”这些边界主动调用它。
- 普通闲聊、一次性命令、临时错误、可直接搜索到的代码表面结构不应触发长期记忆。
- 是否实际调用 Subagent 取决于宿主 Agent 的调度；可用 `agent-knowledge subagents status/logs` 检查。
- `maintenance` 从已记录的 `SubagentStop` 结果自动抽取 observation，但只形成可审阅 proposal。

如果希望明确保存某件事，最可靠的方式仍是直接告诉 Agent“记住这条规则”，或主动运行 `knowledge-organizer`。

当前仍未提供“静默常驻、自动登录在线飞书并主动向用户提问”的后台 Agent。现有
`source refresh` 只复用已登记的本地 Git ref、文件或离线 export；`maintenance watch`
只消费本地日志并生成 proposal。在线爬取需要凭据、限流、通知策略、失败恢复和用户显式
选择的进程管理器，后续实现时仍不得自动写 active knowledge。

## 客服机器人怎么部署

建议为机器人使用独立 workspace/config，并在向导中设置：

- `actorType = customer`
- `captureMode = automated_session`
- `visibilityScopes = project,team`
- `sensitivityClearance = internal`

运行原则：

- 不保存完整客户隐私、凭据或未授权 transcript。
- 客户陈述只是 observation，不能成为 `user_confirmed`。
- 每个 ticket/session 使用稳定 `case_...` stream ID，分别记录 intake/query/hypothesis/
  root_cause/action/verification/closure，不要只保存最终回复。
- 完整聊天和工具响应通过 `event append --payload <file>` 进入 Vault，不进入 staging 或同步。
- 同一客户或同一 session 重复多次不算独立佐证。
- 按租户或业务边界使用独立 root/project key；不要让一个客户的候选进入另一个客户的检索范围。
- `maintenance watch` 只负责生成提案；不要自动执行 `maintenance accept` 或 `organize-inbox --approve`。
- 接受业务事实前，应对照受信文档、owner 确认或多个独立来源。

这能降低无用对话和恶意知识投毒进入正式知识库的风险。完整治理规则见[候选知识与主动记忆](docs/guides/memory-governance.md)。

## 知识图谱怎么使用

本项目实现的是**知识关系图**，不是源码 AST/code graph。Agent 仍应按需搜索代码；图主要表达知识、领域、场景、项目、episode、来源和 proposal 之间的显式关系。

构建并导出离线可视化：

```bash
agent-knowledge graph build
agent-knowledge graph export --format html --output knowledge-graph.html
```

HTML 支持搜索、节点类型/状态/domain/project 筛选和详情查看，适合人类浏览与审阅。脚本也支持：

当前 HTML 使用 Cytoscape.js 离线渲染，支持滚轮缩放、画布平移、节点拖拽、COSE 自动整理、同心/层级/网格布局、适应视图和点击展开一跳邻域。首次打开只加载精炼知识；domain/scenario/project、完整 source 原文知识和 source 证据默认隐藏，避免大规模结构/证据节点挤满画布。左侧可切换：

- `精炼知识`：推荐默认视图。
- `精炼知识 + 直接证据`：查看 source/episode/proposal 邻居。
- `全部节点`：查看完整索引；节点很多时先使用网格，再按需运行 COSE。

```bash
agent-knowledge graph query --text "退款审核"
agent-knowledge graph query --id <knowledge-id> --depth 2
```

要让图真正参与 Agent 检索，使用：

```bash
agent-knowledge query --task "当前任务" --retrieval graph
agent-knowledge query --task "当前任务" --retrieval hybrid-graph
```

图检索只沿 `depends_on`、`refines`、`supports`、`often_used_with` 做最多两跳扩展；`conflicts_with` 和 `supersedes` 不作为普通上下文扩展。图候选仍会重新执行有效期、可见性、敏感级别、项目和类型过滤。

## 核心原则

- `knowledge/` 中排除 generated、`_inbox`、`_archive`、`_inbox-skills` 后的 `schema_version: 2` KnowledgeDocument Markdown 是正式可读事实源。
- `kind` 表达 profile/semantic/procedural/episodic/principle/source，`layer` 表达 synopsis/knowledge/evidence。
- `aliases`、`scenarios` 和 `tags` 都带权重与来源；supported claim 必须带 source/section/hash evidence。
- `_inbox` 和 `_archive` 永远不会进入正式检索。
- `_inbox-skills` 使用 Skill frontmatter，只供人工审阅/安装；不会进入 index、embedding、catalog、graph 或同步。
- 自动会话和客户陈述只能生成 proposed observation，不能直接激活。
- 查询和关系扩展都执行 validity、visibility、sensitivity 和 project 过滤。
- `knowledge show/evidence` 也执行相同安全过滤；知道 ID 不能绕过 project 或敏感级别隔离。
- 同步只处理正式 Markdown；冲突必须人工解决，不能静默覆盖。
- Integration 默认结构化 merge；只有显式 overwrite 才删除目标文件或 symlink。
- Codex standalone Hooks 写 `.codex/hooks.json`，Skills 写 `.agents/skills`；Codex 不支持独立 Markdown agents。
- Codex `plugin-bundle` 生成本地 marketplace，需由用户显式注册和安装，不能与散装 Hooks/Skills 重复启用。

## 常用命令

```bash
# 配置
agent-knowledge workspace git-init --root ~/agent-knowledge-data
agent-knowledge workspace git-status --root ~/agent-knowledge-data
agent-knowledge vault init --root ~/agent-knowledge-data
agent-knowledge configure
agent-knowledge --locale en --help
agent-knowledge config show
agent-knowledge config path

# Integration
agent-knowledge integration list
agent-knowledge integration install
agent-knowledge integration doctor --product trae --scope user
agent-knowledge integration install --product codex --scope user

# 知识库
agent-knowledge init
agent-knowledge index
agent-knowledge list
agent-knowledge catalog
agent-knowledge organize-inbox
agent-knowledge organize-inbox --approve <knowledge-id> --apply

# 检索与 embedding
agent-knowledge embed-index
agent-knowledge embedding status
agent-knowledge embedding download
agent-knowledge query --task "当前任务" --debug
agent-knowledge query --task "当前任务" --retrieval graph --graph-depth 2
agent-knowledge eval --input eval/cases/retrieval-baseline.yaml
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --pipeline lexical
agent-knowledge eval --fixture eval/cases/project-business-retrieval.yaml --pipeline lexical
agent-knowledge eval-calibrate --input calibration-observations.json

# 知识图谱
agent-knowledge graph build
agent-knowledge graph query --text "关键词"
agent-knowledge graph export --format html --output knowledge-graph.html

# 质量审计与渐进展开
agent-knowledge knowledge audit --fail-on warning
agent-knowledge knowledge show <knowledge-id> --layer knowledge
agent-knowledge knowledge evidence <claim-id>

# Source 审阅与蒸馏
agent-knowledge source check
agent-knowledge source check --connector-id <connector-id> --fail-on-updates
agent-knowledge source refresh
agent-knowledge source refresh --connector-id <connector-id>
agent-knowledge source list --needs-review
agent-knowledge source show <source-id>
agent-knowledge source export <source-id> --fingerprint <sha256> --output /secure/tmp/evidence
agent-knowledge source mark <source-id> --fingerprint <sha256> --review-token <token> --status refined --knowledge-id <active-id>

# 客服与需求生命周期事件
agent-knowledge event append --stream-type support --stream-id <case-id> --stage intake --event-type customer_question --summary "..." --payload /secure/tmp/payload.json --content-type application/json
agent-knowledge event list --stream-type support --status closed
agent-knowledge event timeline initiative <initiative-id>
agent-knowledge event show <event-id>
agent-knowledge event export <event-id> --output /secure/tmp/event-payload
agent-knowledge event status

# 飞书批量导出与摄入
node scripts/fetch-lark-corpus.mjs --root-url <wiki-url> --output /secure/exports/lark --refresh-existing
agent-knowledge ingest lark-export --connector-id lark-business --export-dir /secure/exports/lark --project-key github.com/example/business

# 加密完整 evidence
agent-knowledge vault status
agent-knowledge vault put --input complete-session.json --content-type application/json
agent-knowledge vault get <vault-object-id> --output /secure/path/session.json
agent-knowledge vault delete <vault-object-id> --reason "retention expired"

# 同步
agent-knowledge sync run
agent-knowledge sync watch

# Subagent 与主动维护
agent-knowledge subagents status
agent-knowledge subagents logs --agent-type agent-knowledge-writer
agent-knowledge staging status
agent-knowledge staging drain --limit 100
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

## 默认位置

用户配置：

```text
~/.config/agent-knowledge/config.json
```

项目配置：

```text
<git-root>/.agent-knowledge.json
<git-root>/.agent-knowledge.local.json
```

默认 workspace root：

```text
~/.agent_knowledge
```

其中包含：

```text
knowledge/                         Markdown 事实源
.memory/index.sqlite              可重建检索索引
.memory/embeddings/               可重建向量缓存
.memory/logs/                     运行摘要
.memory/staging/                  脱敏主动记忆事件
.memory/subagents/                本地完整 Subagent 调试日志
.memory/observations/             自动抽取的 maintenance observation
.memory/proposals/                待人工审阅的维护提案
.memory/graph.json                可重建知识关系图
.memory/ingestion/connectors/     本机 0600 Connector 登记；不含凭据
.memory/ingestion/update-checks/  本机 0600 probe-only 更新报告
.memory/events/                   Event append lock；不是事实源
.vault/objects/                   完整 source/event payload 密文
events/support/*.jsonl            客服 case 脱敏 hash-chain 时间线
events/projects/*.jsonl           需求 initiative 脱敏 hash-chain 时间线
```

命令行显式参数优先于项目 local，项目 local 优先于项目共享，项目共享优先于用户配置，用户配置优先于兼容环境变量。完整规则见[配置指南](docs/guides/configuration.md)。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/cli.js --help
```

测试不得依赖远程模型或真实 WebDAV/S3 服务。

## 研究与设计

- [正式投入使用前审计、MetaMem/Hindsight/memU/Mem0 对比与当前完成状态](docs/research/2026-08-09-production-memory-system-evaluation.md)
- [Hivemind、Agent Memory 与 Embedding 评测](docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md)
- [Context Infrastructure 深度调研与改进建议](docs/research/2026-07-26-context-infrastructure-evaluation.md)
- [项目知识、同步、客服投毒与主动记忆](docs/research/2026-07-19-project-memory-sync-and-poisoning.md)
- [Agent Knowledge 演进设计](docs/superpowers/specs/2026-07-19-agent-knowledge-evolution-design.md)
- [Agent Knowledge 演进实施计划](docs/superpowers/plans/2026-07-19-agent-knowledge-evolution.md)
