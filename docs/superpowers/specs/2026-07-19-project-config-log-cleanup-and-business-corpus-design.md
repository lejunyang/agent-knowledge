# 项目配置、维护日志清理与真实业务知识库设计

日期：2026-07-19

## 目标

1. 将 `memory-maintainer` 项目 Skill 和 plugin Skill 改为中文，并让 AI 可执行周期维护、用户只负责 proposal/candidate/Skill 的最终决策。
2. 增加安全的已消费日志清理：维护任务完成后删除已抽取的 Subagent 原始日志和已持久化的 feedback 事件，不破坏后续 watermark、Skill 证据或审计链。
3. 支持项目级共享配置和项目级本地配置；项目配置优先于用户全局配置，本地配置不提交 Git。
4. 将本仓库切换为本地私有知识 workspace，复用全局已下载模型缓存。
5. 递归拉取指定飞书 Wiki/Doc 及内嵌文档，保存完整材料，使用 `knowledge-organizer` 构建真实知识并循环评测召回质量。

## 非目标

- 不把私有飞书正文、项目 `knowledge/`、`.memory/` 或 `.agent-knowledge.local.json` 提交 Git。
- 不自动接受 maintenance proposal、激活自动候选或安装 Skill。
- 不复制 embedding/reranker 模型文件到项目；继续使用全局模型缓存目录。
- 不引入远端向量数据库或源码 AST/code graph。

## 1. 配置分层

### 文件

```text
~/.config/agent-knowledge/config.json   用户全局配置
<git-root>/.agent-knowledge.json        项目共享配置，可提交
<git-root>/.agent-knowledge.local.json  项目本地配置，必须忽略
```

非 Git 目录以当前工作目录作为项目根。

### 合并顺序

从低到高：

1. 内置默认值。
2. 兼容环境变量。
3. 用户全局配置；`--config <file>` 只替换这一层的文件位置。
4. 项目共享 `.agent-knowledge.json`。
5. 项目本地 `.agent-knowledge.local.json`。
6. 命令行显式功能参数，如 `--root`、`--retrieval`、`--locale`。

配置文件按对象递归合并；数组整体替换，不做元素拼接。这样项目只需写覆盖字段，同时不会把 visibility/component 列表意外合并。

### CLI

```bash
agent-knowledge configure --scope user
agent-knowledge configure --scope project
agent-knowledge configure --scope project-local
agent-knowledge config show
agent-knowledge config sources
```

- `configure` 默认保持 `user`，兼容现有行为。
- `config show` 输出合并后的生效配置。
- `config path` 继续输出用户层路径，兼容已有脚本。
- `config sources` 输出用户、项目共享、项目 local 的路径和存在状态。
- 项目配置允许部分字段；向导以当前合并结果为默认答案，只把完整结果写入所选目标。

### 本项目 local 配置

完成实现后，将全局生效配置复制为：

```text
.agent-knowledge.local.json
```

修改：

- `knowledgeRoot`：本仓库根目录。
- `embeddings.cacheDir`：保持 `/Users/bytedance/.cache/agent-knowledge/models`。
- embedding/reranker profile/model：保持全局配置，复用已下载模型。
- `allowRemoteModels=false`：真实任务使用已有缓存，不在查询热路径联网。
- 其他治理、Hook 和 integration 设置继承全局配置。

## 2. 已消费日志清理

### 数据边界

```text
.memory/subagents/*.jsonl
  -> observation extraction
  -> .memory/observations/events.jsonl

.memory/logs/*.jsonl feedback events
  -> feedback ledger
  -> Skill eligibility
```

### Feedback ledger

新增可重建但持久的：

```text
.memory/feedback/ledger.json
```

它保存按 `memoryId + queryRunId` 去重后的最新 usefulness 事件；无 `queryRunId` 的反馈按原事件身份保存。`maintenance run/watch` 先吸收日志到 ledger，再计算净分，因此 feedback 日志可以安全清理，晚到反馈仍能继续更新 ledger。

### Cleanup

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

默认 dry-run。`--apply`：

1. 仅当 observation extraction 的 `pendingSourceEvents=0` 时删除 `.memory/subagents/*.jsonl`。
2. 删除后把 source watermark 重置为 0；pair state 保留未匹配 Start。
3. 从 `.memory/logs/*.jsonl` 移除已经写入 feedback ledger 的 `feedback.memory_usefulness` 行。
4. 保留 query、catalog、Hook 运行日志，避免破坏 alias 建议和诊断。
5. 保留 observations、proposals、active Markdown 和 feedback ledger。

`memory-maintainer` 在成功执行 `maintenance run`、列出 proposal 并确认没有 pending source event 后执行 cleanup。它不会代替用户接受/拒绝 proposal。

## 3. 中文维护 Skill

项目和 plugin 的 `memory-maintainer/SKILL.md` 统一使用中文，明确：

- AI 可以运行 status、run、list、show、cleanup。
- AI 可以汇总 proposal、candidate 和 Skill 草稿。
- 用户决定 accept/reject、`organize-inbox --approve` 和 `install-skill`。
- cleanup 只在 extraction 成功且没有 pending source event 后执行。
- 不通过重复 feedback、重复 session 或删除审计产物伪造证据。

README 每周维护同时提供两种入口：

```text
人工命令模式
或
请 AI 使用 memory-maintainer Skill 完成维护和清理，由用户决定提案
```

## 4. 真实业务知识构建

### 私有数据位置

项目已有 `.gitignore` 排除：

```text
knowledge/
.memory/
local_exports/
.agent-knowledge.local.json
```

完整飞书原文保存在：

```text
local_exports/lark/<root-token>/
```

结构化后的 source/semantic/procedural 知识保存在项目：

```text
knowledge/
```

`local_exports` 保存原始拉取证据，`knowledge` 保存可读事实；两者都不提交。

### 飞书递归拉取

首批 Wiki URL 作为 root：

- `FkiRwcyBgiR9nVkh3mbcQdSjn30`
- `M73uwAWWMirbWIkTBZrcabKynnf`
- `OO6Lwef6CisYz7kJLP9ccfWpn7d`
- `Q1HOwsXkCiKZKlkkB2fcFrmDnTe`
- `UOAfwnsPniQuYtkrakqcboPknwf`

流程：

1. 使用 `lark-cli wiki +node-get --as user` 解析 root 节点。
2. 使用 `lark-cli docs +fetch --as user` 拉取完整正文。
3. 从正文中提取 Wiki/Doc 引用、`cite`、`synced_reference` 和文档链接。
4. 对未访问 token 做 BFS/DFS，记录 parent、source URL、token、标题和内容 hash。
5. 对嵌入 Sheets/Base 等资源切换相应 `lark-cli` 能力读取内部数据；无法读取时记录原因，不伪造内容。
6. 所有 raw 响应和规范化正文落 `local_exports/lark`。

### Organizer

使用 `knowledge-organizer`：

1. 合并现有全局知识库 24 条 active knowledge。
2. 为每份飞书材料写一条 `type=source` 的完整来源知识。
3. 从材料中拆分稳定业务术语、实体关系、约束、SOP、异常和变更规则。
4. 填写 source、aliases、domain/scenario、project ID、related_knowledge。
5. 用户给出的正式文档使用 `source_authority=documented`。
6. 不保存 token、权限信息、个人隐私原文和一次性页面状态。
7. 重建 lexical、embedding 和 graph 索引。

## 5. 真实评测循环

### 本地私有评测

从全局知识和飞书材料构建：

- 同义改写。
- 中英文/产品简称。
- 近主题 hard-negative。
- 多跳流程。
- temporal/update。
- no-answer/abstention。
- project/domain 隔离。

私有问题与期望 ID 保存到 `local_exports/eval/`，不提交。

### 可提交脱敏评测

只提交不含业务正文、客户信息或内部 URL 的合成/脱敏 case，例如：

```text
eval/cases/business-knowledge-sanitized.yaml
```

### 优化顺序

每轮：

1. `index` / `embed-index` / `graph build`。
2. 跑 lexical、hybrid、graph、hybrid-graph，必要时 rerank。
3. 查看 Recall@1/3/5、MRR、nDCG、false injection、abstention 和 token。
4. 优先优化 aliases、domain/scenario、CJK 词项、关系和 chunk/summary。
5. 只有评测证据支持时再改阈值或权重。
6. 保持 forbidden injection 为 0；no-answer 必须 abstain。

完成标准：

- 私有评测 Recall@3 和 nDCG 达到稳定高位。
- 关键业务 query Top-1/Top-3 可解释。
- hard-negative 不错误注入。
- graph 多跳只补充明确关系知识。
- 无答案 query 保持静默。
- 重建后结果确定，项目 local 配置与模型缓存复用正常。

## 6. 提交边界

独立提交：

1. 设计文档。
2. 实施计划。
3. 中文 Skill 和安全 cleanup。
4. 项目配置分层。
5. 可提交的脱敏评测/检索优化。
6. 最终文档与验证证据。

不提交：

- `.agent-knowledge.local.json`
- `knowledge/`
- `.memory/`
- `local_exports/`
- 飞书正文、内部 URL 派生内容和私有评测。
