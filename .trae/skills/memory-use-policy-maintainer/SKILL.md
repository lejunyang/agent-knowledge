---
name: memory-use-policy-maintainer
description: "维护 Agent Knowledge 的 Retrieval Lesson 与 Reasoning Policy。用户要求分析误召回、错误路由、forbidden injection、应 abstain 未 abstain、证据冲突、挖掘 memory-use policy、审阅 Policy proposal、运行 shadow simulation、查看长期 Policy history，或判断是否可以进入 P3 active enforcement 时调用。"
---

# Memory Use Policy Maintainer

本 Skill 维护“如何使用记忆”的 shadow 控制面，不维护业务事实。Git `policies/` 是 reviewed
Policy 事实源；`.memory/query-runs`、feedback ledger、Policy proposal 和 simulation history
只是证据/审阅产物。

## 固定边界

- P0–P2 的 Policy 只能是 `shadow` 或 `deprecated`。
- 普通 `query`、Hook、Context Packet 不读取 Policy。
- 不自动执行 `policy accept`，不自动激活、调阈值或修改 query pipeline。
- 不从自由文本 note 生成 Policy；只使用结构化 reason、expected/forbidden ID 和显式 eval。
- Query-run ledger 不保存 task 原文；需要原文时只在用户显式选择后经 DLP 加密进 Vault。
- 没有 domain、scenario 或 project scope 时，不生成全局 Policy。

## 日常记录

查询后根据真实结果记录反馈：

```bash
agent-knowledge feedback \
  --query-run-id "$QUERY_RUN_ID" \
  --memory-id "$MEMORY_ID" \
  --usefulness not_useful \
  --reason wrong_route \
  --expected-memory-id "$EXPECTED_ID" \
  --forbidden-memory-id "$MEMORY_ID"
```

没有单个错误 memory 时省略 `--memory-id`，例如：

```bash
agent-knowledge feedback \
  --query-run-id "$QUERY_RUN_ID" \
  --usefulness not_useful \
  --reason should_abstain
```

Reason 只选真实原因：`wrong_route`、`missing_expected`、`forbidden_injection`、
`should_abstain`、`stale_source`、`insufficient_detail`、`conflicting_evidence`、
`reasoning_failure` 或 `other`。不要为了达到门槛重复提交。

## 周期维护

### 1. 挖掘候选

```bash
agent-knowledge policy mine \
  --eval /secure/eval/business.yaml \
  --min-evidence 3
```

### 2. 审阅 proposal

```bash
agent-knowledge policy proposals --status pending
agent-knowledge policy proposal-show "$PROPOSAL_ID"
```

检查：独立 query/eval 数、scope、prefer/suppress ID、reasoning checks、是否把一次偶然失败放大。

### 3. 交给用户决策

用户明确接受后：

```bash
agent-knowledge policy accept "$PROPOSAL_ID"
```

这只写 Git `policies/` 的 shadow Policy。拒绝：

```bash
agent-knowledge policy reject "$PROPOSAL_ID" --reason "..."
```

### 4. 运行 shadow 回放

```bash
agent-knowledge policy simulate \
  --eval /secure/eval/business.yaml \
  --output /secure/reports/policies

agent-knowledge policy history --limit 100
agent-knowledge policy status
```

优先检查 false injection、abstention failure、Recall、Reasoning violation 和 case mismatch。
Shadow 退化时不要删文件，显式：

```bash
agent-knowledge policy deprecate "$POLICY_ID"
```

## 进入 P3 前

读取 `references/activation-readiness.md`。至少运行 2–4 周、积累 30 个独立真实 query run，
完整中文业务 eval 连续通过，且 false injection/abstention 不退化，才向用户提出 P3 评审。

## 最终汇报

- 新增/跳过了哪些 proposal，证据门槛是什么。
- 接受、拒绝、deprecated 了哪些 Policy。
- Baseline 与 shadow 指标差异。
- 哪些失败仍需要业务判断。
- 当前是否仅 shadow；若建议 P3，列出 readiness 证据和缺口。
