# Agent Knowledge

Agent Knowledge 是一个本地、可审计的 Agent 知识持久化工具。Markdown 是唯一事实源；SQLite、embedding、日志和 staging 都是可重建的机器产物。

## 快速开始

```bash
pnpm install
pnpm build
npm install -g .
```

首次使用运行交互式配置：

```bash
agent-knowledge configure
```

向导会解释并保存：

- 知识库位置。
- `actor_type`、`capture_mode`、可见性和敏感级别。
- embedding provider、profile 和检索模式。
- TRAE / TRAE CN / Claude Code integration。
- WebDAV / S3 和定时同步间隔。

安装 Agent 产品接入；不传参数时会交互式选择：

```bash
agent-knowledge integration install
```

初始化并查询：

```bash
agent-knowledge init
agent-knowledge index
agent-knowledge query --task "审查 Vue SFC lint 迁移方案"
```

## 功能目录

- [用户配置与优先级](docs/guides/configuration.md)
- [知识检索、Embedding 与评测](docs/guides/retrieval.md)
- [候选写入、主动记忆与客服治理](docs/guides/memory-governance.md)
- [TRAE、TRAE CN 与 Claude Code 接入](docs/guides/integrations.md)
- [WebDAV、S3 与定时同步](docs/guides/synchronization.md)
- [研究与设计文档](#研究与设计)

## 核心原则

- `knowledge/**/*.md` 是唯一事实源。
- `_inbox` 和 `_archive` 永远不会进入正式检索。
- 自动会话和客户陈述只能生成 proposed observation，不能直接激活。
- 查询和关系扩展都执行 validity、visibility、sensitivity 和 project 过滤。
- 同步只处理正式 Markdown；冲突必须人工解决，不能静默覆盖。
- Integration 默认结构化 merge；只有显式 overwrite 才删除目标文件或 symlink。

## 常用命令

```bash
# 配置
agent-knowledge configure
agent-knowledge --locale en --help
agent-knowledge config show
agent-knowledge config path

# Integration
agent-knowledge integration list
agent-knowledge integration install
agent-knowledge integration doctor --product trae --scope user

# 知识库
agent-knowledge init
agent-knowledge index
agent-knowledge list
agent-knowledge catalog
agent-knowledge organize-inbox

# 检索与 embedding
agent-knowledge embed-index
agent-knowledge embedding status
agent-knowledge embedding download
agent-knowledge query --task "当前任务" --debug
agent-knowledge eval --input eval/cases/retrieval-baseline.yaml
agent-knowledge eval --fixture eval/cases/retrieval-complete.yaml --pipeline lexical
agent-knowledge eval-calibrate --input calibration-observations.json

# 同步
agent-knowledge sync run
agent-knowledge sync watch

# 主动记忆 staging
agent-knowledge staging status
agent-knowledge staging drain --limit 100
agent-knowledge maintenance run --input observations.json
```

## 默认位置

用户配置：

```text
~/.config/agent-knowledge/config.json
```

默认 workspace root：

```text
~/.agent_knowledge
```

其中包含：

```text
knowledge/                         Markdown 事实源
.memory/index.sqlite              可重建检索索引
.memory/embeddings/               可重建向量缓存
.memory/logs/                     运行摘要
.memory/staging/                  脱敏主动记忆事件
```

命令行显式参数优先于用户配置；用户配置优先于兼容环境变量。完整规则见[配置指南](docs/guides/configuration.md)。

## 开发

```bash
pnpm test
pnpm typecheck
pnpm build
node dist/cli.js --help
```

测试不得依赖远程模型或真实 WebDAV/S3 服务。

## 研究与设计

- [Hivemind、Agent Memory 与 Embedding 评测](docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md)
- [项目知识、同步、客服投毒与主动记忆](docs/research/2026-07-19-project-memory-sync-and-poisoning.md)
- [Agent Knowledge 演进设计](docs/superpowers/specs/2026-07-19-agent-knowledge-evolution-design.md)
- [Agent Knowledge 演进实施计划](docs/superpowers/plans/2026-07-19-agent-knowledge-evolution.md)
