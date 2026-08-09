# Agent Knowledge 场景化工作流

## 目录

- [首次启用](#首次启用)
- [日常任务查询](#日常任务查询)
- [批量业务文档](#批量业务文档)
- [Git 仓库知识](#git-仓库知识)
- [客服问题](#客服问题)
- [需求全生命周期](#需求全生命周期)
- [经验与 Skill 改进](#经验与-skill-改进)
- [同步与多机](#同步与多机)
- [Git 审计](#git-审计)

## 首次启用

1. 配置知识库、身份、检索、Vault 和集成默认值：

```bash
agent-knowledge configure
agent-knowledge config sources
agent-knowledge config show
```

2. 安装宿主接入：

```bash
agent-knowledge integration list
agent-knowledge integration install
```

3. 初始化事实源和索引：

```bash
agent-knowledge init
agent-knowledge index
agent-knowledge knowledge audit
```

4. 检查宿主与项目：

```bash
agent-knowledge integration doctor --product trae --scope user
agent-knowledge hook doctor
agent-knowledge project detect
```

把 `trae` 替换为实际产品。Codex 独立 Skill 位于 `.agents/skills`，Hook 位于 `.codex/hooks.json`；Codex 不安装独立 Markdown subagent。

成功标准：

- `config show` 指向预期 workspace；
- `integration doctor.healthy=true`；
- `knowledge audit` 没有 knowledge-level error；
- Hook 对无关 prompt 静默；
- 普通 `query` 能返回相关 synopsis 或明确 abstain。

## 日常任务查询

自动 Hook 命中时不必再次手工查询。以下情况主动查询：

- Hook 没有覆盖完整条件；
- 任务依赖历史决策、业务术语或 SOP；
- 需要解释为什么没有召回；
- 需要查看证据。

```bash
agent-knowledge query --task "$CURRENT_TASK" --debug
```

先看 `packet` 和 `debug.resultScores`。对实际使用的知识展开：

```bash
agent-knowledge knowledge show "$MEMORY_ID" --layer knowledge
agent-knowledge knowledge evidence "$CLAIM_ID"
```

反馈：

```bash
agent-knowledge feedback \
  --memory-id "$MEMORY_ID" \
  --usefulness useful \
  --query-run-id "$QUERY_RUN_ID" \
  --task "$CURRENT_TASK"
```

错误命中使用 `not_useful`。Feedback 不会直接改知识；maintenance 和 calibration 后续消费它。

## 批量业务文档

首次登记文件或离线导出：

```bash
agent-knowledge ingest files --help
agent-knowledge ingest lark-export --help
```

以后增量：

```bash
agent-knowledge source check
agent-knowledge source refresh
agent-knowledge source list --needs-review
```

蒸馏使用 `source-distiller`，不要只根据标题生成摘要。每份 source 需要：

1. `source show` 记录 fingerprint、review token 和 section。
2. `source export` 到 workspace 外的 `0600` 临时文件。
3. 核验 DLP 和 section hash。
4. 拆成多个有业务价值的 knowledge，而不是“一篇文档一条短结论”。
5. supported claim 引用 section/hash。
6. 写入并审计 active knowledge 后，才 `source mark --status refined`。
7. 删除临时 evidence。

不适合长期保存的一次性通知使用 `no_long_term_value`；严格重复使用 `duplicate`；明确废弃使用 `obsolete`；有歧义或 DLP 缺口使用 `blocked`。

## Git 仓库知识

使用 committed blob 摄入，不读取 dirty/untracked 内容作为正式版本：

```bash
agent-knowledge ingest git --help
```

项目键优先使用规范化 Git remote；无 remote 时显式使用可读的：

```text
local/<owner>/<project>
```

检查远端更新前先显式 `git fetch`，再让 source check 比较本地登记 ref。Agent Knowledge 不会静默联网。

## 客服问题

先用 `lifecycle-recorder` 写 support stream：

```bash
agent-knowledge event append \
  --stream-type support \
  --stream-id "$CASE_ID" \
  --stage intake \
  --event-type customer_question \
  --summary "$REDACTED_SUMMARY" \
  --payload "$PRIVATE_PAYLOAD" \
  --content-type application/json
```

随后按阶段记录 triage、investigation、resolution、verification、closure 和 recurrence。Git timeline 只保存脱敏 metadata 和 hash chain；完整 payload 进入 Vault。

结案后不是立刻写 active knowledge。先让多个独立 case 形成 observation/proposal，再提炼：

- Diagnostic Path
- 查询路径
- FAQ
- SOP
- 防复发 checklist

## 需求全生命周期

使用 initiative stream 记录 discovery、review、design、development、testing、release、operations、incident 和 retrospective：

```bash
agent-knowledge event append \
  --stream-type initiative \
  --stream-id "$INITIATIVE_ID" \
  --stage discovery \
  --event-type requirement_created \
  --summary "$REDACTED_SUMMARY" \
  --payload "$PRIVATE_PAYLOAD" \
  --content-type application/json
```

查询：

```bash
agent-knowledge event timeline initiative "$INITIATIVE_ID"
agent-knowledge event status
```

长期知识应来自完成后的多阶段证据，例如：

- 方案边界和为什么这样设计；
- 测试/上线检查单；
- 事故与回滚教训；
- 可复用项目 Playbook。

## 经验与 Skill 改进

主动维护：

```bash
agent-knowledge maintenance status
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

Proposal 类型：

- `duplicate`
- `consolidation`
- `update`
- `conflict`
- `skill`

审阅：

```bash
agent-knowledge maintenance show "$PROPOSAL_ID"
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge maintenance reject "$PROPOSAL_ID" --reason "$REASON"
```

知识 proposal 进入 `_inbox`；Skill proposal 进入 `_inbox-skills`。自动/客户候选仍需人工列出精确 ID 批准，Skill 仍需显式安装。

个人低频使用每周运行一次 `maintenance run` 即可。持续机器人可以由用户显式交给进程管理器运行 `maintenance watch`；安装/配置不能静默创建后台服务。

## 同步与多机

同步只包含满足 visibility/sensitivity 的正式 active Markdown：

```bash
agent-knowledge sync run
agent-knowledge sync watch
```

不包含：

- `.memory`
- `.vault`
- source manifest
- `_inbox`
- `_inbox-skills`
- proposals
- logs

WebDAV/S3 配置只保存凭据环境变量名。冲突写本地 artifact，不能自动覆盖。

## Git 审计

知识库可直接初始化为 Git：

```bash
agent-knowledge workspace git-init
agent-knowledge workspace git-status
```

建议提交：

- active KnowledgeDocument Markdown
- source manifest
- event timeline metadata
- 人工审阅导航

禁止提交：

- Vault key
- `.vault`
- `.memory`
- 临时 evidence
- 完整对话或客服原文
- secret 和个人隐私
