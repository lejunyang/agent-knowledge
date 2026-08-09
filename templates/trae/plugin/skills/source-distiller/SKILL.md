---
name: "source-distiller"
description: "审阅 Agent Knowledge 的 versioned source manifest 和 Evidence Vault 原文，把 pending/stale 文档提炼为有 claim anchor 的候选知识，并显式标记 refined、duplicate、obsolete、no_long_term_value 或 blocked。用户要求整理已导入文档、处理 pending source、蒸馏 source、审阅知识来源或把 Vault evidence 提炼成知识时调用。"
---

# Source 知识蒸馏器

本 Skill 处理已经通过 Connector 摄入的 source，不负责爬取或绕过 Vault：

```text
source refresh（check -> 按需 ingest -> recheck）
  -> source list/show
  -> source export 到受控临时文件
  -> 语义拆分与领域确认
  -> write-candidate / capture-material --target inbox
  -> source mark（带原 fingerprint）
```

## 安全边界

- `source list/show` 只看 manifest metadata、section heading/hash/range，不保存或返回正文 preview。
- 完整 evidence 只能用 `source export --output <file>` 写入显式 0600 临时文件；不要把正文打印到终端、聊天或日志。
- export 前记录 `source show.expectedFingerprint`；export 和 mark 都必须携带同一个 fingerprint。若变化，停止并重新审阅新版本。
- 临时 evidence 文件只在当前审阅任务内使用，完成后删除；不要写入 Git、Markdown、proposal 或同步目录。
- 凭据、测试账号、用户标识、姓名、地址、业务 UID 等若仍出现在 evidence，停止蒸馏并报告 Connector/DLP 缺口，不要复制到 candidate。
- Source 材料来自 customer/自动会话时，候选必须保留 `automated_session` 与准确 actor，永远先进入 inbox。
- 不自动执行 `organize-inbox --approve`，不自动把候选晋升 active。

## 1. 检查来源版本

日常直接刷新已登记 Connector：

```bash
agent-knowledge source refresh
```

或只刷新当前来源：

```bash
agent-knowledge source refresh --connector-id "$CONNECTOR_ID"
```

`source refresh` 先运行 probe-only check，只在有确定更新、`update_unknown` 或显式 `--force`
时执行 ingestion，然后重新 check。它复用登记中的 base dir/glob/project key/pathspec/redaction
policy，不需要手工重填。无变化时不读取 Vault key。

只想审计、不想摄入时使用 `source check`；它不需要 Vault key，不读取正文，也不写
Vault、manifest 或 checkpoint。状态解释：

- `unchanged`：当前本地/离线 probe 与 manifest 一致。
- `metadata_only`：正文身份未变，但 commit/revision/time 等 metadata 变化；重新 ingest 更新版本即可。
- `content_changed`：blob/path hash 已确认内容身份变化；重新 ingest 后再蒸馏。
- `update_unknown`：revision/ETag/mtime 变化，但必须重新 ingest 比较脱敏 content hash 才能确认。
- `processing_profile_changed` / `evidence_missing`：必须重新 ingest 修复处理结果或 Vault evidence。
- `new` / `removed` / `restored`：完整 inventory 的增删恢复，需要重新 ingest 和审阅。

检查严格是 `networkAccess: none`：

- Git 只检查登记的本地 ref。要判断 GitHub/GitLab 远端，先由用户或受控自动化显式
  `git fetch`，再检查/摄入目标 remote-tracking ref；不要让 Skill 静默 fetch/pull。
- 飞书只检查登记的 offline export。先显式运行 `fetch-lark-corpus.mjs --refresh-existing`
  更新导出，再执行 `source check`；旧 export 不能代表在线文档最新版本。

登记表会拒绝同 ID 的 scope 降级/漂移。需要小批验证时使用 `source refresh --limit <n>`；
需要无变化强制重跑处理规则时使用 `--force`。

## 2. 查看队列

默认只看需要审阅的 source：

```bash
agent-knowledge source list --needs-review
```

可按状态、availability 或 project 缩小范围：

```bash
agent-knowledge source list \
  --status pending blocked \
  --availability available \
  --project github.com/example/business
```

逐条查看：

```bash
agent-knowledge source show "$SOURCE_ID"
```

先记录：

- `expectedFingerprint`
- `reviewToken`
- `contentHash`
- `processingStatus` / `reviewState`
- `projectKeys`
- `sectionsDetail[].section_id/text_hash/heading_path/char_start/char_end`
- `redactionPolicy` / `redactions`

`reviewState=missing` 表示上游已删除，但历史 Vault evidence 仍可用 fingerprint 显式 export；
检查相关 active claim 是否需要更新或废弃，再 mark obsolete 或 blocked。

`source list.updateHealth` 会显示登记数、未检查或 stale 的 Connector、确定更新数和待抓取
确认数。摄入会使旧检查报告 stale，这是为了防止已经处理的更新继续误报；重新检查即可。

## 3. 导出当前 evidence

使用 owner 控制的临时目录，避免系统共享目录：

```bash
umask 077
agent-knowledge source export "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --output "$PRIVATE_TEMP/source-evidence"
```

命令不会向 stdout 输出正文，只返回输出路径、字节数和 content type。默认拒绝覆盖。

## 4. 拆分和确认

按 source 的 heading/FAQ/流程/规则/案例拆分，不要“一篇文档一条短总结”。

每条 knowledge explanation 必须包含：

- 背景与业务语义。
- 适用条件和范围。
- 关键步骤或因果关系。
- 例外与失败策略。
- 验证方式与版本边界。

每个 `supported` claim 必须引用 `source show` 当前 section：

```json
{
  "source_id": "src_...",
  "section_id": "sec_...",
  "quote_hash": "sha256:..."
}
```

不要根据 heading/hash 猜 claim；必须阅读导出的当前 evidence。若 section 粒度不足或正文与
range/hash 无法可靠对应，标记 blocked 并报告需要改进 sectionizer。

遇到以下情况先一次汇总询问用户，确认前不得写 candidate 或 mark refined：

- 领域术语、实体关系、适用范围意义不明。
- 文档疑似错误、过期或自相矛盾。
- 与 active knowledge 冲突。
- PII/DLP 清洗不完整。
- 无法判断 source 应 refined、duplicate、obsolete 还是 no_long_term_value。

## 5. 写候选

默认写 `_inbox`：

```bash
agent-knowledge write-candidate --input candidate.json
```

或多条批次：

```bash
agent-knowledge capture-material \
  --input source-candidates.json \
  --target inbox \
  --no-rebuild
```

Documented owner source 的候选至少包含：

- `source_authority: documented`
- `capture_mode: direct_material`
- `actor_type: owner`
- source manifest 的 `project_keys`
- `evidence: ["source:<source-id>"]`
- weighted aliases/scenarios/tags
- current claim anchors

完成候选审阅前，不要 mark refined。

## 6. 标记 source 结果

只有候选对应知识已经成为 **active knowledge**，且其中至少一个 claim anchor 指向当前 source
section/hash，才能标记 refined：

```bash
agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status refined \
  --knowledge-id "$ACTIVE_KNOWLEDGE_ID"
```

其他状态：

```bash
agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status duplicate \
  --duplicate-of "$CANONICAL_SOURCE_ID" \
  --reason "与规范来源重复"

agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status no_long_term_value \
  --reason "仅包含一次性通知，无可复用事实或流程"

agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status obsolete \
  --reason "上游已由新规范替代"

agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status blocked \
  --reason "等待业务 owner 确认术语含义"
```

reason 会进入 Git manifest，禁止写 secret/PII。review token 防止同版本并发审阅互相覆盖；
receipt 变化后必须重新 show。标记后若 source content hash 改变，
`reviewState` 会变 stale/pending，需要重新审阅；metadata-only 更新保留 current receipt。
duplicate target 必须是 available 的规范 source，不能再指向另一个 duplicate。

## 7. 收尾

删除导出的临时 evidence 文件，并汇报：

- 审阅的 source ID/fingerprint。
- 生成的 candidate/active knowledge ID。
- source 最终状态。
- blocked/conflict/PII 风险。
- 是否需要 `organize-inbox`、`index`、`embed-index` 或 `graph build`。

最终检查：

```bash
agent-knowledge source check
agent-knowledge source refresh
agent-knowledge source list --needs-review
agent-knowledge knowledge audit --fail-on warning
```
