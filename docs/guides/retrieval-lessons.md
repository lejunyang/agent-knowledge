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

## 为什么现在不新增 active schema

这类内容触发范围很宽，错误 Policy 会系统性影响大量任务。当前先把它们作为：

- Eval regression report
- feedback 聚类
- maintenance proposal
- 人工审阅文档

不自动进入 Context Packet，也不新增可被 Hook 全局注入的 knowledge type。

因此它不是正式使用前缺少的一种“业务知识格式”，也不是当前阻塞项。现阶段价值在于把检索
误路由、错误组合和缺少 abstention 的失败变成可审阅证据，先优化 query/reranker/eval 或
Agent 使用流程；只有重复证据证明需要稳定运行时才升级为产品能力。

## 何时值得产品化

至少满足：

1. 同一 lesson 在多个独立 query/case 中复现。
2. 有 hard-negative、forbidden 或 abstention 证据。
3. 有 useful/not_useful feedback。
4. 明确 applicable/invalid contexts。
5. 不与安全、project、sensitivity 或 temporal 规则冲突。
6. 有独立 eval 证明启用后 false injection 不上升。

达到门槛后再决定：作为 `principle`、单独 schema、reader policy，或仅作为 reranker/router
配置。该决策必须显式评审。

## 当前可用手段

```bash
agent-knowledge query --task "..." --debug
agent-knowledge feedback --memory-id ... --usefulness not_useful --query-run-id ...
agent-knowledge eval --input ... --pipeline lexical
agent-knowledge eval-calibrate --input ...
agent-knowledge maintenance run
```

Sidecar compare 也可帮助判断某个外部 backend 是否形成更好的路由，但 sidecar 输出不能直接成为
Reasoning Policy。
