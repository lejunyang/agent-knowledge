# CLI 多语言、Hook 降噪与四阶段路线补齐设计

日期：2026-07-19

## 目标

完成以下互相关联但边界清晰的改进：

1. 将 `ActorType` 的 `system` 迁移为语义更准确的 `agent`，兼容读取旧数据。
2. 为 CLI 普通输出、帮助信息、交互向导和 Hook 提示提供 `zh-CN` / `en` 多语言。
3. 让 `UserPromptSubmit` 默认静默，只在可靠相关或用户明确查看知识菜单时注入最小上下文。
4. 删除旧模板链接 CLI 和 TypeScript 兼容 API。
5. 新增 embedding/reranker 模型缓存状态与显式下载命令。
6. 完成 `2026-07-18-hivemind-memory-and-embeddings-evaluation.md` 四阶段中尚未实现的任务。

## 阶段完成度基线

### 阶段一：可信基线

已完成：

- Eval schema 支持 expected rank、graded relevance、forbidden、abstain、language 和 domain。
- 输出 Recall@1/3/5、MRR、nDCG、false injection、latency 和 packet tokens。
- Deterministic provider 覆盖协议测试。
- 已有 hard-negative 和 no-answer smoke case。

未完成：

- 覆盖 17 个代表性知识主题的完整 fixture/case corpus。
- 每个主题的同义改写、近主题 hard negative、cross-language 与 no-answer case。
- 可显式运行的真实模型 hybrid/reranked eval，以及适合定时任务的稳定输出。

### 阶段二：P0 正确性

已全部完成：

- `_inbox` / `_archive` 路径硬隔离。
- validity、visibility、sensitivity、project 和 relation expansion 过滤。
- token budget。
- embedding manifest/profile 和维度兼容校验。
- 真实 dense score。
- CJK 2/3-gram。
- RRF 与完整 debug。

### 阶段三：默认模型与 rerank

已完成：

- 默认 multilingual E5 small q8 profile。
- BGE small zh profile。
- lexical/dense/metadata RRF。
- 可插拔逐条 reranker 接口。

未完成：

- 批量 cross-encoder candidate reranker。
- `top 30 -> rerank -> top 8` pipeline。
- 使用 hard negative、forbidden、abstention 和 usefulness feedback 的 threshold/权重校准。
- reranker 模型的显式下载和本地状态管理。

### 阶段四：自动沉淀与时间知识

已完成：

- Staging JSONL、watermark、stale lock 和 bounded drain。
- Candidate 基础去重。
- `supersedes` 激活时的 deprecated/valid_until 失效。
- `memory-maintainer` 审阅工作流。

未完成：

- 可重复运行的 maintenance worker/watch。
- duplicate/consolidation/update/conflict proposal 文件协议。
- 结构化 episode provenance。
- 根据重复成功的 procedural memory 生成 Skill dry-run proposal。

## 语言与术语设计

### Locale

支持：

- `auto`
- `zh-CN`
- `en`

默认 `auto`。检测顺序：

1. 全局 `--locale`。
2. 用户配置 `locale`。
3. `LC_ALL`。
4. `LC_MESSAGES`。
5. `LANG`。
6. `Intl.DateTimeFormat().resolvedOptions().locale`。
7. 回退 `zh-CN`。

只有英文 locale 使用 `en`；中文 locale 使用 `zh-CN`；其他系统语言首发统一回退中文。

多语言覆盖：

- Commander 命令和选项说明。
- Inquirer message、choice name 和 description。
- 人类可读结果、错误说明和 Hook context。

JSON 字段、配置 key、frontmatter key 和知识 ID 不翻译。

### ActorType

Canonical 值：

- `owner`
- `teammate`
- `customer`
- `agent`

兼容策略：

- Schema 接受旧 `system`，解析后归一化为 `agent`。
- 旧配置和 Markdown 无需手工迁移。
- 新序列化、新向导和示例只输出 `agent`。

### Sensitivity 帮助

- `public`：允许公开传播的内容。
- `internal`：组织或项目内部内容，默认 clearance。
- `confidential`：限制成员可见的敏感业务信息，需要显式授权。
- `secret`：凭据、密钥或极高敏感信息。治理层仍禁止把 secret-like 原文写入知识库；该级别只用于经脱敏的高敏感元数据或受控引用。

## Hook relevance gate

### 默认行为

普通 prompt：

- 无可靠命中：stdout 为空。
- 命中低于阈值：stdout 为空。
- 可靠命中：只注入 context packet。
- 不注入 runtime context、catalog 总览、aliases registry 或“没有命中”的说明。

### Catalog intent

仅当 prompt 明确表达以下意图时返回相关菜单：

- 查看有哪些知识、记忆、规则或 SOP。
- 浏览知识库目录。
- 询问可用 domain/scenario。

Catalog 输出：

- 先用 prompt 词项、domain/scenario 和 aliases 做相关性过滤。
- 最多 5 条。
- 只包含 title、domain、scenario 和 ID。
- 没有相关菜单时仍静默。

### 配置与日志

新增 Hook 配置：

- `minScore`
- `maxTokens`
- `catalogMaxItems`

日志记录：

- `decision: none | below_threshold | context | catalog_intent | error`
- result IDs。
- packet token estimate。
- latency。

日志不保存完整 prompt。

## 删除兼容命令

完全删除：

- 旧的 TRAE 模板链接 CLI
- 旧模板链接函数
- 旧 TRAE 配置目录辅助函数
- `src/integration/templates.ts`
- 所有 deprecated 文档说明。

产品接入只保留 `agent-knowledge integration ...`。

## 模型状态与下载

新增命令：

```text
agent-knowledge embedding status
agent-knowledge embedding download
agent-knowledge embedding status --kind reranker
agent-knowledge embedding download --kind reranker
```

统一模型配置：

- embedding profile/model。
- reranker profile/model。
- Agent Knowledge 自有 cache dir。

`status`：

- 不联网。
- 使用 Transformers.js model registry/cache API 检查 pipeline 所需文件。
- 输出 configured model、cache dir、cached、missing files 和可用 dtype。

`download`：

- 唯一允许默认联网下载模型的命令。
- 通过 `pipeline(..., local_files_only: false)` 显式下载并初始化缓存。
- 显示进度。
- 完成后重新运行本地 cache status。

普通 `embed-index`、query 和 Hook 不自动联网。

## 阶段一完整评测

新增 17 个脱敏主题 fixture，覆盖：

- 中文业务事实。
- 中英文术语。
- 项目约束。
- SOP。
- 时间更新。
- 冲突和 supersedes。

每个主题至少包括：

- 1 个正向自然语言改写。
- 1 个近主题 hard negative。

Suite 额外包括：

- cross-language。
- no-answer。
- temporal。
- forbidden。
- abstention。

Eval pipeline：

- lexical。
- hybrid。
- reranked。

真实模型评测使用显式命令，不进入普通 CI；输出 JSON 可由定时同步/CI 归档。

## 阶段三批量 rerank 与校准

### BatchCandidateReranker

接口一次接收 query 和候选文档数组，返回 candidate ID 到 score 的映射。

Pipeline：

1. lexical/dense/metadata RRF。
2. 过滤后取 top 30。
3. Cross-encoder 批量打分。
4. 结合 authority、validity、feedback penalty。
5. 阈值过滤。
6. 输出 top 8。

测试使用 deterministic batch reranker。

Transformers.js profile 使用 `Xenova/bge-reranker-large`，但不默认下载；用户必须运行 model download。

### Calibration

新增：

```text
agent-knowledge eval calibrate
```

输入 eval suite 与 usefulness feedback，执行有限 grid search：

- minimum injection score。
- RRF/cross-encoder 权重。
- top K。

目标函数惩罚：

- false injection。
- forbidden memory。
- abstention failure。

输出 dry-run JSON suggestion，不自动改用户配置。

## 阶段四 proposal worker

新增机器目录：

```text
.memory/proposals/
```

Proposal 类型：

- `duplicate`
- `consolidation`
- `update`
- `conflict`
- `skill`

Maintenance worker：

```text
agent-knowledge maintenance run
agent-knowledge maintenance watch
```

它消费 staging watermark，结合 active/inbox metadata 和 retrieval feedback，生成 proposal JSON。它不调用外部 LLM，也不直接修改 active Markdown。

### Episode provenance

Frontmatter 新增可选结构：

- `episode_id`
- `session_hash`
- `turn_hash`
- `project_id`
- `observed_at`
- `evidence_refs`

旧 Markdown 默认无 episode。

### Procedural -> Skill proposal

只有满足以下规则才生成：

- procedural memory。
- 至少 3 个独立 episode/session。
- verified_task 或 owner-confirmed。
- 没有 unresolved conflict。
- 近期 useful feedback 为正。

只生成 proposal 和候选 `SKILL.md` 草稿内容，不写 `.trae/skills`，不安装。

## 验证与提交

每个功能：

1. 先写失败测试。
2. 实现。
3. 跑聚焦测试与必要 typecheck/build。
4. 更新对应文档。
5. 创建独立 commit。

最终运行：

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```
