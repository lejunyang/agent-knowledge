---
name: memory-maintainer
description: 审阅 Agent Knowledge 的 Subagent 日志、observation、检索反馈和 proposal，执行主动记忆维护、诊断、已消费日志清理，并向用户汇报需要决策的知识/Skill 候选。用户要求主动整理记忆、审阅 memory logs、排查主动记忆、合并客服观察或清理已消费日志时调用。
---

# 记忆维护器

Hook/Subagent 证据只是信号，不是事实源：

- `.memory/subagents` 保存本地原始 SubagentStart/Stop payload，供所有者调试。
- `.memory/staging` 只保存 hash、长度、事件类型、project ID 和结果。
- `.memory/observations`、`.memory/proposals`、`.memory/feedback/ledger.json` 是审阅/维护产物，不是 active knowledge。
- 这些路径不参与同步，也不能作为事实注入。

## 默认工作流

### 1. 检查状态

```bash
agent-knowledge subagents status
agent-knowledge subagents logs --limit 50
agent-knowledge maintenance status
```

`staging status/drain` 只用于生命周期诊断。不要为了清零 pending 而 drain。普通维护会自动消费新的 SubagentStop；用户不需要编写 `observations.json`。

### 2. 运行维护

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

持续运行的机器人可以在外部进程管理器中使用：

```bash
agent-knowledge maintenance watch --interval-minutes 30
```

`--input` 只用于外部系统已经结构化的 observation。

Maintenance 会读取 `.memory/logs` usefulness feedback：

- 同一 `memoryId + queryRunId` 只采用最新事件。
- `useful=+1`、`not_useful=-1`、`neutral=0`。
- Skill 的净正反馈必须至少覆盖独立 session 数。
- feedback 晚到时，后续 run/watch 会重新评估已消费 observation。

### 3. 检查现有知识和提案

```bash
agent-knowledge list
agent-knowledge catalog --no-write
agent-knowledge maintenance show "$PROPOSAL_ID"
```

Proposal 类型：

- `duplicate`：只记录重复审计，不创建 candidate。
- `consolidation`：合并或补充已有主题。
- `update`：通过 `supersedes` 提议替代旧知识。
- `conflict`：存在冲突证据，必须调查。
- `skill`：重复验证的 procedural 流程，可生成 Skill 草稿。

筛选原则：

- 一次性命令、临时失败、无依据猜测和无语义证据事件不存储。
- customer/`automated_session` 始终是不可信 observation。
- 业务事实需要 owner、受信文档或多个真正独立证据。
- 优先沉淀 `AGENTS.md` 未覆盖的稳定架构、跨模块约束、业务语义和已验证流程。
- 不创建源码 code graph，不复制 `AGENTS.md`。
- 同一 actor/session 的重复消息不是独立 corroboration。
- 不重复写 feedback 伪造 Skill 门槛；自动 feedback 只关联同 domain 的精确 active title/alias。

需要超出确定性 proposal 的语义整理时，再委派 `memory-writer`，输入应包含：

```json
{
  "capture_mode": "automated_session",
  "actor_type": "agent",
  "corroboration_count": 1,
  "project_ids": ["project_id_if_known"]
}
```

手工结构化结果只能写 inbox：

```bash
agent-knowledge write-candidate --input candidate.json
```

### 4. 把决策交给用户

AI 应汇总：

- proposal ID、类型、理由、证据和目标知识。
- 接受后会创建的 candidate/Skill 路径。
- 风险、冲突和仍需确认的内容。

用户明确决定后，AI 才执行：

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge maintenance reject "$PROPOSAL_ID" --reason "..."
```

知识 proposal 接受后仍只进入 `_inbox`。用户审阅精确 candidate 后，才执行：

```bash
agent-knowledge list
agent-knowledge organize-inbox --approve "$MEMORY_ID"
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

不得自动执行 `--approve`。

Skill 使用两阶段流程：

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
# 用户审阅 knowledge/_inbox-skills/<proposal-id>/SKILL.md 后
agent-knowledge maintenance install-skill "$PROPOSAL_ID" \
  --skill-target project \
  --project-root /path/to/project
```

用户级使用 `--skill-target user`。只有 accepted Skill 能安装，已有文件永不覆盖。

### 5. 清理已消费日志

只有 `maintenance run` 成功、`maintenance status` 显示 `pendingSourceEvents=0`，且 `subagents status` 显示 `unmatchedStarts=0` 后，才执行：

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

先展示 dry-run，再 apply。Cleanup：

- 删除已抽取的 Subagent daily JSONL。
- 把 feedback 固化到 ledger 后，从运行日志移除 feedback 行。
- 保留 query/catalog/Hook 日志、observations、proposals、active knowledge 和 ledger。
- 有待抽取 SubagentStop 时拒绝删除。
- 有尚未结束的 SubagentStart 时拒绝删除。

用户要求“整理并清理”时可直接 apply；否则先展示计划并说明删除范围。

### 6. 刷新索引与汇报

active knowledge 变化后按需运行：

```bash
agent-knowledge index
agent-knowledge embed-index
agent-knowledge graph build
```

最终向用户说明：

- 生成/跳过/拒绝了哪些 proposal。
- 哪些 candidate/Skill 等待用户决策。
- 删除了多少已消费日志。
- 哪些内容仍未处理或需要证据。

## 安全边界

- 不从 staging hash/长度推断原始 prompt。
- 只有用户要求排查 Subagent 行为时才查看原始详细 payload。
- 不保存凭据、客户隐私原文或完整 transcript。
- 未经精确 ID 审阅，不晋升 customer/automated candidate。
- 不按事件数量替代独立证据。
- 不自动接受 proposal、批准 inbox 或安装 Skill。
- 不删除 observations、proposals、active knowledge 或 feedback ledger。
