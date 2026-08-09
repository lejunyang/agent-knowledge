---
name: "lifecycle-recorder"
description: "记录和审阅客服 case、需求 initiative、设计开发测试发布运维的完整生命周期事件。用户要求跟踪客服问题、记录查询路径、创建需求时间线、记录评审/设计/开发/测试/上线/运维/复盘，或把完整会话/工具结果安全存入 Agent Knowledge 时调用。"
---

# 生命周期记录器

本 Skill 把“发生了什么”记录为 append-only Event，而不是直接宣称长期事实：

```text
完整 payload -> secret/PII 治理 -> Evidence Vault
脱敏摘要/scope/hash chain -> events/support|projects/*.jsonl
多事件反思 -> observation/proposal/candidate -> 人工审阅 -> active knowledge
```

## 安全与事实边界

- 完整会话、工具请求/响应、评审纪要、测试报告只通过 `--payload <file>` 输入，避免进入 shell history。
- payload 与 summary 都会执行内置 secret/PII 治理；领域 PII 仍需上游 adapter 先清洗。
- Git timeline 只保存脱敏摘要、阶段、hash chain 和 Vault handle；它不会进入普通 query。
- payload export 只能写 knowledge workspace 外的显式 0600 文件。
- 客户陈述仍只是 event evidence，不能自动成为业务事实；至少需要 documented/owner/verified/独立 case 支撑。
- 不自动运行 `organize-inbox --approve`，不自动把事件总结写 active。

## Stable ID

- 客服：`case_<业务>_<上游工单或会话稳定ID>`。
- 需求：`initiative_<项目>_<需求稳定ID>`。
- `--idempotency-key` 使用上游 message/ticket/meeting/build/release ID；重试相同输入幂等，不同输入冲突失败。
- 不使用客户手机号、邮箱、用户名、绝对路径或随机时间作为 stream ID。

## 客服 Case

支持阶段：

```text
intake -> triage -> query -> hypothesis -> root_cause
       -> action -> verification -> closure
       -> escalation / recurrence
```

典型 intake：

```bash
agent-knowledge event append \
  --stream-type support \
  --stream-id case_account_ticket_12345 \
  --stage intake \
  --event-type customer_question \
  --summary "客户反馈登录失败，身份和环境待确认" \
  --payload /secure/tmp/message.json \
  --content-type application/json \
  --project-key github.com/example/support \
  --actor-type customer \
  --capture-mode automated_session \
  --idempotency-key message_98765
```

查询路径要分别记录，不要只写最终答案：

```bash
agent-knowledge event append \
  --stream-type support \
  --stream-id case_account_ticket_12345 \
  --stage query \
  --event-type account_lookup \
  --summary "查询账号组、授权关系和最近登录状态" \
  --payload /secure/tmp/account-query.json \
  --content-type application/json \
  --project-key github.com/example/support \
  --actor-type agent \
  --capture-mode automated_session \
  --parent-event-id "$INTAKE_EVENT_ID" \
  --idempotency-key tool_call_001
```

`root_cause`、`action`、`verification` 必须分开记录；只有客户/工具确认恢复时才写 `closure`。

## Initiative 全生命周期

支持阶段：

```text
discovery -> review -> design -> development -> testing
          -> release -> operations -> incident -> retrospective
          -> cancelled
```

需求评审：

```bash
agent-knowledge event append \
  --stream-type initiative \
  --stream-id initiative_business_req_12345 \
  --stage review \
  --event-type requirement_review \
  --summary "完成需求评审，确认范围、负责人和风险" \
  --payload /secure/tmp/review-notes.md \
  --content-type text/markdown \
  --project-key github.com/example/business \
  --actor-type owner \
  --capture-mode direct_material \
  --idempotency-key meeting_review_12345
```

开发、测试、发布分别记录 commit/MR、测试报告、发布单或工具结果 payload。上线后继续记录：

- `operations`：监控、指标、日常维护。
- `incident`：告警、故障、回滚。
- `retrospective`：目标是否达成、遗漏、流程改进和后续 action。

`release` 不等于 initiative 完成；有 `retrospective` 才派生 `completed`，`cancelled` 单独派生取消状态。

## 查看与导出

```bash
agent-knowledge event list \
  --stream-type initiative \
  --project-key github.com/example/business

agent-knowledge event timeline initiative initiative_business_req_12345
agent-knowledge event show "$EVENT_ID"

agent-knowledge event export "$EVENT_ID" \
  --output /secure/tmp/event-payload.json

agent-knowledge event status
```

timeline 读取会验证 sequence、parent、previous hash 和 record hash；任何篡改都失败。
`event status.missingPayloads > 0` 表示 retention 已删除 payload，时间线仍保留但完整证据不可展开。

## 从事件提炼知识

不要逐事件生成知识。按多个独立 case/完整 initiative 反思：

- 客服：Diagnostic Path、FAQ、Missing Documentation、Escalation Rule、Unsupported Advice。
- 需求：Project Playbook、stage checklist、风险模式、测试/发布/运维 SOP。
- 查询：什么实体/环境先确认、哪些工具最有效、哪些假设经常误导。

先检查：

```bash
agent-knowledge event list --status closed --stream-type support
agent-knowledge event list --status completed --stream-type initiative
```

语义提炼通过 `memory-maintainer` / `agent-knowledge-writer` 写 proposal/inbox；客户或 automated
event 的候选保持 proposed，且要携带多个独立 event/session evidence refs。

## 输出汇报

记录后向用户说明：

- stream ID、event ID、stage。
- payload 是否进 Vault。
- timeline 当前状态。
- 是否仍缺 root cause/verification/retrospective。
- 是否出现 PII/DLP、hash integrity 或 missing payload 风险。
- 何时适合跨 case/initiative 做反思与知识提炼。
