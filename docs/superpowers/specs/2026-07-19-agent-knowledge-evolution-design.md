# Agent Knowledge 演进设计

日期：2026-07-19

## 目标

在保留“Markdown 是唯一事实源、自动内容先隔离、索引可重建”的前提下，完成以下演进：

1. 修复 Hivemind 对比评测发现的检索、embedding、治理和 token budget 正确性问题。
2. 把固定的 `link-trae-templates` 改造成多产品、可选组件、可卸载、结构化合并的 integration installer。
3. 自动识别 Git 项目身份，让项目知识可以精确绑定项目，同时避免复制 `AGENTS.md` 或建设低收益 code graph。
4. 为 WebDAV 和 S3 提供双向 Markdown 同步，并对并发修改显式产出冲突，不静默覆盖。
5. 增强主动记忆、Subagent 日志和后台整理链路，同时防止客服场景中的低质量记录与知识投毒。

## 核心决策

### Markdown 与隔离边界不变

- `knowledge/**/*.md` 仍是唯一事实源。
- `.memory/**` 只保存索引、embedding、日志、staging、水位和同步状态。
- `knowledge/_inbox/**` 无论 frontmatter 是否误写成 `active`，都不能进入索引、embedding 或 query。
- 自动 hook、普通外部用户和模型推断不能直接生成 active 知识。

### 不建设通用 code graph

Agent 已能按任务搜索源码，完整 code graph 会引入高维护成本、过期边和重复上下文。本阶段只记录：

- Git root、规范化 remote、稳定 project ID。
- `AGENTS.md` / `AGENTS.override.md` 的发现路径和内容 hash，不复制正文。
- 经过验证且 `AGENTS.md` 未覆盖的架构边界、跨模块约束、隐含业务语义、稳定排障流程和历史决策。

项目扫描只生成机器 registry 和候选上下文，不自动把仓库结构写成正式知识。

### 客服场景采用零信任候选治理

外部用户的一次对话只是 observation，不是事实。候选输入增加 capture provenance：

- `capture_mode`: `explicit_remember`、`verified_task`、`automated_session`、`direct_material`。
- `actor_type`: `owner`、`teammate`、`customer`、`system`。
- `corroboration_count`: 独立证据次数。
- `project_ids`: 适用项目。

治理策略：

- `customer` 和 `automated_session` 永远先进入 `_inbox`。
- 外部用户不能通过措辞把 `source_authority` 提升为 `user_confirmed`。
- 业务规则至少需要受信文档、owner 确认或多个独立 observation 后人工晋升。
- 重复内容先合并为 proposal，不按会话数量无限创建候选。
- secret、隐私原文和未授权全文继续拒绝。

### Hook 不直接运行 LLM 或强制 Subagent

当前 TRAE command hook 可以执行 CLI，但 `prompt` / `agent` handler 运行时不会执行。Hook 因此只负责：

- 轻量 query 和上下文注入。
- 记录 Session、Subagent 和 Stop 的脱敏摘要。
- 把可能值得整理的事件写入 staging。
- 通过后续 maintenance skill 或主 Agent 的 `memory-writer` 委派完成语义抽取。

不在 Stop hook 中强制续跑模型，避免循环、额外成本和错误沉淀。主动记忆依靠更明确的 Subagent description、staging 水位和 maintenance skill。

## 架构

### 1. 检索与评测

`eval.ts` 扩展为 suite harness，支持：

- expected rank、graded relevance、forbidden、abstain、language、domain。
- Recall@1/3/5、MRR、nDCG、false injection rate、abstention precision、latency 和 packet tokens。

`query.ts` 执行：

1. visibility、sensitivity、project、validity、type 和 metadata 硬过滤。
2. lexical、dense、metadata 独立取 rank。
3. RRF 融合，保留 dense cosine 和各通道 rank。
4. 可插拔 reranker。
5. 同一安全过滤应用到一跳关系扩展。

CJK 文本通过 2/3-gram 辅助 FTS 列召回，仍保留“无 domain/scenario 且 lexical 无命中时不扫全表”的边界。

`contextPacket.ts` 使用保守 token estimator 逐项装包，而不是只按条数截断。

### 2. Embedding profile 与缓存

`EmbeddingProfile` 明确记录：

- provider、model、revision、dtype、dimensions。
- pooling、query/document prefix、max length、normalization。

默认 profile 为 multilingual E5 small q8；另提供 BGE small zh profile。测试继续使用 deterministic local profile。

`.memory/embeddings/manifest.json` 保存 profile 和 generation。Query 必须校验 provider/profile 与 manifest 完全兼容；不兼容时明确失败，不按短向量静默 cosine。

Embedding rebuild 按 `contentHash` 增量复用未变化记录，并删除已经不存在或失效的记录。

### 3. Integration installer

新命令面：

```text
agent-knowledge integration list
agent-knowledge integration install --product <product> --scope <user|project> --components <...>
agent-knowledge integration uninstall --product <product> --scope <user|project>
agent-knowledge integration doctor --product <product>
```

初始产品：

- `trae`: 用户级 hook 使用 `$TRAECLI_HOME/hooks.json`，agents/skills 使用 `$TRAE_HOME`；项目级使用 `.trae/`。
- `claude-code`: 用户级使用 `~/.claude/settings.json`、`agents/`、`skills/`；项目级使用 `.claude/`。

组件：

- `hooks`
- `agents`
- `skills`
- TRAE 专属 `plugin-bundle`

安装规则：

- 不创建 symlink。
- JSON 配置先 parse，再只删除/替换 command 中带 `agent-knowledge hook` 的自有 handler。
- 保留其他用户或插件的 hook group、handler 和顶层字段。
- 原子写入，写前保留可恢复 backup。
- Agent/Skill 只管理自有命名文件；首次遇到不同内容的同名非托管文件时报告 conflict，不覆盖。
- 写本地 integration manifest，支持幂等升级和卸载。

旧 `link-trae-templates` 保留一个版本作为兼容别名，但内部转到 installer，并输出 deprecation。

### 4. 项目身份

project ID 优先由规范化 Git remote 生成；没有 remote 时由 Git root 的 realpath 生成本机稳定 ID。registry 位于：

```text
.memory/projects/<project-id>.json
```

Frontmatter 增加可选 `project_ids`。查询请求携带当前 project ID：

- `visibility: project` 且 `project_ids` 非空时，只对匹配项目可见。
- 旧知识 `project_ids: []` 作为 legacy unscoped knowledge 保持兼容。

### 5. Staging 与主动记忆

`.memory/staging/events.jsonl` 保存经过裁剪和脱敏的事件；`.memory/staging/state.json` 保存 watermark。锁文件防止多个 hook worker 重复处理。

默认事件不保存完整 prompt、tool response 或 transcript，只保存：

- event/session/turn/subagent 标识的不可逆 hash。
- 长度、结果状态、project ID、知识命中 ID。
- 可配置的 bounded summary；只有显式 opt-in 才保存清洗后的文本。

`memory-maintainer` Skill 负责：

1. 查看 staging 和 query/no-hit/feedback 指标。
2. 结合当前会话中已经验证的结果调用 `memory-writer`。
3. 写入候选并做 dedupe/consolidation proposal。
4. 不自动晋升客服 observation。

Subagent hook 记录 `SubagentStart` / `SubagentStop`，便于确认 memory-reader/writer 是否真正被调用。

### 6. WebDAV / S3 同步

同步对象仅包含 Markdown 事实源，不上传 SQLite、embedding、日志或凭据。

远端保存对象和 manifest，本地保存上次同步 base hash。双向规则：

- 仅本地变化：push。
- 仅远端变化：pull。
- 双方同内容：更新 base。
- 双方相对 base 都变化：不覆盖，写入 `.memory/sync/conflicts/` 并报告。
- 删除使用 tombstone，避免另一端把旧文件复活。

WebDAV 使用 HTTP `GET` / `PUT` / `DELETE` / `MKCOL`，凭据只从参数或环境变量读取。S3 使用内置 SigV4 HTTP client，支持 AWS 和 S3-compatible endpoint；凭据只从环境变量进入内存，不落配置。

同步完成后重建 SQLite；embedding 缓存标记 stale，由用户或后台任务显式重建。

## 分阶段交付

### 阶段一：可信评测基线

- 扩展 eval schema、suite 指标和 CLI。
- 加入 hard negative 与 abstain fixture。
- CI 只跑 deterministic provider。

### 阶段二：P0 正确性

- inbox、validity、visibility、sensitivity、project filtering。
- token budget。
- embedding profile/manifest/incremental。
- dense score、CJK FTS、RRF 和 debug。

### 阶段三：默认模型与 rerank 边界

- E5/BGE profile。
- top-N 融合后 reranker 接口。
- 阈值、limit 和错误注入指标。
- 不在自动测试下载真实模型。

### 阶段四：产品安装

- adapter registry、TRAE/Claude Code、结构化 merge/uninstall/doctor。
- TRAE plugin bundle。
- 迁移旧命令和文档。

### 阶段五：项目知识与零信任治理

- Git project registry、project-scoped query。
- capture provenance、客服防投毒规则和 dedupe proposal。
- 明确哪些项目知识值得保存。

### 阶段六：同步

- backend contract、manifest、三方比较和冲突。
- WebDAV 与 S3 adapter。
- CLI、测试和安全文档。

### 阶段七：主动记忆

- staging/watermark/lock。
- Session/Subagent/Stop 日志。
- memory-maintainer skill。
- 优化 memory-reader/writer 描述、输入输出和日志诊断。

## 验证

- 所有新增行为先写单元测试。
- 网络 adapter 使用内存 fake 或 mock fetch，不访问真实服务。
- 真实 Transformers 模型只提供人工 smoke 命令，不进入 CI。
- Integration tests 只写临时目录，不修改用户真实配置。
- 最终运行 `pnpm test`、`pnpm typecheck`、`pnpm build` 和 CLI smoke。

## 非目标

- 自动把完整对话、tool response 或 transcript 上传到远端。
- 自动把客服用户陈述激活为业务事实。
- 自动解决双端 Markdown 冲突。
- 建设全仓库 AST/code graph。
- 在 hook 热路径下载或加载大模型。
