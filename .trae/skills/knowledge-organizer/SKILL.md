---
name: "knowledge-organizer"
description: "整理 Agent Knowledge。用户要求整理知识库、归类知识、审阅 inbox，或把直接材料沉淀为结构化长期知识时调用。"
---

# 知识整理器

本 Skill 用于主动整理 Agent Knowledge。它处理两类场景：

- 用户要求整理现有知识库、归类 `_inbox` 候选知识、查看待审阅知识。
- 用户直接提供一段材料、文档摘录、会议记录或业务说明，希望整理成长期知识。

## 工作原则

- Markdown 是事实源，索引只是缓存。
- 用户直接提供的材料通常比模型自动总结更可信，但仍需要检查 secret、隐私和适用范围。
- 不要把一段材料强行塞成一条知识。材料中包含多个独立事实、流程或案例时，应拆成多条。
- 不要直接手写正式目录文件。优先调用 `agent-knowledge capture-material` 或 `agent-knowledge organize-inbox`。

## 默认知识库位置

CLI root 优先级：

1. `--root <dir>`
2. 项目 local 配置。
3. 项目共享配置。
4. 用户配置。
5. 兼容环境变量 `AGENT_KNOWLEDGE_ROOT`。
6. `~/.agent_knowledge`

如果用户没有指定项目级知识库，默认使用 `~/.agent_knowledge`。

## 场景一：整理 `_inbox`

当用户说“整理 inbox”“审阅候选知识”“把候选知识归类”等，执行：

```bash
agent-knowledge list
agent-knowledge organize-inbox
```

先把 dry-run 结果展示给用户。对于普通受信候选，如果用户确认应用，再执行：

```bash
agent-knowledge organize-inbox --apply
```

如果用户明确要求直接应用，可以跳过确认，但必须在最终回复中说明移动了哪些知识。

### 自动会话和客户候选

`automated_session` 或 `actor_type: customer` 不允许批量晋升。只有用户已检查 candidate Markdown、evidence、适用项目、敏感级别和冲突关系后，才能按知识 ID 预览并应用：

```bash
agent-knowledge organize-inbox --approve "$MEMORY_ID"
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

一旦使用 `--approve`，该次命令只处理列出的 ID；未知 ID 会在任何写入前报错。不要自行猜测 ID，也不要为了清空 inbox 批量批准自动/客户候选。

Maintenance proposal 的推荐闭环：

```bash
agent-knowledge maintenance show "$PROPOSAL_ID"
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge list
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

`maintenance accept` 只是把知识 proposal 写入 `_inbox`，不代表内容已经通过最终事实审核。

## 场景二：整理用户输入材料

当用户直接提供材料并要求“整理成知识”“归类保存”“沉淀到知识库”时：

1. 阅读用户材料。
2. 判断应拆成几条知识。
3. 为每条知识生成 `CandidateMemoryInput` JSON。
4. 只有材料来自 owner/当前用户本人时才使用 `source_authority: "user_confirmed"` 和 `actor_type: "owner"`。
5. 外部客户、自动客服 transcript 或第三方转述必须使用 `source_authority: "model_inferred"`、`capture_mode: "automated_session"`，写入 inbox。
6. owner 直接材料默认使用 `confidence: 0.8` 到 `0.95`。
7. owner 直接材料默认写入正式目录：`agent-knowledge capture-material --target active --input <json>`。
8. 如果材料含有不确定内容、来自外部 actor，或用户要求先审阅，则用 `--target inbox`。
9. 不要把可由 Agent 当场搜索到的普通代码结构、目录树、函数签名或已有 `AGENTS.md` 内容重复保存。
10. 适合项目知识库的是稳定架构决策、跨模块隐含约束、项目特有业务语义、事故教训和验证 SOP。
11. 用户明确提供/指定拉取的正式文档可使用 `source_authority: "documented"`、`actor_type: "owner"`、`capture_mode: "direct_material"`；confidence 至少 `0.8` 时可按用户要求直接 active。后台自动发现或客户转述不能使用这条放行路径。
12. `type: source` 的原始证据必须先删除临时下载 URL，并遮蔽账号、验证码、密码、token、用户标识和其他个人信息；不应把“内部测试账号表”复制进长期知识。
13. 同一外部文档更新或脱敏规则升级时，可使用 `capture-material --replace-source` 刷新同 ID 的 active documented source。该参数不能覆盖 semantic/procedural/profile/episodic；精炼知识变化必须新增版本并使用 `supersedes`。

JSON 可以是单个对象，也可以是数组：

```json
[
  {
    "title": "直接材料整理规则",
    "memory_type": "semantic",
    "domain": "knowledge/organization",
    "related_domains": ["agent/memory"],
    "scenario": ["knowledge-organization"],
    "tags": ["direct-material"],
    "confidence": 0.9,
    "source_authority": "user_confirmed",
    "summary": "用户直接提供的材料置信度较高，Skill 负责理解拆分，CLI 负责校验、落盘和索引。",
    "evidence": ["user:direct-material"]
  }
]
```

保存为临时 JSON 文件后执行：

```bash
agent-knowledge capture-material --input material.json --target active
```

刷新已导入且稳定映射到同一外部文档的 source：

```bash
agent-knowledge capture-material \
  --input source-batch.json \
  --target active \
  --replace-source
```

## 分类建议

- `profile`：稳定偏好、用户约定、项目长期规则。
- `semantic`：业务事实、术语定义、系统边界、接口语义。
- `episodic`：一次历史任务、事故复盘、失败教训。
- `procedural`：SOP、检查步骤、排障流程、验证流程。
- `source`：原始材料摘要或证据索引。

## 安全边界

不要保存：

- API key、token、cookie、私钥。
- 个人隐私原文。
- 未授权敏感全文。
- 一次性命令输出。
- 没有证据支撑的猜测。

如果材料中出现这些内容，说明无法保存原文，并建议用户提供脱敏版本。

## 输出给用户

整理完成后，简要说明：

- 写入了几条知识。
- 写入位置是 active 正式目录还是 `_inbox`。
- 是否重建索引。
- 如果使用了 `--approve`，列出被人工批准的知识 ID。
- 如果有被拒绝的内容，说明原因。

如果项目使用 embedding 或 graph，active 知识变化后提醒用户按需运行：

```bash
agent-knowledge embed-index
agent-knowledge graph build
```
