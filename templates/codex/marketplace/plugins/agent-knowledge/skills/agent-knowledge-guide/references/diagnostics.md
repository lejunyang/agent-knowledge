# Agent Knowledge 诊断与改进

## 目录

- [最小健康检查](#最小健康检查)
- [质量审计](#质量审计)
- [来源与版本](#来源与版本)
- [检索是否会用记忆](#检索是否会用记忆)
- [Maintenance](#maintenance)
- [Hook 与 Subagent](#hook-与-subagent)
- [Integration](#integration)
- [Automation 与通知](#automation-与通知)
- [Sidecar A/B](#sidecar-ab)
- [Memory Use Policy](#memory-use-policy)
- [图谱与索引](#图谱与索引)
- [处置优先级](#处置优先级)

## 最小健康检查

只读运行：

```bash
agent-knowledge config sources
agent-knowledge config show
agent-knowledge knowledge audit
agent-knowledge source list --needs-review
agent-knowledge maintenance status
agent-knowledge subagents status
agent-knowledge staging status
agent-knowledge integration list
```

检查四类信号：

1. 配置是否指向预期 workspace/project。
2. active knowledge 是否完整、有证据、未过期。
3. source、maintenance、Hook 是否有积压或版本漂移。
4. 已安装宿主资源是否健康。

## 质量审计

```bash
agent-knowledge knowledge audit
```

常见 finding：

| Finding | 含义 | 推荐处置 |
| --- | --- | --- |
| `knowledge_body_too_thin` | L2 正文不足 | 回到 evidence 补背景、条件、例外、失败与验证；不要堆 alias |
| `metadata_frontmatter_dominates` | metadata 占正文过高 | 删除低价值 tag/alias 或补真实解释 |
| `source_without_refined_knowledge` | source 尚未分类 | 用 `source-distiller` 审阅；不等同于必须生成知识 |
| `source_review_stale` | 已审阅 source 正文变化 | 重新 export 当前 fingerprint，验证受影响 claim |
| claim anchor 相关 finding | section/hash 已失效 | 不要继续注入旧 claim；生成 update/conflict proposal |
| unknown project key | project 未登记 | 运行 `project detect`，使用规范 Git remote 或 `local/...` |
| `source_inventory_incomplete` | Connector 未完整遍历 | 保留告警，重试上游抓取；不能宣称完整覆盖 |

审计只报告，不自动修复。

## 来源与版本

```bash
agent-knowledge source check
agent-knowledge source list --needs-review
```

状态：

- `unchanged`：已登记快照与当前可见来源一致。
- `metadata_only`：revision/time 变化但正文身份不变。
- `content_changed`：正文 hash 已变化。
- `update_unknown`：必须重新 ingest 才能确定。
- `processing_profile_changed`：清洗/切分规则变化，需要重处理。
- `new` / `removed` / `restored`：完整 inventory 的增删恢复。

注意：

- 飞书 offline export 的 `current` 不代表在线文档最新。
- Git 本地 ref 的 `current` 不代表 remote 最新。
- refresh 后旧 check report 会 stale，需要重新 check。

## 检索是否会用记忆

Meta-memory 改进不只看“存了什么”，还看“是否在正确场景使用”。

### 1. 查看 debug

```bash
agent-knowledge query --task "$TASK" --debug
```

关注：

- `matchedIds`：候选召回。
- `injectedIds` / packet：真正注入。
- lexical、dense、metadata、RRF、reranker 分数。
- `queryCoverageScore` 和技术词匹配。
- `queryRunId`。

候选存在但 packet abstain 可能是正确安全行为，不要只追求召回数。

### 2. 记录反馈

```bash
agent-knowledge feedback \
  --memory-id "$MEMORY_ID" \
  --usefulness not_useful \
  --query-run-id "$QUERY_RUN_ID" \
  --task "$TASK"
```

Feedback 用于：

- 检索校准；
- 识别常被误用的知识；
- Skill proposal 门槛；
- maintenance 复查。

它不会直接删除知识。

### 3. 维护真实 eval

Eval 至少包含：

- 正向改写；
- 近主题 hard-negative；
- forbidden memory；
- no-answer/abstain；
- temporal case；
- project isolation；
- 中英术语。

```bash
agent-knowledge eval --input "$EVAL_FILE" --pipeline lexical
```

不要因 embedding 已缓存就默认使用 hybrid。以当前语料的 false injection、abstention、延迟和 packet tokens 为准。

### 4. 校准

```bash
agent-knowledge eval-calibrate --input "$OBSERVATIONS"
```

只有具备真实候选、forbidden/abstain 和 usefulness feedback 时才校准。输出只是建议，不会改配置。

## Maintenance

```bash
agent-knowledge maintenance status
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

能发现：

- 多个 observation 重复：duplicate/consolidation。
- 新证据替代旧知识：update。
- 事实冲突：conflict。
- 至少三个独立 session、可信来源、正反馈且无冲突的 procedure：Skill proposal。

不能做：

- 自动改 active Markdown。
- 自动接受 proposal。
- 自动安装 Skill。
- 把同 session 重复事件当独立 corroboration。

## Hook 与 Subagent

```bash
agent-knowledge hook doctor
agent-knowledge subagents status
agent-knowledge subagents logs --agent-type agent-knowledge-reader
agent-knowledge staging status
```

常见问题：

| 表现 | 检查 |
| --- | --- |
| 无关 prompt 被注入 | Hook threshold、context packet 门禁、当前 eval forbidden/no-answer |
| Hook 完全无输出 | 可能是正确静默；先用同 task 手工 query |
| SubagentStop 没有 observation | 检查 detailed logs、配对、maintenance watermark |
| unmatched starts | 宿主未发 Stop 或日志不完整；cleanup 前必须处理 |
| staging 积压 | 不要盲目 drain；先判断是否需要 maintenance/人工审阅 |

详细 Subagent 日志只供本地所有者调试，不同步、不注入、不直接成为事实。

## Integration

```bash
agent-knowledge integration list
agent-knowledge integration doctor --product "$PRODUCT" --scope "$SCOPE"
```

Doctor 状态：

- `ok`：资源存在且仍等于托管 hash，Hook 仍包含自有 handler。
- `missing`：托管资源被删除。
- `modified`：用户或其他工具修改了资源。

默认使用 merge 重装。未托管同名文件报告 conflict，不覆盖。用户修改的托管文件卸载时保留。

Codex 额外检查：

- Hooks：`.codex/hooks.json`。
- standalone Skills：`.agents/skills`。
- marketplace bundle：`.codex/agent-knowledge-marketplace`。
- Codex 可能要求用户信任新 Hook hash；不要绕过 Hook trust。

## 图谱与索引

Markdown 变化后：

```bash
agent-knowledge index
```

只在使用对应能力时重建：

```bash
agent-knowledge embed-index
agent-knowledge graph build
agent-knowledge graph export --format html --output knowledge-graph.html
```

图谱可用于发现：

- 孤立知识；
- 无法解释的关系；
- conflict/supersedes；
- source/knowledge 覆盖；
- proposal 分布。

图和 embedding 不是事实源。图中存在边不代表关系天然正确；关系必须来自明确 frontmatter 或 proposal evidence。

## Automation 与通知

```bash
agent-knowledge automation status --profile /secure/profile.json
agent-knowledge notifications list --root /secure/agent-knowledge-data
```

重点检查：job 是否幂等、失败 step、retry 是否耗尽、callback 是否 4xx、是否有
`confirmation_required`、eval regression 和 incomplete inventory。不要通过扩大 roots/refs 或
提升权限让 job “变绿”。

## Sidecar A/B

```bash
agent-knowledge sidecar doctor --config /secure/sidecar.json
agent-knowledge sidecar compare --config /secure/sidecar.json --eval /secure/eval.yaml --output /secure/reports
agent-knowledge sidecar history --root /secure/agent-knowledge-data --limit 100
```

优先看 false injection、abstention failure、unmapped results 和 latency。外部 recall 高但错误
注入也高时不能替换 native pipeline。Retrieval Lesson / Reasoning Policy 的具体边界见
`docs/guides/retrieval-lessons.md`。

## Memory Use Policy

```bash
agent-knowledge policy proposals --status pending
agent-knowledge policy list
agent-knowledge policy history --limit 100
agent-knowledge policy status
```

检查 proposal 是否达到三个独立证据、scope 是否为空、shadow 是否改善 false injection /
abstention 指标，以及普通 query/Hook 是否仍未读取 Policy。Policy 退化时使用
`policy deprecate`，不要删除 Git 文件。

## 处置优先级

1. **安全和事实错误**：secret/PII、越权、stale claim、冲突证据。
2. **错误注入**：forbidden/no-answer 失败、project 隔离失败。
3. **版本完整性**：incomplete inventory、content_changed、processing profile drift。
4. **知识质量**：正文薄、metadata 主导、source 未分类。
5. **召回优化**：alias、embedding、reranker、graph。
6. **效率**：延迟、packet token、后台运行方式。

不要先通过调高分数或扩大召回来掩盖安全、歧义和版本问题。
