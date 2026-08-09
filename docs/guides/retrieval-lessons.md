# Retrieval Lesson 与 Reasoning Policy

## 要解决什么问题

普通 knowledge 回答“事实或流程是什么”。Retrieval Lesson/Reasoning Policy 回答“Agent 应该
如何使用这些记忆”。

### Retrieval Lesson

记录检索路由与反例，例如：

- 账号注销问题优先找 deletion，不要因为出现“手机号”就同时注入 recovery。
- 明确出现星号/脱敏时使用资产权限专项 SOP；普通“看不到数据”使用通用权限知识。
- 在线版本问题必须先刷新 offline export，再解释 source check=current。

### Reasoning Policy

记录组合证据的规则，例如：

- 事实、SOP、例外和 temporal validity 必须同时满足才能给出结论。
- 客户陈述只能支持 observation，不能覆盖 documented fact。
- 有 conflict 时展示证据并 abstain，不能按 confidence 选一个。
- 执行不可逆操作前必须展开 L2/L3，不只依赖 synopsis。

## 当前产品形态

Policy 与普通 KnowledgeDocument 分开：

```text
policies/retrieval/*.yaml        Git reviewed Retrieval Lesson
policies/reasoning/*.yaml        Git reviewed Reasoning Policy
.memory/query-runs/*.jsonl       task hash、scope、候选/注入 ID
.memory/policies/proposals/      待人工审阅候选
.memory/policies/simulations/    baseline/shadow 安全指标历史
```

P0–P2 只接受 `shadow` 或 `deprecated`。普通 query、Hook、Context Packet 不读取 Policy，
因此引入 Policy 控制面不会改变线上检索结果。

## 日常记录

先用 `query --debug` 获取 `queryRunId`。Query-run ledger 只保存 task hash/长度、scope、候选和
注入 ID，不保存 task 原文。

错误 memory：

```bash
agent-knowledge feedback \
  --query-run-id "$QUERY_RUN_ID" \
  --memory-id "$WRONG_ID" \
  --usefulness not_useful \
  --reason wrong_route \
  --expected-memory-id "$EXPECTED_ID" \
  --forbidden-memory-id "$WRONG_ID"
```

整个查询本应 abstain：

```bash
agent-knowledge feedback \
  --query-run-id "$QUERY_RUN_ID" \
  --usefulness not_useful \
  --reason should_abstain
```

结构化 reason：

- Retrieval：`wrong_route`、`missing_expected`、`forbidden_injection`、`should_abstain`、
  `stale_source`。
- Reasoning：`insufficient_detail`、`conflicting_evidence`、`reasoning_failure`。
- `relevant` / `other` 用于记录，不自动编译确定性 Policy。

只有显式要求保留 query 文本时才使用：

```bash
agent-knowledge query --task "..." --debug --retain-task-evidence
```

它会先执行 `secrets-and-pii` DLP，再加密写入 Vault；query-run 只保存 Vault ID。

## 挖掘和审阅

```bash
agent-knowledge policy mine \
  --eval /secure/eval/business.yaml \
  --min-evidence 3

agent-knowledge policy proposals --status pending
agent-knowledge policy proposal-show "$PROPOSAL_ID"
```

Mining 只使用结构化 reason/expected/forbidden 和显式 eval failure：

- 不读取自由文本 note。
- 不调用 LLM。
- 同一 query 重复反馈只算一个独立证据。
- 没有 domain/scenario/project scope 时不生成全局 Policy。
- 只写 `.memory` proposal。

用户明确接受后：

```bash
agent-knowledge policy accept "$PROPOSAL_ID"
```

接受只写 Git shadow Policy，拒绝：

```bash
agent-knowledge policy reject "$PROPOSAL_ID" --reason "范围过宽"
```

也可人工编写 YAML 后先校验、再显式导入：

```bash
agent-knowledge policy validate --input policy.yaml
agent-knowledge policy import --input policy.yaml
```

已有同 ID Policy 永不覆盖。

## Shadow Simulation

```bash
agent-knowledge policy simulate \
  --eval /secure/eval/business.yaml \
  --output /secure/reports/policies

agent-knowledge policy history --limit 100
agent-knowledge policy status
```

Retrieval Lesson 只在 simulation 内临时追加 route scope、偏好/抑制 memory ID、验证 abstention；
Reasoning Policy 只执行有限 check 并输出 `proceed|warn|abstain`。报告包含 baseline/shadow Recall、
false injection、abstention failure、reasoning violations，但不保存 task 原文。

Shadow 退化时：

```bash
agent-knowledge policy deprecate "$POLICY_ID"
```

不要删除文件，保留 Git 变化历史。

## 运行一段时间后怎么做

推荐节奏：

1. 每次明显误召回或错误推理，立即记录结构化 feedback。
2. 每日或每周运行 `policy mine`。
3. 每周人工审阅 pending proposal。
4. 每次 accept/deprecate 后运行完整中文业务 `policy simulate`。
5. 每月对照 `policy history` 复核没有收益或范围过宽的 Policy。

至少运行 **2–4 周**、积累 **30 个独立真实 query run**，并满足：

- 完整中文业务、hard-negative、forbidden、abstention eval 连续通过。
- Shadow false injection 和 abstention failure 不高于 baseline。
- 每个 Policy 都有明确 scope、excluded context 和 Git review。

之后才评审 P3。

## P3 / P4 Backlog

P3 Runtime Enforcement：

- Policy 编译为实时 `QueryPlan` / `ReasoningContract`。
- `query --policy-set off|shadow|active`。
- generation pin、kill switch、自动回滚和 Hook 延迟预算。
- Hook 只加载通过 eval gate 的 generation。

P4 Optimizer Agent：

- 新增 `memory-use-optimizer` Skill/系统提示词。
- automation 定时执行 mine、simulate、history 和 callback。
- Agent 永远不能 accept/activate/deprecate；用户无回复时保持 no-change。

完整门槛也记录在 `memory-use-policy-maintainer` Skill 的
`references/activation-readiness.md`。
