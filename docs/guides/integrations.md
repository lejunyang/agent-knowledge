# Agent 产品接入

```bash
agent-knowledge integration list
agent-knowledge integration install
```

不传参数时会交互式选择产品、scope、组件、目标位置和写入模式。上下键移动，空格切换多选项，回车确认。

## 产品

| 产品 | 默认位置 | Hook 目标 |
| --- | --- | --- |
| `trae` | `.trae` / `~/.trae` | `.trae/hooks.json` 和 `.trae/cli/hooks.json` |
| `trae-cn` | `.trae-cn` / `~/.trae-cn` | `.trae-cn/hooks.json` |
| `claude-code` | `.claude` / `~/.claude` | `.claude/settings.json` |

## 写入模式

- `merge`：默认。只替换 Agent Knowledge 自有 Hook，保留其他配置；未托管的同名 Agent/Skill 报冲突。
- `overwrite`：显式选择后，删除目标文件、目录或 symlink，再写入模板。不会删除 symlink 指向的外部源文件。

```bash
agent-knowledge integration install --overwrite
agent-knowledge --json integration install ...
```

默认输出人类可读摘要；`--json` 或 `--debug` 输出完整 JSON。

```bash
agent-knowledge integration doctor --product trae --scope user
agent-knowledge integration uninstall --product trae --scope user
```
