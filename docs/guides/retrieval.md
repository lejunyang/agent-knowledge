# 检索与 Embedding

## 基础查询

```bash
agent-knowledge index
agent-knowledge query \
  --task "审查 Vue SFC lint 迁移方案" \
  --domain frontend/lint \
  --scenario lint-migration
```

检索支持 aliases、层级 domain、CJK 2/3-gram、validity、visibility、sensitivity 和 project 过滤。没有 domain/scenario 且 lexical 无可靠命中时，不会回退全表。

## Hybrid

```bash
agent-knowledge embedding status
agent-knowledge embedding download
agent-knowledge embed-index
agent-knowledge query --task "自然语言问题" --retrieval hybrid --debug
```

默认 profile 是 `multilingual-e5-small` q8；中文资源优先可选 `bge-small-zh-v1.5`。自动化测试使用 `--provider local`。

`embedding status` 只检查本地缓存，不联网；`embedding download` 是普通工作流中唯一默认允许显式下载模型的命令。Reranker 可使用：

```bash
agent-knowledge embedding status --kind reranker
agent-knowledge embedding download --kind reranker
```

Embedding manifest 会校验 model、revision、dtype、dimensions、pooling 和 prefix，避免不兼容向量静默混用。

## 调试与评测

```bash
agent-knowledge query --task "当前任务" --debug
agent-knowledge eval --input eval/cases/retrieval-baseline.yaml
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --root /tmp/agent-knowledge-eval
```

评测输出 Recall@1/3/5、MRR、nDCG、false injection、abstention precision、latency 和 packet tokens。

`retrieval-complete.yaml` 包含 17 条 active 脱敏知识、1 条 deprecated temporal predecessor 和 20 个正向/hard-negative/cross-language/no-answer case。普通 CI 使用 deterministic/lexical 路径；真实模型评测应先显式下载模型，再在本地或定时任务中运行。
