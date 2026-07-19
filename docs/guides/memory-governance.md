# 候选知识与主动记忆

其他 Agent 默认只能写 `_inbox`：

```bash
agent-knowledge write-candidate --input candidate.json
```

候选会经过 secret-like 扫描、来源治理、去重和 schema 校验。

## 客服与自动会话

`actor_type: customer` 或 `capture_mode: automated_session` 永远保持 `proposed`。机器人部署建议在配置向导中设置：

- `actorType = customer`
- `captureMode = automated_session`
- visibility 为 `project,team`
- sensitivity 为 `internal`

## 主动记忆

TRAE Hook 会异步记录脱敏事件：

```bash
agent-knowledge staging status
agent-knowledge staging drain --limit 100
```

Staging 只保存 hash、长度、agent type、reason 和 project ID，不保存完整 prompt、response 或 tool payload。`memory-maintainer` Skill 负责审阅并生成保守候选。

## Maintenance proposals

```bash
agent-knowledge maintenance extract
agent-knowledge maintenance run
agent-knowledge maintenance watch --interval-minutes 30
agent-knowledge maintenance status
```

Worker 使用 watermark 和 lock，生成 `.memory/proposals/*.json`：

- `duplicate`
- `consolidation`
- `update`
- `conflict`
- `skill`

Proposal 不会修改 active Markdown。Skill proposal 只在 procedural 流程有至少 3 个独立 session、可信来源、正反馈且无冲突时生成，输出候选 `SKILL.md` 草稿但不写入 `.trae/skills`。

人工审阅：

```bash
agent-knowledge maintenance list --status pending
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance accept <proposal-id>
agent-knowledge maintenance reject <proposal-id> --reason "..."
```

- duplicate：只标记已接受。
- consolidation/update/conflict：接受后写入 `knowledge/_inbox`，仍需知识审核。
- skill：默认写入 `knowledge/_inbox-skills/<proposal-id>/SKILL.md`。
- 只有显式传 `--skill-target project|user` 才写项目或用户 Skill 目录；已有文件不会被覆盖。

知识 frontmatter 可选保存结构化 `episodes`，包含 session/turn/project hash、观察时间和 evidence refs，用于时间更新和独立证据判断。

正常流程不需要手写 `observations.json`：`maintenance extract/run/watch` 会从 `.memory/subagents` 的 SubagentStop 详细日志自动生成 `.memory/observations/events.jsonl`。`--input` 只用于导入外部 observation。

## 整理

```bash
agent-knowledge list
agent-knowledge organize-inbox
agent-knowledge organize-inbox --apply
```

Customer/automated candidate 不会被批量晋升。受信 replacement 可通过 `supersedes` 把旧知识标记为 deprecated。
