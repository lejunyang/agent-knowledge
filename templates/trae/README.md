# TRAE 模板

本目录存放 TRAE 产品 adapter 的源模板和可选 plugin bundle。安装统一由 integration installer 管理。

## 安装

直接运行会进入 Inquirer 向导；上下键移动，空格切换组件，回车确认：

```bash
agent-knowledge integration install
```

用户级：

```bash
agent-knowledge integration install \
  --product trae \
  --scope user \
  --components hooks,agents,skills
```

项目级：

```bash
agent-knowledge integration install \
  --product trae \
  --scope project
```

可选生成 TRAE plugin bundle：

```bash
agent-knowledge integration install \
  --product trae \
  --scope user \
  --components plugin-bundle
```

安装器不使用 symlink：

- Hooks JSON 先 parse，再删除/替换 command 中匹配 `agent-knowledge(.cmd) hook` 的自有 handler。
- 保留其他 hook group、handler 和顶层字段。
- Agent/Skill/plugin 只管理 integration manifest 记录的路径。
- 同名但未被管理的资源报告 conflict，不覆盖。
- `integration uninstall` 只移除自有且未被用户改写的资源。
- `trae` 同时管理 `.trae/hooks.json` 和 `.trae/cli/hooks.json`。
- `trae-cn` 使用 `.trae-cn/hooks.json`，可通过 `--product trae-cn` 选择。
- 显式选择 `overwrite` 时会删除目标文件、目录或 symlink 后写入模板；不会删除 symlink 指向的外部源文件。

## hooks.json 能力

`hooks.json` 遵循 TRAE Hook `version: 1` 配置格式，包含：

- `SessionStart`：初始化 `AGENT_KNOWLEDGE_ROOT`，并向当前会话补充知识库路径说明。
- `UserPromptSubmit`：高相关命中时注入 token-budgeted context packet；无命中或低分时完全静默。
- `SubagentStart` / `SubagentStop`：异步记录本地详细 Subagent payload、配对和持续时间，同时保留 staging 信号。
- `Stop` / `SessionEnd`：异步记录回合/会话结束信号。

只有用户明确询问“有哪些知识/记忆/SOP/目录”时，`UserPromptSubmit` 才返回最多 `hooks.catalogMaxItems` 条与 prompt 相关的知识菜单。普通 prompt 不注入 catalog、aliases registry、runtime context 或“没有命中”的提示。

Subagent 详细日志写入 `.memory/subagents/`，保留原始 payload、Start/Stop 配对和持续时间；它不参与同步或模型上下文。`hooks.detailedSubagentLogging=false` 可关闭详细写入。其他 staging hook 不返回 block、allow 或 continuation，只记录脱敏摘要。

安装命令会按平台选择 hook 模板：

- macOS/Linux：使用 `bash -lc 'agent-knowledge hook ...'`，让 TRAE hook 的非交互执行环境加载用户 shell 配置，从而找到 nvm/npm 全局安装的 `agent-knowledge`。
- Windows：使用 `agent-knowledge.cmd hook ...`，调用 npm 在 Windows 上生成的 `.cmd` shim，不依赖 Bash，也不把 Node 绝对路径写死到模板里。

Hook 输出会包含 runtime context：

- `cwd`：TRAE 触发 hook 时命令实际运行目录。
- `isGit`：该目录是否位于 Git 工作树。
- `gitRoot`：可探测到时输出 Git 根目录。
- `gitOrigin`：可探测到时输出 `remote.origin.url`。
- `project ID`：Git remote 或 canonical Git root 生成的稳定 ID。

如果需要确认 TRAE 当前环境到底把 hook 放在哪个目录执行，可以运行：

```bash
agent-knowledge hook doctor
agent-knowledge project detect
agent-knowledge staging status
```

`UserPromptSubmit` 未命中或低于相关性阈值时完全静默，不输出 Hook stdout。可靠命中时只注入 `context_packet`；只有用户明确要求查看知识目录时，才返回最多 5 条与 prompt 相关的菜单项。

## memory-reader 能力

`memory-reader.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-reader`
- `description`

该 Subagent 用于按需检索 Agent Knowledge。主 Agent 在任务可能依赖项目约定、历史决策、业务术语或 SOP 时应主动调用，而不只是在用户显式问“记忆”时调用。

推荐升级路径：

1. 默认 lexical。
2. 同义/跨语言查询使用 hybrid。
3. 依赖流程和多跳关系使用 graph。
4. 复杂人工诊断使用 hybrid-graph；需要时再加 reranker。

Hook 自动路径不加载 embedding 或 reranker。

## memory-writer 能力

`memory-writer.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-writer`
- `description`
- `tools: ""`

该 Subagent 只输出候选 JSON，不调用工具，不写文件。候选 JSON 支持：

- `aliases`
- `capture_mode`
- `actor_type`
- `corroboration_count`
- `project_ids`
- `visibility`
- `sensitivity`
- `episodes`
- `related_knowledge`
- `supersedes`
- `conflicts_with`

外部客户和 automatic session 只能生成 proposed observation，不能直接成为 active 事实。

Writer 应主动处理显式记忆、已验证可复用结果和 `AGENTS.md` 未覆盖的稳定项目/业务约束；不应记录一次性命令、普通源码结构或未验证推断。

`knowledge/_inbox-skills` 中的 `SKILL.md` 使用 Skill frontmatter，不是 KnowledgeDocument；不会进入 index、embedding、catalog、graph 或同步。

## memory-maintainer

`.trae/skills/memory-maintainer` 用于：

1. 检查 Subagent 详细日志与 maintenance watermark。
2. 运行 `maintenance run` 自动生成 proposal。
3. 逐条 `list/show/accept/reject`。
4. 将知识 proposal 写入 `_inbox` 后，通过明确知识 ID 人工批准。
5. 将 Skill proposal 先写 `_inbox-skills`，审阅后再 `maintenance install-skill`。

普通用户不需要手写 `observations.json` 或先 drain staging；`--input` 只用于外部 observation 导入。

Skill proposal 的 positive feedback 来自 `.memory/logs`：同一 `memoryId + queryRunId` 只采用最新一条，净正反馈数量必须至少覆盖独立 session 数。Feedback 晚于 observation 到达时，后续 maintenance 会重新评估已消费 observation；不会要求重置 watermark。

自动/客户候选只能在人工检查后运行：

```bash
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

不得自动执行批准。

## embedding / aliases 辅助命令

模板 hook 不默认运行 embedding，避免会话启动时加载本地模型。需要维护别名时，由主 Agent 或人工在任务外显式运行：

```bash
agent-knowledge embed-index --provider local
agent-knowledge suggest-aliases --provider local
```

生产环境默认 profile 是 multilingual E5 small q8；也可选 `--profile bge-small-zh-v1.5`。Transformers.js provider 默认禁止远程模型下载，只有人工确认后才使用 `--allow-remote-models`。

如果目标项目已经构建 embedding 缓存，可以在主 Agent 的显式查询流程中使用：

```bash
agent-knowledge query --retrieval hybrid --provider transformers --debug
```

如果需要显式知识关系：

```bash
agent-knowledge graph build
agent-knowledge query --retrieval graph --graph-depth 1 --debug
```

`hybrid-graph` 适合复杂人工查询。Hook 模板保持轻量，不默认执行 hybrid、graph、reranker 或模型抽取。

## 维护规则

当任何流程、行为或推荐方式发生变化时，必须审视整条 Agent 接入链，而不是只改实现：

- 若 `agent-knowledge hook ...` 的行为改变，更新 `hooks.json` 或本说明。
- 若 `CandidateMemoryInput` 字段改变，更新 `agents/memory-writer.md` 的示例。
- 若新增对外安装步骤，更新本说明。
- 若 embedding、alias 建议或 query debug 输出变化，更新本说明和主 README。
- 若检索模式、graph、feedback 或注入边界变化，更新 memory-reader。
- 若 staging、Subagent 日志、proposal、inbox 审核或 Skill 生命周期变化，更新 memory-writer 和 memory-maintainer。
- 同步审视 `templates/claude-code/agents/*.md`。
- 同步审视项目 `.trae/skills/*/SKILL.md`。
- 同步审视 `templates/trae/plugin/agents/*.md` 与 `templates/trae/plugin/skills/*/SKILL.md`。
- 同步审视主 README 的推荐流程和 `docs/guides/*`。
- 若 TRAE 官方 Hook/Subagent 格式有变化，按官方文档同步模板。

如果审视后 Hook JSON 无需变化，应保持原文件不动，但在实现/提交说明中明确已检查，避免无意义 churn。
