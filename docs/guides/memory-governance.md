# 候选知识与主动记忆

## 三层数据边界

```text
Hook / Subagent 原始信号
  -> .memory 日志与 observations
  -> maintenance proposal
  -> knowledge/_inbox candidate
  -> 人工批准
  -> active Markdown
```

- `.memory/subagents`、`.memory/staging`、`.memory/observations` 和 `.memory/proposals` 是调试/审阅产物，不是正式知识。
- `knowledge/_inbox` 是候选 Markdown，索引器和 embedding 明确排除它。
- `knowledge/<type>/<domain>/**/*.md` 中的 active Markdown 才是可检索事实源。

任何自动流程都不能跨过 proposal、inbox 和人工审阅边界直接激活知识。

## 知识何时会被主动记录

主动记忆不是只有用户显式要求才可能发生，也不是所有对话都会自动写入。

### 明确触发

- 用户说“记住”“以后按这个规则”“把这些材料整理成知识”。
- 主 Agent 应调用 `memory-writer` 或 `knowledge-organizer`。
- 这是最可靠、意图最清晰的触发方式。

### 建议主动触发

- 任务已经执行并验证成功，而且结论在未来任务中可复用。
- 发现 `AGENTS.md` 未覆盖的稳定项目约束、业务语义、跨模块隐含边界或 SOP。
- 同一个客服流程在多个独立 session 中反复验证成功，并有受信来源和正反馈。
- 主 Agent 可依据 Subagent description 主动调用 `memory-writer`；是否调用最终由宿主 Agent 调度。

### 不应触发

- 普通闲聊、一次性命令、临时路径、单次错误输出。
- 未验证的模型推断。
- 可由 Agent 当场搜索源码获得的普通目录/类/函数结构。
- `AGENTS.md` 已完整覆盖的项目说明。
- 一次外部客户陈述，哪怕客户要求“记住”。

可用以下命令确认 Subagent 是否实际被调用：

```bash
agent-knowledge subagents status
agent-knowledge subagents logs --agent-type memory-writer
```

## 直接候选写入

其他 Agent 默认只能写 `_inbox`：

```bash
agent-knowledge write-candidate --input candidate.json
```

候选会经过 secret-like 扫描、来源治理、去重和 schema 校验。

`memory-writer` 只输出 JSON，不调用工具、不写文件。主 Agent 负责把 JSON 保存为临时文件并执行 `write-candidate`。即使候选因 `user_confirmed` 或高置信 verified procedural 被判为 active status，文件仍先落在 `_inbox`，不会直接进入正式检索。

用户直接提供的材料可由 `knowledge-organizer` 拆分，再使用：

```bash
agent-knowledge capture-material --input material.json --target active
```

只有 owner 的受信直接材料才适合 `--target active`。外部材料、不确定内容或用户要求先审阅时使用 `--target inbox`。

## Hook、详细日志与 staging

TRAE/Claude Hook 的职责分开：

- `UserPromptSubmit`：查询知识；高相关才注入，无命中/低分完全静默。
- `SubagentStart` / `SubagentStop`：保存本地原始调试 payload，并写脱敏 staging 信号。
- `Stop` / `SessionEnd`：只写脱敏 lifecycle staging。
- Hook 本身不调用 LLM 总结，不写 candidate，不激活知识。

详细 Subagent 日志：

```text
.memory/subagents/YYYY-MM-DD.jsonl
```

它保留原始 payload、Start/Stop 配对和 duration，默认不脱敏，因为仅供本机所有者调试；它不会同步、不会注入上下文。可在配置中关闭：

```json
{
  "hooks": {
    "detailedSubagentLogging": false
  }
}
```

Staging 只保存 hash、长度、agent type、reason 和 project ID：

```bash
agent-knowledge staging status
agent-knowledge staging drain --limit 100
```

`staging drain` 是调试/Skill 人工审阅入口，不是 maintenance 常规输入要求。不要为了清空 pending 数而盲目 drain。

## Maintenance 自动维护

正常数据流：

```text
.memory/subagents 的新 SubagentStop
  -> maintenance extract 的 source watermark
  -> .memory/observations/events.jsonl
  -> maintenance worker 的 proposal watermark + lock
  -> .memory/proposals/*.json
```

```bash
agent-knowledge maintenance extract
agent-knowledge maintenance run
agent-knowledge maintenance watch --interval-minutes 30
agent-knowledge maintenance status
```

- `extract`：只抽取新 `SubagentStop`，没有可复用文本的事件会跳过。
- `run`：先自动 extract，再读取 observation 并生成 proposal。
- `watch`：前台长期循环，立即运行一次，再按间隔执行。
- `status`：查看 source watermark、待抽取事件和 observation 数量。
- `--input <file>`：高级外部 observation 导入；普通用户不需要编写这个 JSON。

`watch` 的 input 来自 Hook 自动写入的详细 Subagent 日志，不是另一个人工脚本。它不会自动成为系统服务；持续机器人应交给 systemd、launchd、容器或其他进程管理器。

Worker 使用 watermark 防止重复消费，使用 lock 防止并发 worker 同时生成提案，每次按 limit 有界处理。它生成：

- `duplicate`
- `consolidation`
- `update`
- `conflict`
- `skill`

Proposal 不会修改 active Markdown。当前 extraction 是确定性字段抽取，不调用外部 LLM；复杂语义整理应由 `memory-maintainer` Skill 和 `memory-writer` 在人工可见流程中完成。

## Proposal 人工审阅

列出并查看：

```bash
agent-knowledge maintenance list --status pending
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance reject <proposal-id> --reason "..."
```

类型含义：

- `duplicate`：观察与已有 active 知识相同；接受只记录审计状态，不创建 candidate。
- `consolidation`：同一主题有新补充，建议合并。
- `update`：显式替代旧知识，candidate 会带 `supersedes`。
- `conflict`：与已有知识冲突，candidate 会带 `conflicts_with`，必须调查证据。
- `skill`：重复验证的 procedural 流程可提炼为可执行 Skill。

接受知识 proposal：

```bash
agent-knowledge maintenance accept <proposal-id>
```

`consolidation/update/conflict` 会写入 `knowledge/_inbox`，status 仍是 proposed。检查命令返回的 `candidatePath`、证据、适用范围、敏感级别和冲突关系后，查出知识 ID：

```bash
agent-knowledge list
agent-knowledge organize-inbox --approve <knowledge-id>
agent-knowledge organize-inbox --approve <knowledge-id> --apply
```

`--approve` 是明确的人类白名单：该次只处理列出的 ID，并允许已核验的 `automated_session` / `customer` 候选越过默认批量阻断。未知 ID 会在写文件前失败。

不传 `--approve` 的普通 `organize-inbox --apply` 只批量处理受信 candidate；客户和自动会话候选继续阻止。

知识 frontmatter 可选保存结构化 `episodes`，包含 session/turn/project hash、观察时间和 evidence refs，用于时间更新和独立证据判断。

## Skill 沉淀生命周期

Skill proposal 只有同时满足以下条件才生成：

- `memoryType=procedural`
- 至少 3 个**独立 session**
- 每个 observation 都是 `verified_task` 或 `user_confirmed`
- 与同 domain、同标题/alias 的 active procedural knowledge 存在足够的净正向 usefulness feedback
- 没有 conflict

这比普通 procedural candidate 更严格，因为 Skill 会改变 Agent 的执行方式。

Feedback 计算规则：

- `agent-knowledge feedback` 写入 `.memory/logs`，maintenance 会自动读取。
- 同一 `memoryId + queryRunId` 只采用时间最新的一条，重复上报不增加票数。
- `useful=+1`、`not_useful=-1`、`neutral=0`；净正反馈数量必须至少等于独立 session 数。
- 自动关联只在 observation 与 active knowledge 的 domain 相同，且标题或 alias 精确匹配时发生，避免把近主题反馈误转给另一条流程。
- feedback 晚于 observation 到达时，后续 `maintenance run/watch` 仍会重新评估已消费 observation；无需删除 watermarks 或重复导入 observation。
- 外部 observation 已显式携带 `usefulFeedback` 时保留该值，不用本地日志覆盖。

这意味着主 Agent 实际使用或拒绝检索结果后，应尽量记录带 `queryRunId` 的 feedback；但不要为了满足 Skill 门槛批量伪造正反馈。

### 第一步：接受到审阅 inbox

```bash
agent-knowledge maintenance show <proposal-id>
agent-knowledge maintenance accept <proposal-id>
```

默认写入：

```text
knowledge/_inbox-skills/<proposal-id>/SKILL.md
```

此时只是草稿，没有安装到 Agent 的 Skill 搜索路径。用户可从命令输出的 `skillPath` 或 proposal 的 `skillPath` 知道新增位置。

### 第二步：人工审阅

检查：

- frontmatter `name` / `description` 是否清晰，触发范围是否过宽。
- 流程是否真的跨任务复用，而不是某次会话细节。
- 命令是否安全、是否包含一次性路径或凭据。
- 是否与现有项目/用户 Skill 重复或冲突。
- 是否需要使用 `skill-creator` 进一步完善。

### 第三步：显式安装

项目级：

```bash
agent-knowledge maintenance install-skill <proposal-id> \
  --skill-target project \
  --project-root /path/to/project
```

用户级：

```bash
agent-knowledge maintenance install-skill <proposal-id> \
  --skill-target user
```

只有 `accepted` 的 Skill proposal 能安装；已有 `SKILL.md` 永不覆盖。也保留高级的一步式 `maintenance accept --skill-target project|user`，但推荐先进入 inbox 审阅，再使用 `install-skill`。

Skill 安装后不会自动修改 integration 目标中的其他第三方 Skill。需要把项目内 Skill 分发到其他产品时，重新审视 integration 模板和安装范围。

## 客服、无用信息与知识投毒

机器人部署建议：

- 使用独立 workspace/config，不与个人 owner 知识直接混写。
- `actorType=customer`
- `captureMode=automated_session`
- visibility 为 `project,team`
- sensitivity 为 `internal`
- 按租户/业务划分 root 或 project ID，避免跨客户召回。

防护层：

1. **来源降权**：客户陈述强制按 `model_inferred` observation 处理，不能伪装为 `user_confirmed`。
2. **硬隔离**：自动/客户内容只进入 logs、proposal 和 `_inbox`，不进入 active 索引。
3. **独立佐证**：同一 actor/session 重复不算多个证据；Skill 要求至少 3 个独立 session。
4. **受信验证**：业务事实需要 owner、正式文档或实际验证支持。
5. **显式晋升**：只有列出具体知识 ID 的 `--approve` 才能激活不可信来源候选。
6. **检索隔离**：visibility、sensitivity、project ID、validity 在直接和图关系扩展中都重新检查。
7. **Secret 扫描**：常见 token/API key/私钥格式在 candidate 写入前拒绝。
8. **同步边界**：只同步正式 Markdown，不同步日志、observations、proposals 或 inbox。

对高流量机器人，不要以“对话次数”作为事实正确性的替代。建议定期抽样查看 rejected/accepted proposal、无用反馈和图谱中的冲突/来源节点。

## 推荐周期

个人电脑每周或按需：

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge list
agent-knowledge organize-inbox
```

客服机器人持续运行：

```bash
agent-knowledge maintenance watch --interval-minutes 30
```

但 proposal 审阅、知识 `--approve` 和 Skill `install-skill` 始终人工执行。接受并激活知识后，`organize-inbox --apply` 会重建 lexical 索引；若使用 embedding 或 graph，还需运行：

```bash
agent-knowledge embed-index
agent-knowledge graph build
```

受信 replacement 通过 `supersedes` 激活时，会把旧知识标为 deprecated 并设置 `valid_until`。
