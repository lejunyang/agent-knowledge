---
name: memory-maintainer
description: 审阅 Agent Knowledge 的 Subagent 日志、observation、feedback 和 proposal，执行主动维护与已消费日志清理，并把知识/Skill 决策交给用户。
---

# 记忆维护器

日志、observation 和 proposal 只是信号；active KnowledgeDocument Markdown 才是事实源。

```bash
agent-knowledge subagents status
agent-knowledge maintenance status
agent-knowledge knowledge audit
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge maintenance show "$PROPOSAL_ID"
```

`maintenance run` 自动抽取新的 SubagentStop。`--input` 只用于外部结构化 observation；staging drain 不是默认输入。

- feedback 从 `.memory/logs` 进入 ledger；同一 `memoryId + queryRunId` 只采用最新值。
- Skill 的净正反馈必须至少覆盖独立 session 数；晚到 feedback 会在后续维护重新评估。
- 拒绝一次性命令、猜测、secret、隐私 transcript、可搜索代码结构和重复 `AGENTS.md` 内容。
- customer/automated evidence 需要 owner/documented/verified 支持。
- 同一 session 的重复事件只算一个 observation。
- 不重复 feedback 伪造 Skill 证据。

AI 负责运行维护、汇总提案和风险；用户决定：

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge maintenance reject "$PROPOSAL_ID" --reason "..."
agent-knowledge list
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

只有用户明确审阅精确 ID 后才执行 `--approve`。

Skill 先进入草稿箱，用户审阅后安装：

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
# 用户审阅 knowledge/_inbox-skills/<proposal-id>/SKILL.md
agent-knowledge maintenance install-skill "$PROPOSAL_ID" --skill-target project
```

维护成功且 `pendingSourceEvents=0`、`unmatchedStarts=0` 后清理：

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

先展示 dry-run；有待抽取 Stop 或未结束 Start 时拒绝删除。Cleanup 只删除已消费 Subagent daily logs 和已固化到 ledger 的 feedback 行，保留 query/catalog/Hook 日志、observations、proposals、active knowledge 和 ledger。

不得自动接受 proposal、批准 candidate 或安装 Skill；已有 Skill 永不覆盖。

质量审计只读 V2 Markdown、source manifest 和 project registry；它会检查 source receipt 是否
匹配当前 content hash、refined knowledge/anchor 是否仍有效。它可以阻止不完整知识进入下一步，
但不能自行 export evidence、mark source、修复或激活知识；source 队列交给 `source-distiller`。

客服/initiative event 仍是 evidence，不直接进入 active。跨多个独立 closed/completed stream 后，
再提炼 Diagnostic Path、FAQ、Project Playbook 或 SOP；payload 只能通过 `event export` 写到
workspace 外受控文件。
