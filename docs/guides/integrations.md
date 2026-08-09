# Agent 产品接入

```bash
agent-knowledge integration list
agent-knowledge integration install
```

不传参数时会交互式选择产品、scope、组件、目标位置和写入模式。上下键移动，空格切换多选项，回车确认。

## 产品

| 产品 | 用途 | 默认位置 | Hook 目标 |
| --- | --- | --- | --- |
| `trae` | TRAE 国际版/通用目录 | `.trae` / `~/.trae` | `.trae/hooks.json` 和 `.trae/cli/hooks.json` |
| `trae-cn` | TRAE 中国区目录 | `.trae-cn` / `~/.trae-cn` | `.trae-cn/hooks.json` |
| `claude-code` | Claude Code agent/settings | `.claude` / `~/.claude` | `.claude/settings.json` |
| `codex` | Codex Hooks、Skills 或本地 plugin marketplace | `.codex` + `.agents` / `~/.codex` + `~/.agents` | `.codex/hooks.json` |

`trae` 必须同时管理 `.trae/hooks.json` 和 `.trae/cli/hooks.json`，因为 IDE 和 CLI 可能从不同位置加载 Hook。两处都使用结构化 merge，不会把第三方 handler 当成 Agent Knowledge 资源删除。

Codex 使用两个标准资源根：

- Hooks 和 integration manifest：用户级 `~/.codex`，项目级 `<repo>/.codex`。
- Standalone Skills：用户级 `~/.agents/skills`，项目级 `<repo>/.agents/skills`。

Codex 当前不使用本项目的独立 Markdown Subagent 模板，因此不支持 `agents` 组件。Reader、
writer、source distillation、maintenance、memory-use Policy 和 lifecycle 行为由可发现 Skill
加 CLI 命令完成。
不要为了目录对称把 TRAE/Claude agent 文件复制到 Codex。

## 安装范围

- `user`：写到用户配置目录，多个项目共享。适合个人电脑上的通用 reader/writer/Hook。
- `project`：写到当前项目目录，只影响该仓库。适合需要项目专属模板或不希望修改用户环境的场景。

`--target-dir` 会覆盖产品标准配置根目录。只有自定义沙箱、测试目录或宿主产品使用非标准路径时才需要设置。

## 组件

- `hooks`：安装生命周期 Hook。负责静默相关知识注入、Subagent 日志和 staging 信号。
- `agents`：安装 `agent-knowledge-reader` / `agent-knowledge-writer` Subagent 模板。
- `skills`：安装 `agent-knowledge-guide`、`knowledge-organizer`、`source-distiller`、
  `lifecycle-recorder`、`memory-maintainer`、`knowledge-automation-operator` 和
  `memory-use-policy-maintainer`。
- `plugin-bundle`：TRAE 安装 plugin 目录；Codex 安装可由 `codex plugin marketplace add` 注册的本地 marketplace。它是散装资源的替代分发方式，不应在同一宿主中重复启用。

只选择实际需要的组件。例如只希望 Agent 能按需读写、不希望自动 Hook 运行时，可选择 `agents,skills` 而不选 `hooks`。

Codex 默认组件是 `hooks,skills`。只传产品即可使用安全默认：

```bash
agent-knowledge integration install --product codex --scope user
```

显式选择 `--components agents` 会在任何写入前失败。

### Codex plugin marketplace

如果希望使用 Codex 原生 plugin 分发，而不是散装 Hooks/Skills：

```bash
agent-knowledge integration install \
  --product codex \
  --scope user \
  --components plugin-bundle

codex plugin marketplace add ~/.codex/agent-knowledge-marketplace
codex plugin add agent-knowledge@agent-knowledge-local
```

项目级 marketplace 位于：

```text
<repo>/.codex/agent-knowledge-marketplace
```

安装 plugin 后，Codex 从 plugin cache 加载同一组 Hooks 和 Skills。不要再同时启用散装
`hooks,skills`，否则相同 Hook 可能重复执行。`integration uninstall` 只删除 Agent Knowledge
生成的 marketplace 目录；已经由 Codex 安装到 cache/config 的 plugin 还需显式移除：

```bash
codex plugin remove agent-knowledge@agent-knowledge-local
codex plugin marketplace remove agent-knowledge-local
```

Codex 首次加载新增/变化的 Hook 时可能要求信任对应 hash。这是宿主安全边界；不要使用
`--dangerously-bypass-hook-trust` 作为日常安装步骤。

从旧版本升级时，安装器会迁移上一版 manifest 管理的 `memory-reader.md` 和 `memory-writer.md`：

- 内容未被修改：安装新名称后删除旧文件。
- 用户已经修改：保留旧文件并报告 conflict，避免升级吞掉定制内容。
- 非本工具管理的同名旧文件：不删除。

历史 `.memory/subagents` 日志保留旧 agent type 作为审计事实，不做重写。

## Hook 上下文策略

`UserPromptSubmit` 默认保持静默：

- 无命中或低于相关性阈值时不输出 stdout，也不污染 Agent 上下文。
- 可靠命中时只注入受 token budget 限制的 Context Packet 2.0 synopsis；完整 knowledge/evidence 必须显式展开。
- 只有明确询问“有哪些知识/记忆/SOP/目录”时，才返回最多 5 条与 prompt 相关的知识菜单。
- 普通任务不会注入 runtime context、全量 catalog、aliases registry 或“没有命中”的提示。

TRAE/Claude Code 的 `SubagentStart` / `SubagentStop` 使用专用详细日志：

```text
.memory/subagents/YYYY-MM-DD.jsonl
```

日志保留本地原始 Hook payload、Start/Stop 配对和持续时间，便于改进 Subagent；不参与同步，不注入上下文。可运行：

```bash
agent-knowledge subagents status
agent-knowledge subagents logs --agent-type agent-knowledge-writer
```

`hooks.detailedSubagentLogging=false` 可关闭原始 payload 写入，但 staging 信号仍按 Hook 模板运行。当前建议保持开启，等 Subagent 触发和输出稳定后再评估是否移除 `SubagentStart` / `SubagentStop` Hook。

Codex 当前模板只配置宿主实际支持且本项目需要的：

- `SessionStart`
- `UserPromptSubmit`
- `SubagentStop`
- `Stop`

Codex 没有对应的 `SubagentStart` / `SessionEnd` 模板项，因此 detailed pair status 可能只有 stop
记录，不能伪装成完整 Start/Stop 配对。Maintenance 仍可消费可用的 `SubagentStop`；如果宿主
事件契约后续增加，再同步升级模板和测试。

## 写入模式

- `merge`：默认。只替换 Agent Knowledge 自有 Hook，保留其他配置；未托管的同名 Agent/Skill 报冲突。
- `overwrite`：显式选择后，删除目标文件、目录或 symlink，再写入模板。不会删除 symlink 指向的外部源文件。

安装器不创建 symlink。`merge` 的所有权边界是：

- Hook handler command 匹配 `agent-knowledge(.cmd) hook ...`，才视为 Agent Knowledge 自有。
- Agent、Skill 和 plugin 路径只有记录在 integration manifest 中才由卸载器管理。
- 同名但不受管理的文件不会合并 Markdown 内容，而是报告 conflict。
- `integration uninstall` 只删除自有且未被用户改写的资源。

`overwrite` 是恢复已知模板状态或处理明确冲突的逃生口，不应作为默认安装方式。

```bash
agent-knowledge integration install --overwrite
agent-knowledge --json integration install ...
```

默认输出人类可读摘要；`--json` 或 `--debug` 输出完整 JSON。

## 安装后检查

```bash
agent-knowledge integration doctor --product trae --scope user
agent-knowledge integration doctor --product codex --scope user
agent-knowledge hook doctor
agent-knowledge project detect
agent-knowledge subagents status
```

- `integration doctor`：检查 manifest、目标文件和已安装组件。
- `hook doctor`：查看 Hook 实际 cwd、Git root 和 origin。
- `project detect`：确认当前 Git 项目映射到哪个规范 project key；无 remote 时使用 `--project-key local/...`。
- `subagents status`：确认 Start/Stop 是否被宿主实际调用和配对。
- Codex plugin 模式还应运行 `codex plugin list`，确认状态为 `installed, enabled`。

卸载：

```bash
agent-knowledge integration uninstall --product trae --scope user
agent-knowledge integration uninstall --product codex --scope user
```

卸载不会删除知识库、`.memory`、第三方 Hook、未托管 Agent/Skill 或 symlink 指向的外部源。

## 与流程变更联动

当查询、候选字段、Hook 输出、maintenance、图检索或推荐工作流变化时，应同时检查：

- TRAE/Claude/Codex Hook 模板是否还调用正确命令和受支持事件。
- `agent-knowledge-reader` 是否知道新的检索模式和反馈字段。
- `memory-use-policy-maintainer` 是否仍使用真实 policy mine/proposal/simulate/history 流程。
- `agent-knowledge-writer` 是否包含新的 candidate/provenance 字段。
- 项目 Skill、TRAE plugin Skill 与 Codex plugin Skill 是否仍逐文件一致并描述真实流程。
- 本文、主 README 和配置指南是否需要同步更新。

模板维护细节见 `templates/trae/README.md` 和 `templates/codex/README.md`。
