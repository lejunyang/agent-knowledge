# Agent Knowledge Guide Skill And Codex Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one tutorial and diagnostic Skill for Agent Knowledge, and make Codex a first-class managed integration with native Hook and Skill paths plus an optional local plugin marketplace template.

**Architecture:** Keep `.trae/skills/agent-knowledge-guide` as the canonical tutorial Skill and mirror it into the TRAE and Codex plugin bundles with drift tests. Extend the integration product registry so Codex writes Hooks to `.codex/hooks.json`, standalone Skills to `.agents/skills`, and an optional marketplace bundle to `.codex/agent-knowledge-marketplace`; do not pretend Codex supports standalone Markdown subagents. Preserve the current manifest-aware merge, conflict, doctor, and uninstall boundaries.

**Tech Stack:** TypeScript, Commander, Vitest, Markdown Skills, Codex local marketplace JSON, existing integration ownership manifest.

---

### Task 1: Tutorial Skill

**Files:**
- Create: `.trae/skills/agent-knowledge-guide/SKILL.md`
- Create: `.trae/skills/agent-knowledge-guide/references/workflows.md`
- Create: `.trae/skills/agent-knowledge-guide/references/diagnostics.md`
- Create: `.trae/skills/agent-knowledge-guide/agents/openai.yaml`
- Create: `templates/trae/plugin/skills/agent-knowledge-guide/**`
- Modify: `tests/templates.test.ts`

- [ ] **Step 1: Add failing drift and content tests**

Require the canonical and TRAE plugin directories to contain the same files and content. Assert that the guide covers first use, versioned sources, query/evidence expansion, lifecycle recording, maintenance, quality audit, feedback, integration doctor, and safety boundaries.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm exec vitest run tests/templates.test.ts
```

Expected: failure because `agent-knowledge-guide` does not exist.

- [ ] **Step 3: Initialize and implement the Skill**

Use `skill-creator/scripts/init_skill.py` with references and explicit UI metadata. Keep `SKILL.md` as the routing tutorial; put command recipes in `references/workflows.md` and health-check interpretation in `references/diagnostics.md`.

- [ ] **Step 4: Validate and run focused tests**

Run the Skill validator in an environment with PyYAML available when possible; always run frontmatter/content tests and `tests/templates.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add .trae/skills/agent-knowledge-guide templates/trae/plugin/skills/agent-knowledge-guide tests/templates.test.ts
git commit -m "feat: add agent knowledge guide skill"
```

### Task 2: Codex Templates And Product Model

**Files:**
- Create: `templates/codex/hooks.json`
- Create: `templates/codex/hooks.windows.json`
- Create: `templates/codex/marketplace/.agents/plugins/marketplace.json`
- Create: `templates/codex/marketplace/plugins/agent-knowledge/.codex-plugin/plugin.json`
- Create: `templates/codex/marketplace/plugins/agent-knowledge/agents/openai.yaml`
- Create: `templates/codex/marketplace/plugins/agent-knowledge/skills/**`
- Modify: `src/integration/manager.ts`
- Modify: `tests/templates.test.ts`

- [ ] **Step 1: Add failing Codex integration tests**

Assert:

- supported products include `codex`;
- Codex Hooks install to a `.codex`-style root;
- Codex Skills install to a separate `.agents/skills` root;
- Codex rejects the unsupported standalone `agents` component;
- the optional plugin bundle is a local marketplace with a valid relative source path;
- merge preserves foreign Hooks and uninstall removes only owned resources.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm exec vitest run tests/templates.test.ts
```

Expected: type/runtime failures because `codex` is not registered.

- [ ] **Step 3: Implement product-specific roots and templates**

Add `codex` to `IntegrationProductId`. For default paths use:

- user Hooks: `~/.codex/hooks.json`;
- user Skills: `~/.agents/skills`;
- user marketplace: `~/.codex/agent-knowledge-marketplace`;
- project Hooks: `<repo>/.codex/hooks.json`;
- project Skills: `<repo>/.agents/skills`;
- project marketplace: `<repo>/.codex/agent-knowledge-marketplace`.

With `--target-dir`, keep all test/custom roots below the explicit target. Codex Hook templates use only supported events: `SessionStart`, `UserPromptSubmit`, `SubagentStop`, and `Stop`.

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm exec vitest run tests/templates.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add templates/codex src/integration/manager.ts tests/templates.test.ts
git commit -m "feat: add codex integration templates"
```

### Task 3: CLI, Configuration, And Help

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/cli/configure.ts`
- Modify: `src/cli/integration.ts`
- Modify: `src/cli.ts`
- Modify: `tests/integrationCli.test.ts`
- Modify: `tests/configCli.test.ts`

- [ ] **Step 1: Add failing CLI and config tests**

Require `codex` in config parsing, interactive product choices, `integration list`, install validation, doctor, uninstall, and human-readable result formatting. Assert unsupported Codex `agents` selection fails before writing.

- [ ] **Step 2: Run focused tests and confirm failure**

Run:

```bash
pnpm exec vitest run tests/integrationCli.test.ts tests/configCli.test.ts
```

- [ ] **Step 3: Implement Codex CLI choices and validation**

Add localized Codex descriptions, update all explicit product unions, and filter or reject components based on the selected product. Keep secrets out of config and preserve the existing precedence rules.

- [ ] **Step 4: Run focused validation**

Run:

```bash
pnpm exec vitest run tests/integrationCli.test.ts tests/configCli.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/core/config.ts src/cli/configure.ts src/cli/integration.ts src/cli.ts tests/integrationCli.test.ts tests/configCli.test.ts
git commit -m "feat: expose codex integration in cli"
```

### Task 4: Documentation And Workflow Linkage

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/integrations.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `templates/trae/README.md`

- [ ] **Step 1: Document the extraction improvements**

Record the proven source-distillation loop: fingerprint gate, private 0600 export, DLP check, section hash verification, L1/L2/L3 writing, quality audit, eval-driven retrieval boundaries, source receipt, and temporary evidence cleanup.

- [ ] **Step 2: Document issue discovery and improvement**

Explain which mechanism catches which problem:

- `knowledge audit` for thin body, metadata dominance, stale claims, unknown project, and source coverage;
- `source check/refresh` for upstream changes;
- eval/feedback/calibration for “whether memory was used correctly”;
- `maintenance run/watch` for repeated observations, conflicts, updates, and Skill proposals;
- graph and integration doctor for relationship and installation health.

- [ ] **Step 3: Document Codex**

Document native paths, supported components, Hook trust, standalone Skills, optional marketplace registration commands, and why Codex has no standalone `agents` component.

- [ ] **Step 4: Run documentation and template checks**

Run:

```bash
git diff --check
pnpm exec vitest run tests/templates.test.ts tests/integrationCli.test.ts tests/configCli.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add README.md AGENTS.md docs/guides templates/trae/README.md
git commit -m "docs: explain guided workflows and codex setup"
```

### Task 5: Full Verification

**Files:**
- Verify only

- [ ] **Step 1: Run repository validation**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
pnpm test:comments
git diff --check
```

- [ ] **Step 2: Run integration smoke**

Install Codex Hooks, Skills, and marketplace bundle into a temporary target; run `integration doctor`; validate marketplace JSON and plugin manifest; run install twice for idempotency; uninstall and confirm foreign files survive.

- [ ] **Step 3: Run CLI help smoke**

```bash
node dist/cli.js integration list
node dist/cli.js integration install --help
node dist/cli.js integration doctor --help
```

- [ ] **Step 4: Review remaining scope**

Confirm that automatic online crawling and autonomous user questioning remain explicit future work because they require credentials, rate limits, notification policy, and a user-approved process manager. Confirm no active knowledge is modified automatically.
