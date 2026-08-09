# Codex 模板

本目录是 Codex 产品 adapter 的安装源。它支持两种互斥方式：

1. Standalone：结构化合并 `.codex/hooks.json`，并把 canonical Skills 安装到 `.agents/skills`。
2. Plugin：生成本地 marketplace，再由用户通过 `codex plugin` 显式注册和安装。

## Standalone

用户级：

```bash
agent-knowledge integration install \
  --product codex \
  --scope user
```

项目级：

```bash
agent-knowledge integration install \
  --product codex \
  --scope project
```

默认组件是 `hooks,skills`。Codex 不加载本项目的 standalone Markdown Subagent，因此
`--components agents` 会在写文件前失败。

默认路径：

| 范围 | Hooks/manifest | Skills |
| --- | --- | --- |
| user | `~/.codex` | `~/.agents/skills` |
| project | `<repo>/.codex` | `<repo>/.agents/skills` |

Hook 模板只配置当前使用的 Codex 事件：

- `SessionStart`
- `UserPromptSubmit`
- `SubagentStop`
- `Stop`

Codex 没有本模板使用的 `SubagentStart` 和 `SessionEnd`，所以不要根据目录对称复制 TRAE
Hook。macOS/Linux 使用 `bash -lc`，Windows 使用 npm `.cmd` shim。

## Plugin Marketplace

生成 marketplace：

```bash
agent-knowledge integration install \
  --product codex \
  --scope user \
  --components plugin-bundle
```

注册并安装：

```bash
codex plugin marketplace add ~/.codex/agent-knowledge-marketplace
codex plugin add agent-knowledge@agent-knowledge-local
codex plugin list
```

项目级时把路径换成：

```text
<repo>/.codex/agent-knowledge-marketplace
```

Plugin bundle 包含 Hooks 和五个 Skills。不要同时启用 standalone `hooks,skills`，否则相同
Hook 可能重复执行。

移除：

```bash
codex plugin remove agent-knowledge@agent-knowledge-local
codex plugin marketplace remove agent-knowledge-local
agent-knowledge integration uninstall --product codex --scope user
```

Codex 可能要求信任新 Hook hash。不得把 `--dangerously-bypass-hook-trust` 写成默认教程步骤。

## Canonical Skills

Canonical 内容位于 `.trae/skills`：

- `agent-knowledge-guide`
- `knowledge-automation-operator`
- `knowledge-organizer`
- `source-distiller`
- `lifecycle-recorder`
- `memory-maintainer`
- `memory-use-policy-maintainer`

后台来源巡检使用 `knowledge-automation-operator`，确定性 CLI 仍负责 allowlist、限流、重试和
notification outbox。Hindsight/memU/Mem0 使用 `agent-knowledge sidecar setup` 生成接入包，
再用 `compare/history` 做 shadow A/B；外部 backend 不替代 Git Markdown 事实源。
Retrieval Lesson / Reasoning Policy 使用 `memory-use-policy-maintainer`，P0-P2 仅 shadow，
不会改变普通 query/Hook。

Codex plugin 内 Skill 必须逐文件与 canonical 目录一致，包括 references 和 `agents/openai.yaml`。
修改 Skill 后运行 `tests/templates.test.ts`，不要只复制 `SKILL.md`。

## 验证

```bash
pnpm exec vitest run tests/templates.test.ts tests/integrationCli.test.ts
pnpm typecheck
```

真实 plugin 冒烟必须使用隔离 `CODEX_HOME`，执行：

```bash
codex plugin marketplace add <temporary-marketplace>
codex plugin add agent-knowledge@agent-knowledge-local
codex plugin list
```

不得在测试中修改用户真实 `~/.codex/config.toml`。
