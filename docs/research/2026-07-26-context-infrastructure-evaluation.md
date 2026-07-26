# Context Infrastructure 深度调研与 Agent Knowledge 改进建议

## 核心结论

`grapeot/context-infrastructure` 值得本项目参考，但不是替代方案，也不适合整仓照搬。

它最有价值的贡献不是语义搜索或记忆存储，而是把长期上下文定义成一条认知资产流水线：

```text
行为与会话数据
  -> L1 每日观察
  -> L2 周期反思、去重、过期清理
  -> L3 Axiom / Skill / USER / COMMUNICATION
  -> 任务按需加载
  -> 新产物和反馈再次进入观察
```

本项目已经在事实治理、项目隔离、检索、评测、同步、审计和安全写入方面明显更强；当前缺口是“蒸馏深度”。Agent Knowledge 主要停留在 profile / semantic / procedural / episodic / source 和 Skill proposal，尚未把跨时间、跨项目重复出现的稳定判断进一步蒸馏成带反例、边界条件和触发场景的个人决策原则。

因此建议：

- 参考 Context Infrastructure 的 **L1/L2/L3 认知分层、反例验证、路由索引和飞轮**。
- 保留本项目的 **proposal -> inbox -> 人工确认 -> active** 治理边界。
- 不采用其 Reflector 直接改 `rules/`、Observer 直接追加长期记忆、日期字符串幂等和全 workspace 自主扫描方式。

## 调研证据

### 仓库

- 仓库：<https://github.com/grapeot/context-infrastructure>
- 审计 commit：`7f0ed7ba37af32fe493a2b78dfaed1bbca038824`
- commit 时间：2026-07-25T09:45:46-07:00
- GitHub API 快照：
  - stars：681
  - forks：164
  - open issues：2
  - 主要语言：Python
  - tracked files：132
  - GitHub API 未返回 license；仓库根也没有 LICENSE 文件，尽管 README 文本写了 MIT。复用代码前需要作者补齐许可证文件或单独确认。
- 仓库定位明确写成 reference implementation，不是开箱即用工具。
- 当前 checkout 是 shallow clone，无法用本地 `rev-list` 还原完整历史；GitHub commits API 显示仓库至少存在 100 条近期提交，contributors API 中主要贡献者为 grapeot。

### 配套文章

- 文章：<https://yage.ai/context-infrastructure.html>
- 标题：为什么 AI 只会说正确的废话，以及怎么把它逼出舒适区
- 发布时间：2026-03-15T22:00:00-07:00
- 文章主张：
  - LLM 默认输出趋向 consensus，模型升级不自动产生个人判断。
  - Deep Research 更多解决信息覆盖，而非认知不对称。
  - 当模型能力跨过阈值，产出性质更多受 context density 影响。
  - 采集客观行为数据比仅写 system prompt 更可靠。
  - 稳定、跨场景、跨时间重复的模式才适合蒸馏。
  - context 通过 Skill 和索引按需加载，不能全部塞入窗口。

文章给出一组同模型档次、同 prompt、同调研 Skill/搜索工具、不同个人 context 的对照报告。该证据说明“context 可能显著改变报告风格和判断框架”，但不是严格 benchmark：

- 本次直接读取两份公开报告：第一份约 1.4 万字符，覆盖知识底座、可观测性、约束、merge、GC、长程记忆、multi-agent 和 eval；第二份约 0.9 万字符，结构更紧，突出“完美主义是吞吐量敌人”“纠错比等待便宜”等判断。第一份并非低质量，只是更像完整工程综述；差异更适合解释为“覆盖面与观点密度不同”，不能解释为一份有 context 就正确、另一份没 context 就无效。
- 模型并非同一模型，只是作者认为同档次。
- 只展示了一组任务。
- 缺少盲评、评分量表、重复试验和统计显著性。
- 两份报告分别托管在不同站点，文章由系统作者本人解释差异。

所以它是有启发性的案例证据，不足以证明“context 一定提高事实正确率”或量化收益。

## 实际架构

### 1. 每次会话的被动上下文

根 `AGENTS.md` 要求每次读取：

- `rules/SOUL.md`
- `rules/USER.md`
- `rules/WORKSPACE.md`
- `rules/COMMUNICATION.md`
- `rules/skills/INDEX.md`

这相当于稳定的 context control plane：

- SOUL：Agent 行为基调。
- USER：用户画像、偏好和背景。
- COMMUNICATION：沟通与写作约束。
- WORKSPACE：目录路由。
- Skills index：能力发现入口。

优点是简单、透明、跨工具可读；缺点是文件变大后每次被动加载会侵占窗口，且规则冲突主要依赖 Agent 自己解释。

### 2. Axiom 与 Skill 分离

仓库把：

- Axiom 定义为 why / 判断原则。
- Skill 定义为 how / 执行能力。

43 条 Axiom 分为 AI/Agentic、技术决策、管理、信任、跨域隐喻。Axiom 文件包含核心表述、展开、应用判定、陷阱和关联原则。

Skill 索引强调：

- 结果确定性优于过程确定性。
- Skill 应写目标、验收标准、资源、边界和输出规格。
- 不把 Skill 写成机械 SOP。
- 已知陷阱来自真实失败，不提前编造。

这个分离值得参考。本项目当前 procedural knowledge 与 Skill proposal 有分层，但“判断原则”只能勉强放入 profile/semantic，缺少单独的验证和调用语义。

### 3. 三层记忆

仓库文档中的 L1/L2/L3：

- L1 Observer：每日扫描文件变化，写入红/黄/绿观察。
- L2 Reflector：每周去重、删除过期 low、合并 medium、晋升 high。
- L3：直接修改 SOUL、USER、COMMUNICATION、WORKSPACE 或 skills。

稳定性是核心筛选标准：跨时间、跨场景重复出现的判断更可能属于用户认知结构。

### 4. Progressive Disclosure

它不把全部 observations/axioms/skills 注入每个任务，而是：

- 根 AGENTS 作为路由入口。
- WORKSPACE/INDEX 作为二级目录。
- 具体 Axiom/Skill 按任务加载。
- 大型 session archive 先 lexical search，再 semantic fallback。

这一点与本项目的 Hook relevance、catalog intent、context packet、memory reader 和 graph retrieval方向一致。区别是本项目已有确定性过滤、token budget、project/sensitivity/validity 和 eval，Context Infrastructure 主要依赖 Markdown 路由和 Agent 自律。

### 5. 认知画像工作流

`workflow_cognitive_profile_extraction.md` 比 observer/reflector 更成熟，包含：

- Discover / Verify / Finalize / Restructure 的 Round 循环。
- 多源、时间序列和原文证据。
- 强制反例狩猎。
- 候选可信度会在验证后下降。
- 口号检测：简洁、反直觉、易传播的候选更需要反例验证。
- 公理必须包含边界条件。
- 预测力回测。
- 独立 Agent 评判作为可选更严格协议。
- 收敛信号与防过拟合。

这是最值得本项目借鉴的部分。它把“重复出现”升级为“可被反例攻击、能预测新场景、知道何时失效”的稳定原则。

### 6. 知识飞轮

`workflow_knowledge_flywheel.md` 的核心是：

```text
触发 -> 简单基础模块 -> 可测量微小进步 -> 固化 -> 下一轮
```

它强调接受不完美原始数据、小步验证、简单索引和本地模型。与本项目真实业务语料迭代非常一致：656 source 没有全部激活，而是先提炼 9 条、建立真实 case、修检索，再扩展。

## 实现质量与限制

### Observer 的实际门禁较弱

`observer.py`：

- 用 `Date: YYYY-MM-DD` 检查当天条目是否存在。
- 存在则整天跳过。
- 通过 OpenCode Session 让 Agent 自主扫描 workspace。
- 直接 append `OBSERVATIONS.md`。

问题：

- 日期是粗粒度幂等；当天部分失败后重跑无法增量补齐。
- 没有 source watermark、content hash、事件 ID 或批次事务。
- 没有锁，cron 重入可能并发写。
- 没有来源 authority、privacy、tenant 或 sensitivity policy。
- Agent 被鼓励使用 shell append，文件格式和原子性依赖模型行为。
- 扫描整个 workspace，范围控制主要靠 prompt 和路径黑白名单。

本项目已有 source watermark、lock、append-only observation、bounded worker、project ID 和日志 cleanup，不应退回日期字符串幂等。

### Reflector 直接修改规则层

`reflector.py` 让 Agent：

- 读取 observations。
- 直接修改 SOUL/USER/COMMUNICATION/WORKSPACE/skills。
- 重写 observations，删除已晋升或过期记录。

文档虽写明晋升门槛“跨项目通用 + 多次验证 + 明确适用场景”，但实现没有：

- 结构化 proposal。
- 人工批准。
- conflict/supersedes。
- source evidence schema。
- 原子批次和 rollback。
- 自动测试或规则回归评测。

这适合单用户、强信任、Git 可回滚的个人 workspace，不适合本项目的机器人客服、多租户和正式业务知识场景。

### 自动化代码仍是模板

- `observer.py` / `reflector.py` 含 `/path/to/your/workspace` 和 `<your-model-id>`。
- setup guide 表示需自行配置 OpenCode。
- OpenCode client 捕获大量宽泛异常并打印后返回 `None`，错误状态不结构化。
- Reflector 默认不删除 session，没有 observer 的 `--no-delete` 对称策略。
- 仓库只有一个 PDF CLI 单测，heartbeat、reflector、routing 和 migration 没有测试。
- 当前审计环境未安装 pytest，因此没有执行该单测；这里只根据仓库文件分布判断自动化覆盖面，不能声称其测试已通过或失败。
- semantic search 的 chunk line position 有 TODO；索引更新逻辑注释明确称简化实现。
- semantic search 使用 pickle，缓存不适合跨不可信边界共享。

因此它更像一套活跃个人 workspace 的公开快照，而非成熟 SDK。

### License 状态矛盾

README 写 MIT，但：

- GitHub API `license` 为 null。
- 根目录没有 LICENSE/COPYING。

方法论可以参考；若复制代码或较长文本，需先确认许可证。

## 与 Agent Knowledge 对比

| 维度 | Context Infrastructure | Agent Knowledge |
|---|---|---|
| 目标 | 个体认知与工作系统 | 受治理的 Agent 事实、流程与项目知识 |
| 事实源 | 普通 Markdown workspace | Schema 化 KnowledgeDocument Markdown |
| 原始输入 | 文件变化、会话、生活/工作数据 | Hook/Subagent observation、直接材料、文档 source |
| 动态记忆 | 单个 OBSERVATIONS.md 红黄绿 | JSONL observations + proposal + inbox |
| 长期层 | rules / axioms / skills | profile/semantic/procedural/episodic/source + Skill |
| 晋升 | Reflector 直接改 rules | proposal -> inbox -> 人工确认 -> active |
| 检索 | rg + 可选独立 semantic skill | CJK FTS、embedding、RRF、reranker、graph |
| 过滤 | Agent 路由和 prompt | status、validity、visibility、sensitivity、project、type |
| Context 注入 | AGENTS/INDEX/Skill 渐进披露 | Hook relevance + token/score gate + reader |
| 定时维护 | cron + OpenCode | maintenance run/watch + watermark/lock |
| 冲突/时间 | 主要依赖人工文本 | conflicts、supersedes、valid_until |
| 评测 | 文章案例、认知画像预测回测方法 | 公开/私有 eval、Recall/MRR/nDCG/false injection |
| 同步 | Git/workspace 自行管理 | WebDAV/S3 + policy |
| 多租户 | 非核心目标 | project/visibility/sensitivity 隔离 |

## 值得参考的内容

### 1. 增加认知原则层

本项目需要区分：

- `profile`：用户是谁、稳定偏好。
- `semantic`：事实和概念。
- `procedural`：怎么做。
- **principle/axiom**：为什么这样判断、权衡优先级和失效边界。

不建议立刻修改 KnowledgeDocument `type` 枚举。先在 proposal 层增加 `principle` kind，经过验证后可写为 profile/semantic 的结构化子类；eval 成熟后再决定是否新增正式 type。

### 2. 多轮蒸馏，而不是一次 consolidation

借鉴 Round 模型：

1. Discover：从 observations/source 找候选模式。
2. Verify：主动找反例、跨项目/跨时间验证。
3. Restructure：合并互补或拆分过泛候选。
4. Finalize：形成带边界条件的 principle/Skill proposal。

每轮都写结构化工件，不直接修改 active。

### 3. 反例与边界条件

为 principle proposal 增加：

- supporting evidence。
- counter evidence。
- valid contexts。
- invalid/weak contexts。
- confidence before/after verification。
- source/session/project diversity。
- last challenged time。

这能防止“出现三次”就被误认为稳定原则，也能识别社交表演、临时情绪和版本漂移。

### 4. Context 路由索引

本项目已有 catalog、domain、scenario、project 和 graph，可以进一步提供一个小型 route registry：

- 任务类型 -> 推荐 domain/scenario。
- repository/path -> project/domain。
- agent role -> 默认 includeTypes。
- explicit browse intent -> catalog。

该 registry 应由配置和可审阅规则生成，不应成为另一份手写且容易过期的 WORKSPACE.md。

### 5. USER / COMMUNICATION 结构

Context Infrastructure 把“用户背景”和“沟通风格”独立文件化，立即有价值。

本项目可以：

- 提供可选用户 profile bootstrap 命令/模板。
- 将稳定沟通偏好保存为 private profile knowledge。
- Hook 只注入极少 always-apply profile，继续受 token budget 和 sensitivity 过滤。
- 不把整份用户画像同步到机器人 workspace。

### 6. Skill 生态与本地 overlay

它把通用 public Skill 与用户本地 alias/path/credential overlay 分离，这值得参考。本项目 integration 可进一步：

- Skill manifest 记录来源 repo/version/hash。
- 私有 overlay 与 public Skill 分开。
- 升级只替换受管 public 部分，保留本地 overlay。

这与当前 integration manifest/hash 所有权模型兼容。

## 不建议照搬

1. 不让 Reflector 直接改 active knowledge、AGENTS 或 Skill。
2. 不把 raw session/transcript 默认放进同一 workspace 或同步。
3. 不用单个无限增长 OBSERVATIONS.md 作为状态机。
4. 不用日期字符串作为唯一幂等键。
5. 不靠 prompt 保证 observer/reflector 角色隔离。
6. 不把作者的 43 条 axioms 当作本项目默认规则。
7. 不为追求“有立场”而降低事实审计；bias 必须显式、可挑战、可禁用。
8. 不因语义相似就把 context 推给自动 Hook；本项目真实 eval 已证明 lexical 在当前语料上更可靠。

## 本项目改进路线

### P0：先补治理，不新增自动写入

1. **直接材料领域确认门禁**：已实现。意义不明、需专业判断、冲突或疑似错误的条目，确认前不写 active/inbox。
2. **Subagent 命名隔离**：已实现。对外名称改为 `agent-knowledge-reader` / `agent-knowledge-writer`，避免与宿主泛化 memory agent 冲突。
3. **旧模板安全迁移**：已实现。只删除 manifest 管理且未修改的旧模板。

### P1：引入 Principle Proposal

扩展 maintenance proposal，而不是立即扩展正式 schema：

```json
{
  "type": "principle",
  "candidate": "...",
  "supportingEpisodes": [],
  "counterEpisodes": [],
  "validContexts": [],
  "weakContexts": [],
  "projectDiversity": 0,
  "sessionDiversity": 0,
  "verificationRounds": []
}
```

门槛建议：

- 至少跨 3 个独立 session。
- 若声明跨项目通用，至少 2 个 project。
- 强制一轮 counterexample search。
- 明确边界条件。
- 用户批准后才进入 private profile/semantic。

### P1：维护任务分为 Observer 与 Challenger

现有 maintenance extraction 相当于受治理 Observer。新增 Challenger：

- 只读候选 principle。
- 从 active/source/episode 中主动寻找反例。
- 生成 challenge report，不改候选。
- 用户或后续 Finalizer 根据报告决定合并、降级或拒绝。

这种角色隔离通过工具权限和输出 schema 实现，而不是只写 prompt。

### P1：Context Route Registry

在 `.memory` 构建可重建 route index：

- project/path/domain/scenario/agent-role 映射。
- 记录来源和更新时间。
- query debug 输出采用的 route。
- drift 检查：知识变化后 route 是否过期。

它可以减少 reader 先看 catalog 的需求，但不能绕过访问控制。

### P2：原则预测力评测

借鉴 cognitive profile workflow：

- 冻结一组真实决策问题。
- 原则生成者看训练 evidence。
- 独立 evaluator 不看训练过程，只看 principle 和 held-out outcome。
- 同时报告方向命中、置信校准、反例破坏度。
- 防止用同一 Agent 既产出原则又给自己打高分。

该评测不能替代事实检索 eval；两者分别衡量“像用户思考”和“事实召回正确”。

### P2：定时观察范围控制

如果增加文件观察：

- 使用显式 root/path allowlist。
- content hash + watermark，不用 mtime/date 单独判断。
- 有界批次和跨进程锁。
- raw event 只写 staging。
- source/PII/secret policy 先于 LLM。
- observer 不直接修改 active。

本项目现有 maintenance watch 可以承载调度，不需要新增 cron 安装器；由用户外部进程管理器托管。

## 采用判断

**值得参考，优先级中高。**

短期最值得做的是：

1. 把 maintenance 从“事实/流程 consolidation”扩展到可挑战的 principle proposal。
2. 增加 counterexample、边界条件和跨时间/项目 diversity。
3. 提供可选 private USER/COMMUNICATION bootstrap。
4. 增加 context route registry。

不建议现在做：

- 自动 Reflector 直接写规则。
- 把所有会话和个人数据默认采集进项目。
- 大规模复制 axioms/skills。
- 用更强模型替代治理和评测。

本项目的正确方向是：用 Context Infrastructure 提升“记忆蒸馏的层级”，用 Agent Knowledge 现有治理保证“蒸馏过程不会污染事实源”。

## 参考文件

外部：

- `README.md`
- `AGENTS.md`
- `periodic_jobs/ai_heartbeat/docs/PRD.md`
- `periodic_jobs/ai_heartbeat/docs/KNOWLEDGE_BASE.md`
- `periodic_jobs/ai_heartbeat/src/v0/observer.py`
- `periodic_jobs/ai_heartbeat/src/v0/reflector.py`
- `periodic_jobs/ai_heartbeat/src/v0/opencode_client.py`
- `rules/axioms/INDEX.md`
- `rules/skills/INDEX.md`
- `rules/skills/workflow_cognitive_profile_extraction.md`
- `rules/skills/workflow_knowledge_flywheel.md`
- `rules/skills/bestpractice_skill_writing.md`
- `rules/skills/ai_session_search_archive.md`

本项目：

- `src/memory/observations.ts`
- `src/memory/maintenance.ts`
- `src/memory/governance.ts`
- `src/retrieval/query.ts`
- `src/retrieval/contextPacket.ts`
- `src/retrieval/eval.ts`
- `src/integration/manager.ts`
- `.trae/skills/knowledge-organizer/SKILL.md`
- `.trae/skills/memory-maintainer/SKILL.md`
