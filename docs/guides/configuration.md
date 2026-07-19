# 用户配置

## 配置向导

```bash
agent-knowledge configure
```

向导使用方向键单选、空格多选、回车确认；路径和自定义模型使用文本输入。

默认写入：

```text
~/.config/agent-knowledge/config.json
```

可用 `XDG_CONFIG_HOME`、`AGENT_KNOWLEDGE_CONFIG` 或全局 `--config <file>` 指定其他位置。

优先级：

1. 命令行显式参数。
2. 用户配置。
3. 兼容环境变量。
4. 内置默认值。

## 配置项

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `locale` | `auto` | `auto` 检测系统语言；支持 `zh-CN` 和 `en`，其他语言回退中文 |
| `knowledgeRoot` | `~/.agent_knowledge` | Markdown、索引、缓存和日志的 workspace root |
| `identity.actorType` | `owner` | 控制写入来源权威性 |
| `identity.captureMode` | `direct_material` | 控制自动内容是否必须审阅 |
| `identity.visibilityScopes` | `private,project,team` | 查询允许读取的可见范围 |
| `identity.sensitivityClearance` | `internal` | 查询允许读取的最高敏感级别 |
| `embeddings.provider` | `transformers` | `transformers` 使用语义模型；`local` 用于确定性测试 |
| `embeddings.profile` | `multilingual-e5-small` | 默认 multilingual embedding profile |
| `embeddings.cacheDir` | `~/.cache/agent-knowledge/models` | Agent Knowledge 自有 Transformers.js 模型缓存 |
| `embeddings.retrieval` | `lexical` | `hybrid` 会合并 lexical 与 dense retrieval |
| `embeddings.rerankerProfile` | `bge-reranker-large` | Cross-encoder reranker profile |
| `embeddings.rerankerCandidateLimit` | `30` | 送入 cross-encoder 的融合候选数 |
| `embeddings.rerankerResultLimit` | `8` | 重排后的最大结果数 |
| `embeddings.rerankerMinScore` | `0.55` | 低于该融合分数的候选不注入 |
| `integration.product` | `trae` | 默认安装产品 |
| `integration.mode` | `merge` | `merge` 保留外部配置；`overwrite` 替换目标 |
| `sync.provider` | `none` | `webdav` 或 `s3` 启用远端同步 |
| `sync.intervalMinutes` | `0` | `0` 禁用定时同步；正数用于 `sync watch` |

配置只保存凭据环境变量名，不保存 secret 值。

`actorType` 可选 `owner`、`teammate`、`customer`、`agent`。其中 `agent` 表示 AI Agent 或自动化服务；`system` 已移除，出现时会直接校验失败。

语言优先级是全局 `--locale` > 用户配置 > `LC_ALL` / `LC_MESSAGES` / `LANG` > 系统 locale。默认和未知系统语言都使用中文说明。

敏感级别：

- `public`：允许公开传播。
- `internal`：组织或项目内部内容，默认权限。
- `confidential`：仅授权成员可见的敏感业务信息。
- `secret`：最高敏感级别；凭据、密钥等 secret-like 原文仍禁止写入知识库。

```bash
agent-knowledge config show
agent-knowledge config path
```
