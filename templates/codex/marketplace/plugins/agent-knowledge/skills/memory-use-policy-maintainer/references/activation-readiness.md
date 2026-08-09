# P3/P4 Readiness

## P3 Runtime Enforcement

只有全部满足才建议启动实现：

1. Policy shadow 运行至少 2–4 周。
2. 至少 30 个真正独立的真实 query run，不把同一会话重复反馈算多次。
3. 完整中文业务 eval、hard-negative、forbidden、abstention case 连续通过。
4. Shadow false injection 和 abstention failure 不高于 baseline。
5. 每个候选 Policy 都有明确 scope、excluded context 和 Git review。
6. 已设计 `off|shadow|active` kill switch、generation pin、自动回滚和 Hook 延迟预算。

P3 待办：

- Policy 编译为实时 `QueryPlan` / `ReasoningContract`。
- `query --policy-set off|shadow|active`。
- Hook 只加载通过 eval gate 的 generation。
- 记录 matched Policy ID，不把 Policy 全文注入 prompt。
- 退化时自动回滚上一 generation，并通过 callback 通知。

## P4 Optimizer Agent

P3 稳定后再启动：

- 新增 `memory-use-optimizer` 系统提示词/Skill。
- automation 定时执行 mine、simulate、history 和 regression notification。
- Agent 只生成 proposal 和解释报告，永远不能 accept/activate/deprecate。
- 用户不回复时安全默认是 no-change。
- 每轮问题一次汇总，不逐条打扰。

## 运行期间推荐节奏

- 每次明显误召回：立刻记录结构化 feedback。
- 每日或每周：`policy mine`。
- 每周：人工审阅 pending proposal。
- 每次 accept/deprecate 后：跑完整 `policy simulate`。
- 每月：对照 history 清理无收益 Policy，并复核 P3 readiness。
