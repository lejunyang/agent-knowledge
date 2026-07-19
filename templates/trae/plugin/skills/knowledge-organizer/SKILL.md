---
name: "knowledge-organizer"
description: "整理 Agent Knowledge inbox 候选、已审阅 maintenance proposal 和用户直接提供的材料。"
---

# 知识整理器

Markdown 是事实源；索引和 `.memory` 都是可重建产物。

## 整理 Inbox

普通候选先预览再应用：

```bash
agent-knowledge list
agent-knowledge organize-inbox
agent-knowledge organize-inbox --apply
```

自动会话和客户观察不得批量晋升。用户检查证据和准确的 candidate Markdown 后，按 ID 审批：

```bash
agent-knowledge organize-inbox --approve "$MEMORY_ID"
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

不得猜测 ID 或批量批准未审阅候选。

## 整理直接材料

对 owner 提供或明确指定拉取的材料：

- 把独立事实和流程拆成多个 `CandidateMemoryInput`。
- 受信材料使用 `capture-material --target active`。
- 外部、不确定或需要先审阅的材料使用 `--target inbox`。
- 不要重复保存 `AGENTS.md`、可搜索代码结构、secret、私人对话或一次性输出。

用户明确指定的正式文档可标记为 `documented + owner + direct_material`；高置信材料可以直接 active。自动发现、客户转述和不确定材料仍必须进入 inbox。

`type: source` 导入前必须移除临时下载 URL，并遮蔽测试账号、验证码、密码、token、用户标识和个人信息。同一外部文档或脱敏规则更新时，可显式刷新稳定 ID 对应的来源证据：

```bash
agent-knowledge capture-material \
  --input source-batch.json \
  --target active \
  --replace-source
```

`--replace-source` 只能替换同 ID、active、documented 的 source。精炼知识变化必须创建新版本并使用 `supersedes`。

完成后向用户汇报写入 ID/路径、active 或 inbox、被拒绝材料，以及是否需要刷新 `embed-index` 或 `graph build`。
