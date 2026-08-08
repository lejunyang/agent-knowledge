# Agent Knowledge

Agent Knowledge 是一个本地、可审计的 Agent 知识持久化工具。V2 正式 KnowledgeDocument Markdown 是人类可读事实源；SQLite、embedding、graph、日志和 staging 都是可重建的机器产物。`_inbox`、`_archive` 和 `_inbox-skills` 是审阅产物，不属于正式事实。

当前主分支使用不兼容的 `schema_version: 2`：知识类型 `kind` 与抽象层 `layer` 分离，`synopsis` 负责路由，正文负责解释，supported claim 必须带 evidence anchor。旧 KnowledgeDocument 不会被静默读取或迁移，应从原始 evidence 重新提炼。

## 功能目录

- [快速开始](#快速开始)
- [推荐使用方式](#推荐使用方式)
- [候选知识怎么整理](#候选知识怎么整理)
- [主动记忆何时发生](#主动记忆何时发生)
- [客服机器人怎么部署](#客服机器人怎么部署)
- [知识图谱怎么使用](#知识图谱怎么使用)
- [常用命令](#常用命令)
- [用户配置与全部选项](docs/guides/configuration.md)
- [检索、Embedding、Reranker、图检索与评测](docs/guides/retrieval.md)
- [候选治理、自动维护和 Skill 生命周期](docs/guides/memory-governance.md)
- [TRAE、TRAE CN 与 Claude Code 接入](docs/guides/integrations.md)
- [WebDAV、S3 与定时同步](docs/guides/synchronization.md)
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
- TRAE / TRAE CN / Claude Code integration。
- WebDAV / S3 和定时同步间隔。

安装 Agent 产品接入；不传参数时会交互式选择：

```bash
agent-knowledge integration install
```

初始化并查询：

```bash
agent-knowledge init
agent-knowledge index
agent-knowledge query --task "审查 Vue SFC lint 迁移方案"
agent-knowledge knowledge audit
```

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

不要仅因为模型已经下载就把日常或 Hook 默认切到 hybrid。当前项目真实业务语料的 13-case 评测中，优化后的 lexical 达到 Recall@1/3/5、MRR、nDCG、abstention precision 均为 `1`，false injection 为 `0`，平均 context packet 约 570 token；同一批语料的 hybrid/reranked Recall@1 只有约 `0.56`，且 dense 通道会给无答案问题返回候选。推荐 lexical 作为自动路径，hybrid/reranker 仅用于 lexical 未命中后的人工诊断，并先用自己的 eval 校准。

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

推荐的每周维护：

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge list
agent-knowledge organize-inbox
```

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

用户明确指定拉取的正式文档可以先由 `knowledge-organizer` 拆成精炼知识，同时把经过治理的证据保存为 `kind: source`、`layer: evidence`。source 导入前必须遮蔽测试账号、验证码、密码、token、用户标识和个人信息；同一外部文档更新或脱敏规则升级时，使用 `capture-material --replace-source` 刷新稳定 ID 对应的 active documented source。该参数不能覆盖精炼知识，semantic/procedural/profile/episodic/principle 更新仍应新增版本并使用 `supersedes`。

用户主动提供材料时也不默认相信其中每个垂直领域结论。术语/关系意义不明、需要专业判断、与受信知识冲突，或 Agent 认为内容疑似错误/过期时，`knowledge-organizer` 会一次汇总具体疑点找用户确认；确认前该条不写 active 或 inbox。明确且不依赖疑点的内容可以分开整理。

批量导入正式文档时使用渐进三层：

1. `synopsis`：只负责低成本路由和首次上下文。
2. knowledge 正文：保存背景、条件、例外、步骤、失败策略和验证方式。
3. evidence：保存 source/section/hash 引用；完整敏感原文未来由加密 Evidence Vault 管理。

现有 656 份飞书 source 和 33 条旧精炼知识只用于审计问题与构造评测，不会迁移进 V2 正式知识库。等 Vault、Connector 和蒸馏流程完成后，从原始飞书导出或重新拉取结果全量重建。

可更新来源必须同时记录稳定身份和版本指纹：

- 飞书：document key + `revision_id` + `updated_at/obj_edit_time` + content hash。
- Git/GitHub：规范 remote + commit SHA + relevant path/tree hash。
- HTTP/WebDAV：稳定 URL/object key + ETag/Last-Modified/version ID + content hash。
- 上游不提供版本时：只能重新抓取后比较 content hash，不能把“没有版本信息”当作“没有更新”。

更新检查先比较 revision/ETag/commit SHA 等轻量信号；信号未变可跳过正文下载。抓取后若只有上游 revision 或更新时间变化但 content hash 不变，记为 metadata-only，不触发重蒸馏；只有 content hash 变化才重新切 section、失效相关 claim 并生成更新 proposal。飞书递归脚本可显式执行：

```bash
node scripts/fetch-lark-corpus.mjs \
  --root-url <wiki-or-doc-url> \
  --output local_exports/lark \
  --refresh-existing
```

## 主动记忆何时发生

主动记忆不是“所有对话自动写入”：

- Hook 会记录生命周期信号和 Subagent 调试日志，但不会调用 LLM 总结，也不会写 active 知识。
- `agent-knowledge-writer` 的 description 会指导主 Agent 在“显式要求记忆、已验证可复用结果、重复且有证据的业务观察”这些边界主动调用它。
- 普通闲聊、一次性命令、临时错误、可直接搜索到的代码表面结构不应触发长期记忆。
- 是否实际调用 Subagent 取决于宿主 Agent 的调度；可用 `agent-knowledge subagents status/logs` 检查。
- `maintenance` 从已记录的 `SubagentStop` 结果自动抽取 observation，但只形成可审阅 proposal。

如果希望明确保存某件事，最可靠的方式仍是直接告诉 Agent“记住这条规则”，或主动运行 `knowledge-organizer`。

## 客服机器人怎么部署

建议为机器人使用独立 workspace/config，并在向导中设置：

- `actorType = customer`
- `captureMode = automated_session`
- `visibilityScopes = project,team`
- `sensitivityClearance = internal`

运行原则：

- 不保存完整客户隐私、凭据或未授权 transcript。
- 客户陈述只是 observation，不能成为 `user_confirmed`。
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

## 常用命令

```bash
# 配置
agent-knowledge workspace git-init --root ~/agent-knowledge-data
agent-knowledge workspace git-status --root ~/agent-knowledge-data
agent-knowledge configure
agent-knowledge --locale en --help
agent-knowledge config show
agent-knowledge config path

# Integration
agent-knowledge integration list
agent-knowledge integration install
agent-knowledge integration doctor --product trae --scope user

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

- [Hivemind、Agent Memory 与 Embedding 评测](docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md)
- [Context Infrastructure 深度调研与改进建议](docs/research/2026-07-26-context-infrastructure-evaluation.md)
- [项目知识、同步、客服投毒与主动记忆](docs/research/2026-07-19-project-memory-sync-and-poisoning.md)
- [Agent Knowledge 演进设计](docs/superpowers/specs/2026-07-19-agent-knowledge-evolution-design.md)
- [Agent Knowledge 演进实施计划](docs/superpowers/plans/2026-07-19-agent-knowledge-evolution.md)
