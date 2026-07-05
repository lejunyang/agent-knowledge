# TRAE 模板

本目录存放对外安装模板，不直接命名为 `.trae`。真正使用时，把文件复制到目标项目或用户级配置目录。

## 安装位置

项目级安装：

```text
templates/trae/agents/memory-writer.md -> <project>/.trae/agents/memory-writer.md
templates/trae/hooks.json -> <project>/.trae/hooks.json
```

用户级安装：

```text
templates/trae/agents/memory-writer.md -> ~/.trae-cn/agents/memory-writer.md
templates/trae/hooks.json -> ~/.trae-cn/hooks.json
```

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

## memory-writer 能力

`memory-writer.md` 遵循 TRAE Subagent Markdown + YAML frontmatter 格式，包含：

- `name: memory-writer`
- `description`
- `tools: ""`

该 Subagent 只输出候选 JSON，不调用工具，不写文件。候选 JSON 支持 `aliases`，用于把用户自然说法、简称、旧称和中英文同义表达写入知识元数据。

## 维护规则

当 CLI、Hook 流程、Subagent 输入输出、schema、query debug、feedback 或 catalog 能力发生变化时，必须 review 本目录：

- 若 `agent-knowledge hook ...` 的行为改变，更新 `hooks.json` 或本说明。
- 若 `CandidateMemoryInput` 字段改变，更新 `agents/memory-writer.md` 的示例。
- 若新增对外安装步骤，更新本说明。
- 若 TRAE 官方 Hook/Subagent 格式有变化，按官方文档同步模板。
