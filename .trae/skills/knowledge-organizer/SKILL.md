---
name: "knowledge-organizer"
description: "Organizes Agent Knowledge. Invoke when user asks to整理知识库, 归类知识, 审阅 inbox, or turn provided material into structured memory."
---

# Knowledge Organizer

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
2. `AGENT_KNOWLEDGE_ROOT`
3. `~/.agent_knowledge`

如果用户没有指定项目级知识库，默认使用 `~/.agent_knowledge`。

## 场景一：整理 `_inbox`

当用户说“整理 inbox”“审阅候选知识”“把候选知识归类”等，执行：

```bash
agent-knowledge list
agent-knowledge organize-inbox
```

先把 dry-run 结果展示给用户。如果用户确认应用，再执行：

```bash
agent-knowledge organize-inbox --apply
```

如果用户明确要求直接应用，可以跳过确认，但必须在最终回复中说明移动了哪些知识。

## 场景二：整理用户输入材料

当用户直接提供材料并要求“整理成知识”“归类保存”“沉淀到知识库”时：

1. 阅读用户材料。
2. 判断应拆成几条知识。
3. 为每条知识生成 `CandidateMemoryInput` JSON。
4. 默认使用 `source_authority: "user_confirmed"`。
5. 默认使用 `confidence: 0.8` 到 `0.95`。
6. 默认写入正式目录：`agent-knowledge capture-material --target active --input <json>`。
7. 如果材料含有不确定内容，或用户要求先审阅，则用 `--target inbox`。

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
- 如果有被拒绝的内容，说明原因。
