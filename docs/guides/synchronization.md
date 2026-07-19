# WebDAV、S3 与定时同步

同步只处理正式 Markdown，不上传 `_inbox`、`_archive`、索引、embedding、日志、staging 或凭据。

先运行：

```bash
agent-knowledge configure
```

配置 WebDAV/S3、凭据环境变量名、同步 visibility/sensitivity 和 interval。

## 提供方选择

### none

不启用远端同步。`sync run/watch` 会因为没有可用 backend 而失败；适合只在单机使用。

### WebDAV

适合个人 NAS、坚果云或其他支持 WebDAV collection 的存储：

- `url`：知识集合根 URL。
- `username`：WebDAV 用户名，可为空。
- `passwordEnv`：保存密码的环境变量名，默认 `WEBDAV_PASSWORD`。

配置文件只保存 `passwordEnv`，运行 `sync` 前必须在进程环境中设置真实密码。

### S3

适合 AWS S3、MinIO 或其他 S3-compatible object storage：

- `bucket`：目标 bucket。
- `region`：签名 region，默认 `us-east-1`。
- `prefix`：对象 key 前缀；建议不同知识库或租户使用不同 prefix。
- `endpoint`：兼容服务 URL；`null` 表示 AWS。
- `forcePathStyle`：MinIO 等不支持 virtual-hosted-style 时启用。
- `accessKeyIdEnv` / `secretAccessKeyEnv` / `sessionTokenEnv`：保存凭据的环境变量名。

不要把 access key、secret key 或 WebDAV 密码直接写入配置或 Markdown。

## 同步过滤

- `visibilityScopes`：只同步 frontmatter visibility 位于该集合的知识。默认 `project,team`，不上传 `private`。
- `sensitivityClearance`：允许同步的最高敏感级别。默认 `internal`，不会上传 `confidential` / `secret`。
- `_inbox`、`_archive`、`.memory`、proposals、Skill 草稿和凭据始终排除，即使 visibility/sensitivity 匹配。

这是上传边界，不改变本地 query 的权限配置。

## 单次同步

```bash
agent-knowledge sync run
```

`sync run` 使用用户配置执行一次三方同步，默认输出 push/pull/conflict 的人类可读摘要；使用 `--json` 查看完整结果。

也保留显式 `sync webdav` / `sync s3` 子命令用于一次性调试，但常规流程推荐把参数保存在用户配置。

## 定时同步

```bash
agent-knowledge sync watch
agent-knowledge sync watch --interval-minutes 15
```

`sync.intervalMinutes` 默认 `0`，表示未配置定时周期。运行 `sync watch` 时应设置正数，或用 `--interval-minutes` 覆盖。

`sync watch` 会立即同步一次，然后按间隔重复。单次失败会记录错误并在下一周期重试；SIGINT/SIGTERM 会优雅停止。

它是前台长进程，不会自动写 cron、launchd 或 systemd。需要后台运行时，请显式交给系统进程管理器。

个人电脑通常不需要常驻：在开始/结束工作时手工 `sync run` 即可。机器人或多设备高频写入才适合托管 `sync watch`。

## 冲突

同步使用 local/base/remote 三方比较和 tombstone。双端同时修改同一文件时写入：

```text
.memory/sync/conflicts/*.json
```

冲突不会自动采用“最后写入获胜”。

- local 与 remote 只有一端变化：安全采用变化端。
- 一端删除、另一端未变：传播 tombstone。
- 两端同时修改或删除/修改冲突：写 conflict artifact，保留两端证据，等待人工处理。

处理冲突时应先决定哪份内容成为 Markdown 事实源，再重建 index、embedding 和 graph。不要编辑 `.memory/sync` 把它当作正式知识。

## 多设备和客服机器人建议

- 个人电脑与机器人不要默认共用同一个无隔离 root/prefix；至少按租户、业务或环境设置不同 project ID/prefix。
- 只把已经人工审阅的正式知识同步给机器人。日志、客户原始对话、proposal 和 inbox 不应通过同步传播。
- 机器人使用 `actorType=customer` / `captureMode=automated_session` 生成本地 proposal；人工确认后再把 active Markdown 同步到共享端。
- 多台机器同时运行 `sync watch` 时保持合理间隔，并定期检查 `.memory/sync/conflicts`。
