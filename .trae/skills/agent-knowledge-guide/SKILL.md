---
name: agent-knowledge-guide
description: "介绍、操作和诊断 Agent Knowledge。用户询问项目有什么能力、如何开始使用、某类材料应走哪个流程、命令怎么写、知识为何没有召回、版本更新如何检查、maintenance 如何改进记忆、integration 如何安装，或要求对 Agent Knowledge 做健康检查时调用。"
---

# Agent Knowledge 使用向导

本 Skill 是 Agent Knowledge 的教程和流程路由器。它帮助 Agent 先判断任务属于哪条工作流，再给出最小安全命令或执行只读诊断；它不代替 `knowledge-organizer`、`source-distiller`、`lifecycle-recorder` 和 `memory-maintainer` 的专业治理职责。

## 核心模型

先向用户解释三层事实结构：

- L1 `synopsis`：检索和首次上下文使用的摘要。
- L2 KnowledgeDocument 正文：背景、条件、步骤、例外、失败策略和验证方式。
- L3 Evidence Vault：脱敏完整原文；Git 只保存 source manifest、section/hash/range 和 Vault handle。

Markdown 是正式事实源；SQLite、embedding、graph、logs、observations 和 proposals 都是可重建或待审阅产物。任何自动流程都不能绕过 proposal、inbox 和人工审阅直接修改 active knowledge。

## 先选择工作流

| 用户目标 | 推荐入口 |
| --- | --- |
| 第一次安装、理解能力、查看常用命令 | 本 Skill；读取 `references/workflows.md` |
| 查询已有知识、展开详细解释或原始证据 | `agent-knowledge-reader` 或 `query` / `knowledge show` / `knowledge evidence` |
| 导入、检查版本、蒸馏文档或 Git 仓库 | `source-distiller` |
| 整理直接材料、审阅 inbox、激活候选 | `knowledge-organizer` |
| 记录客服 case 或需求全生命周期 | `lifecycle-recorder` |
| 从会话、反馈和 observation 发现重复、冲突、更新和 Skill 候选 | `memory-maintainer` |
| 从误召回、abstention、冲突和 eval 中维护 Retrieval Lesson / Reasoning Policy | `memory-use-policy-maintainer` |
| 定时刷新在线飞书/Git、批量确认和 callback | `knowledge-automation-operator` |
| 对接 Hindsight/memU/Mem0 并做 A/B | `sidecar` 命令；读取 `references/diagnostics.md` |
| 排查知识薄、metadata 过多、source 未分类、claim 失效或检索误召回 | 本 Skill；读取 `references/diagnostics.md` |

用户要求实际执行某条专业流程时，切换到对应 Skill；不要在本 Skill 中复制另一 Skill 的全部步骤。

## 快速开始

首次使用建议按顺序运行：

```bash
agent-knowledge configure
agent-knowledge integration install
agent-knowledge init
agent-knowledge index
agent-knowledge knowledge audit
```

先检查实际配置来源，避免在错误知识库上操作：

```bash
agent-knowledge config sources
agent-knowledge config show
agent-knowledge project detect
```

需要产品接入诊断时运行：

```bash
agent-knowledge integration list
agent-knowledge integration doctor --product trae --scope user
agent-knowledge hook doctor
```

根据实际宿主把 `trae` 替换为 `trae-cn`、`claude-code` 或 `codex`。

## 查询与正确使用记忆

先用默认 lexical 查询，不因模型已下载就自动切换 hybrid：

```bash
agent-knowledge query --task "$CURRENT_TASK" --debug
```

普通结果只有 L1 synopsis。需要完整条件时展开 L2；需要核验 claim 时展开 L3：

```bash
agent-knowledge knowledge show "$MEMORY_ID" --layer knowledge
agent-knowledge knowledge evidence "$CLAIM_ID"
```

实际使用或拒绝结果后记录反馈，供后续校准和 maintenance 判断“会不会用记忆”：

```bash
agent-knowledge feedback \
  --memory-id "$MEMORY_ID" \
  --usefulness useful \
  --query-run-id "$QUERY_RUN_ID"
```

不相关时使用 `not_useful`。不要伪造或重复 feedback。

## 版本化来源

日常只检查版本或刷新已登记 Connector：

```bash
agent-knowledge source check
agent-knowledge source refresh
agent-knowledge source list --needs-review
```

`source check=current` 只代表已登记的本地 Git ref、文件或离线导出没有变化。飞书在线文档需要先显式刷新 offline export；Git 远端需要先由用户或受控自动化显式 fetch。

正式蒸馏必须使用 `source-distiller`。该流程会验证 fingerprint，把 evidence 导出到 `0600` 私有临时文件，检查 DLP 与 section hash，生成有 claim anchor 的 L1/L2 知识，标记 source receipt，并删除临时 evidence。

## 生命周期与经验改进

客服或需求不要直接压缩成一条结论。先记录 append-only 事件：

```bash
agent-knowledge event append --help
agent-knowledge event status
```

具体阶段和 payload 规则由 `lifecycle-recorder` 负责。多个事件或独立 session 积累后运行：

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

Maintenance 会发现 duplicate、consolidation、update、conflict 和满足严格门槛的 Skill proposal；它只写 proposal/inbox，不自动批准。

## 健康检查

用户要求“检查项目”“为什么效果不好”“是否在持续改进”时，读取 `references/diagnostics.md`，并优先运行只读命令：

```bash
agent-knowledge knowledge audit
agent-knowledge source list --needs-review
agent-knowledge maintenance status
agent-knowledge subagents status
agent-knowledge staging status
agent-knowledge integration list
```

若任务涉及真实检索质量，再运行当前知识库自己的 eval；不要照搬其他语料的阈值：

```bash
agent-knowledge eval --input "$EVAL_FILE" --pipeline lexical
```

只有有 hard-negative、forbidden、abstention 和实际 feedback 时才使用 `eval-calibrate`；它只输出 dry-run 建议。

## 输出要求

教程回答应包含：

1. 当前目标属于哪条工作流。
2. 最少需要执行的命令。
3. 哪些产物是事实源、哪些可重建、哪些待人工审阅。
4. 成功判定和常见失败边界。
5. 若执行了诊断，列出发现、证据和下一步。

不要只罗列全部命令，也不要默认执行写入操作。

## 安全边界

- 不自动批准 `organize-inbox --approve`。
- 不自动接受或安装 maintenance proposal/Skill。
- 不自动启动 `maintenance watch`、`sync watch` 或后台爬取进程。
- 不把完整对话、客服原文、token、Cookie、账号原值或 Vault evidence 写入 Markdown。
- 不把 `_inbox`、proposal、logs 或 graph 当成 active facts。
- 不用降低 confidence 绕过垂直领域歧义；需要确认时一次汇总问题。
- 不自动切换 retrieval 默认值；先用当前知识库 eval 证明收益。

## 按需参考

- 学习首次、日常、文档、客服、需求、同步和 Git 工作流时读取 `references/workflows.md`。
- 解释审计 finding、版本健康、检索误召回、maintenance、Hook、automation、sidecar 和 integration 问题时读取 `references/diagnostics.md`。
