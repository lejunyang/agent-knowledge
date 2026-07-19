# TRAE 模板

本目录存放 TRAE 产品 adapter 的源模板和可选 plugin bundle。安装统一由 integration installer 管理。

## 安装

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

## hooks.json 能力

`hooks.json` 遵循 TRAE Hook `version: 1` 配置格式，包含：

- `SessionStart`：初始化 `AGENT_KNOWLEDGE_ROOT`，并向当前会话补充知识库路径说明。
- `UserPromptSubmit`：在主 Agent 处理用户请求前注入 catalog 简表和 context packet。
- `SubagentStart` / `SubagentStop`：异步记录脱敏 Subagent staging。
- `Stop` / `SessionEnd`：异步记录回合/会话结束信号。

Staging hook 不返回 block、allow 或 continuation，不会强制模型继续。它只记录 hash、长度、agent type、reason 和 project ID，不保存完整 prompt、response、tool payload 或 transcript。

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

`UserPromptSubmit` 未命中知识时只注入粗粒度 catalog，包含：

- 当前知识总数。
- status/type 分布。
- 可用 domains。
- 可用 scenarios。

这能避免无关 prompt 被大量 aliases/items 污染；主 Agent 如果判断任务需要历史知识，可根据 domains/scenarios 再调用 `memory-reader` 精查。

命中知识并注入 context packet 时，catalog 简表会额外包含：

- 可用 aliases。
- 前 20 条知识的 ID、标题、类型、状态、别名、domain 和 scenarios。

## memory-reader 能力

`memory-reader.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-reader`
- `description`

该 Subagent 用于按需检索 Agent Knowledge。主 Agent 在任务可能依赖项目约定、历史决策、业务术语或 SOP 时应主动调用，而不只是在用户显式问“记忆”时调用。

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

外部客户和 automatic session 只能生成 proposed observation，不能直接成为 active 事实。

## memory-maintainer

`.trae/skills/memory-maintainer` 用于审阅 staging/log、结合已验证证据调用 `memory-writer`，并把支持充分的结果写入 `_inbox`。

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

Hook 模板保持轻量，不默认执行 hybrid 查询或模型抽取。

## 维护规则

当 CLI、Hook 流程、Subagent 输入输出、schema、query debug、feedback 或 catalog 能力发生变化时，必须 review 本目录：

- 若 `agent-knowledge hook ...` 的行为改变，更新 `hooks.json` 或本说明。
- 若 `CandidateMemoryInput` 字段改变，更新 `agents/memory-writer.md` 的示例。
- 若新增对外安装步骤，更新本说明。
- 若 embedding、alias 建议或 query debug 输出变化，更新本说明和主 README。
- 若 staging 事件或治理字段变化，更新 memory-reader、memory-writer 和 memory-maintainer。
- 若 TRAE 官方 Hook/Subagent 格式有变化，按官方文档同步模板。
