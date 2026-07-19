# Observability, Maintenance, Graph, and UX Implementation Plan

> **For agentic workers:** Execute task-by-task with focused tests and one Git commit per task.

**Goal:** Make Subagent behavior inspectable, remove manual maintenance plumbing, add reviewable Skill/proposal workflows, provide knowledge-graph visualization and graph traversal retrieval, and document the recommended operating model.

**Architecture:** Detailed Subagent logs and redacted staging are separate. Maintenance consumes append-only local logs into observations and proposals. Graph files are rebuildable indexes over Markdown/proposals/project metadata. No automatic active-memory or Skill installation occurs.

**Tech Stack:** TypeScript, Commander, Inquirer, Zod, SQLite, Vitest, self-contained HTML/Canvas/SVG.

---

### Task 1: Detailed Subagent Logging

**Files:**
- Create: `src/hooks/subagentLogs.ts`
- Modify: `src/hooks/staging.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Modify: `templates/trae/hooks.json`
- Modify: `templates/trae/hooks.windows.json`
- Modify: `templates/claude-code/settings.json`
- Modify: `templates/claude-code/settings.windows.json`
- Test: `tests/subagentLogs.test.ts`
- Test: `tests/templates.test.ts`

- [ ] Add failing tests for raw payload preservation, start/stop pairing, duration, unmatched events, filtering, and disabled logging.
- [ ] Add `.memory/subagents/YYYY-MM-DD.jsonl` and state pairing.
- [ ] Add `hook subagent-event`, `subagents status`, and `subagents logs`.
- [ ] Update templates to route only SubagentStart/Stop to detailed logging.
- [ ] Run focused tests/typecheck/build.
- [ ] Commit `feat: add detailed subagent observability`.

### Task 2: Automatic Maintenance Extraction

**Files:**
- Create: `src/memory/observations.ts`
- Modify: `src/memory/maintenance.ts`
- Modify: `src/hooks/staging.ts`
- Modify: `src/cli.ts`
- Test: `tests/observations.test.ts`
- Test: `tests/maintenance.test.ts`

- [ ] Add failing tests for extraction precedence, missing-text skips, provenance, watermarks, and idempotency.
- [ ] Implement `.memory/observations/events.jsonl`.
- [ ] Make `maintenance run/watch` auto-extract when `--input` is omitted.
- [ ] Add `maintenance extract/status`.
- [ ] Run focused tests/typecheck/build.
- [ ] Commit `feat: extract maintenance observations automatically`.

### Task 3: Proposal Review and Skill Application

**Files:**
- Modify: `src/memory/proposals.ts`
- Create: `src/memory/proposalActions.ts`
- Modify: `src/cli.ts`
- Test: `tests/proposalActions.test.ts`

- [ ] Add proposal lifecycle schema/status fields.
- [ ] Add list/show/accept/reject tests.
- [ ] Accept knowledge proposals into `_inbox`.
- [ ] Accept Skill proposal into `_inbox-skills`, project, or user only with explicit target.
- [ ] Refuse overwrite conflicts.
- [ ] Run focused tests/typecheck/build.
- [ ] Commit `feat: review and apply maintenance proposals`.

### Task 4: Knowledge Graph Index and Exports

**Files:**
- Create: `src/graph/types.ts`
- Create: `src/graph/build.ts`
- Create: `src/graph/query.ts`
- Create: `src/graph/export.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Test: `tests/graph.test.ts`

- [ ] Add tests for knowledge/domain/scenario/project/episode/source/proposal nodes and typed edges.
- [ ] Build `.memory/graph.json`.
- [ ] Add ID/text query with depth 1-2.
- [ ] Add deterministic JSON and Mermaid export.
- [ ] Run focused tests/typecheck/build.
- [ ] Commit `feat: build and query knowledge graph`.

### Task 5: Self-Contained HTML Visualization

**Files:**
- Create: `src/graph/html.ts`
- Modify: `src/graph/export.ts`
- Test: `tests/graphHtml.test.ts`

- [ ] Add tests for self-contained HTML, embedded graph data, search/filter UI, detail panel, and edge styling.
- [ ] Implement no-CDN SVG/Canvas visualization.
- [ ] Add CLI HTML export.
- [ ] Run focused tests/typecheck/build.
- [ ] Commit `feat: export interactive knowledge graph`.

### Task 6: Graph Retrieval

**Files:**
- Create: `src/retrieval/graph.ts`
- Modify: `src/retrieval/query.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/graphRetrieval.test.ts`
- Modify: `tests/query.test.ts`

- [ ] Add tests for seed retrieval, typed traversal, depth decay, max depth 2, security filtering, and conflict/supersedes exclusion.
- [ ] Add `graph` and `hybrid-graph`.
- [ ] Merge graph candidates with lexical/hybrid scores.
- [ ] Run focused tests/complete eval/typecheck/build.
- [ ] Commit `feat: add graph traversal retrieval`.

### Task 7: Recommended Workflow and Configuration Reference

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/retrieval.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `docs/guides/integrations.md`
- Create: `docs/guides/graph.md`
- Modify: `templates/trae/agents/memory-reader.md`
- Modify: `templates/trae/agents/memory-writer.md`
- Modify: `.trae/skills/memory-maintainer/SKILL.md`

- [ ] Document personal daily/weekly workflow.
- [ ] Document bot workflow and proposal review.
- [ ] Explain every enum/config option and retrieval mode.
- [ ] Explain Subagent responsibilities and Skill lifecycle.
- [ ] Explain graph limits versus code graph.
- [ ] Validate links/commands.
- [ ] Commit `docs: explain recommended knowledge workflows`.

### Task 8: Comment Rules and Core Module Documentation

**Files:**
- Modify: `AGENTS.md`
- Create: `scripts/check-comments.mjs`
- Modify: `package.json`
- Modify core files under `src/hooks`, `src/memory`, `src/retrieval`, `src/integration`, `src/sync`, `src/graph`
- Test: comment checker command

- [ ] Update comment rules and process-review checklist.
- [ ] Add exported-function/JSDoc audit with explicit exceptions.
- [ ] Add/expand comments for non-trivial functions and critical branches.
- [ ] Run comment audit/typecheck/build.
- [ ] Commit `docs: enforce core code documentation`.

### Task 9: Final Validation

- [ ] Run `pnpm test`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm build`.
- [ ] Run comment audit and `git diff --check`.
- [ ] Smoke detailed logs, automatic maintenance, proposal acceptance, graph HTML export, and graph retrieval.
- [ ] Verify no `.memory` or generated Skill is committed.
- [ ] Commit final docs/evidence if needed.
