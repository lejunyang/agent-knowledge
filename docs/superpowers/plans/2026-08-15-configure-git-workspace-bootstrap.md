# Configure Git Workspace Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `agent-knowledge configure` 默认一次完成配置写入和安全 Git 知识 workspace 初始化，并把所有首次使用示例统一到规范默认目录 `~/.agent_knowledge`。

**Architecture:** 配置向导继续只负责收集和验证答案；CLI orchestration 在拿到完整配置后，先对 `configured.knowledgeRoot` 执行幂等 `initializeKnowledgeGitWorkspace()`，成功后才原子写配置。`--no-git-init` 是显式逃生口，用于已有非 Git workspace 或调用方明确管理 Git 的场景；project/project-local scope 同样默认初始化其生效 `knowledgeRoot`。既有 `workspace git-init/status` 保留为独立修复、迁移和诊断命令。

**Tech Stack:** TypeScript、Commander、Inquirer、Vitest、Git CLI、现有 project config 与 Git workspace 模块。

---

### Task 1: 把配置写入与 workspace 初始化拆成可事务编排步骤

**Files:**
- Modify: `src/cli/configure.ts`
- Modify: `tests/config.test.ts`

- [ ] **Step 1: 写“只收集不落盘”的失败测试**

为 `runConfigurationWizard` 增加 `write?: boolean`，测试：

```ts
const configured = await runConfigurationWizard({
  configPath,
  prompter,
  current,
  write: false
});

expect(configured.knowledgeRoot).toBe(root);
await expect(readFile(configPath, "utf8")).rejects.toThrow();
```

- [ ] **Step 2: 运行测试确认当前向导总会写配置**

Run:

```bash
pnpm vitest run tests/config.test.ts
```

Expected: FAIL，`write` 选项尚不存在或配置文件仍被创建。

- [ ] **Step 3: 实现可延迟写入**

签名：

```ts
export async function runConfigurationWizard(options: {
  configPath: string;
  prompter: ConfigurationPrompter;
  current: UserConfig;
  locale?: SupportedLocale;
  write?: boolean;
}): Promise<UserConfig>
```

末尾仅在 `options.write !== false` 时调用 `writeUserConfig()`。默认行为保持兼容，已有单元测试不变。

- [ ] **Step 4: 运行配置测试和类型检查**

Run:

```bash
pnpm vitest run tests/config.test.ts
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交向导事务边界**

```bash
git add src/cli/configure.ts tests/config.test.ts
git commit -m "refactor: separate configuration collection from persistence

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 2: Configure 默认初始化 Git workspace

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/configCli.test.ts`

- [ ] **Step 1: 写默认初始化和帮助失败测试**

新增 CLI 测试，使用确定性 stdin 回答向导后断言：

```ts
expect(help).toContain("--no-git-init");
expect(help).toContain("默认在 knowledgeRoot 初始化");
expect(await readFile(path.join(root, ".gitignore"), "utf8"))
  .toContain(".vault/");
expect(await readFile(path.join(root, "SECURITY.md"), "utf8"))
  .toContain("Knowledge Data Security");
expect(await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"]))
  .toMatchObject({ stdout: expect.stringContaining("true") });
expect(JSON.parse(await readFile(configPath, "utf8")).knowledgeRoot).toBe(root);
```

- [ ] **Step 2: 写失败原子性测试**

把 `knowledgeRoot` 指向另一个 Git worktree 内部目录，断言 configure 失败且原用户配置文件内容保持不变：

```ts
await expect(runConfigure()).rejects.toThrow(/separate directory/);
expect(await readFile(configPath, "utf8")).toBe(previousConfig);
```

- [ ] **Step 3: 写显式关闭测试**

运行：

```text
agent-knowledge configure --no-git-init
```

断言配置被保存，但 `knowledgeRoot/.git`、`SECURITY.md` 和安全 `.gitignore` 未创建。

- [ ] **Step 4: 实现 CLI 编排**

命令新增：

```ts
.option(
  "--no-git-init",
  t(
    "不初始化 knowledgeRoot 的本地 Git 数据仓库",
    "do not initialize a local Git data repository at knowledgeRoot"
  )
)
```

执行顺序：

```ts
const configured = await runConfigurationWizard({
  configPath,
  prompter,
  current: effective.config,
  locale,
  write: false
});
if (options.gitInit) {
  await initializeKnowledgeGitWorkspace(configured.knowledgeRoot);
}
writeUserConfig(configPath, configured);
```

输出增加：

```text
知识 workspace：<root>（Git 已初始化）
```

或 `--no-git-init` 时明确输出“Git 初始化已跳过”。不得自动添加 remote、commit 或 push。

- [ ] **Step 5: 运行 CLI、Git workspace 和帮助测试**

Run:

```bash
pnpm vitest run tests/configCli.test.ts tests/gitWorkspace.test.ts
pnpm typecheck
pnpm build
node dist/cli.js configure --help
```

Expected: PASS，help 展示默认 Git 初始化及关闭选项。

- [ ] **Step 6: 提交默认一体化初始化**

```bash
git add src/cli.ts tests/configCli.test.ts
git commit -m "feat: initialize Git workspace during configure

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 3: 统一默认目录与首次使用流程

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/configuration.md`
- Modify: `.trae/skills/agent-knowledge-guide/SKILL.md`
- Modify: `.trae/skills/agent-knowledge-guide/references/workflows.md`
- Modify: `templates/trae/plugin/skills/agent-knowledge-guide/SKILL.md`
- Modify: `templates/trae/plugin/skills/agent-knowledge-guide/references/workflows.md`
- Modify: `templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide/SKILL.md`
- Modify: `templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide/references/workflows.md`

- [ ] **Step 1: 把推荐首次命令收敛为 configure**

推荐流程改为：

```bash
agent-knowledge configure
agent-knowledge integration install
agent-knowledge index
agent-knowledge knowledge audit
```

解释 configure 默认：

- 使用或询问 `knowledgeRoot`，默认 `~/.agent_knowledge`。
- 初始化 V2 目录、private-data-safe Git、`.gitignore` 和 `SECURITY.md`。
- 保存身份、检索、Integration、同步、Vault key 环境变量名和 Hook 默认值。
- 不添加 Git remote、不 commit、不 push、不安装 Integration、不下载模型。

- [ ] **Step 2: 统一示例目录**

首次使用、Git workspace、Vault、ingest 和 source 示例统一使用：

```text
~/.agent_knowledge
```

`/secure/agent-knowledge-data`、`/srv/agent-knowledge-data` 等部署示例保留，因为它们不是默认路径。
旧设计/计划文档保留历史原文，不批量改写。

- [ ] **Step 3: 说明独立命令仍然有用**

文档明确：

- `workspace git-init --root <dir>`：已有配置之外的显式初始化/修复/迁移入口。
- `workspace git-status --root <dir>`：Git 诊断。
- `init --root <dir>`：只建 V2 目录，不建 Git；主要用于临时、测试或 `--no-git-init` 场景。
- 已有 Git repo 时 configure 幂等执行，不覆盖已有 `.gitignore` / `SECURITY.md`。

- [ ] **Step 4: 同步 Skill 模板**

用 `cmp` 验证 project、TRAE plugin、Codex marketplace 的 guide Skill 和 workflows 零差异。

- [ ] **Step 5: 运行文档/模板回归**

Run:

```bash
pnpm vitest run tests/templates.test.ts tests/configCli.test.ts
cmp .trae/skills/agent-knowledge-guide/SKILL.md templates/trae/plugin/skills/agent-knowledge-guide/SKILL.md
cmp .trae/skills/agent-knowledge-guide/SKILL.md templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide/SKILL.md
```

Expected: PASS。

- [ ] **Step 6: 提交首次使用文档**

```bash
git add README.md AGENTS.md docs/guides/configuration.md .trae/skills/agent-knowledge-guide templates/trae/plugin/skills/agent-knowledge-guide templates/codex/marketplace/plugins/agent-knowledge/skills/agent-knowledge-guide
git commit -m "docs: make configure the default bootstrap command

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

### Task 4: 完整验证

**Files:**
- Modify: `docs/superpowers/plans/2026-08-15-configure-git-workspace-bootstrap.md`

- [ ] **Step 1: 运行完整门禁**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
```

Expected: 全部 PASS。

- [ ] **Step 2: 运行临时 HOME smoke**

使用隔离 HOME 和确定性输入运行 `configure`，验证：

```text
<home>/.agent_knowledge/.git
<home>/.agent_knowledge/knowledge/
<home>/.agent_knowledge/.gitignore
<home>/.agent_knowledge/SECURITY.md
<home>/.config/agent-knowledge/config.json
```

随后运行：

```bash
agent-knowledge config show
agent-knowledge workspace git-status --root "$HOME/.agent_knowledge"
```

确认配置和 Git root 是同一路径。

- [ ] **Step 3: 记录验证并提交**

```bash
git add docs/superpowers/plans/2026-08-15-configure-git-workspace-bootstrap.md
git commit -m "docs: record configure bootstrap validation

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```
