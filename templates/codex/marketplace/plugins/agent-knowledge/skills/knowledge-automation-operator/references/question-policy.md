# 后台确认问题策略

## 必须询问

- 领域术语、实体关系或适用范围不明。
- 来源与 active knowledge 冲突。
- 文档疑似错误、过期或互相矛盾。
- 权限不足导致 inventory 不完整，且用户可能调整授权。
- Eval 出现 forbidden injection 或 abstention failure。
- Sidecar 比 native 更差或返回不可解释内容。
- 操作需要扩大 Lark roots、Git refs、runtime、费用或敏感范围。

## 不需要询问

- metadata-only 更新。
- 已知重复、明确废弃或一次性通知的分类建议。
- 可安全重试的 429/5xx，且未超过 retry 上限。
- 没有新 proposal、没有更新、eval 全通过。

## 一次汇总格式

每个问题必须包含：

```json
{
  "question_id": "q_...",
  "category": "scope | conflict | ambiguity | permission | eval | sidecar",
  "target_ids": ["src_..."],
  "question": "需要用户回答的单一问题",
  "why_it_matters": "不同答案会改变什么",
  "choices": [
    { "id": "keep_blocked", "label": "保持受阻" },
    { "id": "authorize", "label": "授权并重试" }
  ],
  "safe_default": "keep_blocked"
}
```

规则：

- 所有问题放在一个 `confirmation_required` notification 中。
- 不超过 profile `maxQuestions`。
- 选项互斥、短且可执行。
- 不复制正文、个人信息、账号、token 或 URL query secret。
- 没有用户答案时执行 `safe_default`，通常是 blocked/skip/no-change。
