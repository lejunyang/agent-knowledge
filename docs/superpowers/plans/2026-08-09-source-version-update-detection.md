# Source Version Update Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为文件、会话、Git 仓库文档和离线飞书导出保存可复用的 Connector 登记，并提供不读取正文、不写 Vault/manifest 的轻量更新检测。

**Architecture:** `src/ingestion/registry.ts` 在本地 `.memory/ingestion/connectors/` 保存 0600 Connector 登记，绝不进入 Git 或同步；现有 `ingest` 命令在真正摄入前完成 scope 校验与登记。`src/ingestion/sourceUpdates.ts` 只调用 Connector 的 inventory/discover/probe，根据 manifest 当前版本、`path_hash`、其他上游版本信号和 processing profile 生成更新报告，报告写入 `.memory/ingestion/update-checks/`。本轮不静默联网：Git 检查注册的本地 ref，飞书检查最新离线 export；用户必须先显式 fetch/pull 或刷新飞书导出，未来在线 Connector 可复用同一契约。

**Tech Stack:** TypeScript、Zod、Commander、Vitest、Node.js fs/crypto、现有 Connector/source manifest/Vault 契约。

---

### Task 1: Connector 本地登记表

**Files:**
- Create: `src/ingestion/registry.ts`
- Modify: `src/index.ts`
- Test: `tests/connectorRegistry.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖以下契约：

```ts
const registered = await registerConnector(root, {
  kind: "git",
  connectorId: "business-repository",
  redactionPolicy: "secrets-only",
  options: {
    repositoryDir,
    ref: "HEAD",
    pathspecs: ["README.md", "docs"]
  }
}, {
  inventoryIdentity: "git_inventory_abc"
});

expect((await stat(registered.path)).mode & 0o777).toBe(0o600);
expect(await listConnectorRegistrations(root)).toHaveLength(1);
expect(createConnectorFromRegistration(registered.record)).toBeInstanceOf(
  GitRepositoryConnector
);
```

同时验证：

- `.memory` 登记不保存 Vault key 或凭据值。
- 同 ID、同 inventory identity 可以更新本地仓库/export 路径。
- 同 ID、不同 inventory identity 拒绝覆盖。
- filesystem/transcript 没有 inventory identity 时，改变 baseDir/pattern/project scope 必须换 Connector ID。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/connectorRegistry.test.ts`

Expected: FAIL，提示 `src/ingestion/registry.ts` 不存在。

- [ ] **Step 3: 实现严格登记 schema 与 factory**

新增 discriminated union：

```ts
type ConnectorRegistrationInput =
  | {
      kind: "files";
      connectorId: string;
      redactionPolicy: "secrets-only" | "secrets-and-pii";
      options: {
        baseDir: string;
        patterns: string[];
        artifactKind: "document" | "tool_trace" | "repository";
        projectKeys: string[];
        contentType?: string;
      };
    }
  | {
      kind: "transcripts";
      connectorId: string;
      redactionPolicy: "secrets-and-pii";
      options: {
        baseDir: string;
        patterns: string[];
        projectKeys: string[];
      };
    }
  | {
      kind: "git";
      connectorId: string;
      redactionPolicy: "secrets-only" | "secrets-and-pii";
      options: {
        repositoryDir: string;
        ref: string;
        pathspecs: string[];
        projectKey?: string;
      };
    }
  | {
      kind: "lark-export";
      connectorId: string;
      redactionPolicy: "secrets-and-pii";
      options: {
        exportDir: string;
        projectKeys: string[];
      };
    };
```

登记记录包含 `version: 1`、`registeredAt`、`updatedAt`、`inventoryIdentity` 和
`scopeFingerprint`。路径必须绝对化；文件使用临时文件 + rename 原子写入，权限为 0600。
`createConnectorFromRegistration` 只恢复仓库内置 Connector，不执行网络请求。

- [ ] **Step 4: 运行测试与注释审计**

Run: `pnpm exec vitest run tests/connectorRegistry.test.ts && pnpm typecheck && pnpm check:comments`

Expected: PASS。

### Task 2: 无正文更新检测引擎

**Files:**
- Create: `src/ingestion/sourceUpdates.ts`
- Modify: `src/ingestion/core.ts`
- Modify: `src/index.ts`
- Test: `tests/sourceUpdates.test.ts`

- [ ] **Step 1: 写失败测试**

使用不允许调用 `fetch` 的 Connector，验证：

```ts
const report = await checkConnectorSourceUpdates(root, connector, registration);

expect(connector.fetchCount).toBe(0);
expect(report.summary).toMatchObject({
  unchanged: 1,
  content_changed: 1,
  updatesAvailable: 1
});
```

覆盖状态：

```text
new
unchanged
metadata_only
content_changed
update_unknown
processing_profile_changed
evidence_missing
removed
restored
```

分类规则：

- 共同 `path_hash` 不同：`content_changed`，但最终仍由摄入后的脱敏 content hash 确认。
- 最高优先级内容信号相同、commit/revision/time 等低优先级信号变化：`metadata_only`。
- revision/ETag/mtime 等变化但没有可比较的内容 hash：`update_unknown`。
- 没有共同版本信号：`update_unknown`，不得误报 unchanged。
- processing profile 变化：`processing_profile_changed`。
- manifest 指向的 Vault object 缺失：`evidence_missing`。
- complete inventory 才能报告 `removed`；incomplete/partial inventory 不做删除推断。
- missing source 重新出现：`restored`。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/sourceUpdates.test.ts`

Expected: FAIL，提示更新检测 API 不存在。

- [ ] **Step 3: 导出统一 processing profile 计算**

在 `src/ingestion/core.ts` 新增：

```ts
export function buildIngestionProcessingProfile(
  connector: KnowledgeConnector,
  redactionPolicy: EvidenceRedactionPolicy
): string {
  return `${INGESTION_CORE_PROFILE}:${ConnectorProcessingProfileSchema.parse(
    connector.processingProfile
  )}:${EVIDENCE_REDACTION_PROFILE}:${EvidenceRedactionPolicySchema.parse(
    redactionPolicy
  )}`;
}
```

摄入与更新检测必须共用该函数，不能各自拼字符串。

- [ ] **Step 4: 实现 probe-only 检测与报告持久化**

`checkConnectorSourceUpdates`：

1. 复用 Connector ingestion lock。
2. 校验登记的 inventory identity。
3. 读取该 Connector 的严格 v5 manifest。
4. 调用 `inventoryStatus`、`inventoryVersion` 和 `discover`。
5. 对 descriptor 做 runtime schema 校验，但绝不调用 `fetch/normalize`。
6. 生成完整报告并原子写入
   `.memory/ingestion/update-checks/<connector-hash>.json`，权限 0600。

报告明确保存：

```ts
type SourceUpdateReport = {
  version: 1;
  connectorId: string;
  connectorKind: "files" | "transcripts" | "git" | "lark-export";
  checkedAt: string;
  networkAccess: "none";
  freshnessBoundary: "local-filesystem" | "local-git-ref" | "offline-lark-export";
  inventory: {
    mode: "partial" | "complete";
    complete: boolean;
    unresolved: number;
    removalsEvaluated: boolean;
    reason?: string;
  };
  summary: Record<SourceUpdateState, number> & {
    updatesAvailable: number;
    verificationRequired: number;
  };
  items: SourceUpdateItem[];
};
```

- [ ] **Step 5: 运行聚焦验证**

Run: `pnpm exec vitest run tests/sourceUpdates.test.ts tests/ingestion.test.ts tests/gitRepositoryConnector.test.ts tests/larkExportConnector.test.ts && pnpm typecheck && pnpm check:comments`

Expected: PASS，且旧摄入分类无回归。

### Task 3: 摄入自动登记与 source check CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/configCli.test.ts`
- Test: `tests/connectorRegistry.test.ts`

- [ ] **Step 1: 写 CLI 失败测试**

先通过真实 CLI 摄入文件，再执行：

```bash
agent-knowledge source check \
  --root <workspace> \
  --connector-id business-docs
```

断言：

- 首次摄入自动创建 Connector 登记。
- 未修改时为 `unchanged`。
- 文件版本信号变化时为 `update_unknown`，且 Vault object/manifest 未变化。
- `source check` 不需要 Vault key。
- `--fail-on-updates` 在存在 update 时设置非零退出码，JSON 报告仍完整输出。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/configCli.test.ts`

Expected: FAIL，提示 `source check` 未定义。

- [ ] **Step 3: 把四类 ingest 命令接入登记表**

每个命令在调用 `runConnectorIngestion` 前：

1. 构造严格 `ConnectorRegistrationInput`。
2. 对 complete inventory Connector 获取并校验 `inventoryIdentity`。
3. 写入/更新本地登记。
4. 执行现有 ingestion core。

输出增加非敏感登记摘要，不输出本地路径或配置全文：

```json
{
  "registration": {
    "connectorId": "business-docs",
    "kind": "files",
    "path": ".memory/ingestion/connectors/..."
  }
}
```

- [ ] **Step 4: 实现 source check**

CLI：

```bash
agent-knowledge source check
agent-knowledge source check --connector-id lark-business business-repository
agent-knowledge source check --fail-on-updates
```

默认检查全部已登记 Connector。单个 Connector 失败应进入 `errors`，其他 Connector 继续；
结果始终声明 `networkAccess: none`。不存在登记时返回空结果与明确 next action，不猜测来源。

- [ ] **Step 5: 运行 CLI 聚焦验证**

Run: `pnpm exec vitest run tests/configCli.test.ts tests/connectorRegistry.test.ts tests/sourceUpdates.test.ts && pnpm typecheck`

Expected: PASS。

### Task 4: Source review、质量审计与流程联动

**Files:**
- Modify: `src/storage/sourceReview.ts`
- Modify: `src/storage/qualityAudit.ts`
- Modify: `.trae/skills/source-distiller/SKILL.md`
- Modify: `templates/trae/plugin/skills/source-distiller/SKILL.md`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/evidence-vault.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `docs/guides/synchronization.md`
- Modify: `docs/superpowers/specs/2026-08-09-production-memory-platform-design.md`
- Modify: `templates/trae/README.md`
- Test: `tests/qualityAudit.test.ts`
- Test: `tests/templates.test.ts`

- [ ] **Step 1: 补质量审计与模板失败测试**

断言：

- 已登记但从未检查的 Connector 产生 warning。
- 最新报告含 `content_changed/update_unknown/removed/restored/evidence_missing` 时审计可见。
- metadata-only 单独统计但不误报需要重蒸馏。
- source-distiller 先执行 `source check`，再仅摄入/蒸馏真正变化的 source。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm exec vitest run tests/qualityAudit.test.ts tests/templates.test.ts`

Expected: FAIL，缺少更新健康统计与 Skill 流程。

- [ ] **Step 3: 联动审阅入口与质量报告**

`source list` 顶层 inventory 增加登记数、最近检查时间和待更新数；quality audit summary 增加：

```text
registeredSourceConnectors
uncheckedSourceConnectors
sourceUpdatesAvailable
sourceUpdatesUnknown
```

报告只读取 `.memory` 本地状态，不把路径、token 或正文写入 finding。

- [ ] **Step 4: 更新文档与 Skills**

明确推荐流程：

```bash
# GitHub/Git：先由用户或显式自动化更新本地 ref
git fetch origin
agent-knowledge source check --connector-id business-repository
agent-knowledge ingest git ...

# 飞书：先显式刷新离线导出
node scripts/fetch-lark-corpus.mjs ... --refresh-existing
agent-knowledge source check --connector-id lark-business
agent-knowledge ingest lark-export ...
```

说明：

- manifest 当前版本 + private Git 历史共同保存版本轨迹。
- `source check` 不联网、不读正文、不写 Vault/manifest。
- Git `HEAD` 只代表本地 HEAD；要检查远端应先 fetch 并摄入 remote-tracking ref，或显式 pull。
- Lark export 只代表导出快照；必须先刷新 export 才能判断在线文档更新。
- update check 报告、Connector 本地路径和 checkpoint 不参与 WebDAV/S3 或 Git。

按 AGENTS 流程联动要求检查 TRAE/Claude agents、Hook 模板和 memory-maintainer；若命令不改变
Hook/agent 输入输出则保持不动，并在提交说明中记录“已检查、无需变化”。

- [ ] **Step 5: 运行聚焦验证**

Run: `pnpm exec vitest run tests/qualityAudit.test.ts tests/templates.test.ts tests/sourceReview.test.ts && pnpm typecheck && pnpm check:comments`

Expected: PASS。

### Task 5: 全量验证、构建后冒烟与提交

**Files:**
- Review: all files above

- [ ] **Step 1: 运行全量验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
node --test tests/*.test.mjs
```

Expected: all PASS。

- [ ] **Step 2: 运行 dist CLI 冒烟**

用临时 workspace：

1. `ingest files` 摄入一个版本。
2. `source check` 确认 unchanged。
3. 修改来源文件。
4. `source check` 报告 update，确认 manifest 与 Vault object 未变化。
5. 重新 `ingest files`，确认 manifest 进入 pending/current version 更新。
6. 再次 `source check` 返回 unchanged。
7. 检查 registration/update report 文件权限 0600。

- [ ] **Step 3: 自审与流程联动复核**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

确认没有提交 `dist/`、`.memory/`、`node_modules/` 或测试临时文件；确认 source check 没有网络、
正文读取、Vault 写入、manifest 写入或凭据持久化路径。

- [ ] **Step 4: 创建独立提交**

```bash
git add <本计划涉及的文件>
git diff --cached --check
git commit -m "feat: detect source version updates

Co-authored-by: TRAE CLI <noreply@bytedance.com>"
```

Expected: 一个只包含来源版本登记与更新检测的提交。
