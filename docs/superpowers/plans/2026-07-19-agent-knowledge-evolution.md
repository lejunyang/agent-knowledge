# Agent Knowledge Evolution Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver trustworthy retrieval, managed multi-product integrations, project-scoped knowledge, safe synchronization, and observable proactive-memory staging.

**Architecture:** Keep Markdown as the only fact source. Add focused modules for retrieval profiles, integrations, projects, synchronization, and staging; each module exposes deterministic APIs and the CLI only composes them. Automatic inputs remain untrusted proposals until governance promotes them.

**Tech Stack:** TypeScript, Node.js, SQLite FTS5, Zod, Vitest, Transformers.js, native `fetch`, built-in AWS Signature V4 S3 client.

---

## File Map

- `src/eval.ts`: eval case validation and aggregate retrieval metrics.
- `src/query.ts`: secure filtering, CJK lexical candidates, dense ranks, RRF, debug output.
- `src/contextPacket.ts`: conservative token budgeting.
- `src/embeddings.ts`: embedding profiles, manifest compatibility, incremental rebuild.
- `src/projects.ts`: Git project identity and registry.
- `src/integrations.ts`: product adapters, managed structured merge, uninstall and doctor.
- `src/sync.ts`: backend-neutral three-way synchronization.
- `src/syncWebdav.ts`: WebDAV backend.
- `src/syncS3.ts`: S3 backend with injected client boundary.
- `src/staging.ts`: bounded hook event staging, watermark and lock.
- `src/governance.ts`: capture provenance and untrusted actor policy.
- `src/cli.ts`: commands and hook event wiring.
- `templates/trae/**`: current TRAE resources.
- `templates/claude-code/**`: Claude Code resources.
- `templates/trae/plugin/**`: installable TRAE plugin bundle.
- `.trae/skills/memory-maintainer/SKILL.md`: explicit log-to-candidate maintenance workflow.

### Task 1: Trusted Eval Baseline

**Files:**
- Modify: `src/eval.ts`
- Modify: `src/schema.ts`
- Modify: `src/cli.ts`
- Modify: `tests/eval.test.ts`
- Create: `eval/cases/retrieval-baseline.yaml`

- [ ] **Step 1: Write failing eval tests**

Add cases that assert expected rank, graded relevance, forbidden results, abstention, language, and aggregate Recall@1/3/5, MRR, nDCG, false-injection, latency, and packet-token fields.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/eval.test.ts`

Expected: FAIL because suite metrics and extended fields do not exist.

- [ ] **Step 3: Implement schemas and metrics**

Parse eval YAML with Zod, evaluate real query output, compute deterministic aggregate metrics, and expose `agent-knowledge eval --input <yaml>`.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/eval.test.ts`

Expected: PASS.

### Task 2: P0 Retrieval and Embedding Correctness

**Files:**
- Modify: `src/workspace.ts`
- Modify: `src/indexer.ts`
- Modify: `src/query.ts`
- Modify: `src/contextPacket.ts`
- Modify: `src/embeddings.ts`
- Modify: `src/types.ts`
- Modify: `src/schema.ts`
- Modify: `tests/workspace.test.ts`
- Modify: `tests/indexer.test.ts`
- Modify: `tests/query.test.ts`
- Modify: `tests/embeddings.test.ts`

- [ ] **Step 1: Write failing isolation and policy tests**

Cover active files under `_inbox`, expired/not-yet-valid knowledge, visibility/sensitivity clearance, project scope, secure relation expansion, CJK natural-language recall, dense score preservation, incompatible manifests, incremental embedding reuse, and small packet budgets.

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/workspace.test.ts tests/indexer.test.ts tests/query.test.ts tests/embeddings.test.ts`

Expected: FAIL on all new assertions.

- [ ] **Step 3: Implement hard isolation and query policy**

Exclude `_inbox` and `_archive` by path, extend query request with `now`, visibility and sensitivity clearance, filter direct and related results identically, add CJK 2/3-gram indexing, preserve dense cosine, and fuse channel ranks with RRF.

- [ ] **Step 4: Implement profile manifest and token budget**

Write `.memory/embeddings/manifest.json`, reject incompatible query providers, reuse content-hash-compatible vectors, delete stale records, and pack context items with a conservative token estimator.

- [ ] **Step 5: Verify**

Run: `pnpm test -- tests/workspace.test.ts tests/indexer.test.ts tests/query.test.ts tests/embeddings.test.ts`

Expected: PASS.

### Task 3: Model Profiles and Rerank Boundary

**Files:**
- Modify: `src/embeddings.ts`
- Modify: `src/query.ts`
- Modify: `src/cli.ts`
- Modify: `tests/embeddings.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing profile tests**

Assert E5 query/document prefixes and mean pooling, BGE query instruction and CLS pooling, deterministic profile compatibility, candidate limit, and configurable minimum dense score.

- [ ] **Step 2: Implement profile registry**

Provide `multilingual-e5-small`, `bge-small-zh-v1.5`, and `deterministic-local`; make E5 the Transformers default without allowing automatic downloads.

- [ ] **Step 3: Implement rerank boundary**

Fuse top-N candidates before the existing pluggable reranker and expose threshold/limit decisions in debug.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/embeddings.test.ts tests/query.test.ts`

Expected: PASS without network access.

### Task 4: Managed Product Integrations

**Files:**
- Create: `src/integrations.ts`
- Modify: `src/templates.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Replace: `tests/templates.test.ts`
- Create: `templates/claude-code/settings.json`
- Create: `templates/claude-code/agents/memory-reader.md`
- Create: `templates/claude-code/agents/memory-writer.md`
- Create: `templates/trae/plugin/.codex-plugin/plugin.json`
- Create: `templates/trae/plugin/hooks/hooks.json`

- [ ] **Step 1: Write failing merge tests**

Assert optional components, user/project targets, no symlinks, preservation of foreign hooks, replacement of only agent-knowledge handlers, conflict reporting, idempotency, uninstall, Windows command selection, and integration doctor.

- [ ] **Step 2: Implement adapters and ownership**

Define adapter metadata for TRAE and Claude Code, copy managed resources atomically, save an integration manifest, and merge hooks structurally by owned command marker.

- [ ] **Step 3: Implement CLI**

Add `integration list/install/uninstall/doctor`; keep `link-trae-templates` as a deprecated wrapper.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/templates.test.ts`

Expected: PASS and all targets are regular files/directories.

### Task 5: Project Identity and Zero-Trust Governance

**Files:**
- Create: `src/projects.ts`
- Modify: `src/gitContext.ts`
- Modify: `src/types.ts`
- Modify: `src/schema.ts`
- Modify: `src/governance.ts`
- Modify: `src/inbox.ts`
- Modify: `src/organizer.ts`
- Modify: `src/cli.ts`
- Create: `tests/projects.test.ts`
- Modify: `tests/inbox.test.ts`

- [ ] **Step 1: Write failing project/governance tests**

Cover remote normalization, path fallback, registry output, AGENTS hash-only inventory, project-scoped query, customer authority downgrade, automatic-session inbox enforcement, and corroboration metadata.

- [ ] **Step 2: Implement project registry**

Generate stable project IDs and write `.memory/projects/<id>.json` without copying AGENTS content.

- [ ] **Step 3: Implement capture policy**

Add provenance to candidate input/frontmatter, enforce actor/capture constraints, and ensure automatic candidates cannot become active.

- [ ] **Step 4: Verify**

Run: `pnpm test -- tests/projects.test.ts tests/inbox.test.ts tests/query.test.ts`

Expected: PASS.

### Task 6: WebDAV and S3 Synchronization

**Files:**
- Create: `src/sync.ts`
- Create: `src/syncWebdav.ts`
- Create: `src/syncS3.ts`
- Modify: `src/cli.ts`
- Modify: `src/index.ts`
- Create: `tests/sync.test.ts`
- Create: `tests/syncWebdav.test.ts`
- Create: `tests/syncS3.test.ts`

- [ ] **Step 1: Write failing synchronization tests**

Use fake backends to cover first push, first pull, unchanged files, local-only changes, remote-only changes, tombstones, concurrent conflicts, exclusion of `.memory`, and post-pull index rebuild.

- [ ] **Step 2: Implement three-way engine**

Hash Markdown files, persist a local base manifest, compare local/base/remote, write conflict artifacts instead of overwriting, and atomically apply non-conflicting pulls.

- [ ] **Step 3: Implement protocol adapters**

Use native fetch for WebDAV and an injected S3-compatible client interface. Load credentials from environment/standard provider chains only.

- [ ] **Step 4: Implement CLI and verify**

Run: `pnpm test -- tests/sync.test.ts tests/syncWebdav.test.ts tests/syncS3.test.ts`

Expected: PASS without real network calls.

### Task 7: Proactive Memory Staging and Logs

**Files:**
- Create: `src/staging.ts`
- Modify: `src/cli.ts`
- Modify: `templates/trae/hooks.json`
- Modify: `templates/trae/hooks.windows.json`
- Modify: `templates/trae/agents/memory-reader.md`
- Modify: `templates/trae/agents/memory-writer.md`
- Create: `.trae/skills/memory-maintainer/SKILL.md`
- Create: `tests/staging.test.ts`

- [ ] **Step 1: Write failing staging tests**

Assert bounded/redacted event records, stable hashed session identifiers, watermark advancement, stale-lock recovery, and no raw prompt/tool response by default.

- [ ] **Step 2: Implement staging**

Append bounded records under `.memory/staging`, provide `staging status` and `staging drain`, and guard drain with an exclusive lock.

- [ ] **Step 3: Wire hooks**

Add `SubagentStart`, `SubagentStop`, `Stop`, and `SessionEnd` command hooks. Commands log/stage only and never force model continuation.

- [ ] **Step 4: Improve agent and skill instructions**

Make memory-writer trigger criteria explicit, include provenance in output, require `should_store: false` for weak observations, and add maintenance workflow for periodic candidate generation.

- [ ] **Step 5: Verify**

Run: `pnpm test -- tests/staging.test.ts tests/hookOutput.test.ts tests/templates.test.ts`

Expected: PASS.

### Task 8: Documentation and Full Validation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `templates/trae/README.md`
- Create: `docs/research/2026-07-19-project-memory-sync-and-poisoning.md`

- [ ] **Step 1: Document behavior and threat model**

Document install adapters, managed merge/uninstall, project knowledge selection, customer poisoning defenses, proactive-memory timing, Subagent logging, and WebDAV/S3 conflict behavior.

- [ ] **Step 2: Run focused CLI smoke**

Run:

```bash
pnpm build
node dist/cli.js integration list
node dist/cli.js integration install --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js integration doctor --product trae --scope project --target-dir /tmp/agent-knowledge-integration-smoke
node dist/cli.js project detect
```

Expected: JSON success output and no modification outside the smoke directory except read-only project detection.

- [ ] **Step 3: Run complete validation**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
git diff --check
```

Expected: all tests pass, TypeScript emits no errors, build succeeds, and diff check is clean.

