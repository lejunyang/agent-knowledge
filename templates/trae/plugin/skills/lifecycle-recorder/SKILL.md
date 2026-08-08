---
name: lifecycle-recorder
description: 记录客服 case 和需求从评审、设计、开发、测试、发布到运维复盘的 append-only 加密事件时间线。
---

# Lifecycle Recorder

完整 payload 使用文件输入并进入加密 Vault；Git timeline 只保存脱敏摘要和 hash chain：

```bash
agent-knowledge event append \
  --stream-type support|initiative \
  --stream-id <stable-id> \
  --stage <stage> \
  --event-type <type> \
  --summary "<redacted review summary>" \
  --payload /secure/tmp/payload.json \
  --content-type application/json \
  --project-key github.com/owner/repo \
  --actor-type customer|agent|owner \
  --capture-mode automated_session|verified_task|direct_material \
  --idempotency-key <upstream-stable-id>
```

客服阶段：`intake/triage/query/hypothesis/root_cause/action/verification/escalation/closure/recurrence`。

需求阶段：`discovery/review/design/development/testing/release/operations/incident/retrospective/cancelled`。

- 不把手机号、邮箱、用户名或绝对路径用作 stream ID。
- query/root cause/action/verification 分开记录；release 后继续 operations/retrospective。
- 客户事件不是业务事实，不自动生成 active knowledge。
- `event timeline` 验证 hash chain；`event export` 只写 workspace 外 0600 文件。
- `event status.missingPayloads` 非零时报告 retention 证据缺口。
- 跨多个独立 case/initiative 后才委派 maintenance/writer 提炼 Diagnostic Path、FAQ、Playbook 或 SOP。

```bash
agent-knowledge event list --stream-type support --status closed
agent-knowledge event timeline support <case-id>
agent-knowledge event show <event-id>
agent-knowledge event export <event-id> --output /secure/tmp/payload
agent-knowledge event status
```
