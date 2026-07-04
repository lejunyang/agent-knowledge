# Agent 知识持久化系统设计

日期：2026-07-05

状态：已确认设计，待用户审阅书面规格

## 背景

目标是设计一套给 agent 使用的知识持久化手段。系统需要能按场景分类存储知识，自动从会话、任务、文件和其他 agent 运行过程中总结业务知识，并在后续任务中根据当前场景匹配相关知识注入给主 agent。同时，知识库不能只是机器索引，也必须让人类能直接阅读、审阅和维护。

本设计采用“人类可读 Markdown 事实源 + 元数据/全文/向量多索引 + 可选图谱扩展”的混合架构。向量化是必要的召回通道之一，但不是唯一事实源，也不替代分类、元数据、全文检索和来源治理。

## 设计目标

- 人类可读：知识以 Markdown 保存，支持直接阅读、git diff、审阅和手动修订。
- Agent 可用：提供结构化查询工具，输出主 agent 可直接消费的 `context packet`。
- 自动沉淀：通过 hooks 和 writer subagent 自动抽取候选知识。
- 可治理：候选知识默认进入审阅队列，避免自动总结污染长期知识库。
- 可追溯：每条知识都记录来源、置信度、状态、有效期、冲突和替代关系。
- 可扩展：第一版不强依赖图数据库，但保留 episode、关系和时间有效性字段，未来可升级到时间知识图谱。

## 非目标

- 第一版不实现完整 Graphiti/Zep 风格的时间图谱。
- 第一版不做团队级权限服务，只保留 `visibility` 和 `sensitivity` 字段。
- 第一版不让主 agent 直接写正式知识库。
- 第一版不把所有历史会话原文保存为长期知识。

## 总体架构

系统分为七层：

```text
Event Sources
  -> Hooks
  -> memory-writer subagent
  -> candidate memories
  -> governance pipeline
  -> Markdown knowledge base
  -> indexer
  -> metadata index + FTS/BM25 + embeddings
  -> memory-query
  -> context packet
  -> main agent / other agents
```

模块边界如下：

| 模块 | 责任 | 不负责 |
|---|---|---|
| `hooks` | 捕获会话、任务、文件、git、显式记忆指令等事件 | 判断知识是否最终可信 |
| `memory-writer subagent` | 从事件中抽取候选知识，生成 Markdown 草稿和 metadata | 直接写入正式知识目录 |
| `memory-governor` | 校验 schema、去重、合并、冲突检测、审阅分流 | 生成原始业务结论 |
| `Markdown knowledge base` | 保存人类可读事实源 | 提供高性能检索 |
| `indexer` | 从 Markdown 重建 metadata、FTS/BM25、embedding 索引 | 成为事实源 |
| `memory-query` | 根据当前场景混合召回和重排序 | 修改知识 |
| `context-injector` | 组装主 agent 可消费的上下文包 | 暴露原始检索噪声 |

核心边界：Markdown 是唯一可审计事实源；SQLite、FTS/BM25、embedding 都是可重建索引。主 agent 只消费 `context packet`，不直接读取和拼接原始知识库。

## 知识目录

建议目录结构：

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

目录含义：

| 目录 | 存放内容 | 是否直接注入 |
|---|---|---|
| `profile/` | 用户偏好、团队约定、项目稳定规则 | 经压缩后常驻注入 |
| `semantic/` | 业务事实、概念定义、系统边界、接口语义 | 按场景召回 |
| `episodic/` | 历史任务、问题排查、失败教训、复盘 | 作为相似案例召回 |
| `procedural/` | SOP、检查规则、开发流程、排障流程 | 作为操作指导召回 |
| `sources/` | 原始会话摘要、文档摘要、工单摘要、commit 摘要 | 默认不直接注入 |
| `_inbox/` | 自动抽取但未确认的候选知识 | 默认不注入 |
| `_archive/` | 过期、废弃、被替代的知识 | 不注入，仅审计 |

命名规则：

```text
knowledge/<type>/<domain>/<YYYY-MM-DD>-<short-slug>.md
```

示例：

```text
knowledge/semantic/frontend-lint/2026-07-05-vue-sfc-eslint-fallback.md
knowledge/procedural/code-review/2026-07-05-review-lint-migration.md
knowledge/episodic/incidents/2026-07-05-oxlint-false-positive.md
```

`id` 稳定性高于文件路径。文件可以移动，`id` 不应改变。

## Markdown Schema

每条知识是一个 Markdown 文件，frontmatter 供机器解析，正文供人类阅读。

```yaml
---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
related_domains:
  - ci/performance
  - monorepo/tooling
scenario:
  - code-review
  - lint-migration
tags:
  - oxlint
  - eslint
  - vue-sfc
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:2026-07-05-agent-memory-design
related_knowledge:
  - id: k_20260705_ci_three_stage_validation
    relation: depends_on
    reason: 当前规则依赖 CI 三阶段校验链路
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
valid_until:
---
```

正文章节建议：

```md
# Vue SFC lint 迁移约束

## 结论

Oxlint 负责 TS/JS 快速检查，Vue SFC template 仍需要 ESLint fallback。

## 适用场景

用于 lint 迁移、代码审查、CI 性能优化相关任务。

## 证据

- 用户确认过当前团队采用 Oxlint -> ESLint fallback -> Oxfmt 的三阶段校验链路。

## 注意事项

- 如果未来 Oxlint 支持完整 Vue SFC template 检查，需要重新评估该知识。
```

### 关联字段

业务知识会跨领域关联，因此 schema 包含两类关联：

| 字段 | 含义 | 用途 |
|---|---|---|
| `related_domains` | 粗粒度跨领域关联 | 召回时做领域扩展 |
| `related_knowledge` | 具体知识条目关系 | 一跳关系扩展、冲突提示、解释来源 |

推荐关系类型：

| `relation` | 含义 |
|---|---|
| `depends_on` | 当前知识依赖另一条知识成立 |
| `refines` | 当前知识细化另一条知识 |
| `supports` | 当前知识为另一条提供证据或案例 |
| `conflicts_with` | 两条知识存在冲突 |
| `supersedes` | 当前知识替代旧知识 |
| `often_used_with` | 经常一起召回，但无强逻辑依赖 |

组织原则：知识按主领域归档，不复制到多个目录。跨领域关系通过 `related_domains` 表达，精确关系通过 `related_knowledge` 表达。

## 自动沉淀

写入链路：

```text
event -> hooks -> memory-writer subagent -> knowledge/_inbox/*.md -> governor -> knowledge/<type>/**/*.md -> indexer
```

### Hooks

| Hook | 触发时机 | 产物 |
|---|---|---|
| `session_end` | 一轮对话结束后 | 会话摘要、明确偏好、业务规则候选 |
| `task_success` | 任务完成且验证通过 | 成功流程、项目约定、踩坑经验 |
| `task_failure_recovered` | 出错后修复成功 | 失败原因、排障路径、避免方式 |
| `explicit_remember` | 用户说“记住/以后都/这个项目约定” | 高权威候选知识 |

### Writer Subagent

输入是压缩后的事件包：

```json
{
  "event_type": "task_success",
  "task_summary": "迁移 lint 配置并验证通过",
  "evidence": ["changed_files", "test_result", "user_confirmation"],
  "candidate_scope": ["semantic", "procedural", "episodic"],
  "do_not_store": ["secrets", "temporary paths", "raw private content"]
}
```

输出是候选知识：

```json
{
  "should_store": true,
  "memory_type": "procedural",
  "title": "Lint 迁移验证流程",
  "domain": "frontend/lint",
  "related_domains": ["ci/performance", "monorepo/tooling"],
  "scenario": ["lint-migration", "code-review"],
  "confidence": 0.78,
  "source_authority": "model_inferred",
  "summary": "迁移 lint 配置后应按 Oxlint -> ESLint fallback -> Oxfmt 顺序验证。",
  "evidence": ["conversation:xxx", "command:xxx"],
  "risks": ["该流程可能只适用于当前项目"]
}
```

硬规则：

- 不保存 secret、token、cookie、私钥、隐私原文。
- 不把未经验证的推测标成事实。
- 不直接写入正式目录，只能生成候选知识。

### Governance

治理步骤：

1. `schema validation`：字段完整、类型合法、路径合法。
2. `secret scanning`：拒绝保存凭证、密钥、隐私原文。
3. `dedupe`：按标题、domain、embedding、关键词检查重复。
4. `conflict detection`：检查 `conflicts_with`、`supersedes`、同领域互斥规则。
5. `activation policy`：决定进入 `active`、保留 `proposed`、或拒绝。
6. `merge strategy`：更新旧文件、创建新文件，或追加到已有知识的证据区。

激活策略：

| 条件 | 状态 |
|---|---|
| 用户显式确认 | `active` |
| 来自验证通过的任务，且只记录流程/经验 | `active` 或 `proposed`，取决于置信度 |
| 模型从普通对话推断出的业务事实 | `proposed` |
| 与现有 active 知识冲突 | `proposed`，并写入 `conflicts_with` |
| 涉及安全、权限、生产环境、合规 | `proposed`，必须人工确认 |
| 含 secret、token、个人敏感信息 | `rejected` |

## 检索与注入

检索流程：

```text
current task
  -> scene classifier
  -> metadata hard filter
  -> FTS/BM25 recall
  -> embedding recall
  -> relation expansion
  -> reranker
  -> context packet builder
  -> main agent
```

### 场景识别

示例输出：

```json
{
  "task_type": "code_review",
  "agent_role": "main_agent",
  "domains": ["frontend/lint", "ci/performance"],
  "scenarios": ["code-review", "lint-migration"],
  "paths": ["packages/eslint-config", "apps/web"],
  "risk_level": "medium",
  "need_procedures": true,
  "need_examples": true
}
```

场景识别不应完全依赖 LLM。路径、文件类型、命令、用户措辞、agent 名称都应提供规则信号；LLM 只补足模糊场景。

### 硬过滤

混合召回前先做 metadata 过滤：

```yaml
status: active
domain in current_domains + related_domains
scenario intersects current_scenarios
sensitivity <= allowed_level
valid_until is null or valid_until >= today
```

这一步能避免“向量相似但业务无关”的误召回。

### 混合召回

| 通道 | 适合召回 | 不适合 |
|---|---|---|
| `FTS/BM25` | 精确术语、错误码、API、文件路径、业务名词 | 同义表达、概念相近 |
| `embedding` | 自然语言相似、同义表达、模糊问题 | 强约束规则、细粒度路径 |
| `relation expansion` | 依赖知识、补充知识、经常一起用的知识 | 多跳泛化探索 |

召回策略：

```yaml
retrieval_policy:
  direct_top_k: 8
  related_top_k: 4
  max_relation_depth: 1
  relation_allowlist:
    - depends_on
    - refines
    - supports
    - often_used_with
```

`conflicts_with` 和 `supersedes` 不作为普通扩展注入，而进入 `warnings`。

### 重排序

建议初始分数：

```text
final_score =
  0.30 * lexical_score
+ 0.25 * embedding_score
+ 0.15 * scenario_match
+ 0.10 * confidence
+ 0.10 * source_authority
+ 0.05 * recency
+ 0.05 * relation_strength
```

权重可通过评估集调参。业务场景匹配和来源权威性必须参与排序，否则向量相似度容易把“看起来像”的内容排到前面。

### Context Packet

主 agent 不消费原始 Markdown，而消费结构化上下文包：

```json
{
  "context_version": "1.0",
  "scene": {
    "task_type": "code_review",
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

注入策略：

| 类型 | 注入位置 | 处理方式 |
|---|---|---|
| `always_apply` | system/developer 附近 | 极短、强约束、少量 |
| `relevant_facts` | task context | 中等长度，带来源 |
| `procedures` | execution guidance | 步骤化，但不能压过用户指令 |
| `examples` | few-shot/reference | 最多 1-2 条，防止上下文膨胀 |
| `warnings` | risk notes | 明确提示冲突、过期、低置信 |
| `sources` | trace section | 默认简短引用，需要时展开 |

建议 token budget：

```yaml
context_budget:
  always_apply: 800
  relevant_facts: 1200
  procedures: 1000
  examples: 800
  warnings: 400
  sources: 300
```

## 查询接口

```ts
type MemoryQueryRequest = {
  task: string;
  agentRole: "main" | "reviewer" | "writer" | "planner" | string;
  paths?: string[];
  domains?: string[];
  scenarios?: string[];
  maxTokens?: number;
  includeTypes?: Array<"profile" | "semantic" | "episodic" | "procedural">;
};

type MemoryQueryResponse = {
  packet: ContextPacket;
  debug?: {
    matchedIds: string[];
    scores: Record<string, number>;
    filters: Record<string, unknown>;
  };
};
```

默认不把 `debug` 注入主 agent，但排查召回质量时可以打开。

## 生命周期与冲突

状态：

```yaml
status: proposed | active | deprecated | rejected
```

状态流转：

```text
proposed -> active
proposed -> rejected
active -> deprecated
deprecated -> active  # 仅人工恢复
```

冲突和替代规则：

| 场景 | 处理方式 |
|---|---|
| 新知识替代旧知识 | 新知识 `supersedes` 旧知识，旧知识设 `deprecated` 和 `valid_until` |
| 新旧知识冲突但无法判断 | 新知识保留 `proposed`，双方写 `conflicts_with` |
| 同一事实多来源支持 | 合并 evidence，提高 `confidence` |
| 旧知识长期未使用 | 降权，不直接废弃 |
| 召回时命中冲突知识 | 不注入旧知识，把冲突写入 `warnings` |

## 安全与权限

默认拒绝保存：

- API key、token、cookie、私钥。
- 个人隐私原文。
- 未授权内部敏感全文。
- 临时路径和一次性命令输出。
- 未验证的模型推断作为 active 事实。

权限字段：

```yaml
visibility: private | project | team
sensitivity: public | internal | confidential | secret
```

召回过滤：

```yaml
allowed_visibility:
  - private
  - project
max_sensitivity: internal
```

## 评估

需要维护一组检索评估用例：

```text
eval/
  cases/
    lint-migration-code-review.yaml
    production-incident-debugging.yaml
    architecture-design-memory-system.yaml
```

示例：

```yaml
task: "审查 lint 迁移方案"
expected_memories:
  - k_20260705_vue_sfc_eslint_fallback
  - k_20260705_ci_three_stage_validation
forbidden_memories:
  - k_20260601_deprecated_lint_flow
```

指标：

| 指标 | 含义 |
|---|---|
| `recall_hit_rate` | 人工标注应召回知识中实际召回的比例 |
| `precision_at_k` | top-k 结果中真正相关的比例 |
| `bad_injection_rate` | 注入无关、过期、冲突知识的比例 |
| `context_usefulness` | 主 agent 是否实际使用了注入知识 |
| `task_success_delta` | 注入知识前后任务成功率或返工率变化 |
| `token_cost` | 每次注入消耗的 token |
| `write_acceptance_rate` | 自动候选知识被采纳的比例 |

## FTS/BM25 说明

FTS 是 Full-Text Search，即全文检索。以 SQLite FTS5 为例，它是 SQLite 的虚拟表模块，用来高效搜索大量文档中包含某些词、短语、前缀、近邻关系或布尔组合的内容。

BM25 是文本相关性排序算法。Elastic 文档把 BM25 描述为基于 TF/IDF 的 similarity，带有词频归一化和文档长度归一化，常用于给全文检索结果排序。

在本系统中，FTS/BM25 用于精确术语、错误码、API、文件路径、业务名词召回；embedding 用于同义表达、语义相近、自然语言描述不完全一致的召回。两者必须混合使用。

## 业界参考结论

- LangGraph：区分短期记忆和长期记忆，并将长期记忆理解为 semantic、episodic、procedural 三类。
- Letta：强调 agent memory 的核心是管理上下文窗口，区分总是可见的 core memory blocks 和按需检索的 external memory。
- Mem0：组合 LLM 抽取、向量存储、图数据库关系追踪、语义检索和记忆更新管理。
- Zep/Graphiti：使用 temporal context graph 表达实体、关系、事实有效期、episodes 和 provenance，适合复杂、动态、需要历史追溯的企业级场景。
- Hermes：当前检索到的 Hermes agent memory 资料主要是二级文章，缺少稳定官方来源；可以参考其分层记忆描述，但不作为本设计硬依据。

## 后续实施拆分

建议后续实现按以下顺序拆分：

1. 建立 Markdown schema、目录结构和校验器。
2. 建立 indexer，将 Markdown 同步为 metadata、FTS/BM25、embedding 索引。
3. 实现 `memory-query`，返回结构化 `context packet`。
4. 实现 `_inbox` 候选知识写入和 governance。
5. 接入 hooks 和 `memory-writer subagent`。
6. 建立评估集和召回质量回归测试。
7. 评估是否接入图谱扩展。

## 自审结果

- 无 `TBD`、`TODO` 或未完成章节。
- 架构、schema、写入、检索、治理和评估之间保持一致。
- 范围聚焦在单一端到端知识持久化系统，可进入实施计划阶段。
- 已明确自动写入、人工确认、冲突处理、权限过滤和索引可重建边界。
