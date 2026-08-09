# Memory Use Policy Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Retrieval Lesson / Reasoning Policy 产品化为独立 Git 事实源、可审阅 proposal、可回放 shadow simulation 和长期 history，同时保持实时 query enforcement 关闭。

**Architecture:** `policies/retrieval/*.yaml` 与 `policies/reasoning/*.yaml` 是人类审阅、Git 追踪的 Policy 事实源；`.memory/query-runs`、`.memory/policies/proposals` 和 `.memory/policies/simulations` 是可清理或可重建的运行产物。P0 先补足脱敏 query trace 与结构化反馈原因，P1 提供 Policy schema/store/proposal，P2 从 feedback/eval 挖掘候选并做 shadow 回放；P3 runtime enforcement 和 P4 optimizer Agent 仅写入 backlog，不在本阶段改变 query/Hook 行为。

**Tech Stack:** TypeScript、Zod、YAML、Vitest、Commander、现有 Evidence Vault、Git Markdown/YAML workspace。

---

## 文件结构

- Create `src/policy/types.ts`: Policy、proposal、simulation schema。
- Create `src/policy/queryRuns.ts`: 脱敏 query-run append-only ledger 与 packet completion。
- Create `src/policy/store.ts`: Git Policy YAML 和 `.memory` proposal 的安全读写。
- Create `src/policy/mining.ts`: feedback/eval failure 的确定性聚类与 proposal 生成。
- Create `src/policy/simulation.ts`: lexical shadow replay、ReasoningContract 检查与 history。
- Create `src/policy/index.ts`: 公共导出。
- Modify `src/retrieval/query.ts`, `src/retrieval/graph.ts`, `src/retrieval/feedback.ts`: trace 和结构化原因。
- Modify `src/memory/feedbackLedger.ts`: 长期保留 reason/expected/forbidden。
- Modify `src/storage/workspace.ts`, `src/core/paths.ts`, `src/storage/gitWorkspace.ts`: 初始化并追踪 `policies/`。
- Modify `src/cli.ts`, `src/index.ts`: `policy` 命令组。
- Create `.trae/skills/memory-use-policy-maintainer/SKILL.md`: 人工审阅和 shadow 流程。
- Mirror Skill 到 TRAE/Codex plugin bundle。
- Modify README、AGENTS、`docs/guides/retrieval-lessons.md` 和生产评估报告。

### Task 1: Query-Run Evidence Ledger

**Files:**
- Create: `src/policy/queryRuns.ts`
- Create: `src/policy/index.ts`
- Modify: `src/retrieval/query.ts`
- Modify: `src/retrieval/graph.ts`
- Modify: `src/retrieval/contextPacket.ts`
- Modify: `src/index.ts`
- Test: `tests/policyQueryRuns.test.ts`
- Test: `tests/query.test.ts`

- [ ] **Step 1: 写 query-run ledger 失败测试**

覆盖：

```ts
expect(run.taskHash).toMatch(/^sha256:[a-f0-9]{64}$/);
expect(JSON.stringify(run)).not.toContain("完整查询原文");
expect(run.candidateIds).toEqual([...]);
expect(run.injectedIds).toEqual([...]);
expect(run.abstained).toBe(false);
```

同时验证 eval `log: false` 不写 ledger，graph/rerank 只产生一个最终 retrieval event。

- [ ] **Step 2: 运行测试确认失败**

Run:

```bash
pnpm vitest run tests/policyQueryRuns.test.ts tests/query.test.ts
```

Expected: FAIL，缺少 `recordQueryRetrieval` / `recordQueryPacket`。

- [ ] **Step 3: 实现最小 ledger**

契约：

```ts
type QueryRun = {
  version: 1;
  id: string;
  timestamp: string;
  taskHash: `sha256:${string}`;
  taskLength: number;
  taskVaultId?: string;
  domains: string[];
  scenarios: string[];
  projectKeys: string[];
  retrievalMode: string;
  candidateIds: string[];
  injectedIds: string[];
  abstained: boolean;
};
```

`.memory/query-runs/YYYY-MM-DD.jsonl` 权限必须为 `0600`。同 run 的 retrieval/packet 事件读取时合并；不保存 task、token、完整 Markdown 或 result text。

- [ ] **Step 4: 统一 graph/rerank logging**

Graph/hybrid/rerank 的内部 base 查询必须 `log:false`，只对最终结果写一次 query-run；普通 eval 保持零运行日志。

- [ ] **Step 5: 验证并提交**

```bash
pnpm vitest run tests/policyQueryRuns.test.ts tests/query.test.ts tests/graphRetrieval.test.ts tests/reranker.test.ts
pnpm typecheck
git add src/policy src/retrieval src/index.ts tests/policyQueryRuns.test.ts tests/query.test.ts
git commit -m "feat: persist privacy-safe query run evidence"
```

### Task 2: Structured Feedback Reasons And Optional Vault Task Evidence

**Files:**
- Modify: `src/retrieval/feedback.ts`
- Modify: `src/memory/feedbackLedger.ts`
- Modify: `src/cli.ts`
- Test: `tests/feedback.test.ts`
- Test: `tests/maintenanceCleanup.test.ts`
- Test: `tests/configCli.test.ts`

- [ ] **Step 1: 写 reason taxonomy 测试**

支持：

```ts
const FeedbackReasonSchema = z.enum([
  "relevant",
  "wrong_route",
  "missing_expected",
  "forbidden_injection",
  "should_abstain",
  "stale_source",
  "insufficient_detail",
  "conflicting_evidence",
  "reasoning_failure",
  "other"
]);
```

反馈还可包含 `expectedMemoryIds`、`forbiddenMemoryIds`。Ledger 按 `memoryId + queryRunId` 最新值去重后仍保留这些字段。

- [ ] **Step 2: 增加 CLI 失败测试**

```bash
agent-knowledge feedback \
  --memory-id k_bad \
  --usefulness not_useful \
  --reason wrong_route \
  --query-run-id <id> \
  --expected-memory-id k_good \
  --forbidden-memory-id k_bad
```

`query --retain-task-evidence` 必须经 `secrets-and-pii` 脱敏后写入 Vault，并只把 Vault ID 写入 query-run；缺少 Vault key 时明确失败。

- [ ] **Step 3: 实现并验证**

```bash
pnpm vitest run tests/feedback.test.ts tests/maintenanceCleanup.test.ts tests/configCli.test.ts tests/vault.test.ts
pnpm typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/retrieval/feedback.ts src/memory/feedbackLedger.ts src/cli.ts tests
git commit -m "feat: capture memory-use failure reasons"
```

### Task 3: Policy Schema And Git Store

**Files:**
- Create: `src/policy/types.ts`
- Create: `src/policy/store.ts`
- Modify: `src/core/paths.ts`
- Modify: `src/storage/workspace.ts`
- Modify: `src/storage/gitWorkspace.ts`
- Test: `tests/policyStore.test.ts`
- Test: `tests/gitWorkspace.test.ts`

- [ ] **Step 1: 写 schema/store 失败测试**

Policy 公共字段：

```ts
{
  version: 1,
  id: "policy_account_deletion_route",
  kind: "retrieval_lesson" | "reasoning_policy",
  status: "shadow" | "deprecated",
  title: "...",
  rationale: "...",
  priority: 50,
  applicability: {
    domains: [],
    scenarios: [],
    project_keys: [],
    query_terms_any: [],
    query_terms_all: [],
    excluded_terms: []
  },
  evidence: {
    query_run_ids: [],
    feedback_keys: [],
    eval_case_ids: []
  }
}
```

Retrieval directive：`route_domains`、`route_scenarios`、`prefer_memory_ids`、`suppress_memory_ids`、`abstain_if_no_preferred_memory`、`require_source_refresh`。

Reasoning directive：`checks`、`required_layers`、`authority_order`、`decision_on_violation`。

- [ ] **Step 2: 强制 shadow-only**

本阶段 schema 不接受 `active`；P3 才引入 runtime status。Policy 文件只允许写入：

```text
policies/retrieval/<id>.yaml
policies/reasoning/<id>.yaml
```

`.memory/policies/proposals` 不是事实源。

- [ ] **Step 3: 初始化目录和 Git 安全说明**

Workspace README 解释 Policy 与 Knowledge 分离；`.gitignore` 保持排除 `.memory`，但追踪 `policies/`。

- [ ] **Step 4: 验证并提交**

```bash
pnpm vitest run tests/policyStore.test.ts tests/workspace.test.ts tests/gitWorkspace.test.ts
pnpm typecheck
git add src/policy src/core/paths.ts src/storage tests
git commit -m "feat: add git-backed memory-use policies"
```

### Task 4: Policy Proposal Lifecycle

**Files:**
- Create: `src/policy/proposals.ts`
- Modify: `src/policy/index.ts`
- Modify: `src/cli.ts`
- Test: `tests/policyProposals.test.ts`
- Test: `tests/configCli.test.ts`

- [ ] **Step 1: 写 proposal 生命周期测试**

命令：

```bash
agent-knowledge policy validate --input policy.yaml
agent-knowledge policy import --input policy.yaml
agent-knowledge policy list
agent-knowledge policy show <id>
agent-knowledge policy proposals
agent-knowledge policy proposal-show <id>
agent-knowledge policy accept <proposal-id>
agent-knowledge policy reject <proposal-id> --reason "..."
```

Accept 只能把 pending proposal 的 candidate 以 `status: shadow` 写入 Git Policy；已有同 ID 文件拒绝覆盖。Reject 只更新 proposal。

- [ ] **Step 2: 实现 owner-only proposal store**

Proposal 包含：

```ts
{
  version: 1,
  id: "policy_proposal_...",
  status: "pending" | "accepted" | "rejected",
  candidate: MemoryUsePolicy,
  evidenceSummary: { independentQueryRuns: 3, feedbackEvents: 3, evalCases: 0 }
}
```

- [ ] **Step 3: 验证并提交**

```bash
pnpm vitest run tests/policyProposals.test.ts tests/configCli.test.ts
pnpm typecheck
git add src/policy src/cli.ts tests
git commit -m "feat: govern memory-use policy proposals"
```

### Task 5: Deterministic Policy Mining

**Files:**
- Create: `src/policy/mining.ts`
- Modify: `src/policy/index.ts`
- Modify: `src/cli.ts`
- Test: `tests/policyMining.test.ts`

- [ ] **Step 1: 写 feedback mining 测试**

三个独立 `queryRunId`、同 domain/scenario、同 reason 才生成 proposal；同一个 run 重复反馈只计一次。没有 domain/scenario/project scope 时拒绝生成全局 Policy。

映射：

```text
wrong_route / forbidden_injection / missing_expected / should_abstain / stale_source
  -> retrieval_lesson
conflicting_evidence / insufficient_detail / reasoning_failure
  -> reasoning_policy
```

- [ ] **Step 2: 写 eval mining 测试**

`policy mine --eval <yaml...>` 只消费显式 eval 文件；至少三个同 scope failure 才形成 proposal。Synthetic eval 不进入 query-run ledger。

- [ ] **Step 3: 实现确定性候选**

Feedback 的 expected IDs 进入 `prefer_memory_ids`，forbidden IDs 和负反馈 memory ID 进入 `suppress_memory_ids`。Reasoning reason 编译为受控 checks，不能生成自由文本 prompt injection。

- [ ] **Step 4: 验证并提交**

```bash
pnpm vitest run tests/policyMining.test.ts tests/feedback.test.ts tests/eval.test.ts
pnpm typecheck
git add src/policy src/cli.ts tests
git commit -m "feat: mine memory-use policy proposals"
```

### Task 6: Shadow Simulation And History

**Files:**
- Create: `src/policy/simulation.ts`
- Modify: `src/policy/index.ts`
- Modify: `src/cli.ts`
- Test: `tests/policySimulation.test.ts`

- [ ] **Step 1: 写 retrieval shadow 测试**

命令：

```bash
agent-knowledge policy simulate \
  --eval eval/cases/retrieval-complete.yaml \
  --output /secure/reports/policies
```

Simulation 允许：

- 向 request 追加 `route_domains/route_scenarios`。
- 在 shadow 结果中重排 `prefer_memory_ids`。
- 在 shadow 结果中移除 `suppress_memory_ids`。
- 计算 baseline/shadow passed、recall、false injection、abstention failure。

它不得改变真实 query、配置或 Markdown knowledge。

- [ ] **Step 2: 写 reasoning contract 测试**

Eval case 可选：

```yaml
reasoning_context:
  has_unresolved_conflict: true
  has_expired_fact: false
  has_documented_evidence: true
  expanded_layers: [synopsis]
  operation_risk: high
expected_reasoning_decision: abstain
```

Reasoning Policy 只输出 shadow decision：`proceed | warn | abstain` 与 violation 列表。

- [ ] **Step 3: 写 privacy-safe history**

`.memory/policies/simulations/*.json` 只保存 case ID/hash、Policy ID 和指标，不保存 task 文本。损坏 history 进入 `skipped`。

命令：

```bash
agent-knowledge policy history --limit 100
```

- [ ] **Step 4: 验证并提交**

```bash
pnpm vitest run tests/policySimulation.test.ts tests/eval.test.ts tests/configCli.test.ts
pnpm typecheck
git add src/policy src/cli.ts tests
git commit -m "feat: simulate memory-use policies in shadow"
```

### Task 7: Skill, Documentation, And Operations Runbook

**Files:**
- Create: `.trae/skills/memory-use-policy-maintainer/SKILL.md`
- Mirror: `templates/trae/plugin/skills/memory-use-policy-maintainer/**`
- Mirror: `templates/codex/marketplace/plugins/agent-knowledge/skills/memory-use-policy-maintainer/**`
- Modify: `.trae/skills/agent-knowledge-guide/**`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/retrieval-lessons.md`
- Modify: `docs/research/2026-08-09-production-memory-system-evaluation.md`
- Test: `tests/templates.test.ts`

- [ ] **Step 1: 新增 maintainer Skill**

Skill 固定流程：

```text
policy mine -> proposal review -> policy accept -> policy simulate
-> compare baseline/shadow -> callback/user decision
```

禁止自动 accept、自动 active、自动修改 query pipeline。

- [ ] **Step 2: 写运行一段时间后的操作手册**

建议周期：

- 每次出现明显误召回：记录带 reason 的 feedback。
- 每日/每周：`policy mine`。
- 每周：审阅 proposal。
- 每次接受后：对完整中文业务 eval 执行 `policy simulate`。
- 至少积累 2–4 周、30 个独立 query run，且 false injection/abstention 不退化后，才评审 P3。

- [ ] **Step 3: 更新完成状态与 P3/P4 backlog**

P3：

- Policy 编译为实时 `QueryPlan` / `ReasoningContract`。
- `query --policy-set off|shadow|active`。
- Hook 只允许经过 eval 门禁的 active Policy。
- 自动回滚、kill switch、policy generation pin。

P4：

- `memory-use-optimizer` 后台 Agent/Skill。
- automation 定时聚类、生成 proposal、运行 simulation、callback。
- Agent 永远不能自动 accept/activate。

- [ ] **Step 4: 验证并提交**

```bash
pnpm vitest run tests/templates.test.ts tests/configCli.test.ts
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
pnpm test:comments
git add .trae/skills templates README.md AGENTS.md docs
git commit -m "docs: add memory-use policy operating workflow"
```

## 完成标准

- Query-run ledger 不含 task 原文、知识正文或凭据。
- Eval 不写 query-run/feedback 日志。
- Policy 事实源只在 `policies/`，proposal/simulation 只在 `.memory`。
- P0–P2 不改变普通 query/Hook 的结果。
- `policy accept` 只写 shadow Policy，拒绝覆盖。
- Simulation 同时报告安全指标和 reasoning violation。
- TRAE/Codex Skill bundle 与 canonical 逐文件一致。
- P3/P4 backlog 有明确启动门槛和回滚要求。
