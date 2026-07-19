# Subagent 可观测性、自动维护、知识图谱与使用体验设计

日期：2026-07-19

## 目标

1. 让 `SubagentStart` / `SubagentStop` 保存足够完整的本地调试证据，支持改进 Agent 描述、触发条件和执行质量。
2. 去掉普通用户手工维护 `observations.json` 的必要性，让 maintenance 能从 Hook/Subagent 日志自动抽取 observation。
3. 提供 proposal 查看、接受、拒绝和 Skill 草稿安装流程。
4. 构建可重建的轻量知识关系图，并提供 JSON、Mermaid 和自包含 HTML 可视化。
5. 增加可选 graph / hybrid-graph 检索，不引入图数据库或全量代码 AST 图谱。
6. 重写最佳实践文档，让个人用户和客服机器人都能清楚知道日常、每周和长期运行方式。
7. 强化注释规则并补充核心模块注释，重点解释安全边界、排序、锁、水位、冲突和外部副作用。

## 非目标

- 不建设仓库源码 AST/code graph。
- 不将 `.memory/subagents`、`.memory/proposals` 或 `.memory/graph.json` 同步到远端。
- 不从 Hook 日志自动激活知识。
- 不自动安装 Skill proposal。
- 不引入 Neo4j、Graphiti server 或其他图数据库运维依赖。

## 1. Subagent 详细日志

### 存储

```text
.memory/subagents/YYYY-MM-DD.jsonl
.memory/subagents/state.json
```

只对 `SubagentStart` / `SubagentStop` 记录完整 payload；其他事件继续使用现有脱敏 staging。

每条记录包含：

- `timestamp`
- `event`
- 原始 `payload`
- `sessionId`
- `turnId`
- `agentId`
- `agentType`
- `threadName`
- `model`
- `permissionMode`
- `cwd`
- `transcriptPath`
- `paired`
- `durationMs`

Stop 事件按 `agent_id` 优先、`session_id + agent_type` 次优进行 Start/Stop 配对。配对状态只用于本地诊断，不参与知识抽取权威性判断。

### 配置与命令

用户配置：

```json
{
  "hooks": {
    "detailedSubagentLogging": true
  }
}
```

命令：

```bash
agent-knowledge subagents status
agent-knowledge subagents logs
agent-knowledge subagents logs --agent-type memory-writer --limit 50
```

详细日志默认开启，未来稳定后可关闭。Hook 模板使用专用 `hook subagent-event` 命令；该命令同时写详细日志和现有 staging 信号。

## 2. Maintenance 自动 extraction

### 数据流

```text
SubagentStart/Stop detailed logs
  + Stop/SessionEnd staging
  + retrieval feedback
  -> maintenance extract
  -> .memory/observations/events.jsonl
  -> proposal worker
  -> .memory/proposals/*.json
```

### Observation 抽取

确定性 extraction 从 SubagentStop payload 中按以下优先级读取文本：

1. `result`
2. `output`
3. `last_assistant_message`
4. `subagent_stop.result`
5. `subagent_stop.output`

标题优先使用 task/prompt 的短摘要，否则使用 `agent_type`。Domain 优先使用显式 payload domain，其次 project ID，最后 `agent/<agent-type>`。

没有可复用文本的事件不生成 observation。自动生成 observation 使用：

- `sourceAuthority: model_inferred`
- `actorType: agent`
- `captureMode: automated_session`
- episode/session/turn/project provenance

### 命令

```bash
agent-knowledge maintenance extract
agent-knowledge maintenance run
agent-knowledge maintenance watch
agent-knowledge maintenance status
```

- `extract`：详细日志/staging -> observations。
- `run`：extract + proposal。
- `watch`：前台循环，持续消费 append-only 日志。
- `status`：显示各水位、待处理 observations 和 proposals。
- `--input` 保留为高级导入路径。

## 3. Proposal 生命周期

Proposal 新增状态：

- `pending`
- `accepted`
- `rejected`

以及：

- `updatedAt`
- `resolution`
- `candidatePath`
- `skillPath`

命令：

```bash
agent-knowledge maintenance list
agent-knowledge maintenance show <id>
agent-knowledge maintenance accept <id>
agent-knowledge maintenance reject <id> --reason "..."
```

接受行为：

- `duplicate`：只标记 accepted。
- `consolidation/update/conflict`：生成 candidate 到 `knowledge/_inbox`，不直接 active。
- `skill`：
  - 未传 target：写 `knowledge/_inbox-skills/<proposal-id>/SKILL.md`。
  - `--skill-target project`：写当前项目 `.trae/skills/<name>/SKILL.md`。
  - `--skill-target user`：写 `$TRAE_HOME/skills/<name>/SKILL.md`。

Skill 写入冲突时拒绝覆盖。所有接受/拒绝操作更新 proposal JSON，保留审计记录。

## 4. 轻量知识图谱

### 图节点

- `knowledge`
- `domain`
- `scenario`
- `project`
- `episode`
- `source`
- `proposal`

### 图边

- `depends_on`
- `refines`
- `supports`
- `often_used_with`
- `supersedes`
- `conflicts_with`
- `belongs_to_domain`
- `used_in_scenario`
- `belongs_to_project`
- `observed_in_episode`
- `sourced_from`
- `proposes_change_to`

### 存储

```text
.memory/graph.json
```

图是可重建索引，不是事实源。构建只读取 Markdown、project registry 和 proposal JSON。

### 命令

```bash
agent-knowledge graph build
agent-knowledge graph query --text "refund approval"
agent-knowledge graph query --id k_xxx --depth 2
agent-knowledge graph export --format json --output graph.json
agent-knowledge graph export --format mermaid --output graph.md
agent-knowledge graph export --format html --output graph.html
```

HTML 为自包含文件，支持：

- 关键词搜索。
- node type / memory status / domain / project 筛选。
- 点击节点查看 summary、source、validity、relations。
- 冲突和 supersedes 边使用不同样式。
- 无外部 CDN。

## 5. Graph retrieval

新增 retrieval mode：

- `graph`
- `hybrid-graph`

流程：

1. lexical 或 hybrid 找 seed。
2. 读取/重建 `.memory/graph.json`。
3. 按允许边遍历，默认 depth 1，最大 depth 2。
4. 每跳应用衰减。
5. 最终文档重新执行 validity、visibility、sensitivity、project 和 includeTypes 过滤。
6. 与原结果合并后排序。

允许自动扩展：

- `depends_on`
- `refines`
- `supports`
- `often_used_with`

`conflicts_with` 和 `supersedes` 用于 warning/temporal 解释，不作为普通事实扩展。

这是真正的图遍历检索；当前旧机制只是基于 `related_knowledge` 的固定一跳扩展。

## 6. 推荐使用流程

### 个人电脑

首次：

```bash
agent-knowledge configure
agent-knowledge integration install
agent-knowledge embedding download
agent-knowledge embed-index
```

日常：

- Hook 自动注入高相关知识。
- `memory-reader` 在 Hook 不足时主动检索。
- `memory-writer` 在验证成功或显式记忆时生成 candidate。

每周：

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list
agent-knowledge organize-inbox
agent-knowledge graph export --format html --output knowledge-graph.html
```

### 客服机器人

- `actorType=customer`
- `captureMode=automated_session`
- visibility=`project,team`
- sensitivity=`internal`
- `maintenance watch` 由进程管理器托管
- 只生成 proposals/inbox
- 不自动 accept

### 人工审阅

```bash
agent-knowledge maintenance list
agent-knowledge maintenance show <id>
agent-knowledge maintenance accept <id>
agent-knowledge list
agent-knowledge graph export --format html
```

## 7. 注释规则

`AGENTS.md` 更新：

- 每个 exported function/class 必须有 JSDoc。
- 每个非平凡内部 function 必须说明用途或背景。
- 安全过滤、fallback、阈值、锁、水位、去重、冲突、时间失效、排序融合和外部副作用附近必须有“为什么”注释。
- 简单 getter、一行 wrapper、显然字段映射不要求重复注释。
- 流程变动或优化时必须审视：
  - README 推荐流程。
  - `templates/trae/hooks*.json`
  - `templates/trae/agents/*.md`
  - `templates/claude-code/agents/*.md`
  - `.trae/skills/*`
  - `templates/trae/plugin/skills/*`

本轮优先补充：

- `src/hooks/staging.ts`
- `src/memory/maintenance.ts`
- `src/memory/proposals.ts`
- `src/retrieval/query.ts`
- `src/integration/manager.ts`
- `src/sync/core.ts`
- 新增 graph 模块

## 提交顺序

1. 设计与实施计划。
2. Subagent 详细日志。
3. Maintenance 自动 extraction。
4. Proposal 审阅与 Skill 应用。
5. Knowledge graph build/query/export。
6. HTML 可视化。
7. Graph retrieval。
8. 推荐流程与配置枚举说明。
9. 注释规则、核心注释补充和注释审计。
10. 全量验证与最终审计。
