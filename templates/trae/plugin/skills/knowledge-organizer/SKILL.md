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

### 垂直领域确认门禁

用户主动提供材料时，以下内容必须先找用户确认：

- 术语、关系或适用范围意义不明。
- 需要垂直领域判断才能确认，证据不足。
- 与 active knowledge、受信文档或同批材料冲突。
- Agent 认为内容疑似错误、过期、缺少关键条件或因果关系不成立。

引用具体原文，说明疑点和影响，并尽量一次汇总全部问题。确认前不得写入 active 或 inbox，不能用低 confidence 代替确认。用户无法确认时跳过该条并汇报暂缓原因；其他不依赖该疑点的明确材料可分开处理。

`kind: source` / `layer: evidence` 导入前必须移除临时下载 URL，并遮蔽测试账号、验证码、密码、token、用户标识和个人信息。完整本地文档或会话优先通过 Connector 写入加密 Vault 和版本化 source manifest：

```bash
agent-knowledge ingest files \
  --connector-id business-docs \
  --base-dir /secure/exports/business-docs \
  --pattern '**/*.md' \
  --project-key github.com/example/business

agent-knowledge ingest transcripts \
  --connector-id agent-sessions \
  --base-dir /secure/exports/agent-sessions \
  --project-key github.com/example/business

agent-knowledge ingest git \
  --connector-id business-repository \
  --repository /projects/business \
  --pathspec README.md docs

agent-knowledge ingest lark-export \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business
```

Git 摄入只读 committed blob，不包含 dirty/untracked 内容，也不自动 fetch/pull；完整运行会对账
删除，恢复后的 source 回到 pending。

飞书知识库先完成离线递归导出，再用 `ingest lark-export`；不把完整 XML 写入 source Markdown。
有 failures 时成功文档可先摄入，但必须报告 unresolved inventory，不能宣称完整覆盖。

摄入完成后委派 `source-distiller`，由它执行 `source list/show/export/mark`；manifest 不含正文
preview，不要只根据 heading/hash 生成结论，也不要在 active knowledge/claim anchor 尚未形成时标 refined。

旧流程中已存在的 source Markdown 才使用：

```bash
agent-knowledge capture-material \
  --input source-batch.json \
  --target active \
  --replace-source
```

V2 candidate 必须提供 `kind`、`layer`、短 `synopsis`、实质 `explanation`、weighted metadata 和必要的 evidence-backed claims。旧 KnowledgeDocument 不迁移，应从原始 evidence 重新提炼。

`--replace-source` 只能替换同 ID、active、documented 的 source。精炼知识变化必须创建新版本并使用 `supersedes`。

完成后向用户汇报写入 ID/路径、active 或 inbox、被拒绝材料，以及是否需要刷新 `embed-index` 或 `graph build`。
