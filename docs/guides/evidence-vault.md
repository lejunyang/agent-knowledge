# Evidence Vault

Evidence Vault 用于保存完整文档、完整会话、工具轨迹和附件。它与 Git 知识仓库分离：

- `knowledge/`：可 review、可 diff 的 synopsis、knowledge、claim 和 source manifest。
- `.vault/`：AES-256-GCM 客户端加密的完整 evidence object。
- `.memory/`：可重建索引和运行状态。

`.vault/` 默认被知识数据仓库 `.gitignore` 排除，也不参与现有 WebDAV/S3 Markdown 同步或普通 query。

## 密钥

配置只保存环境变量名：

```json
{
  "vault": {
    "keyEnv": "AGENT_KNOWLEDGE_VAULT_KEY"
  }
}
```

环境变量值必须是 32 字节密钥，使用 64 位 hex 或 base64：

```bash
export AGENT_KNOWLEDGE_VAULT_KEY="<32-byte-key-as-hex-or-base64>"
```

不要把真实密钥写进配置、Markdown、Git、shell script 或日志。当前阶段不提供自动密钥生成、托管或轮换；生产使用应由 KMS、密码管理器或进程环境注入。

## 初始化与状态

```bash
agent-knowledge vault init --root ~/agent-knowledge-data
agent-knowledge vault status --root ~/agent-knowledge-data
```

`status` 只返回对象数、tombstone 数、加密字节数和 key ID，不输出对象 ID、路径或正文。

## 写入

`vault put` 是受控的底层写入命令，调用方必须自行完成 secret/PII 脱敏和 source manifest。
正式文档、会话和工具轨迹优先通过 Connector 摄入，不要绕过治理编排：

```bash
agent-knowledge ingest files \
  --root ~/agent-knowledge-data \
  --connector-id local-business-docs \
  --base-dir /secure/exports/business-docs \
  --pattern '**/*.md' \
  --project-key github.com/example/business

agent-knowledge ingest transcripts \
  --root ~/agent-knowledge-data \
  --connector-id trae-sessions \
  --base-dir /secure/exports/trae-sessions \
  --project-key github.com/example/business

agent-knowledge ingest git \
  --root ~/agent-knowledge-data \
  --connector-id business-repository \
  --repository /projects/business \
  --pathspec README.md docs

agent-knowledge ingest lark-export \
  --root ~/agent-knowledge-data \
  --connector-id lark-business \
  --export-dir /secure/exports/lark-business \
  --project-key github.com/example/business
```

当前 `files`/`transcripts` Connector 只读取显式 `base-dir` 下的 UTF-8 普通文件，不跟随
symbolic link。`transcripts` 默认 `**/*.jsonl` 并强制 `secrets-and-pii`；`files` 默认
`secrets-only`，处理含个人信息的文档时显式传 `--redaction secrets-and-pii`。

内置确定性规则覆盖私钥、常见 token/key、密码/cookie、邮箱、中国手机号和身份证号；它
不是完整 DLP，也无法可靠判断姓名、地址、业务 UID 或自由文本中的所有个人信息。包含领域
PII 的来源必须由专用 Connector 在 `normalize` 阶段额外清洗，并在
`processingProfile` 中版本化该规则。Vault 加密不能替代来源授权与最小化采集。

Git Connector 只读本地 object database 的 committed blob，不读取工作区草稿/untracked
文件，也不会联网更新仓库。commit SHA 记录仓库时间点，blob SHA 写入 `path_hash` 并优先
用于轻量比较：无关 commit 只更新 manifest metadata，不重新读取正文。

Lark export Connector 只读离线递归导出的 `manifest.json + content.xml`。每份 XML 必须命中
导出时记录的 SHA-256；临时资源句柄和 user cite 会先清洗，之后再执行统一
`secrets-and-pii`，不允许降级。若 manifest 有 pending/failures，成功文档仍可进入 Vault，
但 checkpoint inventory 标记 incomplete/unresolved，删除对账关闭。

推荐文件输入，避免完整内容进入 shell history：

```bash
agent-knowledge vault put \
  --root ~/agent-knowledge-data \
  --input complete-session.json \
  --content-type application/json \
  --actor owner
```

同一明文字节生成同一个 `vault_sha256_<hash>` 对象 ID；相同密钥下幂等去重。对象 envelope 保存：

- AES-256-GCM ciphertext、IV 和 auth tag。
- 明文 hash、content type、字节数、创建时间。
- 非敏感 key ID。

密文和访问日志文件权限为 0600；目录权限为 0700。

## 增量状态与版本

Connector 每次 source 尝试写入：

- `knowledge/source-manifests/<source-id>.json`：严格 `schema_version: 5` 的 Git 可跟踪身份、版本、availability、section heading/hash/range、处理状态、
  review receipt、`redaction_policy`、`processing_profile`、脱敏计数和 `vault_object`。
- `.memory/ingestion/connectors/<connector-hash>.json`：0600 本机 Connector 登记，保存可重跑的
  非凭据 scope；不进入 Git/WebDAV/S3。
- `.memory/ingestion/update-checks/<connector-hash>.json`：0600 最近一次 probe-only 检查报告；
  不保存正文，也不是版本事实源。
- `.memory/ingestion/jobs/<job-id>.json`：本次 completed/skipped/failed 审计；不保存正文。
- `.memory/ingestion/checkpoints/<connector-hash>.json`：成功或跳过后的增量水位。
- `.memory/ingestion/locks/<connector-hash>.lock`：同 Connector 互斥运行状态。

轻量 probe 优先比较 revision、commit SHA、ETag、opaque version 或更新时间。共同信号相同且
`processing_profile` 未变时跳过正文；无共同信号时必须重新抓取并比较 content hash。
处理规则版本变化会强制重抓，避免旧脱敏结果永久被当作“未更新”。

每次 `ingest` 会自动登记相同 Connector scope。之后可在不提供 Vault key 的情况下运行：

```bash
agent-knowledge source check
agent-knowledge source check --connector-id business-repository
agent-knowledge source check --fail-on-updates
agent-knowledge source refresh
agent-knowledge source refresh --connector-id business-repository
```

检查只调用 inventory/discover/probe，绝不调用 `fetch/normalize`，也不更新 manifest、Vault、
checkpoint 或 review receipt。报告明确 `networkAccess: none`：

- Git 只观察登记的本地 ref；先显式 `git fetch` 才能看到远端更新。
- 飞书只观察登记的 offline export；先显式刷新 export 才能看到在线文档更新。
- 本地文件只观察 filesystem mtime/size probe；变化标为 `update_unknown`，重新 ingest 后以
  脱敏 content hash 确认。

`path_hash` 变化可标 `content_changed`；只有 revision/ETag/mtime 等信号变化时标
`update_unknown`，不能在未抓取正文前宣称内容已改变。`metadata_only` 表示内容身份稳定但
commit/revision/time 有变化。摄入会刷新登记快照，使旧 update report 变 stale；重新检查后
才算 current，避免已经处理的变化继续告警。

日常推荐 `source refresh`。它先运行同一套 probe-only check，只在确定更新、待抓取确认或
显式 `--force` 时读取 Vault key 并执行 ingestion，随后再次 check。该命令复用登记中的完整
scope，因此不需要重复输入 base dir、glob、project key、pathspec 或 redaction policy。

当前版本保存在 source manifest，历史版本由 private Git 的 manifest 变更记录追踪。`.memory`
登记和更新报告只负责本机执行状态，不替代 Git 历史，也不应复制到共享远端。

旧 source manifest 不做字段补齐或原地迁移；与旧 KnowledgeDocument 一样，从原始 evidence
重新摄入生成 v5 manifest，避免缺少 Vault、availability、receipt 或 processing profile 的记录被误认为完整。v5 不保存任何 section 正文 preview。

失败 job 不推进 checkpoint，可安全重跑；metadata-only 更新保留已有 source 处理状态。
锁归活进程所有时拒绝并发，进程崩溃留下的死 PID 锁由下一次运行恢复。

完整 inventory 运行会把上次存在、本次缺失的 Git path 标记 missing/obsolete；原 Vault
证据仍保留用于历史审计，但 missing source 不再支撑 active claim。missing 先进入 pending，
由人工 mark obsolete/blocked；恢复同路径时重新抓取并回 pending。传 `--limit` 时不会做删除对账。

## Source evidence 审阅

`vault get` 是底层 object 命令。正常文档蒸馏优先使用 source identity 和 fingerprint：

```bash
agent-knowledge source show "$SOURCE_ID"
agent-knowledge source export "$SOURCE_ID" \
  --fingerprint "$EXPECTED_FINGERPRINT" \
  --output /secure/tmp/source-evidence
```

source export 复用 Vault 的 GCM/hash 校验和 0600 文件边界，不向 stdout 返回正文。missing source
只要历史 Vault object 仍存在，也允许显式 export 用于删除影响分析。输出路径必须位于
knowledge workspace 之外，处理完成后删除临时文件。

## 读取

CLI 不向 stdout 输出完整 evidence，只能写到显式文件：

```bash
agent-knowledge vault get vault_sha256_<hash> \
  --root ~/agent-knowledge-data \
  --output /secure/path/session.json
```

默认拒绝覆盖已有文件；显式 `--overwrite` 才允许替换。读取会验证 GCM auth tag、明文 hash、对象 ID 和字节数。

## 删除

```bash
agent-knowledge vault delete vault_sha256_<hash> \
  --root ~/agent-knowledge-data \
  --reason "retention expired"
```

删除会：

1. 物理移除密文对象。
2. 写入不含原始 reason 的 tombstone，只保留 reason hash。
3. 默认拒绝同一对象 ID 静默复活。

当前 tombstone 需要由 owner 明确清理或未来的合规恢复流程处理。

## 安全边界

- Vault 允许保存授权范围内的完整会话和工具轨迹，但写入前仍应执行 secret detector、PII 分类、tenant/project scope 和 retention policy。
- API key、token、cookie、私钥等凭据原值仍不应进入 Vault；只保存 redaction marker。
- `.vault/access-log` 只记录 timestamp、action、object ID、actor、bytes 和 dedupe 状态，不记录正文。
- source manifest 可以保存 `vault_object` handle，但 Git 中不能保存解密原文。
- 所有 source manifest 都不保存 section 正文 preview，只保存 heading/range/hash、脱敏计数和 Vault handle。
- Connector 会脱敏 external key/title，但 source ID 与 connector ID 仍应使用不含个人信息的稳定标识。
- 当前 WebDAV/S3 是 Markdown 镜像，不会上传 `.vault/`。远端加密 Vault backend 属于后续 Connector/Storage adapter 阶段。
