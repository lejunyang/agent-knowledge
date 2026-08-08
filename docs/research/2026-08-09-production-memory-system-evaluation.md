# Agent Knowledge 正式投入使用前审计与记忆系统调研

日期：2026-08-09

## 结论摘要

当前项目不是“原文丢失”，而是“精炼知识层没有建立起来”。

本次对现有工作区做了量化审计：

- `knowledge/source/` 中有 656 份飞书来源文档，正文合计约 1317 万字符。
- `semantic` 只有 27 条，`procedural` 只有 6 条，精炼正文合计约 1.18 万字符。
- 33 条精炼知识只明确引用了 6 份 source，来源覆盖率约 0.91%。
- `semantic` 正文中位数只有 325 字，frontmatter 占文件内容约 78.2%。
- `procedural` 正文中位数只有 432 字，frontmatter 占文件内容约 74.2%。
- 每条 `semantic` 平均包含 7 个 alias、6.78 个 tag、4.04 个 scenario。
- 当前精炼知识没有 source span、段落、block 或 chunk 级证据锚点。
- `knowledge/` 整体被 `.gitignore` 忽略，没有任何知识文件被当前 Git 仓库追踪。

因此用户感受到的“正文只有一点点，tag、alias、scenario 却很多”是准确的。现有系统偏向构建检索标签和短结论，没有形成从摘要到解释、再到原始证据的渐进知识结构，也没有覆盖度、信息密度和证据可追溯性的质量门禁。

推荐方向不是继续给现有短知识补更多 tag，也不是立即把某个外部记忆产品替换成主存储，而是：

1. 把“知识类型”和“抽象层级”拆成两个正交维度。
2. 建立 `Synopsis -> Knowledge -> Evidence` 三层知识，加上独立的 `Event/Episode` 事实流和 `Principle/Skill` 巩固层。
3. 使用独立私有 Git 仓库管理可审阅知识，不把内部知识提交到当前公开代码仓库。
4. 完整文档和完整会话进入加密 Evidence Vault，不直接进入普通检索和 Git 历史。
5. 把 Hindsight、memU、Mem0 作为可插拔实验后端或架构参考，不能让它们成为新的不可审计事实源。
6. 优先建设文档覆盖审计、证据锚点、持续蒸馏、客服案例和项目全生命周期记忆，再扩大 embedding 或图数据库投入。

## 一、当前系统为什么看起来“有知识，但不够懂业务”

### 1. 原始材料其实保存得很完整

`scripts/fetch-lark-corpus.mjs` 会递归抓取完整飞书 XML，`scripts/build-lark-source-candidates.mjs` 会在脱敏后把完整正文保存为 `type: source`。

现有 source 的正文长度分布：

| 指标 | 字符数 |
|---|---:|
| 最小 | 107 |
| P25 | 5030 |
| 中位数 | 10865 |
| P75 | 22463 |
| 最大 | 448771 |
| 平均 | 20078 |

所以问题不是抓取脚本只拿到了摘要，而是 source 之后的蒸馏流程几乎没有覆盖整个语料库。

### 2. 精炼层的覆盖率远低于可用知识库要求

当前只有 33 条 semantic/procedural 知识，并且只引用 6 个 source ID。即使一份 source 能产生多条知识，0.91% 的明确来源覆盖率仍意味着绝大多数文档没有进入“可直接帮助 Agent 回答和执行”的精炼层。

当前压缩比例约为：

```text
精炼正文字符 / source 正文字符 = 0.000898
```

这不是正常意义上的“高质量压缩”，而是绝大多数材料尚未蒸馏。

### 3. 当前 schema 鼓励“短结论 + 大量元数据”

`KnowledgeFrontmatterSchema` 强制至少一个 `scenario`，同时支持 aliases、related domains、tags、relations、project IDs、来源和治理字段。正文却只有一个无结构约束的 `body`。

这会产生不对称：

- 元数据字段有 schema 和数量上的显性要求。
- 正文没有“解释、条件、例子、例外、操作影响、证据锚点”等质量合同。
- writer 模板明确要求普通知识使用“精炼 summary”，没有要求保留足够的解释层。
- `extractSummary` 最多取正文前 500 字，context packet 又只取前 360 字。

结果是系统更容易优化“能不能被搜到”，而不是优化“搜到之后是否足够解决问题”。

### 4. alias、tag、scenario 混用了不同语义

当前常见问题：

- `alias` 同时承担同义词、缩写、内部术语、字段名和查询关键词。
- `tag` 同时承担业务分类、文档来源、组织属性和检索关键词。
- `scenario` 同时承担任务场景、主题分类、产品域和知识目录。
- 这些值只有“有或没有”，没有关联强度、特异性、来源或使用反馈。
- 高频通用标签如 `internal-doc`、`company-business`、`business-knowledge` 出现在大部分知识中，区分度很低。

即使检索端已经加入 alias coverage gate，这些元数据仍会让人工阅读、维护和后续自动学习变得困难。

### 5. source 只有文档级引用，没有证据片段级引用

精炼知识能指向某个 source ID，但不能回答：

- 结论来自原文哪一节？
- 是否来自表格、正文、FAQ 还是代码片段？
- 原文更新后哪些知识受影响？
- 一条知识是否遗漏了同一章节中的限制条件？
- 两条冲突知识分别依赖什么证据？

没有 span/chunk 锚点，就无法可靠执行增量更新、反例检查和影响分析。

### 6. 当前 context packet 只有一档内容

`ContextPacketItem.content` 只放最多 360 字摘要。主 Agent 无法表达：

1. 先拿最短结论。
2. 不够时再拿解释和边界。
3. 仍有争议时再展开证据原文。

虽然图谱中有 source 节点，但 query 默认不检索 source，且没有统一的渐进读取协议，所以现有“source 完整保存”没有转化为任务执行能力。

### 7. 主动维护更偏去重，不是真正的巩固与反思

现有 maintenance 能做：

- duplicate。
- consolidation。
- update。
- conflict。
- skill proposal。

但确定性 worker 主要按同 domain、同 title/alias 和 summary 包含关系判断。它没有：

- 来源覆盖率审计。
- 正文过薄检测。
- 元数据膨胀检测。
- 反例和边界条件挑战。
- 跨文档同主题聚合。
- 当前知识对业务问题的解释充分性评估。
- 从客服结果中学习“更精准查询路径”的结构。
- 从需求全生命周期中提炼阶段风险和检查点。

### 8. 当前工作区不是 Git 化知识库

`.gitignore` 中直接包含：

```text
knowledge/
```

这避免了把内部飞书材料误提交到当前代码仓库，是安全的；但也说明当前知识没有版本追踪。

不能简单删除这一条并提交。当前 origin 是代码项目 remote，知识中包含大量内部业务材料。正确做法是把知识工作区迁移到独立私有 Git 仓库，而不是把私域知识混入当前代码仓库。

## 二、外部产品调研

### 调研方法

优先审计官方仓库、官方文档和论文，不把宣传页分数直接当作可复现实验结论。

本次审计快照：

| 项目 | 审计 commit | 许可证 | 核心定位 |
|---|---|---|---|
| MetaMem | `66232c1cb33d3d7939d323b431f21c741785142e` | Apache-2.0 | 学习“如何使用记忆”的元记忆研究 |
| Hindsight | `4b2041eb3de5c4235f4a3dd5619fc47cce782e29` | MIT | Retain/Recall/Reflect 完整记忆服务 |
| memU | `3afdb107837679f108ed3313f8dedd30073626d7` | Apache-2.0 | Agent 驱动的共享 Wiki 与自动 Skill 提取 |
| Mem0 | `4debc58a83377b18be81ae1e5969a300736b2fac` | Apache-2.0 | 通用用户/会话/Agent 记忆 SDK 与服务 |

### 1. MetaMem

官方仓库：<https://github.com/OpenBMB/MetaMem>

论文：<https://arxiv.org/abs/2602.11182>

MetaMem 的核心不是存储，而是训练一份可演化的 meta-memory，让模型学会：

- 从分散记忆中识别关键证据。
- 进行跨 session 信息整合。
- 处理时序问题。
- 通过环境反馈总结“以后应该怎么用记忆”。

实际仓库是研究复现代码：

- 依赖 LightMem 构造 factual memory。
- 需要 Qwen3-30B、Llama 3.1 70B、Qwen3-235B 等模型。
- 使用 SGLang 部署。
- 包含训练、k-fold、推理和 LongMemEval 评测脚本。

判断：

- **适合借鉴**：meta-memory、知识使用经验、跨任务反思、错误归因。
- **不适合直接嵌入**：不是通用存储中间件，训练和 GPU 成本高。
- **对本项目的价值**：建设 `retrieval lesson` 和 `reasoning policy` 层，记录“什么问题应该先找哪类证据、哪些检索结果组合容易误判”。

### 2. Hindsight

官方仓库：<https://github.com/vectorize-io/hindsight>

文档：<https://hindsight.vectorize.io/>

论文：<https://arxiv.org/abs/2512.12818>

Hindsight 把记忆分为：

- World：外部世界事实。
- Experiences：Agent 自己经历过的事件。
- Mental Models / Observations：从事实和经历反思形成的稳定认识。

提供三种操作：

- `retain`：LLM 抽取事实、实体、关系和时间信息。
- `recall`：并行执行 semantic、BM25、graph 和 temporal 检索，RRF 融合后 cross-encoder 重排。
- `reflect`：基于已有记忆做更深入分析并形成观察。

工程能力包括：

- 独立 memory bank 隔离。
- PostgreSQL 或内嵌 pg0。
- Python embedded 模式。
- Python、TypeScript、Go、REST 和 MCP 接入。
- consolidation、mental model refresh、版本和 dry-run。
- retain/recall/reflect trace。
- 异步批量 retain 和失败恢复。

官方仓库中能看到专门的：

- consolidation worker 和失败恢复测试。
- mental model 定时刷新、版本和 structured output。
- temporal recall。
- recall score trace。
- output language 测试。

判断：

- **最适合做实验 sidecar**：尤其适合客服经历、项目事件和主动反思。
- **不能直接成为事实源**：它会通过 LLM 抽取和巩固，输出需要回写 proposal 并保留原始证据。
- **部署成本较高**：需要 LLM、embedding、reranker 和数据库；完整仓库和运行栈明显重于当前 Node CLI。
- **中文能力需本地评测**：工程上支持输出语言和多模型，官方公开 benchmark 仍以英文长期记忆任务为主，不能直接推断中文业务知识效果。

### 3. memU

官方仓库：<https://github.com/NevaMind-AI/memU>

memU 当前版本的价值不只是“另一个向量库”，而是完整处理了 Agent 宿主接入：

- 读取 Codex、Claude Code、Cursor、OpenClaw、Hermes、WorkBuddy 等 session 日志。
- 用 per-session cursor 增量读取。
- `prepare -> self-evolve -> commit` 后台流水线。
- 由 Agent 自己决定跳过、修改现有 Skill 或新增 Skill。
- 存储层只负责文件、embedding 和 retrieval，不调用 LLM。
- 本地支持 SQLite，团队场景支持 PostgreSQL/pgvector。
- 通过 `progressive_retrieve` 返回文件、segment 和 resource。

值得直接借鉴的点：

- `TranscriptSource` 宿主 adapter 抽象。
- job 文件是自包含、可重放的 Agent 工作单元。
- leftovers、cursor、prepare/commit 的失败恢复。
- 多宿主共享一个记忆后端。
- Skill 提取把分支、边界情况和陷阱写入可读 Markdown。

需要警惕的点：

- 默认工作流允许 Agent 直接修改 Skill Markdown 并 commit。
- 本地模式仍需要外部 embedding provider key。
- 当前主项目是 TypeScript，直接嵌入 Python 服务会增加部署和诊断复杂度。
- 它更关注个人 Agent 经验与 Skill，不覆盖本项目的文档 authority、敏感级别、租户、冲突和人工晋升边界。

判断：

- **架构复用优先级最高**：优先复用 adapter/job/cursor/commit 协议。
- **可选 sidecar**：可做快速对照实验，但不建议让其数据库成为权威事实层。
- **不直接照搬自动写入策略**：Agent 产物必须先进入 review branch 或 proposal。

### 4. Mem0

官方仓库：<https://github.com/mem0ai/mem0>

Mem0 提供：

- Python 和 TypeScript SDK。
- 自托管服务、Dashboard、鉴权和 API key。
- user/session/agent 多级记忆。
- 多种 vector store、embedding、LLM 和 reranker。
- entity linking、BM25、semantic 和 temporal retrieval。
- CLI、插件、skills 和多框架集成。

它是四者中通用 SDK 和生态最成熟的方案，适合快速接入用户个体记忆或客服用户历史。

但官方 README 已明确说明：

- 2026 年最新高分来自 managed platform。
- managed platform 包含 OSS SDK 中没有的专有优化。
- OSS 用户只能期待方向相似，不能期待相同结果。

另有两个与本项目相关的边界：

- 默认需要 LLM 和外部 embedding。
- NLP hybrid 安装示例默认使用英文 spaCy 模型，中文业务检索需要另行配置和实测。

判断：

- **适合做对照基线和可插拔 personalization backend**。
- **不适合直接承载完整业务文档事实源**。
- **不能用托管版 benchmark 替代本地中文业务 corpus 评测**。

### 5. 其他可参考项目

#### Graphiti

官方仓库：<https://github.com/getzep/graphiti>

Graphiti 是 Apache-2.0 的时序知识图引擎，适合：

- 实体关系。
- 事实有效期。
- 增量更新。
- supersession。

当前项目已有 lightweight graph 和 validity 字段，短期不应为了“看起来更先进”立即切换。只有当项目生命周期、多跳因果和时间更新评测证明现有图不足时，才做 adapter 对照。

#### Letta

文档：<https://docs.letta.com/>

Letta 更像完整 Agent runtime，提供 core/archival memory、MemFS、后台 sleep-time agent、skills 和 schedules。它值得参考 Git 版本化 MemFS 和后台巩固，但直接嵌入会改变本项目“作为跨 Agent 中间件”的产品定位。

## 三、能力对比

| 维度 | 当前 Agent Knowledge | MetaMem | Hindsight | memU | Mem0 |
|---|---|---|---|---|---|
| 权威事实源 | Markdown | 外部 memory | 数据库 | 文件/数据库 | 数据库 |
| 完整原文 | 已支持 source | 非重点 | retain 输入可保存 | resource/file | 可作为输入 |
| 分层知识 | 类型分层，抽象层不足 | factual + meta | world/experience/mental model | resource/file/segment/skill | atomic memories + entity |
| 主动巩固 | proposal/skill 门禁，语义弱 | 强，需训练 | 强 | Agent 自演化 | 平台能力较强 |
| 时序更新 | 有 validity/supersedes | 强项之一 | 强 | 基础文件更新 | 新版强调 temporal |
| 多宿主接入 | TRAE/Claude hooks/skills | 无 | SDK/MCP/wrapper | 很强 | 很强 |
| 文档治理 | 强 | 弱 | bank/tag | 弱 | filter/user/session |
| 人工审阅 | 强 | 研究流程 | 可通过 UI/trace | 默认自动 | 有 Dashboard |
| 中文业务可用性 | 有本地语料证据 | 未验证 | 未验证 | 依赖 embedding | 需单独配置 |
| 直接嵌入建议 | 主体 | 否 | shadow sidecar | adapter/sidecar | baseline/可选 backend |

## 四、市场产品对本项目的真正启示

### 1. “记住”和“会用”必须分开

当前项目把事实检索做得比最初稳定，但缺少 MetaMem 所强调的“如何组合和使用记忆”。

需要新增两类资产：

- Retrieval Lesson：某类问题应该先查什么、后查什么、哪些信号是噪声。
- Reasoning Policy：如何把事实、经历、SOP、例外和时序变化组合成判断。

它们不能与业务事实混在一起，也不能由一次任务自动晋升。

### 2. 原始经历、世界事实和稳定认识必须分开

Hindsight 的 World / Experience / Mental Model 对当前项目很有启发：

- 文档中的明确规则是世界事实。
- 客服会话、事故、需求过程是经历。
- 多次经历后形成的诊断模式、风险判断和流程原则是 mental model。

当前 `semantic/procedural/episodic` 只能表达内容类型，无法表达它位于“原始经历、详细知识还是巩固认识”的哪一层。

### 3. 接入能力应该是 adapter，不应该继续堆 Hook

memU 证明了多宿主 session ingestion 可以抽象为：

```text
discover -> incremental read -> prepare jobs -> agent synthesis -> commit
```

本项目应该建立统一 Connector/TranscriptSource/ArtifactSource 协议，让 Hook 只是其中一个 adapter。

### 4. 外部后端必须运行在 shadow 模式

对 Hindsight、Mem0、memU、Graphiti 的正确接入方式：

1. 同一批脱敏输入同时送到 native pipeline 和外部 backend。
2. 比较 recall、更新、冲突、时序、中文和成本。
3. 外部 backend 输出只生成 proposal。
4. Git 知识仍是权威事实源。
5. 评测达标后才能让某个 backend 负责特定子场景。

这样既能“拿来直接用”，又不会把项目重新绑定到一个不可审计黑盒。

## 五、推荐优先级

### P0：先修知识完整性，不先换模型

- 分层 schema。
- source chunk/span 锚点。
- 精炼知识正文质量合同。
- source 覆盖审计。
- 独立私有 Git 知识仓库。
- 以原始飞书导出或重新拉取结果为输入，从空库全量重建；不迁移当前 33 条精炼知识和旧 frontmatter。

### P1：建设持续输入与案例闭环

- 飞书增量同步。
- 全会话加密 capture。
- 客服 case/diagnostic trace。
- 需求生命周期 timeline。
- job/cursor/commit adapter。

### P2：建设主动巩固

- 每日 observation。
- 每周 consolidation。
- contradiction challenge。
- knowledge gap。
- principle/skill proposal。
- retrieval lesson。

### P3：外部后端 A/B

- Hindsight：经历、时序、reflect。
- memU：多宿主 adapter、Skill 提取。
- Mem0：用户/会话个体记忆 baseline。
- Graphiti：复杂时序关系 baseline。

### P4：再决定是否替换局部底座

只有本地中文业务 corpus、客服案例和项目全生命周期评测证明外部后端稳定更优，才替换对应子系统。

## 六、评测基线必须扩展

现有 retrieval eval 主要验证“该命中的知识有没有命中”。正式使用前还需要：

### 文档学习

- Source Coverage：每份 source 是否被标记为已提炼、无长期价值、重复、受阻。
- Claim Coverage：关键章节和表格是否有对应知识。
- Evidence Grounding：每条结论是否有 span 证据。
- Explanation Sufficiency：仅看 detail 层能否回答“为什么、适用条件、例外”。
- Update Accuracy：文档变更后能否找到受影响知识。

### 客服

- Query Path Precision：是否选择了正确系统、实体、日志和接口。
- Resolution Success：最终是否真实解决。
- Unsupported Advice Rate：是否给出无证据建议。
- Repeat Issue Improvement：同类问题后续处理是否更快、更准。
- Customer Poisoning Rate：客户单方陈述进入 active 的比例必须为 0。

### 项目全生命周期

- Decision Traceability。
- Requirement-to-Release Coverage。
- Risk Recall。
- Regression Prevention。
- Retrospective Transfer：历史教训能否改善新需求计划。

### 长期记忆通用能力

建议引入：

- LongMemEval：信息提取、多 session 推理、时序、更新、abstention。
- MemoryAgentBench：accurate retrieval、test-time learning、long-range understanding、selective forgetting。
- 自建中文业务集：必须继续作为最终门禁，不能只跑英文公开集。

## 七、参考资料

- MetaMem：<https://github.com/OpenBMB/MetaMem>
- MetaMem Paper：<https://arxiv.org/abs/2602.11182>
- Hindsight：<https://github.com/vectorize-io/hindsight>
- Hindsight Docs：<https://hindsight.vectorize.io/>
- Hindsight Paper：<https://arxiv.org/abs/2512.12818>
- memU：<https://github.com/NevaMind-AI/memU>
- Mem0：<https://github.com/mem0ai/mem0>
- Mem0 Research：<https://mem0.ai/research>
- LongMemEval：<https://github.com/xiaowu0162/LongMemEval>
- MemoryAgentBench：<https://github.com/HUST-AI-HYZ/MemoryAgentBench>
- Graphiti：<https://github.com/getzep/graphiti>
- Letta：<https://docs.letta.com/>
