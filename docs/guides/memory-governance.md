# 候选知识与主动记忆

## 三层数据边界

```text
Hook / Subagent 原始信号
  -> .memory 日志与 observations
  -> maintenance proposal
  -> knowledge/_inbox candidate
  -> 人工批准
  -> active Markdown
```

- `.memory/subagents`、`.memory/staging`、`.memory/observations` 和 `.memory/proposals` 是调试/审阅产物，不是正式知识。
- `knowledge/_inbox` 是候选 Markdown，索引器和 embedding 明确排除它。
- `knowledge/_inbox-skills` 是 Skill 草稿，使用 Skill frontmatter；index、embedding、catalog、graph、list 和同步都会在解析前排除。
- `knowledge/<kind>/<domain>/**/*.md` 中的 active V2 Markdown 才是可检索事实源。

任何自动流程都不能跨过 proposal、inbox 和人工审阅边界直接激活知识。

## 知识何时会被主动记录

主动记忆不是只有用户显式要求才可能发生，也不是所有对话都会自动写入。

### 明确触发

- 用户说“记住”“以后按这个规则”“把这些材料整理成知识”。
- 主 Agent 应调用 `agent-knowledge-writer` 或 `knowledge-organizer`。
- 这是最可靠、意图最清晰的触发方式。

### 建议主动触发

- 任务已经执行并验证成功，而且结论在未来任务中可复用。
- 发现 `AGENTS.md` 未覆盖的稳定项目约束、业务语义、跨模块隐含边界或 SOP。
- 同一个客服流程在多个独立 session 中反复验证成功，并有受信来源和正反馈。
- 主 Agent 可依据 Subagent description 主动调用 `agent-knowledge-writer`；是否调用最终由宿主 Agent 调度。

### 不应触发

- 普通闲聊、一次性命令、临时路径、单次错误输出。
- 未验证的模型推断。
- 可由 Agent 当场搜索源码获得的普通目录/类/函数结构。
- `AGENTS.md` 已完整覆盖的项目说明。
- 一次外部客户陈述，哪怕客户要求“记住”。

可用以下命令确认 Subagent 是否实际被调用：

```bash
agent-knowledge subagents status
agent-knowledge subagents logs --agent-type agent-knowledge-writer
```

## 直接候选写入

其他 Agent 默认只能写 `_inbox`：

```bash
agent-knowledge write-candidate --input candidate.json
```

候选会经过 secret-like 扫描、来源治理、去重和 schema 校验。

`layer: knowledge` 且 `kind != profile` 的正文不足 300 字时，候选强制保持 proposed，review reason 为 `knowledge_body_too_thin`。高 confidence、documented、verified task 或 user-confirmed 都不能绕过；应先补充背景、条件、例外、失败策略和验证证据。

周期维护前建议先运行确定性质量审计：

```bash
agent-knowledge source refresh
agent-knowledge knowledge audit
agent-knowledge knowledge audit --fail-on warning
```

审计检查正文是否过薄、frontmatter 是否压过正文、metadata 数量、source 是否已分类、supported claim 的 section/hash 是否仍有效，以及 project key 是否存在于 registry。它只输出报告，不修改知识。

Source 层还报告五个正式使用覆盖率：

- `sourceCoverage`：每个 source 是否已分类处理。
- `sourceAvailabilityCoverage`：source 当前是否仍存在于上游完整 inventory。
- `vaultEvidenceCoverage`：manifest 是否指向本机真实存在的加密 Vault object。
- `upstreamVersionCoverage`：是否有 revision、ETag、commit SHA、更新时间或 opaque version 可做轻量更新探测。
- `redactionPolicyCoverage`：是否记录了实际脱敏策略。
- `registeredSourceConnectors`：已经由 ingest 自动登记、可重复检查的本地 Connector 数。
- `uncheckedSourceConnectors/staleSourceUpdateChecks`：尚未检查，或摄入/重新登记后旧报告已失效的 Connector 数。
- `sourceUpdatesAvailable/sourceUpdatesUnknown`：当前报告中的确定更新，以及必须重新抓取后才能确认的版本变化。

缺失或丢失 Vault object 是 error；缺少上游版本信号或脱敏策略记录是 warning。缺少上游版本
不阻止摄入，但后续每次检查都必须抓取全文比较 content hash。

## Source 审阅与蒸馏

Connector 只负责把证据安全摄入，不会自动把文档结论写成 active knowledge。查看审阅队列：

```bash
agent-knowledge source refresh
agent-knowledge source list --needs-review
agent-knowledge source show "$SOURCE_ID"
```

`source list.updateHealth` 汇总登记、检查 freshness、确定更新和待抓取确认。只有绑定当前登记
快照的报告才算 current；摄入后旧报告自动 stale，且不再贡献 update 数，防止已处理的变化
继续误报。

`show` 返回 current fingerprint、review token、section heading/ID/hash/range、project scope 和
export 状态，不解密完整正文。需要语义蒸馏时使用 `source-distiller` Skill，把完整 evidence
写入 knowledge workspace 之外、owner 控制的 0600 临时文件：

```bash
agent-knowledge source export "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --output /secure/tmp/source-evidence
```

候选默认通过 `write-candidate` 或 `capture-material --target inbox`。只有候选已经成为 active
knowledge，且其中 supported claim 的 current anchor 指向该 source，才能：

```bash
agent-knowledge source mark "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --review-token "$REVIEW_TOKEN" \
  --status refined \
  --knowledge-id "$ACTIVE_KNOWLEDGE_ID"
```

其他结果显式标为 `duplicate`、`obsolete`、`no_long_term_value` 或 `blocked`，并写不含
secret/PII 的 reason。duplicate 必须指向存在且 available 的 source。mark 同时使用
fingerprint 和 review token 乐观锁；source 在阅读期间更新，或其他 reviewer 已改变 receipt
时会拒绝旧结论。

export/mark 与 Connector ingestion 使用同一把本地锁，确保 fingerprint/token 校验和读取/写入
之间不会插入并发摄入。锁只保护本机 workspace；多设备通过 private Git 同步 manifest 时仍需
依赖 Git 冲突审阅，不能最后写入获胜。

### Source 蒸馏质量门禁

真实批量飞书重建表明，只执行“读原文 -> 写 candidate”仍会重新产生短正文和 metadata
膨胀。正式蒸馏必须同时完成：

1. `source show` 固定 fingerprint、review token 和目标 section。
2. `source export` 只写 workspace 外 `0600` 临时文件。
3. 验证导出内容 hash、确定性 DLP 和引用 section 的 text hash。
4. 按业务主题拆分；一份长文可产生多条知识，也可以不产生知识。
5. L1 synopsis 只负责路由；L2 必须有背景、范围、步骤/因果、例外、失败策略和验证方式。
6. alias/scenario/tag 只保留有来源和检索价值的少量项，不能补偿正文不足。
7. supported claim 使用 current section/hash；未阅读正文不得根据 heading 猜结论。
8. `knowledge audit` 无知识级 finding，且新增真实 eval/hard-negative 不破坏既有边界后，
   才能 `source mark --status refined`。
9. 删除临时 evidence，并在 Git 中只提交知识和 manifest receipt。

文档含图片、附件或画板时，正文 evidence 会使用 `<asset-ref source-id="...">` 指向独立
attachment source。媒体不会自动进入知识 Git；先用 `source show/export` 固定 fingerprint 并
检查授权、PII、active content 和业务相关性，再按需执行：

```bash
agent-knowledge source publish-asset "$ASSET_SOURCE_ID" \
  --fingerprint "$ASSET_FINGERPRINT" \
  --confirm-reviewed
```

候选 explanation 只使用命令返回的 `asset://asset_sha256_<hash>`。写入 active/inbox 时系统会
校验 asset manifest 和二进制 hash，再按 Markdown 位置改写为相对路径；inbox 晋升后重新定位。
飞书 token、临时下载 URL、本机绝对路径和手工猜测的资产相对路径都不得进入候选。

如果文档明确废弃、严格重复、一次性通知或意义不明，分别使用
`obsolete`、`duplicate`、`no_long_term_value` 或 `blocked`，不要为了提高 source coverage
强制制造 active knowledge。

Source manifest v5 review receipt 保存 `processed_at`、`processed_content_hash` 和
`refined_knowledge_ids`。metadata-only 更新不要求重蒸馏；content change/restored 清空 receipt
并回 pending。missing source 先进入 missing+pending，人工审查历史 Vault evidence 与受影响
claim 后再标 obsolete/blocked。

`agent-knowledge-writer` 只输出 JSON，不调用工具、不写文件。主 Agent 负责把 JSON 保存为临时文件并执行 `write-candidate`。即使候选因 `user_confirmed` 或高置信 verified procedural 被判为 active status，文件仍先落在 `_inbox`，不会直接进入正式检索。

用户直接提供的材料可由 `knowledge-organizer` 拆分，再使用：

```bash
agent-knowledge capture-material --input material.json --target active
```

直接材料进入 active 前仍要经过领域确认门禁。术语或关系意义不明、需要垂直领域判断、与受信知识冲突，或 Agent 根据现有证据认为内容疑似错误/过期时，必须引用具体原文并一次汇总疑点向用户确认。确认前该条不得写入 active 或 inbox，不能用低 confidence 代替确认；不依赖疑点的明确条目可以分开处理。

`kind: source` / `layer: evidence` 只保存经过治理的 evidence：导入前必须移除临时下载 URL，并遮蔽测试账号、验证码、密码、token、飞书用户标识和个人信息。上游文档内容变化或脱敏规则升级时，可以刷新稳定 ID 对应的来源证据：

```bash
agent-knowledge capture-material \
  --input source-batch.json \
  --target active \
  --replace-source
```

`--replace-source` 只允许替换同 ID、`active`、`documented` 的 `kind: source` 文档。它不能覆盖 semantic/procedural/profile/episodic/principle；精炼知识发生变化时应新增版本并用 `supersedes` 保留历史。

只有 owner 的受信、含义明确且通过必要领域确认的直接材料才适合 `--target active`。外部材料或用户要求先审阅时使用 `--target inbox`；意义不明、疑似错误和需要用户领域判断的内容在确认前不写任何候选目录。

### 可更新来源的版本治理

Source manifest 同时保存：

- 稳定身份：`source_id`、connector、external key。
- 上游版本：revision、ETag、commit SHA、blob/path hash、更新时间或 opaque provider version。
- 本地确认：content hash、version fingerprint、observed time。
- 结构：section ID、heading path、section text hash。
- 治理：artifact kind、project keys、content type/bytes、redaction policy/counts、processing profile。
- 原文：指向客户端加密 Vault object 的不可逆 handle。

更新流程：

1. `ingest` 自动保存 0600 本地 Connector 登记；scope 变化或 project key 降级必须使用新 ID。
2. `source check` 只读取廉价 upstream probe，不读取正文或写 Vault/manifest。
3. 日常 `source refresh` 复用登记，执行 check -> conditional ingestion -> recheck；无变化时
   不读取 Vault key，也无需重复填写 Connector scope。
4. 与上次共同版本信号相同且 processing profile 未变：标记 unchanged。
5. `path_hash` 变化可标 content_changed；revision/ETag/mtime 变化但无内容 identity 时标
   update_unknown，不能直接断言正文已变化。
6. refresh 显式重新 ingest、脱敏并比较 content hash；相同则 metadata-only，不同才重新生成 section。
7. 引用已变化 section 的 claim 进入待验证状态，再生成知识更新 proposal。

检查不联网。飞书使用 offline export 中的 revision/更新时间；要判断线上版本先显式刷新 export。
Git/GitHub 使用本地 ref 的 blob/commit SHA；要判断远端先显式 fetch。没有上游版本信息时必须
重新抓取比较 content hash，不能静默假设未变化。normalize 或脱敏规则升级会改变
processing profile，即使上游版本没变也必须重抓；若正文 hash 未变，保留已有 source 分类状态。

本地文件与完整 transcript 可先使用：

```bash
agent-knowledge ingest files \
  --connector-id business-docs \
  --base-dir /secure/exports/business-docs \
  --pattern '**/*.md' \
  --project-key github.com/example/business

agent-knowledge ingest transcripts \
  --connector-id support-sessions \
  --base-dir /secure/exports/support-sessions \
  --project-key github.com/example/support

agent-knowledge ingest git \
  --connector-id business-repository \
  --repository /projects/business \
  --pathspec README.md docs

agent-knowledge ingest lark-export \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business
```

`transcripts` 强制遮蔽 secret 与 PII；所有 manifest 都不保存正文 preview，完整脱敏内容只进入 Vault。
每次尝试有独立 job，失败不推进 checkpoint，同一 Connector 的并发运行由本地 lock 拒绝。

Git Connector 用 blob SHA 判断单文档变化，用 commit SHA 记录仓库版本；无关代码 commit
只形成 metadata-only，不重读正文。完整 inventory 发现 source 被删除后将其标记
missing/obsolete，相关 supported claim 失去有效 anchor；同路径恢复后必须重新蒸馏/审阅。

飞书正式批量流程：

```bash
node scripts/fetch-lark-corpus.mjs \
  --root-url <wiki-or-doc-url> \
  --output /secure/exports/lark-business \
  --refresh-existing

agent-knowledge ingest lark-export \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business

agent-knowledge source refresh --connector-id lark-business
agent-knowledge source list --needs-review
```

manifest v2 会保存图片、附件和画板 inventory；同一媒体重复出现保留各自 occurrence，但下载
bytes 可复用。content hash 不一致的文档或媒体会作为独立 source 失败且不推进对应 watermark。
导出未 complete 或仍有文档/媒体 failures 时允许成功项先进入队列，但 inventory warning
持久化、删除对账关闭；这不等于完整覆盖。
旧 `build-lark-source-candidates.mjs` 不属于正式 pipeline。

`source list` 顶层 `inventory` 和 `knowledge audit` 的
`incompleteSourceConnectors/unresolvedSourceInventory` 用于追踪这类缺口。只有 unresolved 清零，
才能宣称 source inventory 完整。

`source list.updateHealth` 与 audit 的 update 指标来自 `.memory/ingestion/update-checks`，不进入
Git/WebDAV/S3。当前 manifest 版本与 private Git 历史才是可审计版本轨迹；update report 只是
本机当前快照检查结果。

单文档 content hash、解码、脱敏或 Vault 失败会写入 checkpoint failure ledger，并通过
`source list.inventory.failedSources` / `failedSourceIngestions` error 持续暴露；成功重试会清除。

## 客服 Case 与需求 Initiative 事件

Event 记录“发生了什么”，不是长期事实。完整 payload 在 secret/PII 治理后进入 Vault；Git
只保存脱敏摘要、scope、stage、parent、previous hash 和 record hash：

```bash
agent-knowledge event append \
  --stream-type support \
  --stream-id case_account_ticket_12345 \
  --stage query \
  --event-type account_lookup \
  --summary "查询账号组和授权关系" \
  --payload /secure/tmp/query-result.json \
  --content-type application/json \
  --project-key github.com/example/support \
  --actor-type agent \
  --capture-mode automated_session \
  --idempotency-key tool_call_001
```

客服阶段：

```text
intake/triage/query/hypothesis/root_cause/action/verification/escalation/closure/recurrence
```

需求阶段：

```text
discovery/review/design/development/testing/release/operations/incident/retrospective/cancelled
```

查看与审计：

```bash
agent-knowledge event list --stream-type support --status closed
agent-knowledge event timeline support <case-id>
agent-knowledge event show <event-id>
agent-knowledge event export <event-id> --output /secure/tmp/payload
agent-knowledge event status
```

- `--payload` 只接受文件，避免完整对话/工具结果进入 shell history。
- `--idempotency-key` 使用上游 message/ticket/build/release ID；相同输入幂等，不同输入冲突。
- 同一 stream append 使用本机锁，timeline 读取校验 sequence/parent/hash chain。
- export 只能写 workspace 外 0600 文件。
- `missingPayloads > 0` 表示 retention 已物理删除 Vault payload，timeline 仍保留但证据不可展开。
- 客户/automated event 只能支持 observation/proposal；多次同 session 不算独立事实。
- 至少跨多个独立 closed case 或完整 completed initiative，才提炼 Diagnostic Path、FAQ、
  Project Playbook 或 SOP。

## Hook、详细日志与 staging

TRAE、Claude Code 和 Codex Hook 的职责分开：

- `UserPromptSubmit`：查询知识；高相关才注入，无命中/低分完全静默。
- `SubagentStart` / `SubagentStop`：保存本地原始调试 payload，并写脱敏 staging 信号。
- `Stop` / `SessionEnd`：只写脱敏 lifecycle staging。
- Hook 本身不调用 LLM 总结，不写 candidate，不激活知识。

Codex 当前只有 `SessionStart`、`UserPromptSubmit`、`SubagentStop` 和 `Stop` 模板项；没有
`SubagentStart` / `SessionEnd` 时不能伪造完整配对。可用的 `SubagentStop` 仍可进入
maintenance extraction，详细配对指标则按宿主实际事件解释。

详细 Subagent 日志：

```text
.memory/subagents/YYYY-MM-DD.jsonl
```

它保留原始 payload、Start/Stop 配对和 duration，默认不脱敏，因为仅供本机所有者调试；它不会同步、不会注入上下文。可在配置中关闭：

```json
{
  "hooks": {
    "detailedSubagentLogging": false
  }
}
```

Staging 只保存 hash、长度、agent type、reason 和 project key：

```bash
agent-knowledge staging status
agent-knowledge staging drain --limit 100
```

`staging drain` 是调试/Skill 人工审阅入口，不是 maintenance 常规输入要求。不要为了清空 pending 数而盲目 drain。

## Maintenance 自动维护

正常数据流：

```text
.memory/subagents 的新 SubagentStop
  -> maintenance extract 的 source watermark
  -> .memory/observations/events.jsonl
  -> maintenance worker 的 proposal watermark + lock
  -> .memory/proposals/*.json
```

```bash
agent-knowledge maintenance extract
agent-knowledge maintenance run
agent-knowledge maintenance watch --interval-minutes 30
agent-knowledge maintenance status
```

- `extract`：只抽取新 `SubagentStop`，没有可复用文本的事件会跳过。
- `run`：先自动 extract，再读取 observation 并生成 proposal。
- `watch`：前台长期循环，立即运行一次，再按间隔执行。
- `status`：查看 source watermark、待抽取事件和 observation 数量。
- `--input <file>`：高级外部 observation 导入；普通用户不需要编写这个 JSON。

`watch` 的 input 来自 Hook 自动写入的详细 Subagent 日志，不是另一个人工脚本。它不会自动成为系统服务；持续机器人应交给 systemd、launchd、容器或其他进程管理器。

也可以直接要求 AI 使用 `memory-maintainer` Skill 完成状态检查、run、proposal 汇总和日志清理；用户负责 accept/reject、精确 ID approve 和 Skill 安装决策。

如果用户不知道该运行哪条命令，先使用 `agent-knowledge-guide`：它会把首次启用、查询、source、
客服/需求、maintenance、integration 和质量诊断路由到对应 Skill，并默认只执行只读检查。

Worker 使用 watermark 防止重复消费，使用 lock 防止并发 worker 同时生成提案，每次按 limit 有界处理。它生成：

- `duplicate`
- `consolidation`
- `update`
- `conflict`
- `skill`

Proposal 不会修改 active Markdown。当前 extraction 是确定性字段抽取，不调用外部 LLM；复杂语义整理应由 `memory-maintainer` Skill 和 `agent-knowledge-writer` 在人工可见流程中完成。

## Proposal 人工审阅

列出并查看：

```bash
agent-knowledge maintenance list --status pending
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance reject <proposal-id> --reason "..."
```

类型含义：

- `duplicate`：观察与已有 active 知识相同；接受只记录审计状态，不创建 candidate。
- `consolidation`：同一主题有新补充，建议合并。
- `update`：显式替代旧知识，candidate 会带 `supersedes`。
- `conflict`：与已有知识冲突，candidate 会带 `conflicts_with`，必须调查证据。
- `skill`：重复验证的 procedural 流程可提炼为可执行 Skill。

接受知识 proposal：

```bash
agent-knowledge maintenance accept <proposal-id>
```

`consolidation/update/conflict` 会写入 `knowledge/_inbox`，status 仍是 proposed。检查命令返回的 `candidatePath`、证据、适用范围、敏感级别和冲突关系后，查出知识 ID：

```bash
agent-knowledge list
agent-knowledge organize-inbox --approve <knowledge-id>
agent-knowledge organize-inbox --approve <knowledge-id> --apply
```

`--approve` 是明确的人类白名单：该次只处理列出的 ID，并允许已核验的 `automated_session` / `customer` 候选越过默认批量阻断。未知 ID 会在写文件前失败。

不传 `--approve` 的普通 `organize-inbox --apply` 只批量处理受信 candidate；客户和自动会话候选继续阻止。

知识 frontmatter 可选保存结构化 `episodes`，包含 session/turn hash、project key、观察时间和 evidence refs，用于时间更新和独立证据判断。

## Skill 沉淀生命周期

Skill proposal 只有同时满足以下条件才生成：

- `memoryType=procedural`
- 至少 3 个**独立 session**
- 每个 observation 都是 `verified_task` 或 `user_confirmed`
- 与同 domain、同标题/alias 的 active procedural knowledge 存在足够的净正向 usefulness feedback
- 没有 conflict

这比普通 procedural candidate 更严格，因为 Skill 会改变 Agent 的执行方式。

Feedback 计算规则：

- `agent-knowledge feedback` 写入 `.memory/logs`，maintenance 会自动读取。
- 同一 `memoryId + queryRunId` 只采用时间最新的一条，重复上报不增加票数。
- `useful=+1`、`not_useful=-1`、`neutral=0`；净正反馈数量必须至少等于独立 session 数。
- 自动关联只在 observation 与 active knowledge 的 domain 相同，且标题或 alias 精确匹配时发生，避免把近主题反馈误转给另一条流程。
- feedback 晚于 observation 到达时，后续 `maintenance run/watch` 仍会重新评估已消费 observation；无需删除 watermarks 或重复导入 observation。
- 外部 observation 已显式携带 `usefulFeedback` 时保留该值，不用本地日志覆盖。

这意味着主 Agent 实际使用或拒绝检索结果后，应尽量记录带 `queryRunId` 的 feedback；但不要为了满足 Skill 门槛批量伪造正反馈。

这套 usefulness 分数继续服务普通 knowledge/Skill maintenance。`wrong_route`、
`forbidden_injection`、`should_abstain`、`conflicting_evidence` 等结构化 memory-use failure
由 `memory-use-policy-maintainer` 走独立 `policy mine/proposals/simulate` 流程，不与普通
maintenance proposal 混合。

## 记忆使用质量闭环

本项目对“会不会用记忆”的治理分为五层：

1. `query --debug` 保留候选和最终 packet 的区别，输出 scorer、coverage 与 `queryRunId`。
2. 主 Agent 对实际使用或拒绝的结果记录 useful/not_useful/neutral feedback。
3. Eval 使用 expected rank、hard-negative、forbidden 和 abstain 检查错误使用，而不只看 Recall。
4. `eval-calibrate` 把 forbidden injection、abstention failure 和负反馈作为高优先级惩罚，只输出 dry-run 建议。
5. Maintenance 用独立 session、可信来源、conflict 和净正反馈判断 knowledge/Skill proposal。
6. Policy control plane 用结构化 failure reason、独立 query/eval、Git shadow Policy 和
   simulation/history 判断“如何使用记忆”，但 P0-P2 不改变实时 query/Hook。

这是一套可审计的 meta-memory 近似实现：它不会直接训练 MetaMem 模型，但会记录哪类 query
使用了哪条知识、结果是否有用，以及哪些流程经过多次验证。任何外部 memory backend 的
reflect/self-evolve 输出也只能进入 observation/proposal，不能直接修改 active Markdown。

## 已消费日志清理

Maintenance 成功后可运行：

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

- 默认 dry-run，列出待删除 Subagent daily logs 和 feedback 事件数。
- 有待抽取 SubagentStop 时 `--apply` 拒绝执行。
- 有未匹配 SubagentStart 时 `--apply` 拒绝执行，避免删除仍在运行的原始调试日志。
- Feedback 先固化到 `.memory/feedback/ledger.json`，再从 `.memory/logs` 删除对应 feedback 行。
- 同一 `memoryId + queryRunId` 的最新值继续保留在 ledger，后续晚到 feedback 可覆盖。
- Query、catalog、Hook 日志继续保留，支持 alias 建议和诊断。
- Observations、proposals、active knowledge、pair state 和 feedback ledger 永不由 cleanup 删除。

### 第一步：接受到审阅 inbox

```bash
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance accept <proposal-id>
```

默认写入：

```text
knowledge/_inbox-skills/<proposal-id>/SKILL.md
```

此时只是草稿，没有安装到 Agent 的 Skill 搜索路径。用户可从命令输出的 `skillPath` 或 proposal 的 `skillPath` 知道新增位置。

### 第二步：人工审阅

检查：

- frontmatter `name` / `description` 是否清晰，触发范围是否过宽。
- 流程是否真的跨任务复用，而不是某次会话细节。
- 命令是否安全、是否包含一次性路径或凭据。
- 是否与现有项目/用户 Skill 重复或冲突。
- 是否需要使用 `skill-creator` 进一步完善。

### 第三步：显式安装

项目级：

```bash
agent-knowledge maintenance install-skill <proposal-id> \
  --skill-target project \
  --project-root /path/to/project
```

用户级：

```bash
agent-knowledge maintenance install-skill <proposal-id> \
  --skill-target user
```

只有 `accepted` 的 Skill proposal 能安装；已有 `SKILL.md` 永不覆盖。也保留高级的一步式 `maintenance accept --skill-target project|user`，但推荐先进入 inbox 审阅，再使用 `install-skill`。

Skill 安装后不会自动修改 integration 目标中的其他第三方 Skill。需要把项目内 Skill 分发到其他产品时，重新审视 integration 模板和安装范围。

## 客服、无用信息与知识投毒

机器人部署建议：

- 使用独立 workspace/config，不与个人 owner 知识直接混写。
- `actorType=customer`
- `captureMode=automated_session`
- visibility 为 `project,team`
- sensitivity 为 `internal`
- 按租户/业务划分 root 或 project key，避免跨客户召回。

防护层：

1. **来源降权**：客户陈述强制按 `model_inferred` observation 处理，不能伪装为 `user_confirmed`。
2. **硬隔离**：自动/客户内容只进入 logs、proposal 和 `_inbox`，不进入 active 索引。
3. **独立佐证**：同一 actor/session 重复不算多个证据；Skill 要求至少 3 个独立 session。
4. **受信验证**：业务事实需要 owner、正式文档或实际验证支持。
5. **显式晋升**：只有列出具体知识 ID 的 `--approve` 才能激活不可信来源候选。
6. **检索隔离**：visibility、sensitivity、project key、validity 在直接、图关系扩展和显式 knowledge/evidence 展开中都重新检查。
7. **Secret 扫描**：常见 token/API key/私钥格式在 candidate 写入前拒绝。
8. **同步边界**：只同步正式 Markdown，不同步日志、observations、proposals 或 inbox。

对高流量机器人，不要以“对话次数”作为事实正确性的替代。建议定期抽样查看 rejected/accepted proposal、无用反馈和图谱中的冲突/来源节点。

## 推荐周期

个人电脑每周或按需：

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge list
agent-knowledge organize-inbox
```

客服机器人持续运行：

```bash
agent-knowledge maintenance watch --interval-minutes 30
```

但 proposal 审阅、知识 `--approve` 和 Skill `install-skill` 始终人工执行。接受并激活知识后，`organize-inbox --apply` 会重建 lexical 索引；若使用 embedding 或 graph，还需运行：

```bash
agent-knowledge embed-index
agent-knowledge graph build
```

受信 replacement 通过 `supersedes` 激活时，会把旧知识标为 deprecated 并设置 `valid_until`。
