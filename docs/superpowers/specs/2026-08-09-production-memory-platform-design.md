# Agent Knowledge 正式记忆平台设计

日期：2026-08-09

## 目标

把当前“本地 Markdown 知识检索工具”升级为“可持续摄入、可审阅巩固、可渐进读取、可追踪演化的私域记忆平台”，支持：

1. 初始批量业务文档学习。
2. 每日文档增量学习和旧知识修正。
3. 客服问题解决、查询路径学习和 SOP 演化。
4. 需求从评审、方案、开发、测试、发布到运维的全生命周期跟踪。
5. 完整会话和工具轨迹保存，用于后续复盘、重提炼和系统优化。
6. 多 Agent、多宿主、多数据源接入。
7. 后台 observer、consolidator、critic 和 curator 主动工作。
8. Git 版本追踪、人类 review、回滚和可审计变更。
9. 外部 memory backend 的 shadow A/B 和局部替换。

## 核心原则

### 1. 完整存储不等于完整注入

系统可以保存完整文档、完整会话和完整项目轨迹，但普通 query 不得把它们全量注入模型。

必须区分：

- **持久化完整性**：后续能重放、审计、重新提炼。
- **检索完整性**：需要时能定位到具体证据。
- **上下文经济性**：当前任务只加载必要层级和片段。

### 2. 内容类型和抽象层级正交

现有 `semantic/procedural/episodic/profile/source` 是“知识内容类型”，不能同时承担“摘要/解释/原文层级”。

新模型使用两个维度：

```text
kind  = semantic | procedural | episodic | profile | principle | skill | source
layer = synopsis | knowledge | evidence
```

示例：

- semantic + synopsis：一句核心业务结论。
- semantic + knowledge：概念、条件、关系、例外和例子。
- source + evidence：原始飞书章节或完整文档。
- procedural + synopsis：SOP 的触发条件和 3 步总览。
- procedural + knowledge：详细步骤、分支、失败策略和验证。
- episodic + evidence：完整客服会话或需求过程。
- principle + knowledge：从多个事件中形成、经过反例验证的判断原则。

### 3. Git 是知识变更账本，不是 secret vault

Git 适合：

- synopsis。
- knowledge。
- source manifest。
- 脱敏 evidence。
- schema。
- proposal。
- review 决策。

Git 不适合默认保存：

- 未脱敏完整客服对话。
- token、cookie、账号、验证码。
- 大型附件和二进制。
- 用户明确要求删除但会残留在历史中的个人信息。

因此采用双平面：

```text
Knowledge Git Repository
  - 可审阅、可 diff、可同步的 Markdown/JSON

Encrypted Evidence Vault
  - 完整会话、原始文档、工具轨迹、附件
  - 内容寻址、加密、保留策略、访问审计
```

Git 中只保存 Vault object 的不可逆 ID、内容 hash、脱敏摘要和精确 span。

### 4. 外部后端永远不能静默成为权威

Hindsight、memU、Mem0、Graphiti 等输出必须经过 adapter 转成统一 proposal。

无论选择哪个后端：

- Git Markdown 是正式知识事实源。
- Vault 是原始证据事实源。
- SQLite/vector/graph/external memory 都是可重建或可替换投影。

### 5. 自动化可以主动，晋升必须有治理

后台 Agent 可以：

- 发现文档更新。
- 生成候选知识。
- 找冲突、反例和空洞。
- 建议修订。
- 生成 Skill/Principle。
- 创建 Git review branch。

但不能：

- 把客户陈述直接变成正式业务事实。
- 无 evidence 修改 active 结论。
- 覆盖已有人工知识。
- 自动向远端公开仓库推送私域知识。

## 一、五层记忆模型

用户提出的三层内容模型是正确方向，但要再补两层事件与巩固，才能支持客服和项目全流程。

### L0：Route / Synopsis

用途：

- 快速判断这条知识是否值得展开。
- Hook 热路径注入。
- catalog 和导航。

内容：

- 1 到 3 条核心结论。
- 适用条件。
- 关键风险。
- 下一层引用。

建议预算：

- 80 到 220 中文字。
- 不允许堆砌术语。
- 不重复 frontmatter。

### L1：Knowledge / Explanation

用途：

- Agent 解决大多数业务问题的主要内容层。

内容质量合同：

- 定义与背景。
- 核心事实或流程。
- 适用条件。
- 不适用条件和例外。
- 关键实体/字段/状态。
- 示例或反例。
- 操作影响。
- 时效和版本。
- evidence span。

建议长度：

- 单条 600 到 3000 中文字。
- 超过 3000 字时按独立主题拆分，不按固定 chunk 生硬切割。

这不是越长越好，而是必须足以回答：

- 是什么？
- 为什么？
- 什么时候适用？
- 不适用时怎么办？
- 结论从哪里来？

### L2：Evidence

用途：

- 审计。
- 争议解决。
- 文档更新影响分析。
- 重新提炼。
- 训练和评测。

内容：

- 完整来源文档。
- 稳定 section/chunk/span。
- 表格。
- 代码片段。
- 原始事件。
- 脱敏后的会话片段。

Evidence 默认不进入普通 query。只有以下情况展开：

- 用户要求来源。
- knowledge 层存在冲突。
- Agent 需要检查限制条件。
- 更新/反思 worker 需要重新验证。

### L3：Event / Episode

用途：

- 记录发生了什么，而不是直接宣称什么永远为真。

主要事件：

- 客服 case。
- 需求评审。
- 设计决策。
- 实现和测试结果。
- 发布变更。
- 故障、告警和运维。
- 用户纠正。
- 检索命中/未命中和反馈。

Event 是 append-only 流，可在 Vault 保存完整 payload，在 Git 保存脱敏 timeline。

### L4：Consolidated Memory

用途：

- 从多个知识和事件中形成更稳定的长期能力。

产物：

- Principle：判断原则和边界。
- Skill：可执行工作流。
- Diagnostic Path：客服/排障查询路径。
- Retrieval Lesson：如何找知识、什么信号容易误导。
- Project Playbook：从需求到运维的阶段检查单。
- User/Team Profile：稳定偏好和协作方式。

L4 必须有：

- supporting evidence。
- counter evidence。
- applicable contexts。
- invalid contexts。
- independent source/session/project count。
- last challenged time。
- acceptance decision。

## 二、目录与仓库设计

### 推荐部署

代码仓库和知识仓库分离：

```text
agent-knowledge-code/
  src/
  tests/
  docs/
  templates/

agent-knowledge-data/             # 独立 private Git repo
  .agent-knowledge.json
  registry/
    projects.yaml
    domains.yaml
    scenarios.yaml
    connectors.yaml
  knowledge/
    synopsis/
    semantic/
    procedural/
    profile/
    principle/
    skills/
    source-manifests/
  events/
    support/
    projects/
    conversations/
  proposals/
  reviews/
  eval/
  .gitignore

agent-knowledge-vault/            # 非 Git，默认本机或对象存储
  objects/
  manifests/
  tombstones/
  access-log/
```

### 知识仓库 Git 工作流

```text
connector sync
  -> ingest/<connector>/<batch-id> branch
  -> source manifest + evidence refs
  -> distill/<batch-id> branch
  -> synopsis/knowledge proposals
  -> quality gate
  -> human or policy review
  -> merge main
  -> rebuild projections
```

优势：

- 每次知识变化都有 diff。
- 可以回滚错误蒸馏。
- 能做 code review 式知识 review。
- 后台 Agent 不需要直接写 main。
- 可以按 branch 隔离多个 worker。

### 大文件和敏感材料

不建议直接把所有原文和会话写入普通 Git：

- 需要“可删除”时，Git 历史会成为障碍。
- 文档和图片体积会快速膨胀。
- 内部隐私与凭据风险更高。

默认使用加密 Vault。若用户明确要求“完整原文也进 Git”，应使用：

- 独立私有仓库。
- `git-crypt` 或 SOPS。
- Git LFS。
- 访问和 retention policy。
- 历史重写/删除应急流程。

但这应是可选高风险模式，不是默认。

## 三、Project Identity 重构

### 当前问题

`project_222a913d21c0ba91` 不适合作为知识库对外身份：人无法反向识别，且规范化 Git remote 本身已经能提供跨机器稳定、可读的项目作用域。

Git remote 本身在多数场景确实可以作为自然唯一标识，但仍存在：

- remote URL 可能包含用户名或凭据。
- HTTPS/SSH 表达不同。
- 仓库迁移或 fork。
- 没有 remote 的本地项目。
- 同一 remote 的多个 worktree。

### 新设计

规范化 Git remote 直接作为项目主键：

```yaml
project_key: github.com/lejunyang/agent-knowledge
display_name: agent-knowledge
aliases:
  - lejunyang/agent-knowledge
  - knowledge
remotes:
  - role: origin
    normalized: github.com/lejunyang/agent-knowledge
    raw_redacted: git@github.com:lejunyang/agent-knowledge.git
local_roots:
  - hash: local_...
status: active
```

规则：

- `project_key` 是规范 remote，不含协议、SSH 用户、URL 凭据、`.git` 和末尾 `/`。
- Markdown、CLI、日志和 query 都直接使用 `project_key`，不再暴露或要求 hash ID。
- query 接受 `--project <project-key-or-alias>`。
- remote rename、仓库迁移和 fork 通过 registry alias 维护；知识 frontmatter 可保留创建时的 key，并由 registry 解析到当前 canonical key。
- 无 remote 的本地项目使用显式用户命名 key，例如 `local/lejunyang/private-prototype`；不得把绝对路径或路径 hash 当作默认可见身份。
- 如 SQLite 需要短键，可以内部计算 hash，但它只是可重建索引字段，不属于 Markdown schema 或公共 API。

## 四、Metadata 评分模型

### 为什么不能只保留字符串数组

不是每个 alias、scenario、tag 与知识的相关性相同。评分不仅影响检索，也影响：

- 自动清理。
- 人工 review 排序。
- 元数据是否值得保留。
- 失败后如何调整。

### 新结构

#### Alias

```yaml
aliases:
  - value: B号
    kind: abbreviation
    weight: 0.98
    source: documented
    evidence_refs:
      - ev_...
  - value: 企业抖音号
    kind: user_phrase
    weight: 0.72
    source: query_observed
    positive_hits: 8
    negative_hits: 2
```

#### Scenario

```yaml
scenarios:
  - id: support/account-binding
    relevance: 0.95
    role: primary
  - id: onboarding
    relevance: 0.55
    role: secondary
```

#### Tag

```yaml
tags:
  - value: account
    weight: 0.80
    source: taxonomy
  - value: internal-doc
    weight: 0.10
    source: provenance
```

### 评分语义

评分必须可解释：

- `relevance`：当前 metadata 对知识主题的相关程度。
- `specificity`：能否区分其他知识。
- `evidence_strength`：是否有正式来源或真实 query 支撑。
- `utility`：历史召回后是否帮助任务。
- `freshness`：是否可能随版本失效。

检索使用的有效权重：

```text
effective =
  relevance
  * specificity
  * evidence_strength
  * utility_calibration
  * freshness
```

第一版不需要给用户暴露五个浮点数。frontmatter 可只保存 `weight/source/kind`，其余由索引投影计算。

### Metadata 数量门禁

推荐默认：

- primary scenario：1 到 2 个。
- secondary scenario：最多 4 个。
- alias：默认最多 8 个，超过需要 query/evidence 支持。
- tag：默认最多 8 个；provenance 类 tag 不参与主题检索。
- 通用 tag 的 IDF 太低时自动降权，不要求人工逐条维护。

## 五、Evidence 与 Claim 模型

### Source Manifest

完整 source 不再只是一大段 XML Markdown，而是：

```yaml
source_id: src_lark_...
connector: lark
external_key: wiki:...
title: 商家中心前端开发指南
version:
  observed_at: ...
  upstream:
    revision: "2461"
    updated_at: ...
    commit_sha: null
    etag: null
  content_hash: sha256:...
  fingerprint: sha256:...
vault_object: vault_sha256_...
sections:
  - section_id: sec_...
    heading_path:
      - 登录态与账号组
      - 商业化登录态 vs 抖音登录态
    text_hash: ...
    char_start: 18320
    char_end: 21790
```

版本判断遵循“先 probe、后确认”：

- 飞书优先比较 `revision/updated_at`。
- Git/GitHub 优先比较 commit SHA，必要时增加 path/tree hash。
- HTTP/WebDAV/S3 优先比较 ETag、Last-Modified 或 object version ID。
- 共同上游信号相同可跳过完整抓取。
- 上游信号变化但 content hash 相同是 metadata-only，不重蒸馏。
- content hash 变化才重新切 section、失效受影响 claim。
- 没有共同上游信号时必须抓取后比较 hash，不能判定 unchanged。

### Knowledge Claim

一条 knowledge 可以包含多个 claim：

```yaml
claims:
  - id: claim_...
    statement: 商业化 UID 和抖音 UID 属于不同账号组，不能默认相等。
    evidence:
      - source_id: src_lark_...
        section_id: sec_...
        quote_hash: ...
    confidence: 0.96
    status: supported
```

这样才能做：

- 文档变更影响分析。
- claim 级冲突。
- 重新验证。
- evidence coverage。
- 引用原文而不注入整个文档。

## 六、统一接入架构

### Connector 协议

每个来源实现：

```ts
interface KnowledgeConnector {
  readonly id: string;
  readonly processingProfile: string;
  discover(cursor: ConnectorCursor | null): AsyncIterable<SourceDescriptor>;
  fetch(source: SourceDescriptor): Promise<Buffer>;
  normalize(
    source: SourceDescriptor,
    raw: Buffer
  ): Promise<NormalizedArtifact>;
}
```

Connector 本身保持只读，不直接写 checkpoint。统一 ingestion core 在 runtime 校验 descriptor，
然后执行脱敏、Vault、source manifest、独立 job 和原子 checkpoint；只有 completed/skipped
才推进水位。这样不同来源不能绕过同一套安全、失败恢复和并发锁边界。

当前已交付第一批本地 UTF-8 adapter：

- `ingest files`：显式 base directory + glob，不跟随 symlink。
- `ingest transcripts`：JSONL convenience adapter，强制 secret + PII 脱敏，manifest 不保存正文 preview。
- `ingest git`：只读本地 committed blob；remote 作为 project key，commit SHA 记录仓库版本，
  blob SHA 作为 path hash，完整运行执行删除/恢复对账。

Source manifest 同时记录 upstream/content fingerprint 与 `processing_profile`。上游版本未变但
normalize/脱敏规则升级时仍会重抓；正文未变则归类 metadata-only 并保留已有处理状态。

### 首批 Connector

#### 文档与知识库

- Lark Wiki/Docx。
- 本地 Markdown/PDF/Office。
- URL/站点 crawler。
- Git repository docs/ADR 已支持 committed blob；issue/MR 仍需 GitHub/Codebase API Connector。

#### 会话与 Agent

- TRAE Hook。
- TRAE/Codex/Claude session JSONL。
- 通用 transcript adapter。
- MCP retain/recall。
- REST/Webhook。

#### 客服

- Ticket。
- IM chat。
- Oncall/事故。
- FAQ/知识库。
- 查询和工具调用轨迹。

#### 项目生命周期

- 需求文档。
- 评审纪要。
- 设计文档。
- commit/MR。
- 测试报告。
- 发布单。
- 告警和事故。

### Ingest Job

借鉴 memU 的 job 思想：

```text
discover
  -> raw capture
  -> normalize
  -> privacy classify
  -> chunk/section
  -> extract candidate claims/events
  -> cross-source consolidate
  -> quality audit
  -> create review branch
  -> merge/commit
```

每个 job 必须：

- 自包含输入引用。
- 有 stable id。
- 可重放。
- 有 cursor/watermark。
- 有失败状态。
- 有成本、模型、prompt 版本。
- 不直接写 main。

## 七、四类正式工作流

### 1. 初始批量业务文档

```text
source inventory
  -> duplicate/version clustering
  -> section extraction
  -> topic map
  -> per-topic knowledge synthesis
  -> claim/evidence linking
  -> coverage audit
  -> unresolved-question batch
  -> review and merge
```

不能再采用“每份文档只生成一条短总结”。一份长文可以产生：

- 多条 semantic。
- 多条 procedural。
- 术语 glossary。
- 状态机。
- FAQ。
- 例外和风险。
- source manifest。

同时一条知识也可以由多份文档共同支持。

### 2. 每日文档增量

```text
connector cursor
  -> detect added/changed/deleted sections
  -> map affected claims
  -> classify append/update/conflict/deprecate
  -> regenerate affected synopsis/knowledge only
  -> run regression eval
  -> review diff
```

不重新总结整库，也不按文档更新时间直接覆盖知识。

### 3. 客服学习

每个 case 保存：

```text
用户问题
  -> 识别实体/租户/账号/环境
  -> 查询路径
  -> 使用的文档/接口/日志
  -> 假设及排除过程
  -> 最终根因
  -> 解决动作
  -> 用户确认结果
  -> 是否复发
```

从多个 case 巩固：

- Diagnostic Path。
- FAQ。
- Missing Documentation。
- Tool Query Pattern。
- Unsupported Advice Anti-pattern。
- Escalation Rule。

客户陈述仍只是 event evidence；只有正式文档、可复现工具结果、owner 确认或独立 case 支撑后才能变成业务事实。

### 4. 项目全生命周期

每个需求建立 `initiative_id`，串联：

```text
intake
  -> requirement review
  -> alternatives
  -> decisions
  -> implementation
  -> validation
  -> release
  -> operations
  -> retrospective
```

事件不应被立即压缩掉。系统定期生成：

- 当前状态摘要。
- 决策日志。
- 风险登记。
- 未解决问题。
- 验收证据。
- 复盘结论。
- 可迁移 Playbook。

## 八、后台 Agent 设计

不建议“一个无限权限 Agent 不断优化”。应拆为有界 worker：

### Observer

- 只读 Connector/Vault。
- 发现新增事件、来源变化和 no-hit。
- 只写 observation。

### Distiller

- 把 source section/event 提炼成 claim 和 knowledge proposal。
- 必须附 evidence span。

### Consolidator

- 合并重复知识。
- 处理增量更新。
- 生成 supersedes/conflict。
- 不直接修改 main。

### Critic

- 找反例。
- 检查边界条件。
- 检测过度概括、正文过薄、metadata 膨胀和无证据 claim。

### Curator

- 维护 taxonomy、route registry、project registry。
- 发现 orphan source、orphan knowledge 和 stale knowledge。

### Skill Miner

- 从重复成功经历中提炼 Skill。
- 需要独立 session、成功结果、正反馈和无 unresolved conflict。

### Research/Crawler Agent

- 按 allowlist 主动爬业务知识库。
- 只读。
- 遇到权限、冲突、术语歧义和缺失上下文时生成一次性问题包。
- 不自行扩大抓取范围。

### Eval Agent

- 生成和维护 query/case。
- 运行回归。
- 不把 synthetic 数据写入真实运行日志。

所有后台 Agent 必须有：

- 输入范围。
- 输出 schema。
- 最大批次。
- token/费用预算。
- 超时。
- 重试策略。
- 模型版本。
- 操作 trace。
- 禁止写入的目录。

## 九、渐进检索协议

### Query 阶段

```text
1. route synopsis
2. retrieve top knowledge claims
3. assemble explanation
4. conditionally expand evidence
5. conditionally reflect across episodes
```

### 新 Context Packet

```json
{
  "context_version": "2.0",
  "route": [],
  "claims": [],
  "procedures": [],
  "principles": [],
  "episodes": [],
  "evidence_handles": [],
  "warnings": [],
  "expansion": {
    "available": true,
    "commands": []
  }
}
```

默认 packet 只含 synopsis 和最必要 claim。Agent 可显式请求：

- `knowledge show <id> --layer knowledge`
- `knowledge evidence <claim-id>`
- `knowledge timeline <initiative-id>`
- `knowledge reflect --scope ...`

### 检索评分

候选分数至少考虑：

- lexical。
- dense。
- metadata weighted match。
- authority。
- validity/freshness。
- evidence completeness。
- historical utility。
- relation。
- project/tenant hard filter。

Source/episode 不能因正文长而自然占优势。

## 十、完整会话存储策略

用户允许保存完整对话，这为后续重提炼提供了价值，但仍需要默认保护：

### Vault 中保存

- prompt。
- assistant response。
- tool call/response。
- agent/subagent relation。
- 时间。
- project/user/session scope。
- attachments。
- result/feedback。

### 入库前处理

- secret detector。
- PII classifier。
- tenant scope。
- legal/authorization tag。
- content hash。
- encryption。

### 保留策略

- owner 私人会话：默认长期，用户可配置。
- 客服会话：按业务合规周期。
- tool 大输出：可保存 hash + compressed object。
- 明确凭据：只保存 redaction marker，不保存原值。

### 删除

Vault 必须支持 tombstone 和物理删除。Git 只保存不含敏感原文的引用，避免“删了 Vault 但 Git 永久留存”。

## 十一、外部后端集成

统一接口：

```ts
interface MemoryBackend {
  retain(input: BackendRetainInput): Promise<BackendRetainResult>;
  recall(input: BackendRecallInput): Promise<BackendRecallResult>;
  reflect?(input: BackendReflectInput): Promise<BackendReflectResult>;
  deleteScope?(scope: MemoryScope): Promise<void>;
  health(): Promise<BackendHealth>;
}
```

初始 adapter：

- `native`。
- `hindsight`。
- `memu`。
- `mem0`。
- 后续 `graphiti`。

Shadow 评测记录：

- ingest latency/cost。
- recall quality。
- evidence grounding。
- temporal update。
- Chinese quality。
- false memory。
- deletion completeness。
- operational burden。

## 十二、从原始材料全量重建

现有知识库不做 V1 -> V2 迁移。当前 33 条精炼知识和旧 metadata 只用于证明问题、设计评测问题和人工抽样对照，不进入新知识事实源。

重建流程：

1. 创建空的独立 private Git 数据仓库和空 Vault。
2. 优先重新拉取飞书文档；无法重新拉取时使用 `local_exports/lark-business/` 的原始 XML 和 manifest。
3. 对原始材料重新执行脱敏、内容 hash、重复/版本聚类和 source manifest 构建。
4. 按 heading、表格、FAQ、流程和代码块生成稳定 section。
5. 从 section 重新生成 L0 synopsis、L1 knowledge 和 claim/evidence anchor。
6. 每份 source 必须被分类为 refined、duplicate、obsolete、no_long_term_value 或 blocked，禁止无声遗漏。
7. 当前 33 条旧知识只参与离线差异报告：
   - 新知识是否补足旧知识缺失的解释。
   - 旧知识是否包含新材料无法支持的结论。
   - 新知识是否减少 metadata inflation。
8. 旧知识库保持原样直到新库通过正式使用门禁；随后可直接归档或删除，不做逐文件转换。

Project identity 同样从零使用 `github.com/lejunyang/agent-knowledge` 等规范 key，不保留 `project_222a913d21c0ba91` 作为新 schema 字段。

## 十三、正式使用门禁

在宣称“可正式投入使用”前，至少满足：

- 知识仓库是独立 private Git。
- Vault 加密和删除可用。
- project key 可读。
- 文档 source coverage 100% 有状态，不允许无声遗漏。
- active claim evidence coverage 100%。
- forbidden injection = 0。
- 客户陈述直接晋升 = 0。
- 至少 50 个中文业务问答 case。
- 至少 30 个客服 case。
- 至少 3 个完整 initiative timeline。
- 文档增量更新和 supersession 测试通过。
- backup/restore 演练通过。
- 外部 backend 关闭时 native pipeline 仍可用。

## 非目标

- 不把所有原文注入每次会话。
- 不自动把任何来源都视为同等可信。
- 不用一个万能 Agent 直接修改全部知识。
- 不以 graph 节点数量、tag 数量或 embedding 数量作为知识质量指标。
- 不在没有本地中文评测前替换 native 检索。
- 不把内部业务知识提交到当前公开代码 remote。
