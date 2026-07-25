# Context Infrastructure 调研与 Agent 模板演进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Context Infrastructure 深度调研，并安全重命名 Subagent 模板、增强直接材料确认门禁。

**Architecture:** 调研报告独立记录外部证据和项目改进建议；integration manager 通过 manifest/hash 迁移受管旧模板；knowledge-organizer 用文档级确认协议阻止歧义或疑似错误知识写入。

**Tech Stack:** TypeScript、Markdown/YAML Subagent 模板、Vitest、结构化 integration manifest。

---

### Task 1: Context Infrastructure 深度调研

**Files:**
- Create: `docs/research/2026-07-26-context-infrastructure-evaluation.md`

- [ ] 审计文章、仓库 commit、README、AGENTS、Observer/Reflector、记忆 PRD、Skills/Axioms、语义检索和定时任务。
- [ ] 区分方法论、参考实现、个人内容和可复用架构。
- [ ] 与本项目 observation/proposal/inbox、retrieval/eval、graph、sync 和 templates 对比。
- [ ] 给出采用、部分采用和不采用清单，以及分阶段改进建议。
- [ ] 提交：

```bash
git add docs/research/2026-07-26-context-infrastructure-evaluation.md
git commit -m "docs: evaluate context infrastructure architecture"
```

### Task 2: 重命名 Subagent 模板

**Files:**
- Rename: `templates/trae/agents/memory-reader.md` -> `templates/trae/agents/agent-knowledge-reader.md`
- Rename: `templates/trae/agents/memory-writer.md` -> `templates/trae/agents/agent-knowledge-writer.md`
- Rename: `templates/claude-code/agents/memory-reader.md` -> `templates/claude-code/agents/agent-knowledge-reader.md`
- Rename: `templates/claude-code/agents/memory-writer.md` -> `templates/claude-code/agents/agent-knowledge-writer.md`
- Rename: `templates/trae/plugin/agents/memory-reader.md` -> `templates/trae/plugin/agents/agent-knowledge-reader.md`
- Rename: `templates/trae/plugin/agents/memory-writer.md` -> `templates/trae/plugin/agents/agent-knowledge-writer.md`
- Modify: `src/integration/manager.ts`
- Modify: `tests/templates.test.ts`
- Modify: `src/cli/integration.ts`

- [ ] 先更新测试，要求新安装只生成新名称。
- [ ] 增加已有 manifest 旧模板未修改时自动迁移测试。
- [ ] 增加旧模板被用户修改时保留并报告测试。
- [ ] 实现 manifest-aware 旧资源退休。
- [ ] 更新模板 frontmatter 和正文自称。
- [ ] 运行 integration/template 测试。
- [ ] 提交：

```bash
git add src templates tests
git commit -m "feat: rename agent knowledge subagents"
```

### Task 3: 增强 Knowledge Organizer 确认门禁

**Files:**
- Modify: `.trae/skills/knowledge-organizer/SKILL.md`
- Modify: `templates/trae/plugin/skills/knowledge-organizer/SKILL.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Test: `tests/templates.test.ts`

- [ ] 写模板测试，要求项目/plugin Skill 都包含垂直领域确认、疑似错误、批量提问和未确认不写入。
- [ ] 更新两个 Skill。
- [ ] 同步 README、governance 和 AGENTS 流程约定。
- [ ] 运行模板和全量测试。
- [ ] 提交：

```bash
git add .trae templates docs README.md AGENTS.md tests
git commit -m "docs: require confirmation for uncertain domain knowledge"
```

### Task 4: 最终联动与验证

**Files:**
- Modify: `templates/trae/README.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/integrations.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] 更新所有当前推荐名称；历史设计文档保留旧名称作为历史事实。
- [ ] 检查 TRAE/Claude/plugin/Windows Hook，无命令变化则不修改。
- [ ] 运行 `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm check:comments`。
- [ ] 检查 Git clean，确认用户 `TODO` 文件未提交。
- [ ] 提交最终文档更新。
