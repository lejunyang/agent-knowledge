# TRAE 模板

本目录存放对外安装模板，不直接命名为 `.trae`。真正使用时，把文件链接或复制到目标项目或用户级配置目录。

## 安装位置

项目级安装：

```text
templates/trae/agents/memory-reader.md -> <project>/.trae/agents/memory-reader.md
templates/trae/agents/memory-writer.md -> <project>/.trae/agents/memory-writer.md
templates/trae/hooks.json -> <project>/.trae/hooks.json
```

用户级安装推荐使用命令创建符号链接：

```bash
agent-knowledge link-trae-templates
```

等价目标位置：

```text
templates/trae/agents/memory-reader.md -> ~/.trae-cn/agents/memory-reader.md
templates/trae/agents/memory-writer.md -> ~/.trae-cn/agents/memory-writer.md
templates/trae/hooks.json -> ~/.trae-cn/hooks.json
.trae/skills/knowledge-organizer -> ~/.trae-cn/skills/knowledge-organizer
```

如果目标已存在，命令会拒绝覆盖；确认替换时使用 `agent-knowledge link-trae-templates --force`。

## hooks.json 能力

`hooks.json` 遵循 TRAE Hook `version: 1` 配置格式，包含：

- `SessionStart`：执行 `agent-knowledge hook session-start`，初始化 `AGENT_KNOWLEDGE_ROOT`，并向当前会话补充知识库路径说明。
- `UserPromptSubmit`：执行 `agent-knowledge hook user-prompt-submit`，在主 Agent 处理用户请求前注入 catalog 简表和 context packet。

`UserPromptSubmit` 注入的 catalog 简表包含：

- 当前知识总数。
- status/type 分布。
- 可用 domains。
- 可用 scenarios。
- 可用 aliases。
- 前 20 条知识的 ID、标题、类型、状态、别名、domain 和 scenarios。

## memory-reader 能力

`memory-reader.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-reader`
- `description`

该 Subagent 用于按需检索 Agent Knowledge。主 Agent 在 hook 注入不足、任务中途需要历史约定、需要 `query --debug`、需要 hybrid 查询或需要记录反馈时调用它。

## memory-writer 能力

`memory-writer.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-writer`
- `description`
- `tools: ""`

该 Subagent 只输出候选 JSON，不调用工具，不写文件。候选 JSON 支持 `aliases`，用于把用户自然说法、简称、旧称和中英文同义表达写入知识元数据。

## embedding / aliases 辅助命令

模板 hook 不默认运行 embedding，避免会话启动时加载本地模型。需要维护别名时，由主 Agent 或人工在任务外显式运行：

```bash
agent-knowledge embed-index --provider local
agent-knowledge suggest-aliases --provider local
```

生产环境可把 `embed-index` 切到 `--provider transformers --model <local-model-path>`；Transformers.js provider 默认禁止远程模型下载，只有人工确认后才使用 `--allow-remote-models`。

如果目标项目已经构建 embedding 缓存，可以在主 Agent 的显式查询流程中使用：

```bash
agent-knowledge query --retrieval hybrid --provider transformers --model <local-model-path> --debug
```

Hook 模板仍保持轻量，不默认执行 hybrid 查询。

## 维护规则

当 CLI、Hook 流程、Subagent 输入输出、schema、query debug、feedback 或 catalog 能力发生变化时，必须 review 本目录：

- 若 `agent-knowledge hook ...` 的行为改变，更新 `hooks.json` 或本说明。
- 若 `CandidateMemoryInput` 字段改变，更新 `agents/memory-writer.md` 的示例。
- 若新增对外安装步骤，更新本说明。
- 若 embedding、alias 建议或 query debug 输出变化，更新本说明和主 README。
- 若 TRAE 官方 Hook/Subagent 格式有变化，按官方文档同步模板。
