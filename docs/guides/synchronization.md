# WebDAV、S3 与定时同步

同步只处理正式 Markdown，不上传 `_inbox`、`_archive`、索引、embedding、日志、staging 或凭据。

先运行：

```bash
agent-knowledge configure
```

配置 WebDAV/S3、凭据环境变量名、同步 visibility/sensitivity 和 interval。

## 单次同步

```bash
agent-knowledge sync run
```

## 定时同步

```bash
agent-knowledge sync watch
agent-knowledge sync watch --interval-minutes 15
```

`sync watch` 会立即同步一次，然后按间隔重复。单次失败会记录错误并在下一周期重试；SIGINT/SIGTERM 会优雅停止。

它是前台长进程，不会自动写 cron、launchd 或 systemd。需要后台运行时，请显式交给系统进程管理器。

## 冲突

同步使用 local/base/remote 三方比较和 tombstone。双端同时修改同一文件时写入：

```text
.memory/sync/conflicts/*.json
```

冲突不会自动采用“最后写入获胜”。
