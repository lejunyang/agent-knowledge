# Hindsight、memU、Mem0 Shadow Sidecar

## 目标

Sidecar 用于在同一批输入和 eval 上比较外部 memory backend。它们永远是 shadow projection：

- Git Markdown 仍是知识事实源。
- Vault 仍是原始证据事实源。
- Sidecar 输出只写 `.memory/sidecars` 和报告。
- Sidecar 结果不会自动变成 active knowledge 或 proposal。

## 一键生成接入包

```bash
agent-knowledge sidecar setup \
  --provider hindsight \
  --id hindsight-shadow \
  --base-url http://localhost:8888 \
  --scope merchant-center \
  --output /secure/sidecars/hindsight
```

Provider：

- `hindsight`
- `memu`
- `mem0`

`setup` 一条命令生成 owner-only `sidecar.json` 与 provider 部署/环境骨架，但不拉镜像、不启动
服务、不写真实凭据。输出 JSON 的 `nextCommands` 是建议动作，仍需人工审阅后执行。

```bash
agent-knowledge sidecar setup \
  --provider memu \
  --id memu-shadow \
  --scope merchant-center \
  --output /secure/sidecars/memu

agent-knowledge sidecar setup \
  --provider mem0 \
  --id mem0-shadow \
  --scope merchant-center \
  --output /secure/sidecars/mem0
```

- Hindsight/Mem0 生成 Compose 骨架，并强制用户设置 pinned image。
- memU 生成 Cloud API env/config 示例。
- `scaffold` 保留为 `setup` 的兼容别名。
- 只需要连接已部署服务、不需要部署骨架时，可继续使用 `sidecar init` 只生成配置。
- 配置生成后应固定上游版本并检查 endpoint。所有 endpoint 都可编辑，因为外部 API 会演进。

上游部署方式和必需模型/API key 以固定版本的官方文档为准。

## Provider Presets

当前默认 endpoint family：

### Hindsight

```text
POST /v1/default/banks/{scope}/memories
POST /v1/default/banks/{scope}/memories/recall
```

### memU Cloud

```text
POST /api/v3/memory/memorize
GET  /api/v3/memory/memorize/status/{task_id}
POST /api/v3/memory/retrieve
```

memU memorize 是异步任务，adapter 会有界 polling。

### Mem0 OSS REST

```text
POST /memories
POST /search
```

如果运行的是 Mem0 Platform v3 或其他 server 版本，应覆盖 endpoint 和认证配置。

## Doctor

```bash
agent-knowledge sidecar doctor --config /secure/sidecars/hindsight/sidecar.json
```

Doctor 只验证 HTTP capability，不证明中文检索质量或数据隔离正确。

## Shadow Ingest

输入是显式 JSON 数组或 JSONL：

```json
{
  "id": "k_example",
  "text": "完整但已脱敏的知识文本",
  "metadata": {
    "domain": "example/domain"
  }
}
```

```bash
agent-knowledge sidecar shadow-ingest \
  --config /secure/sidecars/hindsight/sidecar.json \
  --input /secure/sidecars/input.jsonl \
  --root /secure/agent-knowledge-data
```

不要直接把 Vault 全文、客户对话或未授权内部原文发送到外部服务。Sidecar 数据范围必须单独
获得授权。

## 单次查询

```bash
agent-knowledge sidecar search \
  --config /secure/sidecars/hindsight/sidecar.json \
  --query "账号注销能恢复吗" \
  --root /secure/agent-knowledge-data
```

如果外部结果 metadata 携带 `native_memory_id`，后续 compare 可以映射到原生 expected/forbidden
ID；没有映射的文本只计为 unmapped。

## 对比

```bash
agent-knowledge sidecar compare \
  --root /secure/agent-knowledge-data \
  --config /secure/sidecars/hindsight/sidecar.json /secure/sidecars/memu/sidecar.json /secure/sidecars/mem0/sidecar.json \
  --eval /secure/eval/business.yaml \
  --output /secure/reports/sidecars
```

报告包含：

- native lexical baseline
- Passed/Failed
- Recall@1/3
- False Injection Rate
- Abstention Failure Rate
- 平均延迟
- unmapped 外部结果数

输出：

```text
sidecar-comparison.json
sidecar-comparison.md
```

Sidecar 必须在真实中文业务、客服和生命周期 case 上长期比较，不能拿官方英文 benchmark
替代本地门禁。

可把 compare 加入 automation profile 的 `tasks.sidecarComparisons`，由后台 runner 定时执行；
低于 native baseline 时通过 notification callback 通知用户。

## 长期趋势

每次 compare 还会把安全指标快照写入 `.memory/sidecars`，可以查看历史：

```bash
agent-knowledge sidecar history \
  --root /secure/agent-knowledge-data \
  --limit 100
```

历史按时间倒序返回每次 native/provider 的 Passed、Recall、false injection、abstention、
latency 和 unmapped 指标。旧格式或损坏 artifact 列入 `skipped`，不会阻断其他历史。

`--output` 中的 `sidecar-comparison.json/.md` 是便于通知和查看的“最新报告”，同一路径后续会
覆盖；长期趋势以 `.memory/sidecars` run artifact 为准。两者都不是事实源，也不进入同步。

## 凭据和失败

- 配置只保存 token 环境变量名。
- HTTP timeout/retry 有上限。
- 408/429/5xx 可重试，其他 4xx 视为权限/契约错误。
- Response 和 artifact 有 512KB 上限。
- `.memory/sidecars/artifacts` 只保存 query/result/response hash、数量、映射 ID 和结构摘要，不保存
  query、result 文本或 provider 原始响应；不进 Git/同步。
- Provider 不健康或比较退化时，可由 automation 创建 `sidecar_regression` 通知。

## 停用与卸载

Sidecar setup 目录可在停止服务后删除。Agent Knowledge 只管理本地配置和 `.memory` shadow
artifact，不会自动删除外部 backend 中的数据。外部数据删除必须使用对应 provider 的管理
API，并按数据保留策略单独审计。
