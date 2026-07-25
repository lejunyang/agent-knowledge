# Context Infrastructure 调研与 Agent 模板演进设计

## 目标

本轮完成三件事：

1. 深度审计 `grapeot/context-infrastructure` 仓库和配套文章，判断哪些架构值得本项目参考。
2. 将对外 Subagent 模板从 `memory-reader` / `memory-writer` 重命名为 `agent-knowledge-reader` / `agent-knowledge-writer`。
3. 为 `knowledge-organizer` 增加垂直领域知识确认门禁，防止用户直接材料中的歧义或疑似错误内容被直接写入 active。

## Context Infrastructure 对比边界

调研必须区分：

- 文章的方法论主张。
- 仓库当前实际实现。
- 作者个人积累的 axioms/skills。
- 可复用的系统结构。

重点对比：

- 原始行为数据采集。
- L1 Observer、L2 Reflector、L3 Axiom/Skill 的蒸馏深度。
- Progressive Disclosure 与按需加载。
- 定时任务和闭环。
- 写入治理、冲突、时效、人工审核和安全隔离。
- 检索、评测、可观测性和可复现性。

## Subagent 重命名

### 新名称

- `agent-knowledge-reader`
- `agent-knowledge-writer`

文件名和 YAML frontmatter `name` 同步修改。覆盖：

- `templates/trae/agents/`
- `templates/claude-code/agents/`
- `templates/trae/plugin/agents/`
- README、guides、AGENTS 和 CLI 交互说明。

### 安装迁移

新安装只生成新名称。

更新已有 integration 时：

- 如果旧 `memory-reader.md` / `memory-writer.md` 位于上一版 manifest 中；
- 且当前内容 hash 仍等于上一版 manifest 记录；
- 则安装新模板后删除旧文件，并从新 manifest 移除旧资源。

以下情况保留旧文件并报告 conflict/preserved：

- 文件未由 manifest 管理。
- 文件已被用户修改。
- 文件是用户自己创建的同名资源。

`overwrite` 模式允许替换目标新名称，但也不应删除未被 manifest 管理的旧文件。

### 日志兼容

历史 `.memory/subagents` 中的 `memory-reader` / `memory-writer` 记录是审计数据，不做改写。新模板和新调用产生新 agent type。CLI 的 `--agent-type` 是自由字符串，无需 schema 兼容层。

## Knowledge Organizer 确认门禁

用户直接提供材料时，先把内容拆为：

- 明确且受信：可以继续生成 candidate。
- 需要领域确认：暂停该条，不写 active 或 inbox。

必须向用户确认的情况：

1. 术语、缩写、实体关系或适用范围意义不明。
2. 需要垂直领域专业判断才能确认真伪。
3. 与 active knowledge、正式文档或同批材料存在冲突。
4. Agent 根据已知证据判断内容疑似错误、过期或因果关系不成立。
5. 缺少决定性上下文会让分类、敏感级别或操作步骤产生实质差异。

确认问题必须：

- 引用原材料中的具体句子或字段。
- 说明疑点和可能影响。
- 尽量一次汇总全部疑点。
- 不把 Agent 的怀疑表述成既定事实。

用户确认后再继续；未确认内容不写入任何知识路径。明确内容可与待确认内容分离处理，但最终必须汇报哪些条目被暂缓。

## 预期项目改进方向

调研报告会按优先级提出：

- 增加 profile/axiom 类型或独立 cognitive policy 层。
- 从 observation 到 principle 的多轮反例验证与边界条件蒸馏。
- 为 maintenance proposal 增加 evidence diversity、contradiction challenge 和 human-confirmation 状态。
- 增加 workspace/context route registry，减少每次扫描范围。
- 增加 observer/reflector 产物评测，而不是直接改 active rules。
- 保留本项目现有治理边界，不照搬直接写 rules 的自动 Reflector。

## 验收

- 三产品和 plugin bundle 都只安装新 Subagent 名称。
- 旧受管模板可安全迁移，用户修改的旧模板保留。
- 全仓库当前使用说明不再把旧名称当推荐名称。
- Knowledge Organizer 项目 Skill 与 plugin Skill 都包含确认门禁。
- 调研报告引用 commit、文章、关键实现文件和本项目代码证据。
- 全量测试、typecheck、build 和注释审计通过。
