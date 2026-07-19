# Hivemind 对比、Agent Memory 调研与 Embedding 评测

日期：2026-07-18

## 结论

本仓库的总体方向是对的，而且在“可审计事实源、写入治理、来源权威性、有效期、冲突关系”方面比 Hivemind 更严格。Hivemind 更强的部分是全链路自动化、跨 agent 接入、后台增量处理、运行时可观测性和真实任务成本评测。

当前效果的主要瓶颈不是缺少更大的 embedding 模型，而是检索实现有正确性缺口：

1. hybrid 只用真实 embedding 选候选，最终 `embeddingScore` 仍来自 token cosine，真实向量分数没有进入最终排序。
2. embedding 缓存没有校验 query provider 与缓存的 model、dimensions、prefix、pooling 是否一致。
3. 中文 FTS 通常把整句当成 token，真实中文自然语言问题容易零召回。
4. `valid_until`、`visibility`、`sensitivity` 没有进入查询过滤。
5. `maxTokens` 没有执行，context packet 只按条数截断。
6. indexer 和 embedding loader 没有明确排除 `_inbox`；若 inbox 文件被标为 `active`，会进入检索。

优先修复这些问题，再升级模型。否则更强模型只能改善部分候选召回，不能稳定改善最终注入结果。

模型建议：

- 默认本地模型：`Xenova/multilingual-e5-small`，使用 q8、384 维、`query:` / `passage:` 前缀和 mean pooling。
- 纯中文且资源敏感：`Xenova/bge-small-zh-v1.5`，使用 q8、512 维、query instruction 和 CLS pooling。
- 更高效果上限：将 `Qwen3-Embedding-0.6B` 和对应 reranker 作为独立本地服务，不建议直接塞入当前同步 CLI 热路径。
- 不推荐继续把 `Xenova/all-MiniLM-L6-v2` 作为本仓库默认模型；它是英文模型。
- Hivemind 的 `nomic-embed-text-v1.5` 适合英文 agent trace，不适合当前以中文业务知识为主的知识库。

## 调研对象与证据边界

### Hivemind

- 仓库：<https://github.com/activeloopai/hivemind>
- 审计 commit：`2611cd6c028fe1df7fcd22d2ee1f9e26b0d3d4ae`
- commit 时间：2026-07-18T07:24:11Z
- npm 版本：`@deeplake/hivemind@0.7.134`
- 本次直接检查了 README、embedding daemon、recall hook、hybrid grep、session summary、Skillify 和相关测试。

Hivemind README 的 LoCoMo 结果是 100 个 QA 上的内部 eval，只报告成本、token 和轮次：

| 指标 | 无 Hivemind | Hivemind | 报告改进 |
|---|---:|---:|---:|
| 100 QA 成本 | $8.94 | $6.65 | 25% |
| 每题 token | 1,700 | 1,008 | 1.7 倍更少 |
| 每题轮次 | 8.9 | 6.2 | 31% |

仓库没有公开这次 100 QA 实验的完整可复现脚本和答案准确率，因此这些数字可作为运行成本证据，不能作为本仓库检索准确率的直接基准。

### 其他参考

- LangMem：hot-path memory tools 与 background extraction/consolidation。
- Letta：常驻 memory blocks、外部 archival memory、conversation history 的上下文层级。
- Mem0：事实抽取、semantic + BM25 + entity 多信号融合、temporal reasoning、公开 memory benchmark harness。
- Graphiti：episode provenance、事实有效期、增量 temporal graph、semantic + BM25 + graph traversal。
- LongMemEval：information extraction、multi-session、knowledge update、temporal reasoning、abstention；同时评估 session/turn retrieval。
- LoCoMo：single-hop、multi-hop、temporal、open-domain 和 adversarial recall。
- LlamaIndex：多 memory source 组合、priority 和 token budget。

## 架构对比

| 维度 | 本仓库 | Hivemind |
|---|---|---|
| 核心目标 | 本地、可审计的 agent 业务知识 | 跨 agent、跨成员共享 trace 与技能 |
| 原始数据 | 人工可读 Markdown | Deeplake 中的 prompt、tool、response trace |
| 正式知识 | 结构化 Markdown | AI wiki summary、Skill、rules、trace |
| 写入治理 | candidate -> `_inbox` -> review -> active | 自动 capture，后台 summary/Skillify |
| 来源与有效性 | authority、source、validity、conflict、sensitivity | author、project、session、timestamp 为主 |
| 检索 | SQLite FTS5 + 可选 embedding + 一跳关系 | summary/session 双表，semantic + lexical，另有 code graph |
| 注入 | 分类后的 context packet | proactive recall 单条 snippet，或 agent 主动 grep/read |
| 自动化 | TRAE hook + reader/writer 模板 | 多 agent hooks、MCP、VFS、后台 workers |
| 团队共享 | 未实现 | 核心能力 |
| 事实可审计性 | 强 | summary/Skill 可读，但原始事实主要在云端 trace |
| 隐私面 | 默认不保存原始会话和 secret | 默认捕获完整活动，依赖 notice、workspace 和 opt-out |

两者不是简单替代关系。本仓库更像“受治理的知识事实层”，Hivemind 更像“团队 agent 运行数据与能力传播层”。

## Hivemind 值得借鉴的做法

### 1. 增量后台流水线

Hivemind 每 50 条消息或 2 小时做 periodic summary，session end 再做 final summary；使用 watermark、sidecar state 和 lock 防止重复或并发 worker。适合借鉴为：

```text
raw event staging
  -> bounded background extraction
  -> candidate diff
  -> governance
  -> Markdown inbox
```

不要直接把 raw trace 变成 active 知识。保留本仓库候选审阅边界。

### 2. 检索门控、超时与失败隔离

Hivemind proactive recall：

- 先用便宜规则跳过 ack、过短 prompt 和低信号 prompt。
- 总预算 1500ms，embedding 子预算 500ms。
- 低于 cosine threshold 0.55 不注入。
- 失败时返回空，不阻塞主任务。
- 每次记录 `none`、`below`、`timeout`、`error`、`injected`。

本仓库应加入相同的运行时约束，但阈值必须基于自己的 eval 校准，不能照抄 0.55。

### 3. 常驻 embedding daemon

Hivemind 把 Transformers.js 隔离到共享 daemon：

- 多 agent 共用依赖和模型。
- session start warmup。
- Unix socket IPC。
- 10 分钟 idle shutdown。
- pidfile lock、防重复启动、版本 handshake 和 self-heal。

当本仓库把 hybrid 作为默认路径后，daemon 比每次 CLI 重新加载模型更合理。

### 4. 自动技能沉淀与事实记忆分离

Hivemind 的 Skillify 从最近 session 中提炼可复用 `SKILL.md`，与 session summary 分开。建议本仓库也明确分开：

- semantic/procedural memory：事实、约束、SOP。
- Skill：可执行工作流和工具使用方式。
- episode/source：证据和复盘，不默认注入。

### 5. 运行指标

除了 usefulness feedback，至少记录：

- gate 触发率、零命中率、低阈值率、注入率。
- Recall@K、MRR、nDCG、错误注入率、abstention precision。
- p50/p95 检索延迟、embedding 冷/热启动。
- 注入 token、任务总 token、任务轮次和最终任务成功率。

### 不建议照搬

- 默认捕获完整 prompt/tool/response 会显著扩大隐私和合规面。
- Hivemind 交互式 hybrid 将 lexical 命中固定记为 1.0，再与 cosine 直接混排；这不是稳健的跨通道校准。
- 只用云数据库作为事实源会削弱 Git diff、人工审阅和本地可恢复性。
- proactive recall 一次只注入一条适合 Hivemind summary，不一定适合本仓库“事实 + 流程 + warning”的 context packet。

## 当前仓库的具体问题

### P0：正确性与治理

1. **真实 embedding 分数丢失**

`selectEmbeddingRows()` 计算 cosine 后只保留 ID；`rankSelectedRows()` 又调用默认 token scorer。应保留每个候选的 dense score，并进入融合和 debug。

2. **缓存兼容性未校验**

JSONL 记录虽保存 provider、model、dimensions 和 content hash，查询时却不校验。不同模型或维度会按较短向量静默计算 cosine，结果没有意义。应增加 index manifest，并在不兼容时明确失败或降级。

3. **模型配置不完整**

当前 provider 对所有模型固定 mean pooling、无 query/document prefix、未指定 dtype。实际模型要求不同：

- E5：`query:` / `passage:` + mean。
- Nomic：`search_query:` / `search_document:` + mean。
- BGE：query instruction + CLS。
- Qwen3：instruction + last-token pooling。

应引入显式 `EmbeddingProfile`，包含 model revision、dtype、dimensions、pooling、prefix、max length 和 normalization。

4. **中文 lexical 召回失效**

真实问题“商家中心里如何给运营人员授权管理抖音B号，变更时有哪些限制”被切成两个长句 token，FTS 零命中。建议为 CJK 建立 2/3-gram 辅助列，或使用可用的中文 tokenizer；保留当前“无 domain/scenario 不扫全表”的安全边界。

5. **治理字段未执行**

查询只检查 active、domain、scenario 和 type；应同时检查：

- `valid_from <= now`
- `valid_until is null or valid_until >= now`
- caller 可见性和 sensitivity clearance
- related expansion 也必须应用同一安全过滤

6. **inbox 隔离不够硬**

indexer 和 embedding loader 应按路径明确排除 `knowledge/_inbox/**`，不能只依赖 status。候选文件误标 active 时仍不能进入正式检索。

7. **token budget 未执行**

`maxTokens` 目前没有影响输出。应以实际 tokenizer 或保守估算逐项装包，并给 always-apply、facts、procedures、examples、warnings 分配预算；超预算时优先保留权威性高、更新、直接命中的知识。

### P1：检索质量

1. 先对 lexical、dense、metadata exact-match 分别取 rank，再用 RRF 融合，避免 BM25 与 cosine 分数量纲不一致。
2. 对融合后的 top 20-50 使用 cross-encoder reranker，最终注入 top 5-10。
3. title、aliases、summary 和 body 不应简单拼成一个长向量。短知识可分字段加权；长知识按语义段落 chunk，并保留 parent ID。
4. relation expansion 不应无条件排在所有 direct result 之后；应作为一个 rank signal，并限制 relation type、深度和预算。
5. 加入 recency、validity、negative feedback、重复度和 diversity/MMR，防止同一子主题占满 packet。
6. 加入规则优先、LLM 可选的 scene classifier，从路径、Git repo、agent role、用户措辞推断 domain/scenario。
7. 对知识更新实现 temporal policy：新事实激活时标记旧事实 superseded 或设置 valid_until，而不是仅靠排序。

### P2：规模与运维

1. 使用 `contentHash` 做增量 embedding，只重算变更知识；删除失效记录。
2. 小于约 10k 文档时 JSONL 线性扫描可接受；更大时再引入 sqlite-vec/HNSW，不要过早增加向量数据库运维。
3. 使用 daemon 或长期 MCP server 缓存模型，热路径设 deadline 和 cancel。
4. query 日志加入 provider revision、index generation、各通道 rank、融合分、阈值决策和 packet token。
5. 将项目 identity 绑定 Git root/remote，而不是只依赖 cwd 名称。

## Embedding 对比

### 模型规格

| 模型 | 语言 | 参数 | 维度 | 最大长度 | 本地模型文件 | 特点 |
|---|---|---:|---:|---:|---:|---|
| deterministic token hash | 任意字符但无语义 | 无 | 64 | 不适用 | 0 | 仅测试替身 |
| `all-MiniLM-L6-v2` | 英文 | 22.7M | 384 | 默认截断 256 wordpieces | fp32 86MB | 很快，但不适合中文 |
| Hivemind Nomic v1.5 | 英文 | 136.7M | 768，可 Matryoshka | 8192 | q8 131MB | 英文长文本、前缀区分 |
| `multilingual-e5-small` | 100+ 语言 | 117.7M | 384 | 512 | q8 113MB | 中英混合效果最好 |
| `bge-small-zh-v1.5` | 中文 | 24.0M | 512 | 512 | q8 23MB | 极轻量，纯中文强 |
| Qwen3 Embedding 0.6B | 100+ 语言和代码 | 0.6B | 32-1024 | 32k | ONNX q8 约 614MB | 更高上限，适合服务化 |

“本地模型文件”是本次实际下载或 Hugging Face API 返回的 ONNX 文件大小，不包含 Transformers.js、onnxruntime、tokenizer 和缓存开销。Hivemind 文档称完整可选 embedding 依赖约 600MB。

### 本地评测方法

环境：

- Apple arm64
- Node.js v24.13.0
- `@huggingface/transformers@4.2.0`
- cosine retrieval，无 reranker
- MiniLM 使用 fp32；其余本地模型使用 q8
- 各模型按官方要求使用 prefix 和 pooling

评测一：16 条中英技术知识，17 个同义或跨语言 query。

| 模型 | Top-1 | MRR | Recall@3 |
|---|---:|---:|---:|
| MiniLM | 29.4% | 0.442 | 47.1% |
| Nomic v1.5 | 29.4% | 0.442 | 47.1% |
| BGE-small-zh | 70.6% | 0.771 | 76.5% |
| multilingual-E5-small | **76.5%** | **0.873** | **100%** |

评测二：本仓库 17 条真实中文知识，每条一条自然语言改写 query，知识主题高度相近。

| 模型 | Top-1 | MRR | Recall@3 |
|---|---:|---:|---:|
| MiniLM | 47.1% | 0.608 | 70.6% |
| Nomic v1.5 | 64.7% | 0.741 | 82.4% |
| BGE-small-zh | **94.1%** | **0.971** | **100%** |
| multilingual-E5-small | **94.1%** | **0.971** | **100%** |
| 当前 lexical CLI 示例 | 0 命中 | 不适用 | 不适用 |

这些是小样本、仓库定向评测，不应外推为通用 MTEB 结论；但足以否定英文 MiniLM 作为当前中文知识库默认值，并支持 E5/BGE 进入正式 eval。

### 推荐顺序

1. **默认选 multilingual-E5-small**

适合当前中文业务知识、英文标识符、未来中英跨语言 query。向量只有 384 维，JSONL 体积也比 Nomic 768 维约小一半。

2. **资源优先选 BGE-small-zh**

实际 q8 模型约 23MB，当前真实语料与 E5 同分。缺点是英文/跨语言明显弱，且必须支持 CLS pooling。

3. **高质量档选 Qwen3-Embedding-0.6B + reranker**

官方模型卡给出的 multilingual MTEB mean 为 64.33、retrieval 为 64.64，支持 instruction、MRL、100+ 语言和代码。模型和运行内存明显更大，应通过 daemon、Ollama、vLLM 或 TEI 服务化，并在本仓库 eval 上验证收益。

4. **不推荐直接换成 Hivemind Nomic**

Nomic v1.5 官方语言为英文。它比 MiniLM 有更长上下文、Matryoshka 和更好的英文 MTEB，但本仓库真实中文评测明显落后于 E5/BGE，768 维缓存也更大。

## 建议实施顺序

截至 2026-07-19，以下四阶段已全部实现。每项后的证据是对应命令、文件或测试。

### 阶段一：先建立可信基线

1. [x] 扩展 eval schema：expected rank、relevance grade、forbidden、abstain、语言、domain。证据：`src/retrieval/eval.ts`、`tests/eval.test.ts`。
2. [x] 加入 17 条 active 主题、近主题 hard-negative、cross-language、temporal 和无答案 query。证据：`eval/cases/retrieval-complete.yaml`。
3. [x] 输出 Recall@1/3/5、MRR、nDCG、false injection rate、latency 和 packet tokens。证据：`agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml`。
4. [x] CI 使用 deterministic provider；真实模型支持 lexical/hybrid/reranked pipeline，可由本地或定时任务运行。证据：`--pipeline lexical|hybrid|reranked`。

### 阶段二：修 P0

1. [x] inbox/validity/sensitivity/token budget。
2. [x] embedding manifest 与 profile。
3. [x] 保留真实 dense score。
4. [x] CJK lexical index。
5. [x] RRF 融合与完整 debug。

### 阶段三：升级默认模型和 rerank

1. [x] 默认 profile 切到 E5-small q8。
2. [x] 提供 BGE-small-zh profile。
3. [x] 实现融合 top 30 -> BGE cross-encoder batch reranker -> threshold -> top 8。证据：`query --rerank`、`tests/reranker.test.ts`。
4. [x] 使用 hard-negative、forbidden、abstention 和 usefulness feedback 做 threshold/权重 grid search。证据：`agent-knowledge eval-calibrate`、`tests/calibration.test.ts`。

### 阶段四：自动沉淀与时间知识

1. [x] 引入 watermark/lock/bounded run/watch worker，只写 staging/proposal。证据：`maintenance run/watch`、`tests/maintenance.test.ts`。
2. [x] 生成 duplicate、consolidation、update、conflict proposal。
3. [x] 支持结构化 episode provenance；`supersedes` 激活时设置旧知识 deprecated/valid_until。
4. [x] 至少 3 个独立 episode、可信来源、正反馈且无冲突时生成 Skill proposal；只输出草稿，不自动写入或安装 Skill。

## 参考

- Hivemind：<https://github.com/activeloopai/hivemind>
- Hivemind embeddings：<https://github.com/activeloopai/hivemind/blob/main/docs/EMBEDDINGS.md>
- Nomic Embed v1.5：<https://huggingface.co/nomic-ai/nomic-embed-text-v1.5>
- MiniLM：<https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2>
- multilingual-E5-small：<https://huggingface.co/intfloat/multilingual-e5-small>
- BGE-small-zh-v1.5：<https://huggingface.co/BAAI/bge-small-zh-v1.5>
- Qwen3 Embedding：<https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- LangMem：<https://github.com/langchain-ai/langmem>
- Letta memory：<https://docs.letta.com/guides/agents/memory>
- Mem0：<https://github.com/mem0ai/mem0>
- Mem0 benchmark harness：<https://github.com/mem0ai/memory-benchmarks>
- Graphiti：<https://github.com/getzep/graphiti>
- LongMemEval：<https://github.com/xiaowu0162/LongMemEval>
- LoCoMo：<https://snap-research.github.io/locomo/>
