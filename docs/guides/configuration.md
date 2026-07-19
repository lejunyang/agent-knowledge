# 用户配置

## 配置向导

```bash
agent-knowledge configure
```

向导使用方向键单选、空格多选、回车确认；路径、模型和阈值使用文本输入。它会读取已有配置作为默认答案，不会执行 integration 安装、模型下载或远端同步。

默认写入：

```text
~/.config/agent-knowledge/config.json
```

可用 `XDG_CONFIG_HOME`、`AGENT_KNOWLEDGE_CONFIG` 或全局 `--config <file>` 指定其他位置。

项目配置：

```text
<git-root>/.agent-knowledge.json
<git-root>/.agent-knowledge.local.json
```

- `.agent-knowledge.json`：项目共享配置，可提交 Git。
- `.agent-knowledge.local.json`：项目本地覆盖，默认在本项目 `.gitignore` 中排除。
- Git 项目从任意子目录向上发现 root；非 Git 目录使用当前工作目录。
- 配置对象递归合并；数组整体替换，不与低优先级数组拼接。

优先级从高到低：

1. 命令行显式功能参数，如 `--root`、`--locale`、`--retrieval`。
2. 项目本地 `.agent-knowledge.local.json`。
3. 项目共享 `.agent-knowledge.json`。
4. 用户配置。
5. 兼容环境变量。
6. 内置默认值。

`--config <file>` 只替换用户配置层的位置，不关闭项目配置发现。需要测试或故障诊断时，可临时设置 `AGENT_KNOWLEDGE_DISABLE_PROJECT_CONFIG=1`。

交互写入不同层：

```bash
agent-knowledge configure --scope user
agent-knowledge configure --scope project
agent-knowledge configure --scope project-local
```

编辑 project 层时不会把 project-local 覆盖值反写进共享文件。

查看生效配置和配置路径：

```bash
agent-knowledge config show
agent-knowledge config path
agent-knowledge config sources
```

- `config show`：输出所有层合并后的生效配置。
- `config path`：输出用户配置层路径，兼容已有脚本。
- `config sources`：输出用户、项目共享、项目 local 路径和存在状态。

配置只保存行为参数和**凭据环境变量名**，不保存密码、access key、session token 或其他 secret 值。

## 基础配置

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `locale` | `auto` | `auto` 检测系统语言；支持 `zh-CN` 和 `en`，其他语言回退中文 |
| `knowledgeRoot` | `~/.agent_knowledge` | Markdown、索引、缓存和日志的 workspace root |

语言优先级是全局 `--locale` > 项目 local > 项目共享 > 用户配置 > `LC_ALL` / `LC_MESSAGES` / `LANG` > 系统 locale。默认和未知系统语言都使用中文说明。

## 身份与治理

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `identity.actorType` | `owner` | 控制写入来源权威性 |
| `identity.captureMode` | `direct_material` | 控制自动内容是否必须审阅 |
| `identity.visibilityScopes` | `private,project,team` | 查询允许读取的可见范围 |
| `identity.sensitivityClearance` | `internal` | 查询允许读取的最高敏感级别 |

### actorType

- `owner`：知识库所有者或当前用户的受信输入。
- `teammate`：已知协作者输入；仍需按证据和 capture mode 判断是否直接采用。
- `customer`：外部客户或不可信对话者。其陈述只能作为 observation，不能自动成为确认事实。
- `agent`：AI Agent、机器人或自动化服务。是否可信取决于验证证据，不等同于 owner。

`system` 已移除，配置中出现时会直接校验失败。

### captureMode

- `direct_material`：用户直接提供的文档、规则或材料。
- `explicit_remember`：用户明确要求“记住”“以后按此执行”。
- `verified_task`：任务已经实际执行并验证成功，可沉淀可复用结果。
- `automated_session`：从普通会话、机器人或后台日志自动提取；始终进入人工审阅流程。

### visibilityScopes

- `private`：仅本地个人范围。
- `project`：只在匹配 `project_ids` 的项目上下文中可见；没有 project ID 时作为未绑定项目知识处理。
- `team`：允许团队共享场景读取。

查询必须同时满足 caller 的可见范围和知识 frontmatter 的 `visibility`。

### sensitivityClearance

- `public`：只允许公开传播内容。
- `internal`：允许组织或项目内部内容，默认值。
- `confidential`：允许仅授权成员可见的敏感业务信息。
- `secret`：最高敏感级别；API key、token、cookie、私钥等 secret-like 原文仍禁止写入。

clearance 是“最多可读取到哪个级别”，不是给新知识自动打标。

## Embedding、检索与 Reranker

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `embeddings.provider` | `transformers` | `transformers` 使用语义模型；`local` 用于确定性测试 |
| `embeddings.profile` | `multilingual-e5-small` | 默认 multilingual embedding profile |
| `embeddings.model` | `null` | 自定义 Transformers.js 模型 ID 或本地路径；`null` 使用 profile 模型 |
| `embeddings.cacheDir` | `~/.cache/agent-knowledge/models` | Agent Knowledge 自有 Transformers.js 模型缓存 |
| `embeddings.allowRemoteModels` | `false` | 普通命令是否允许模型运行时联网下载；建议保持关闭 |
| `embeddings.retrieval` | `lexical` | 默认查询模式 |
| `embeddings.graphDepth` | `1` | graph / hybrid-graph 的关系遍历深度，只允许 `1` 或 `2` |
| `embeddings.graphDecay` | `0.6` | 每跳图关系分数衰减，范围 `(0,1]` |
| `embeddings.embeddingTopK` | `20` | dense 通道参与融合的最大候选数 |
| `embeddings.rerankerProfile` | `bge-reranker-large` | Cross-encoder reranker profile |
| `embeddings.rerankerModel` | `null` | 自定义 reranker 模型；`null` 使用 profile 模型 |
| `embeddings.rerankerCandidateLimit` | `30` | 送入 cross-encoder 的融合候选数 |
| `embeddings.rerankerResultLimit` | `8` | 重排后的最大结果数 |
| `embeddings.rerankerMinScore` | `0.55` | 低于该融合分数的候选不注入 |
| `embeddings.rerankerBaseWeight` | `0.3` | 基础检索分在最终 rerank 分数中的权重 |
| `embeddings.rerankerModelWeight` | `0.7` | cross-encoder 分数在最终 rerank 分数中的权重 |

### provider

- `transformers`：真实本地语义模型。生产检索使用此项。
- `local`：确定性 token-hash provider，不代表真实语义质量，只用于离线测试、协议检查和 CI。

### profile

- `multilingual-e5-small`：默认选择，适合中文业务知识、英文标识符和中英跨语言查询。
- `bge-small-zh-v1.5`：模型更小，适合资源敏感的纯中文场景；英文和跨语言能力较弱。

### retrieval

- `lexical`：FTS5/BM25 + CJK 2/3-gram。最快、无需模型，适合术语、路径、错误码和明确关键词。
- `hybrid`：lexical + embedding + metadata 通过 RRF 融合。适合同义改写和跨语言查询，需要 embedding 缓存。
- `graph`：先 lexical 找 seed，再沿显式可信知识关系扩展。适合查找依赖流程和配套规则。
- `hybrid-graph`：先 hybrid，再图扩展。召回最广、开销最高，需要 embedding 缓存和图索引。

`graphDepth=1` 更保守；`2` 可以发现多跳依赖，但更容易引入较远上下文。`graphDecay` 越低，远距离候选越难进入前排。

### reranker

`query --rerank` 才会启用 cross-encoder。默认流程是融合 top 30、模型重排、按 `0.55` 过滤、最多保留 8 条。

`rerankerBaseWeight` 与 `rerankerModelWeight` 建议相加为 `1`。提高模型权重可增强语义匹配，但也会增加模型误判对最终排序的影响；阈值和权重应通过 `eval-calibrate` 调整，不要仅凭直觉修改。

模型管理：

```bash
agent-knowledge embedding status
agent-knowledge embedding download
```

两条命令在交互终端未传 `--kind` 时，会选择 Embedding 或 Reranker。普通查询保持 `allowRemoteModels=false`，避免任务执行中意外联网和长时间阻塞。

## Integration

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `integration.product` | `trae` | 默认安装产品 |
| `integration.scope` | `user` | 默认安装到用户级或当前项目 |
| `integration.components` | `hooks,agents,skills` | 默认安装的组件 |
| `integration.targetDir` | `null` | 自定义产品配置根目录；`null` 使用产品标准位置 |
| `integration.mode` | `merge` | `merge` 保留外部配置；`overwrite` 替换目标 |

### product

- `trae`：管理 `.trae`；Hooks 同时写 `.trae/hooks.json` 和 `.trae/cli/hooks.json`。
- `trae-cn`：管理 `.trae-cn` 和 `.trae-cn/hooks.json`。
- `claude-code`：管理 `.claude` 和 `.claude/settings.json`。

### scope

- `user`：安装到用户配置目录，供多个项目使用。
- `project`：安装到当前项目目录，仅该项目生效。

### components

- `hooks`：生命周期 Hook 配置。
- `agents`：`memory-reader` 和 `memory-writer` 模板。
- `skills`：`knowledge-organizer`、`memory-maintainer` 等项目 Skill。
- `plugin-bundle`：TRAE plugin bundle；只在产品支持时选择。

### mode

- `merge`：推荐。结构化合并 JSON，只替换 Agent Knowledge 自有 Hook；保留第三方配置，未托管同名资源报告冲突。
- `overwrite`：删除目标文件、目录或 symlink 后写入模板；不会删除 symlink 指向的外部源文件。

配置只保存 integration 默认答案。真正安装仍需显式运行：

```bash
agent-knowledge integration install
```

## 同步

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `sync.provider` | `none` | `webdav` 或 `s3` 启用远端同步 |
| `sync.intervalMinutes` | `0` | `0` 禁用定时同步；正数用于 `sync watch` |
| `sync.visibilityScopes` | `project,team` | 允许上传的知识可见范围 |
| `sync.sensitivityClearance` | `internal` | 允许上传的最高敏感级别 |
| `sync.webdav.url` | 空 | WebDAV collection/base URL |
| `sync.webdav.username` | 空 | WebDAV 用户名 |
| `sync.webdav.passwordEnv` | `WEBDAV_PASSWORD` | 保存密码的环境变量名 |
| `sync.s3.bucket` | 空 | S3 bucket |
| `sync.s3.region` | `us-east-1` | S3 region |
| `sync.s3.prefix` | 空 | 对象 key 前缀，用于隔离知识库 |
| `sync.s3.endpoint` | `null` | S3-compatible endpoint；`null` 使用 AWS |
| `sync.s3.forcePathStyle` | `false` | MinIO 等服务是否使用 path-style 寻址 |
| `sync.s3.accessKeyIdEnv` | `AWS_ACCESS_KEY_ID` | access key ID 环境变量名 |
| `sync.s3.secretAccessKeyEnv` | `AWS_SECRET_ACCESS_KEY` | secret key 环境变量名 |
| `sync.s3.sessionTokenEnv` | `AWS_SESSION_TOKEN` | 可选 session token 环境变量名 |

### provider

- `none`：不配置远端同步。
- `webdav`：适合个人 NAS、坚果云或支持 WebDAV 的文件服务。
- `s3`：适合 AWS S3、MinIO 和其他 S3-compatible object storage。

`intervalMinutes` 只由 `sync watch` 消费。`0` 不会创建后台任务；正数也不会自动安装 cron/systemd/launchd，必须显式运行并托管 `sync watch`。

同步策略同时检查知识 frontmatter 的 visibility 和 sensitivity。默认不上传 `private` 或高于 `internal` 的知识；`.memory`、`_inbox`、`_archive`、`_inbox-skills` 和凭据不参与同步。

## Hook

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `hooks.minScore` | `0.55` | `UserPromptSubmit` 自动注入所需的最低首条结果分数 |
| `hooks.maxTokens` | `1200` | Hook context packet 的最大估算 token 预算 |
| `hooks.catalogMaxItems` | `5` | 用户明确询问知识目录时最多展示的相关条数，范围 `1-20` |
| `hooks.detailedSubagentLogging` | `true` | 是否保存完整本地 SubagentStart/Stop 调试日志 |

`minScore` 只影响自动 Hook 注入，不阻止人工 `query --debug` 查看低分候选。无命中或低于阈值时 Hook stdout 为空，避免污染上下文。

`catalogMaxItems` 只在用户明确询问“有哪些知识/SOP/记忆目录”时使用；普通任务不会注入 catalog。

`detailedSubagentLogging=true` 会把原始 Subagent payload 保存到 `.memory/subagents`。它不参与同步或上下文注入，当前用于调试触发与输出质量；环境稳定后可在配置中关闭。

## 推荐配置

个人电脑：

- `actorType=owner`
- `captureMode=direct_material`
- `retrieval=lexical`；同义召回需求明显时改 `hybrid`
- `sync.provider=none` 或个人 WebDAV/S3
- `hooks.minScore=0.55`

客服机器人：

- 使用独立 `knowledgeRoot`
- `actorType=customer`
- `captureMode=automated_session`
- `visibilityScopes=project,team`
- `sensitivityClearance=internal`
- `sync.visibilityScopes=project,team`
- 不自动接受 proposal 或晋升 inbox
