# Agent Memory 与知识持久化调研摘要

日期：2026-07-05

## 调研目标

为 agent 使用的知识持久化系统提供设计依据，重点关注：

- 长期记忆如何分类。
- 是否需要向量化。
- 如何兼顾人类可读和机器可检索。
- 自动总结和自动注入如何避免污染。
- 业界方案如何处理长期记忆、检索和上下文窗口。

## 结论摘要

业界主流方案并不是“只接一个向量库”。更可靠的方向是：

```text
结构化知识 / 文档事实源
  + 元数据过滤
  + 全文检索
  + 向量语义检索
  + 关系或图谱扩展
  + 上下文注入治理
```

向量化应该作为召回通道之一，而不是事实源本身。对于需要人类可读、可审计、可维护的业务知识，Markdown 或其他结构化文档应作为事实源，索引层从事实源派生并可重建。

## LangGraph

来源：https://langchain-ai.github.io/langgraph/concepts/memory/

可信度：官方文档

关键点：

- LangGraph 区分短期记忆和长期记忆。
- 短期记忆是 thread-scoped state，通过 checkpointer 持久化，服务于当前会话线程恢复。
- 长期记忆跨会话共享，存储在自定义 namespace 中。
- 长期记忆类型包括 semantic、episodic、procedural。
- 写入记忆有两类方式：hot path 实时写入，以及 background 异步写入。
- Semantic memory 不等于 semantic search。前者是事实和概念，后者是检索方法。

对本设计的启发：

- 采用 `profile`、`semantic`、`episodic`、`procedural`、`source` 的分层。
- 把“记忆类型”和“检索方法”分开设计。
- 支持同步写入和后台写入，但默认把自动写入放入候选区。

## Letta

来源：https://docs.letta.com/guides/agents/memory

可信度：官方文档

关键点：

- Letta 认为 agent memory 的核心是管理上下文窗口中应该放什么信息。
- Letta 区分 core memory 和 external memory。
- Core memory 是常驻上下文中的结构化 memory blocks。
- External memory 是按需检索的外部存储，包括 conversation search、archival memory、filesystem、MCP 或自定义工具。
- Letta 强调 memory blocks 不等于传统 RAG。memory blocks 是持久结构化上下文，RAG 更适合大文档集合和静态参考材料。
- Letta agent 可以通过 `memory_replace`、`memory_insert`、`memory_rethink` 等工具主动管理记忆。

对本设计的启发：

- 设计 `always_apply` 作为常驻短上下文，类似 core memory。
- 设计 `relevant_facts`、`procedures`、`examples` 作为按需检索上下文。
- 主 agent 不直接获得原始检索结果，而是获得结构化 `context packet`。

## Mem0

来源：https://docs.mem0.ai/overview

可信度：官方文档

关键点：

- Mem0 提供 persistent contextual memory。
- LLM 从对话中抽取和处理关键信息。
- 向量存储支持语义检索。
- 图数据库用于关系追踪。
- 检索系统结合语义搜索、图查询、重要性和新鲜度。
- 对外提供简单 API，如 `add` 和 `search`。

对本设计的启发：

- 采用 writer subagent 抽取候选知识。
- 采用向量检索，但与 metadata、FTS/BM25、关系扩展混合使用。
- 对外暴露简单稳定的 `memory-query` 和 `memory-write` 接口。

## Zep / Graphiti

来源：https://github.com/getzep/graphiti

可信度：官方源码仓库/README

关键点：

- Graphiti 是构建和查询 temporal context graphs 的框架。
- Context graph 包含 entities、facts/relationships、episodes、custom types。
- 每条事实有时间有效性，可以表达“过去为真”和“现在为真”。
- 每个派生事实都能追溯到 episodes。
- Graphiti 支持语义、关键词和图遍历的混合检索。
- Graphiti 强调增量更新，不需要每次完整重建图。
- Zep 是托管上下文图基础设施，Graphiti 是开源图引擎。

对本设计的启发：

- 第一版保留 `source`、`valid_from`、`valid_until`、`supersedes`、`conflicts_with`、`related_knowledge` 字段。
- 第一版不直接上完整图谱，但允许未来从 Markdown 和索引迁移到 temporal context graph。
- 关系扩展只做一跳，避免多跳泛化导致误召回。

## FTS/BM25

SQLite FTS5 来源：https://www.sqlite.org/fts5.html

Elastic BM25 来源：https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity

可信度：官方文档

关键点：

- FTS 是 Full-Text Search，适合在大量文档中查找包含指定词、短语、前缀、近邻关系或布尔组合的结果。
- SQLite FTS5 是 SQLite 的全文检索虚拟表模块。
- BM25 是一种基于 TF/IDF 的相关性排序模型，包含词频归一化和文档长度归一化。
- Elastic 默认 BM25 similarity 用于文本相关性打分。

对本设计的启发：

- FTS/BM25 适合错误码、路径、API、业务术语和精确关键词。
- Embedding 适合同义表达和自然语言语义相近问题。
- 推荐混合召回，而不是只使用向量库。

## Hermes

来源：当前检索结果主要为中文二级文章和转载，未找到稳定官方文档或源码作为依据。

可信度：低到中，不能作为硬性规格依据。

二级资料中常见描述：

- 分层记忆系统。
- 常驻关键事实。
- 可检索历史会话。
- 可扩展外部记忆后端。
- 将成功流程沉淀为 skills 或流程记忆。

对本设计的处理：

- 这些方向与 LangGraph、Letta、Mem0、Graphiti/Zep 的官方资料大体一致。
- 由于缺少可验证官方来源，本设计不把 Hermes 作为核心依据。
- 后续如果用户提供具体 Hermes 项目链接，应单独补充源码或官方文档精读。

## 设计建议

推荐采用：

```text
Markdown fact source
  + YAML frontmatter
  + SQLite metadata index
  + FTS/BM25 lexical search
  + embedding semantic search
  + one-hop relation expansion
  + context packet injection
```

不推荐：

- 只用向量库保存所有知识。
- 只存历史对话，不做知识抽取。
- 让主 agent 自由写长期记忆。
- 不记录来源、置信度、有效期和冲突。
- 无限制多跳关联扩展。

## 参考链接

- LangGraph Memory：https://langchain-ai.github.io/langgraph/concepts/memory/
- Letta Agent Memory：https://docs.letta.com/guides/agents/memory
- Mem0 Overview：https://docs.mem0.ai/overview
- Graphiti：https://github.com/getzep/graphiti
- SQLite FTS5：https://www.sqlite.org/fts5.html
- Elasticsearch Similarity / BM25：https://www.elastic.co/docs/reference/elasticsearch/index-settings/similarity
