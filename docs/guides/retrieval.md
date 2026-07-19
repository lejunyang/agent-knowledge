# 检索与 Embedding

## 先选检索模式

| 模式 | 需要模型 | 需要图索引 | 主要效果 | 推荐场景 |
| --- | --- | --- | --- | --- |
| `lexical` | 否 | 否 | 精确术语、路径、错误码、标题、CJK 片段 | 默认；低延迟和明确关键词 |
| `hybrid` | 是 | 否 | lexical + embedding + metadata RRF 融合 | 同义改写、自然语言、跨语言 |
| `graph` | 否 | 是 | lexical seed + 有界知识关系扩展 | SOP 依赖、配套规则、多条相关知识 |
| `hybrid-graph` | 是 | 是 | hybrid seed + 有界知识关系扩展 | 召回最广；复杂人工查询 |
| 任意模式 + `--rerank` | reranker | 随基础模式 | cross-encoder 对候选成对重排和阈值过滤 | hard-negative 多、需要更高精度 |

推荐顺序：

1. 默认使用 `lexical`，成本最低且行为最容易解释。
2. 术语不同、中文自然语言改写或跨语言查询较多时使用 `hybrid`。
3. 问题需要同时找到依赖步骤、配套规则或多跳知识时使用 `graph`。
4. 只有复杂检索或人工诊断才使用 `hybrid-graph --rerank`；Hook 不默认走这条高成本路径。

## Lexical

```bash
agent-knowledge index
agent-knowledge query \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration
```

`lexical` 使用 SQLite FTS5/BM25，并为中文建立 CJK 2/3-gram 辅助索引。它适合：

- API、命令、错误码、路径和产品名。
- title、aliases、domain、scenario、tag 中的明确术语。
- 中文句子与知识正文存在相同关键词片段的查询。

查询先执行 active、validity、visibility、sensitivity、project、type、domain/scenario 过滤，再排序。没有 domain/scenario 且 lexical 无可靠命中时，不会回退全表，避免无关知识污染上下文。

普通 `query` 未显式传 `--project-id` 时，会自动发现当前 Git 工作树并使用稳定 project ID；从仓库任意子目录执行都能召回绑定当前项目的知识。显式传入 `--project-id` 时完全以参数为准，便于跨项目诊断；非 Git 目录或探测失败时使用空项目作用域，只召回未绑定项目的知识。

基础查询仍保留 `related_knowledge` 的受控一跳扩展，但只允许 `depends_on`、`refines`、`supports`、`often_used_with`。完整多跳遍历请显式使用 graph 模式。

## Hybrid

```bash
agent-knowledge embedding status
agent-knowledge embedding download
agent-knowledge embed-index
agent-knowledge query --task "自然语言问题" --retrieval hybrid --debug
```

默认 profile 是 `multilingual-e5-small` q8；中文资源优先可选 `bge-small-zh-v1.5`。自动化测试使用 `--provider local`。

`hybrid` 分别对 lexical、dense embedding 和 metadata exact-match 取 rank，再用 RRF 融合。这样不会直接把 BM25 和 cosine 的不同分数量纲相加。

适合：

- “退款审批”与“售后审核流程”这类同义改写。
- 中文问题检索含英文术语或英文标题的知识。
- 用户描述很自然，但没有复用知识里的精确关键词。

Embedding 缓存包含 model、revision、dtype、dimensions、pooling、prefix 和内容 hash manifest。查询 provider 与缓存不兼容时会明确失败，不会静默混用向量。

`type: source` 用于保存完整原始证据，不属于默认 query `includeTypes`，因此 `index` 和 `embed-index` 都不把 source 原文放入 FTS/向量缓存。应由 `knowledge-organizer` 从 source 中拆出精炼 semantic/procedural/episodic/profile 知识承担检索，避免超长原文污染 lexical/dense topK。

`embedding status` 只检查本地缓存，不联网；`embedding download` 是普通工作流中唯一默认允许显式下载模型的命令：

```bash
agent-knowledge embedding status
agent-knowledge embedding download
```

未传 `--kind` 且处于交互式终端时，命令会用方向键选择 Embedding 或 Reranker；脚本中应显式传 `--kind embedding|reranker`。

## Reranked

Reranker 可叠加在任意基础模式上：

```bash
agent-knowledge embedding status --kind reranker
agent-knowledge embedding download --kind reranker
agent-knowledge query --task "自然语言问题" --retrieval hybrid --rerank --debug
```

`--rerank` 默认从融合结果取 top 30，使用本地 BGE cross-encoder 批量打分，阈值过滤后保留 top 8。普通 Hook 不会自动加载 reranker。

与 embedding 双塔检索不同，cross-encoder 会把当前 query 和每条候选文本成对输入模型，更擅长区分近主题 hard-negative，但延迟更高。默认最终分数为：

```text
0.3 * 基础检索分 + 0.7 * reranker 模型分
```

不要直接照搬阈值到其他语料。使用 `eval-calibrate` 基于 forbidden、abstain、hard-negative 和 usefulness feedback 调整。

## Graph

本项目的 graph 是**知识关系图**，不是源码 AST/code graph。节点包括知识、domain、scenario、project、episode、source 和 maintenance proposal；关系来自 Markdown frontmatter 和 proposal 元数据，不由 LLM 猜测。

构建：

```bash
agent-knowledge graph build
```

存储在 `.memory/graph.json`，属于可重建索引。已有图不会在每次查询时自动检查 Markdown 是否变更，因此知识或 proposal 更新后应重新运行 `graph build`。

图检索：

```bash
agent-knowledge query \
  --task "发布前还需要哪些验证和依赖步骤" \
  --retrieval graph \
  --graph-depth 2 \
  --graph-decay 0.6 \
  --debug
```

流程：

1. `graph` 用 lexical、`hybrid-graph` 用 hybrid 找 seed。
2. 沿允许的知识关系执行 breadth-first traversal。
3. 默认 1 跳、最大 2 跳；每跳按 `graphDecay ** depth` 衰减。
4. 图候选重新通过 active、validity、visibility、sensitivity、project 和 includeTypes 安全过滤。
5. 可信显式关系允许跨越直接查询的 domain/scenario，以找回依赖知识；它不能越过安全边界。

允许自动扩展：

- `depends_on`
- `refines`
- `supports`
- `often_used_with`

不作为普通上下文扩展：

- `conflicts_with`：只能用于冲突解释或人工审阅。
- `supersedes`：用于时间替代关系，不应把旧知识当作并列事实注入。

`graphDepth=1` 更保守；`2` 适合多跳 SOP，但会增加候选。`graphDecay` 越小，远距离知识的排序影响越弱。

## Hybrid Graph

```bash
agent-knowledge embed-index
agent-knowledge graph build
agent-knowledge query \
  --task "自然语言问题" \
  --retrieval hybrid-graph \
  --graph-depth 2 \
  --rerank \
  --debug
```

这是召回最完整、运行成本最高的路径：embedding 先处理同义语义，graph 再补关系依赖，reranker 最后过滤 hard-negative。适合人工诊断、复杂业务问题或离线评测，不建议直接放入每次 Hook 热路径。

## 图谱浏览与可视化

图浏览命令返回节点/边，不执行知识 context packet 排序：

```bash
agent-knowledge graph query --text "退款审核"
agent-knowledge graph query --id <knowledge-id> --depth 2
```

导出：

```bash
agent-knowledge graph export --format json --output graph.json
agent-knowledge graph export --format mermaid --output graph.md
agent-knowledge graph export --format html --output knowledge-graph.html
```

自包含 HTML 无外部 CDN，支持关键词搜索、node type、memory status、domain、project 筛选和节点详情。它适合人类了解知识分布、发现孤立知识、冲突、过期关系和 proposal；真正让 graph 参与 Agent 查询必须使用 `--retrieval graph|hybrid-graph`。

## 调试与评测

```bash
agent-knowledge query --task "当前任务" --debug
agent-knowledge eval --input eval/cases/retrieval-baseline.yaml
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --root /tmp/agent-knowledge-eval
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --pipeline hybrid --root /tmp/agent-knowledge-eval
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --pipeline reranked --root /tmp/agent-knowledge-eval
agent-knowledge eval-calibrate --input calibration-observations.json
```

`query --debug` 重点字段：

- `queryRunId`：记录 usefulness feedback 时使用。
- `retrievalMode`：实际运行的 lexical/hybrid/graph/hybrid-graph。
- `fallbackUsed` / `fallbackSuppressedReason`：是否回退及为何拒绝全表扫描。
- `embeddingCandidateIds`：dense 通道候选。
- `relatedCandidateIds`：固定一跳关系候选。
- `graphExpansion`：图新增结果、深度、关系和图分数。
- `resultScores`：lexical、embedding、scenario、confidence、authority、relation、RRF、reranker 和 final score。

评测输出 Recall@1/3/5、MRR、nDCG、false injection、abstention precision、latency 和 packet tokens。

`retrieval-complete.yaml` 包含 17 条 active 脱敏知识、1 条 deprecated temporal predecessor 和 20 个正向/hard-negative/cross-language/no-answer case。普通 CI 使用 deterministic/lexical 路径；真实模型评测应先显式下载模型，再在本地或定时任务中运行。

`eval-calibrate` 对候选 base/reranker score、forbidden/abstain case 和 usefulness feedback 做有限 grid search。它只输出 dry-run 参数建议，不自动修改配置。

评测 case 可用 `project_ids` 声明调用方项目作用域；完整 fixture 的 document 也可用同名字段绑定项目。这样同一套 harness 可以同时验证“当前项目命中”和“其他项目 abstain”，不会为了评测而移除生产中的项目隔离。

如果主 Agent 实际使用或拒绝了某条结果，建议记录反馈：

```bash
agent-knowledge feedback \
  --memory-id <knowledge-id> \
  --usefulness useful \
  --query-run-id <query-run-id>
```

`not_useful` 反馈同样重要，可用于后续校准和维护诊断，但不会直接删除或修改 Markdown。
