# 项目知识、同步、客服投毒与主动记忆设计结论

日期：2026-07-19

## 项目知识应该记录什么

不建议为通用 coding agent 建设全量 code graph。Agent 会针对任务搜索源码，完整图谱容易过期，并与代码索引能力重复。

适合长期记录：

- `AGENTS.md` 未覆盖的稳定架构边界和模块职责。
- 必须跨多个文件才能推断出的业务语义。
- 已验证的隐含约束、兼容性要求和发布/排障流程。
- 历史决策及其原因，尤其是“为什么不能采用看似简单的方案”。
- 特定项目独有的术语、系统边界、数据所有权和高风险操作。

不适合长期记录：

- 普通目录树、函数列表和可即时搜索的代码表面事实。
- 当前分支的一次性状态、临时路径和单次命令输出。
- `AGENTS.md` 已经明确说明的内容。
- 未验证的架构推断。

实现上使用 Git remote 或 canonical Git root 生成稳定 project ID。只保存 `AGENTS.md` 路径与 hash，不复制正文。

## 客服场景为什么容易污染

自动客服会接触大量低信号、互相矛盾或恶意构造的输入。主要风险包括：

- 用户把自己的误解说成业务规则。
- 用户显式要求“以后都记住”，试图提升来源权威性。
- 多次重复同一错误内容，制造虚假 corroboration。
- 在文本中夹带 prompt injection、隐私或凭据。
- 将一次成功处理误总结为通用流程。

## 防投毒策略

1. 外部客户只产生 observation，不能产生 `user_confirmed` 事实。
2. `actor_type: customer` 或 `capture_mode: automated_session` 永远先写 `_inbox`，不能直接 active。
3. 同一 actor/session 的重复陈述只算一次证据。
4. 业务规则晋升需要以下至少一种：
   - owner 明确确认；
   - 受信文档；
   - 可复现任务验证；
   - 多个真正独立的 observation，再经人工审阅。
5. 对相同主题先做 dedupe/consolidation proposal，不按会话数量无限创建文件。
6. secret、隐私原文和完整会话不写入 Markdown 或 staging。
7. 同步冲突不自动“最后写入获胜”，而是输出冲突文件。

机器人部署建议固定环境变量，防止模型通过 candidate JSON 伪造 actor：

```bash
export AGENT_KNOWLEDGE_ACTOR_TYPE=customer
export AGENT_KNOWLEDGE_CAPTURE_MODE=automated_session
```

## 主动记忆何时触发

主动记忆不应只依赖用户显式说“记住”。合理触发点是：

- 用户明确要求长期记忆。
- 一个可复用流程执行成功且验证通过。
- 一次失败恢复揭示了稳定、非显然的排障知识。
- 会话出现 `AGENTS.md` 未覆盖的稳定项目约束或业务知识。
- 多个独立客服 observation 指向同一候选经验。

不触发：

- 普通闲聊或确认语。
- 一次性命令和临时环境状态。
- 可直接从源码搜索的表面结构。
- 未验证模型推断。

## 为什么 Hook 不直接调用 Subagent

当前 TRAE command hook 能运行命令，但 `prompt` / `agent` handler 运行时不会执行。强行在 Stop hook 中要求模型继续也容易形成循环和额外成本。

因此采用两层机制：

1. `SubagentStart`、`SubagentStop`、`Stop`、`SessionEnd` hook 异步写入脱敏 staging。
2. 主 Agent 在明确触发点主动委派 `memory-writer`，或使用 `memory-maintainer` Skill 批量审阅 staging。

Staging 只保存：

- session/turn/agent 的短 hash。
- event、agent type、project ID、reason。
- prompt/response 长度和 tool response 大小。

不保存完整 prompt、response、tool payload 或 transcript。

## 同步边界

WebDAV/S3 只同步正式 KnowledgeDocument Markdown，排除：

- `.memory/index.sqlite`
- embedding 缓存
- staging/log
- 凭据
- 生成型 catalog/review 文件
- `knowledge/_inbox/**`
- `knowledge/_archive/**`
- `knowledge/_inbox-skills/**`

同步使用本地 base manifest、当前本地和当前远端做三方比较。双端同时修改同一知识时写 `.memory/sync/conflicts/*.json`，保留双方内容供人工处理。
