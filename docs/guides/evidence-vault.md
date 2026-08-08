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
- 当前 WebDAV/S3 是 Markdown 镜像，不会上传 `.vault/`。远端加密 Vault backend 属于后续 Connector/Storage adapter 阶段。
