# 项目配置、日志清理与真实业务知识库实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加项目配置分层与安全日志清理，并用递归飞书材料构建、评测和优化本地私有业务知识库。

**Architecture:** `src/core/config.ts` 负责部分配置递归合并和 source 解析，CLI 只消费生效配置并提供 scope-aware 向导。Maintenance 先把 feedback 日志固化到 ledger，再清理已消费原始日志；正式知识发现继续通过统一路径策略。私有飞书原文、项目知识和私有 eval 全部位于 gitignore 路径，只有通用实现、脱敏 fixture 和文档提交 Git。

**Tech Stack:** TypeScript、Zod、Commander、Vitest、Node test、SQLite FTS5、Transformers.js、lark-cli、Markdown/YAML。

---

### Task 1: 项目级配置合并

**Files:**
- Modify: `src/core/config.ts`
- Create: `src/core/projectConfig.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/configure.ts`
- Modify: `src/index.ts`
- Test: `tests/config.test.ts`
- Test: `tests/configCli.test.ts`

- [ ] **Step 1: 写项目配置发现与递归合并失败测试**

覆盖：

```text
user < .agent-knowledge.json < .agent-knowledge.local.json
```

并断言对象递归合并、数组整体替换、非 Git cwd 回退、`--config` 仅替换用户层。

- [ ] **Step 2: 运行配置测试确认失败**

Run:

```bash
pnpm exec vitest run tests/config.test.ts tests/configCli.test.ts
```

Expected: FAIL，缺少 project config API 和 source 输出。

- [ ] **Step 3: 实现项目配置模块**

提供：

```ts
resolveProjectConfigRoot(cwd)
getProjectConfigPaths(cwd)
mergeConfigSources(user, project, local)
loadEffectiveConfig({ userConfigPath, cwd })
```

深度合并只处理 plain object；数组和 scalar 由高优先级整体替换。

- [ ] **Step 4: CLI 接入生效配置**

启动时解析：

```text
user source -> project -> local -> locale/command explicit
```

新增：

```bash
agent-knowledge config sources
agent-knowledge configure --scope user|project|project-local
```

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run tests/config.test.ts tests/configCli.test.ts
pnpm check:comments
pnpm typecheck
pnpm build
```

Commit:

```bash
git add src/core/config.ts src/core/projectConfig.ts src/cli.ts src/cli/configure.ts src/index.ts tests/config.test.ts tests/configCli.test.ts
git commit -m "feat: add layered project configuration"
```

### Task 2: 本地配置忽略与配置文档

**Files:**
- Modify: `.gitignore`
- Modify: `README.md`
- Modify: `docs/guides/configuration.md`
- Modify: `AGENTS.md`
- Modify: `templates/trae/README.md`

- [ ] **Step 1: 忽略项目 local 配置**

加入：

```gitignore
.agent-knowledge.local.json
```

共享 `.agent-knowledge.json` 不忽略。

- [ ] **Step 2: 文档化三层配置**

说明：

- 文件名。
- 发现根目录。
- 合并优先级。
- 数组替换语义。
- `--config`、`--root`、`--locale` 行为。
- project-local 不提交 Git。

- [ ] **Step 3: 验证并提交**

Run:

```bash
node dist/cli.js config sources
node dist/cli.js config show
git check-ignore .agent-knowledge.local.json
git diff --check
```

Commit:

```bash
git add .gitignore README.md docs/guides/configuration.md AGENTS.md templates/trae/README.md
git commit -m "docs: explain project configuration layers"
```

### Task 3: Feedback ledger 与日志清理

**Files:**
- Create: `src/memory/feedbackLedger.ts`
- Create: `src/memory/cleanup.ts`
- Modify: `src/memory/maintenance.ts`
- Modify: `src/hooks/subagentLogs.ts`
- Modify: `src/memory/observations.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Test: `tests/maintenanceCleanup.test.ts`
- Modify: `tests/maintenance.test.ts`

- [ ] **Step 1: 写 ledger/cleanup 失败测试**

覆盖：

- 同 `memoryId + queryRunId` 最新值获胜。
- ledger 跨日志删除保留。
- pending SubagentStop 时拒绝删除。
- 无 pending 时删除 daily subagent JSONL 并重置 source watermark。
- 只删除 feedback 行，保留 query/catalog/Hook 日志。
- dry-run 不写文件。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm exec vitest run tests/maintenanceCleanup.test.ts tests/maintenance.test.ts
```

- [ ] **Step 3: 实现 feedback ledger**

路径：

```text
.memory/feedback/ledger.json
```

API：

```ts
refreshFeedbackLedger(rootDir)
readFeedbackScores(rootDir)
```

`generateMaintenanceProposals` 改为读取 ledger。

- [ ] **Step 4: 实现安全 cleanup**

API：

```ts
planMaintenanceCleanup(rootDir)
applyMaintenanceCleanup(rootDir)
```

CLI：

```bash
agent-knowledge maintenance cleanup
agent-knowledge maintenance cleanup --apply
```

- [ ] **Step 5: 验证并提交**

Run:

```bash
pnpm exec vitest run tests/maintenanceCleanup.test.ts tests/maintenance.test.ts tests/observations.test.ts tests/feedback.test.ts
pnpm check:comments
pnpm typecheck
pnpm build
```

Commit:

```bash
git add src/memory/feedbackLedger.ts src/memory/cleanup.ts src/memory/maintenance.ts src/hooks/subagentLogs.ts src/memory/observations.ts src/cli.ts src/index.ts tests/maintenanceCleanup.test.ts tests/maintenance.test.ts
git commit -m "feat: clean consumed maintenance logs"
```

### Task 4: 中文 Maintenance Skill 与推荐流程

**Files:**
- Modify: `.trae/skills/memory-maintainer/SKILL.md`
- Modify: `templates/trae/plugin/skills/memory-maintainer/SKILL.md`
- Modify: `README.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `templates/trae/README.md`
- Test: `tests/templates.test.ts`

- [ ] **Step 1: 中文化两个 Skill**

完整中文描述：

- AI 自动执行 status/run/list/show/cleanup。
- 用户决定 accept/reject/approve/install。
- cleanup 安全前置条件。
- feedback 去重和独立 session 门槛。

- [ ] **Step 2: README 增加 AI 维护入口**

每周维护说明：

```text
也可以直接要求 AI 使用 memory-maintainer Skill：
运行维护、汇总提案、清理已消费日志；由用户决定接受、拒绝和安装。
```

- [ ] **Step 3: 模板契约测试**

断言安装后的 project/plugin maintainer：

- 包含中文说明。
- 包含 `maintenance cleanup --apply`。
- 包含“用户决定”边界。

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm exec vitest run tests/templates.test.ts
git diff --check
```

Commit:

```bash
git add .trae/skills/memory-maintainer/SKILL.md templates/trae/plugin/skills/memory-maintainer/SKILL.md README.md docs/guides/memory-governance.md templates/trae/README.md tests/templates.test.ts
git commit -m "docs: localize maintenance workflow"
```

### Task 5: 本项目 local 配置与私有 workspace

**Files:**
- Modify: `.agent-knowledge.local.json`（ignored）
- Remove: `knowledge/` existing local contents（ignored）
- Create: `local_exports/` content（ignored）

- [ ] **Step 1: 记录全局生效配置**

Run:

```bash
agent-knowledge config show
agent-knowledge embedding status --kind embedding
agent-knowledge embedding status --kind reranker
```

- [ ] **Step 2: 重建本地私有目录**

删除当前 ignored `knowledge/`，重新初始化项目 workspace。

- [ ] **Step 3: 写 project-local 配置**

以全局配置为基线：

```json
{
  "knowledgeRoot": "<repo-root>",
  "embeddings": {
    "cacheDir": "/Users/bytedance/.cache/agent-knowledge/models",
    "allowRemoteModels": false
  }
}
```

保留 profile/model/reranker 设置。

- [ ] **Step 4: 验证**

Run:

```bash
agent-knowledge config sources
agent-knowledge config show
agent-knowledge embedding status --kind embedding
agent-knowledge embedding status --kind reranker
git status --short
```

Expected: project-local 生效，配置和私有目录均未出现在 Git 状态。

### Task 6: 飞书递归材料导出

**Files:**
- Create: `scripts/fetch-lark-corpus.mjs`
- Create: `tests/larkCorpus.test.mjs`
- Create: `local_exports/lark/**`（ignored runtime）
- Modify: `package.json`

- [ ] **Step 1: 写离线解析测试**

用脱敏 fixture 覆盖 Wiki/Doc URL、`cite`、`synced_reference`、重复 token 和循环引用去重。

- [ ] **Step 2: 实现递归 exporter**

脚本参数：

```bash
node scripts/fetch-lark-corpus.mjs \
  --root-url <wiki-url> \
  --output local_exports/lark \
  --as user
```

调用 `lark-cli wiki +node-get`、`lark-cli docs +fetch`，写 manifest、raw JSON、规范化正文和引用关系。

- [ ] **Step 3: 运行五个 root**

对用户提供的五个 URL 执行，递归到所有未访问内嵌 Doc/Wiki；嵌入 Sheet/Base 按对应 CLI 读取或记录不可读原因。

- [ ] **Step 4: 验证和提交通用脚本**

Run:

```bash
node --test tests/larkCorpus.test.mjs
find local_exports/lark -type f | wc -l
git status --short
```

Commit only generic script/test:

```bash
git add scripts/fetch-lark-corpus.mjs tests/larkCorpus.test.mjs package.json
git commit -m "feat: export recursive lark corpus"
```

### Task 7: 使用 Knowledge Organizer 构建私有知识

**Files:**
- Create/Modify: `knowledge/**`（ignored）
- Create: `local_exports/organizer/**`（ignored）

- [ ] **Step 1: 导入全局 active knowledge**

复制或通过结构化材料导入 `/Users/bytedance/.agent_knowledge/knowledge` 中 24 条 active knowledge，保留 ID/source/aliases/relations。

- [ ] **Step 2: 为每份飞书材料生成 source knowledge**

完整正文落 source knowledge；稳定业务知识拆到 semantic/procedural。

- [ ] **Step 3: 运行 organizer**

按 `.trae/skills/knowledge-organizer/SKILL.md`：

```bash
agent-knowledge capture-material --input <batch.json> --target active
```

- [ ] **Step 4: 重建全部索引**

```bash
agent-knowledge index
agent-knowledge embed-index
agent-knowledge graph build
agent-knowledge catalog
```

- [ ] **Step 5: 审计**

检查 secret、个人隐私、重复 ID、失效关系、domain 层级和 source provenance。

### Task 8: 私有评测与循环优化

**Files:**
- Create: `local_exports/eval/business-private.yaml`（ignored）
- Create/Modify: `eval/cases/business-knowledge-sanitized.yaml`
- Modify: retrieval/knowledge metadata only when evidence supports
- Test: `tests/eval.test.ts`

- [ ] **Step 1: 构建私有 case**

从文档内容生成正向、同义、跨语言、hard-negative、multi-hop、temporal 和 no-answer case。

- [ ] **Step 2: 跑四种检索**

```bash
agent-knowledge eval --input local_exports/eval/business-private.yaml --pipeline lexical
agent-knowledge eval --input local_exports/eval/business-private.yaml --pipeline hybrid
```

Graph case 使用 CLI query batch runner，记录 Top-K 与 graphExpansion。

- [ ] **Step 3: 诊断和优化**

逐轮调整：

- aliases
- domain/scenario
- title/summary
- related_knowledge
- CJK token evidence
- reranker threshold/weights（只在 eval 支持时）

- [ ] **Step 4: 重复直到达标**

每轮保存指标和误召回分析到 ignored report。

- [ ] **Step 5: 提交脱敏 eval**

Run:

```bash
pnpm exec vitest run tests/eval.test.ts
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
```

Commit:

```bash
git add eval/cases/business-knowledge-sanitized.yaml tests/eval.test.ts README.md docs/guides/retrieval.md
git commit -m "test: add sanitized business retrieval evaluation"
```

### Task 9: 最终验证与审计

**Files:**
- Modify only final evidence docs if needed.

- [ ] **Step 1: 全量验证**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
pnpm test:comments
```

- [ ] **Step 2: 真实 CLI smoke**

验证：

- 项目配置优先级。
- maintenance run/cleanup。
- knowledge organize/approve。
- embedding/reranker 使用全局缓存。
- graph HTML 和 graph retrieval。
- 五个飞书 root 与内嵌文档 manifest 完整。

- [ ] **Step 3: Git 审计**

```bash
git status --short
git ls-files | rg '(^|/)(knowledge|local_exports|\\.memory)(/|$)'
git check-ignore .agent-knowledge.local.json knowledge local_exports .memory
```

- [ ] **Step 4: 最终提交**

只在有最终通用文档/测试变更时提交；私有数据保持 ignored。
