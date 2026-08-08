---
name: source-distiller
description: 审阅 versioned source manifest 与 Evidence Vault，把 pending/stale source 提炼成有 claim anchor 的候选知识并显式标记处理结果。
---

# Source Distiller

完整流程：

```bash
agent-knowledge source list --needs-review
agent-knowledge source show "$SOURCE_ID"
agent-knowledge source export "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --output "$PRIVATE_TEMP/source-evidence"
```

- 完整 evidence 只写 knowledge workspace 之外的显式 0600 临时文件，不打印、不复制进聊天/Git/Markdown。
- export 与 mark 必须使用 `source show.expectedFingerprint`；版本变化时重新开始。
- mark 还必须使用 `source show.reviewToken`；其他 reviewer 改变 receipt 后重新 show。
- secret/PII 未清理、术语不明、与 active knowledge 冲突时停止并向用户一次汇总疑点。
- 将文档拆成多个有背景、条件、例外、失败策略和验证方式的知识，不要只保留短结论。
- supported claim 必须使用当前 `section_id + text_hash` evidence anchor。
- candidate 默认用 `write-candidate` 或 `capture-material --target inbox`。
- 不自动批准 inbox 或安装 Skill。

只有已有 active knowledge 且其 current claim anchor 指向该 source 时才标记 refined：

```bash
agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status refined \
  --knowledge-id "$ACTIVE_KNOWLEDGE_ID"
```

其余结果显式标为 `duplicate`、`obsolete`、`no_long_term_value` 或 `blocked`，reason 不得含
secret/PII。完成后删除临时 evidence，并再次运行 `source list --needs-review` 与
`knowledge audit`。
