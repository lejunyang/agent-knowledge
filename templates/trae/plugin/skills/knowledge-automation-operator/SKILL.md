---
name: knowledge-automation-operator
description: "运行 Agent Knowledge 后台巡检和来源刷新。用户要求定时检查在线飞书/Git 来源、运行有界维护、批量整理待确认问题、投递通知回调、排查后台 job，或让其他 Agent CLI 按 automation profile 工作时调用。"
---

# Knowledge Automation Operator

本 Skill 用于让外部 Agent CLI 安全执行 Agent Knowledge 后台工作。确定性 CLI 负责 allowlist、限流、重试、job、audit、maintenance、eval 和 notification outbox；本 Agent 只负责解释结果、聚合问题和决定是否需要用户确认。

## 不可绕过的边界

- 只使用用户提供的 automation profile。
- 不扩大 Lark roots、Git remote/refs、Connector、project 或知识库范围。
- 不修改 active knowledge，不运行 `organize-inbox --approve`、`maintenance accept` 或 Skill install。
- 不把 Vault evidence、完整对话、token、Cookie、验证码或用户原值放进通知。
- 不静默更改 profile、阈值、系统提示词、常驻服务或 sidecar 配置。
- 遇到歧义、冲突、权限、DLP 缺口或 eval regression 时停止相关分支，并一次汇总问题。

## 标准流程

### 1. 校验与只读展开

```bash
agent-knowledge automation validate --profile "$PROFILE"
agent-knowledge automation inspect --profile "$PROFILE"
```

检查计划是否只包含预期 Lark roots、Git refs、Connector、audit、maintenance 和 eval。检查 profile 中的 `maxRuntimeMinutes`、`maxQuestions`、callback 和 retry 边界。

### 2. 执行有界任务

默认让 runner 完成确定性工作，但先不自动投递，以便本 Agent合并问题：

```bash
agent-knowledge automation run \
  --profile "$PROFILE" \
  --idempotency-key "$SCHEDULE_WINDOW" \
  --no-deliver
```

Runner 可以显式联网刷新 allowlist 中的在线飞书/Git refs，随后执行 source refresh、audit、maintenance 和 eval。它不写 active knowledge。

### 3. 审阅结果

```bash
agent-knowledge automation status --profile "$PROFILE"
agent-knowledge notifications list --root "$AGENT_KNOWLEDGE_ROOT"
agent-knowledge source list --root "$AGENT_KNOWLEDGE_ROOT" --needs-review
agent-knowledge maintenance list --root "$AGENT_KNOWLEDGE_ROOT" --status pending
```

只读取与当前 job/profile 有关的 notification。需要详细解释时读取 `references/profile-schema.md`。

### 4. 一次汇总确认问题

按 `references/question-policy.md` 聚合所有问题。问题总数不得超过 profile `maxQuestions`。

若确定性 runner 已生成多个低层通知，可以再生成一个 `confirmation_required` 问题包：

```bash
agent-knowledge notifications enqueue \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  --input "$QUESTION_PACKAGE_JSON"
```

问题包只写：问题 ID、类型、source/proposal/knowledge ID、为何需要确认、互斥选项、默认安全动作和截止时间。不要复制正文或敏感原值。

### 5. 投递 callback

```bash
agent-knowledge notifications deliver --profile "$PROFILE"
```

Callback 失败时通知留在 outbox，后续调度继续重试。用户处理后：

```bash
agent-knowledge notifications ack \
  --root "$AGENT_KNOWLEDGE_ROOT" \
  "$NOTIFICATION_ID"
```

## 失败策略

- `automation validate` 失败：不执行任何后续命令。
- Online Lark/Git 失败：不回退到扩大权限或其他 root/ref；保留 `source_refresh_failed`。
- Inventory incomplete：保留告警，不宣称完整覆盖。
- Audit warning/error：不自动修复 active knowledge；创建问题或交给对应治理 Skill。
- Eval regression：不更改 retrieval 默认值；通知用户并附指标。
- Maintenance 有 proposal：只通知数量和 ID，不自动接受。
- Callback 4xx：视为配置/权限错误，不无限重试。
- 达到 runtime、retry 或 maxQuestions：停止并报告未处理项。

## 与其他 Skills 协作

- 文档证据需要语义蒸馏：`source-distiller`。
- Inbox/直接材料审阅：`knowledge-organizer`。
- 客服/需求 timeline：`lifecycle-recorder`。
- Proposal、feedback、Skill 候选：`memory-maintainer`。
- Retrieval Lesson / Reasoning Policy：`memory-use-policy-maintainer`；本 Operator 不自动
  mine/accept/deprecate Policy。
- 使用说明和健康诊断：`agent-knowledge-guide`。

本 Skill 只做后台操作编排和问题汇总，不复制上述专业流程。

## 最终输出

人类摘要后必须输出一个可机器解析对象，字段名固定：

```text
FINAL_REPORT_JSON
```

```json
{
  "profile_id": "business-refresh",
  "job_id": "job_...",
  "status": "succeeded | needs_confirmation | failed",
  "completed_steps": [],
  "notification_ids": [],
  "question_count": 0,
  "unresolved": [],
  "active_knowledge_modified": false
}
```

`active_knowledge_modified` 必须始终为 `false`；若发现不是 false，视为安全事故并停止。
