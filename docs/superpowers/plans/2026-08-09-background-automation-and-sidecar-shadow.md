# Background Automation And Sidecar Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a bounded background-agent contract for online Lark/Git refresh, persistent notification callbacks, launchd/systemd/container templates, and one-command Hindsight/memU/Mem0 shadow experiments with comparable reports.

**Architecture:** Deterministic CLI modules own configuration validation, rate limits, retries, job state, notification outbox, callback delivery, service rendering, and sidecar HTTP/command adapters. A new `knowledge-automation-operator` Skill plus a versioned system prompt tells any external agent CLI how to consume a bounded automation profile and when to ask the user; the agent never writes active knowledge directly. External memory systems remain shadow projections: inputs are explicitly selected, raw responses are stored under `.memory`, and comparisons use the same query/eval cases.

**Tech Stack:** TypeScript, Commander, Zod, Node fetch/child_process, JSONL/JSON state under `.memory`, launchd plist, systemd unit/timer, Docker Compose, Markdown Skills.

---

### Task 1: Automation Profile, Job, And Notification Schemas

**Files:**
- Create: `src/automation/types.ts`
- Create: `src/automation/profile.ts`
- Create: `src/automation/jobs.ts`
- Create: `src/automation/notifications.ts`
- Modify: `src/core/paths.ts`
- Modify: `src/index.ts`
- Test: `tests/automationProfile.test.ts`
- Test: `tests/notifications.test.ts`

- [ ] **Step 1: Add failing schema and persistence tests**

Cover strict versioned profiles, Lark/Git source allowlists, rate/retry bounds, agent budgets, callback URL plus token environment names, idempotent job IDs, atomic `0600` state, notification dedupe, ack, retry scheduling, and secret rejection.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm exec vitest run tests/automationProfile.test.ts tests/notifications.test.ts
```

- [ ] **Step 3: Implement strict automation contracts**

Persist only non-secret configuration. Use:

```text
.memory/automation/jobs/*.json
.memory/notifications/*.json
.memory/notifications/deliveries/*.jsonl
```

Notification types:

```text
confirmation_required
source_updates_found
source_refresh_failed
inventory_incomplete
maintenance_proposals_ready
eval_regression
sidecar_regression
automation_failed
```

- [ ] **Step 4: Run tests, typecheck, and comment audit**

- [ ] **Step 5: Commit**

```bash
git add src/automation src/core/paths.ts src/index.ts tests/automationProfile.test.ts tests/notifications.test.ts
git commit -m "feat: add automation jobs and notification outbox"
```

### Task 2: Bounded Online Refresh And Automation Inspection

**Files:**
- Create: `src/automation/runner.ts`
- Modify: `scripts/fetch-lark-corpus.mjs`
- Modify: `src/cli.ts`
- Test: `tests/automationRunner.test.ts`
- Test: `tests/larkCorpus.test.mjs`
- Modify: `tests/configCli.test.ts`

- [ ] **Step 1: Add failing retry, rate-limit, and bounded-run tests**

Test Lark request delay, exponential retry with Retry-After support, max document cap, Git fetch retry, command timeout, offline dry-run, source check summaries, notification creation, and no active knowledge writes.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
pnpm exec vitest run tests/automationRunner.test.ts
node --test tests/larkCorpus.test.mjs
```

- [ ] **Step 3: Implement deterministic inspection**

Add:

```bash
agent-knowledge automation validate --profile <file>
agent-knowledge automation inspect --profile <file>
agent-knowledge automation run --profile <file>
agent-knowledge automation status --profile <file>
```

`inspect` is read-only. `run` may explicitly refresh allowlisted upstream snapshots and registered connectors, then run audit/maintenance/eval according to profile, but only writes `.memory`, Vault/source manifests, proposals, and notifications. It never approves inbox or modifies active knowledge.

- [ ] **Step 4: Add rich CLI help and run tests**

- [ ] **Step 5: Commit**

```bash
git add src/automation/runner.ts scripts/fetch-lark-corpus.mjs src/cli.ts tests/automationRunner.test.ts tests/larkCorpus.test.mjs tests/configCli.test.ts
git commit -m "feat: run bounded source automation"
```

### Task 3: Notification Callback Delivery

**Files:**
- Modify: `src/automation/notifications.ts`
- Modify: `src/cli.ts`
- Test: `tests/notifications.test.ts`
- Modify: `docs/guides/configuration.md`

- [ ] **Step 1: Add failing delivery tests**

Cover webhook POST, bearer/custom header from environment, idempotency header, timeout, retryable 408/429/5xx, Retry-After, non-retryable 4xx, max attempts, redacted errors, manual ack, and dry-run.

- [ ] **Step 2: Implement delivery commands**

```bash
agent-knowledge notifications list
agent-knowledge notifications show <id>
agent-knowledge notifications enqueue --input <json>
agent-knowledge notifications deliver --profile <file>
agent-knowledge notifications ack <id>
```

Callbacks receive a bounded JSON envelope and never receive Vault evidence or secrets.

- [ ] **Step 3: Run focused validation**

- [ ] **Step 4: Commit**

```bash
git add src/automation/notifications.ts src/cli.ts tests/notifications.test.ts docs/guides/configuration.md
git commit -m "feat: deliver automation notification callbacks"
```

### Task 4: Background Agent Prompt And Skill

**Files:**
- Create: `.trae/skills/knowledge-automation-operator/SKILL.md`
- Create: `.trae/skills/knowledge-automation-operator/references/profile-schema.md`
- Create: `.trae/skills/knowledge-automation-operator/references/question-policy.md`
- Create: `.trae/skills/knowledge-automation-operator/agents/openai.yaml`
- Create: `templates/automation/knowledge-automation-system-prompt.md`
- Mirror: `templates/trae/plugin/skills/knowledge-automation-operator/**`
- Mirror: `templates/codex/marketplace/plugins/agent-knowledge/skills/knowledge-automation-operator/**`
- Modify: `tests/templates.test.ts`

- [ ] **Step 1: Add failing complete-bundle drift and prompt-contract tests**

Require the system prompt and Skill to define allowlists, budgets, read/write boundaries, confirmation batching, notification callbacks, retry stop conditions, evidence handling, no active promotion, and final machine-readable report.

- [ ] **Step 2: Initialize and implement the Skill**

The external Agent workflow:

```text
validate profile
-> inspect current state
-> refresh allowlisted upstream
-> refresh/check registered sources
-> run audit/maintenance/eval
-> classify findings
-> enqueue one batched confirmation notification
-> emit final report
```

- [ ] **Step 3: Validate frontmatter and bundle parity**

- [ ] **Step 4: Commit**

```bash
git add .trae/skills/knowledge-automation-operator templates/automation templates/trae/plugin/skills/knowledge-automation-operator templates/codex/marketplace/plugins/agent-knowledge/skills/knowledge-automation-operator tests/templates.test.ts
git commit -m "feat: add background knowledge operator skill"
```

### Task 5: launchd, systemd, And Container Templates

**Files:**
- Create: `src/automation/serviceTemplates.ts`
- Create: `templates/automation/runner-contract.md`
- Create: `templates/automation/container/Dockerfile`
- Create: `templates/automation/container/compose.yaml`
- Modify: `src/cli.ts`
- Test: `tests/serviceTemplates.test.ts`

- [ ] **Step 1: Add failing renderer tests**

Require absolute external runner path, explicit profile path, safe labels, no embedded credentials, deterministic files, launchd StartInterval, systemd oneshot+timer, Docker restart policy, health/state mounts, callback env pass-through, and uninstall instructions.

- [ ] **Step 2: Implement rendering**

```bash
agent-knowledge automation service render \
  --manager launchd|systemd|docker \
  --profile <absolute-file> \
  --runner <absolute-executable> \
  --interval-minutes <n> \
  --output <dir>
```

The service invokes a user-provided wrapper. Environment variables expose profile, system prompt, workspace, and notification-delivery command; the project does not assume another Agent CLI's flags.

- [ ] **Step 3: Run tests and smoke generated files**

- [ ] **Step 4: Commit**

```bash
git add src/automation/serviceTemplates.ts templates/automation src/cli.ts tests/serviceTemplates.test.ts
git commit -m "feat: render background service templates"
```

### Task 6: Generic Shadow Sidecar Adapter And Presets

**Files:**
- Create: `src/sidecar/types.ts`
- Create: `src/sidecar/config.ts`
- Create: `src/sidecar/httpAdapter.ts`
- Create: `src/sidecar/commandAdapter.ts`
- Create: `src/sidecar/presets.ts`
- Create: `src/sidecar/store.ts`
- Modify: `src/index.ts`
- Test: `tests/sidecarConfig.test.ts`
- Test: `tests/sidecarAdapter.test.ts`

- [ ] **Step 1: Add failing strict config and HTTP tests**

Support presets `hindsight`, `memu`, and `mem0`, plus explicit endpoint overrides. Credentials are environment-variable names only. Test health probe, retain/memorize/add, recall/retrieve/search, async task polling, timeout/retry, response extraction, response size bounds, redaction, and raw artifact hashes.

- [ ] **Step 2: Implement provider presets**

Default endpoint families:

```text
Hindsight:
  POST /v1/default/banks/{scope}/memories
  POST /v1/default/banks/{scope}/memories/recall

memU Cloud:
  POST /api/v3/memory/memorize
  GET  /api/v3/memory/memorize/status/{task_id}
  POST /api/v3/memory/retrieve

Mem0 OSS:
  POST /memories
  POST /search
```

Every path and payload template is overridable because external versions drift. `doctor` must verify capabilities before shadow execution.

- [ ] **Step 3: Persist shadow runs**

```text
.memory/sidecars/configs/
.memory/sidecars/runs/
.memory/sidecars/artifacts/
```

External content never becomes active knowledge.

- [ ] **Step 4: Run tests and commit**

```bash
git add src/sidecar src/index.ts tests/sidecarConfig.test.ts tests/sidecarAdapter.test.ts
git commit -m "feat: add shadow memory sidecar adapters"
```

### Task 7: One-Command Sidecar Setup And Comparison

**Files:**
- Create: `src/sidecar/compare.ts`
- Modify: `src/cli.ts`
- Create: `templates/sidecars/hindsight.compose.yaml`
- Create: `templates/sidecars/mem0.compose.yaml`
- Create: `templates/sidecars/memu.env.example`
- Test: `tests/sidecarCompare.test.ts`
- Modify: `tests/configCli.test.ts`

- [ ] **Step 1: Add failing CLI and comparison tests**

Test preset config generation, doctor, shadow ingestion, shared eval query execution, normalized result IDs/text, recall/forbidden/abstention/latency/token/cost/error metrics, deterministic Markdown+JSON reports, and no runtime query logs.

- [ ] **Step 2: Implement commands**

```bash
agent-knowledge sidecar init --provider hindsight|memu|mem0 --output <file>
agent-knowledge sidecar doctor --config <file>
agent-knowledge sidecar shadow-ingest --config <file> --input <jsonl>
agent-knowledge sidecar compare --config <file...> --eval <yaml> --output <dir>
```

Comparison includes native lexical as baseline. External results are mapped by configured metadata/source IDs where available; otherwise text relevance is reported separately and never presented as native memory identity.

- [ ] **Step 3: Add one-command deployment helpers**

Copy compose/env templates with:

```bash
agent-knowledge sidecar scaffold --provider <provider> --output <dir>
```

memU Cloud scaffold is configuration-only. Hindsight/Mem0 templates remain examples and must be checked against the pinned upstream version before production deployment.

- [ ] **Step 4: Run focused tests and commit**

```bash
git add src/sidecar/compare.ts src/cli.ts templates/sidecars tests/sidecarCompare.test.ts tests/configCli.test.ts
git commit -m "feat: compare shadow memory sidecars"
```

### Task 8: Retrieval Lesson And Reasoning Policy Product Decision

**Files:**
- Create: `docs/guides/retrieval-lessons.md`
- Modify: `.trae/skills/agent-knowledge-guide/references/diagnostics.md`
- Modify: `docs/research/2026-08-09-production-memory-system-evaluation.md`

- [ ] **Step 1: Document the concrete purpose**

`Retrieval Lesson` records evidence-backed routing lessons such as “for account deletion, do not inject recovery unless the query includes recovery/rebinding signals.” `Reasoning Policy` records how to combine fact, SOP, exception, temporal validity, and negative evidence.

- [ ] **Step 2: Keep it out of active schema for now**

Generate them as review reports/proposals from eval failures, not a new automatically injected knowledge type. Promote only after repeated cross-case evidence and an explicit schema/eval decision.

- [ ] **Step 3: Remove domain DLP from planned scope**

Document that custom name/address/business-UID DLP is not requested. Keep existing deterministic DLP and Connector extension point without adding a new implementation task.

- [ ] **Step 4: Commit**

```bash
git add docs/guides/retrieval-lessons.md .trae/skills/agent-knowledge-guide/references/diagnostics.md docs/research/2026-08-09-production-memory-system-evaluation.md
git commit -m "docs: define retrieval lesson product boundary"
```

### Task 9: Full Documentation And Verification

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/integrations.md`
- Create: `docs/guides/automation.md`
- Create: `docs/guides/sidecars.md`
- Modify: `templates/trae/README.md`
- Modify: `templates/codex/README.md`

- [ ] **Step 1: Document setup and threat boundaries**

Cover another Agent CLI runner contract, profile examples, callback envelopes, service installation instructions, sidecar credentials, shadow-only semantics, comparison metrics, and uninstall/recovery.

- [ ] **Step 2: Update process linkage**

Require future automation/sidecar changes to review prompt, Skill bundles, callbacks, service templates, provider presets, eval reports, and product templates.

- [ ] **Step 3: Run full validation**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
pnpm test:comments
git diff --check
```

- [ ] **Step 4: Run end-to-end smokes**

Use fake HTTP servers for callback and all sidecar presets; render all service managers; run automation dry-run; validate Skill bundle parity; keep both repositories clean.
