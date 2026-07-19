# CLI I18n, Hook Relevance, and Roadmap Completion Implementation Plan

> **For agentic workers:** Execute this plan task-by-task in order. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver bilingual CLI behavior, quiet relevant hooks, explicit model management, and complete the remaining Hivemind evaluation roadmap without weakening Markdown/inbox governance.

**Architecture:** Keep `core`, `retrieval`, `memory`, `hooks`, and `cli` responsibilities separate. User-facing text goes through a locale catalog; Hook injection goes through a relevance decision; model cache management stays separate from retrieval; background maintenance emits proposals only.

**Tech Stack:** TypeScript, Commander, Inquirer, Zod, SQLite FTS5, Transformers.js, Vitest.

---

### Task 1: ActorType Compatibility Migration

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli/configure.ts`
- Modify: `src/memory/governance.ts`
- Modify: `src/memory/inbox.ts`
- Modify: `templates/trae/agents/memory-writer.md`
- Modify: `.trae/skills/memory-maintainer/SKILL.md`
- Test: `tests/schema.test.ts`
- Test: `tests/config.test.ts`
- Test: `tests/inbox.test.ts`

- [ ] Add failing tests proving removed `system` values are rejected and new serialization/config output uses `agent`.
- [ ] Run `pnpm exec vitest run tests/schema.test.ts tests/config.test.ts tests/inbox.test.ts`; expect failure on canonical value assertions.
- [ ] Remove `system` from Zod/TypeScript unions, change Inquirer choice to `agent`, and update examples.
- [ ] Run the focused tests and `pnpm typecheck`; expect pass.
- [ ] Commit with `feat: rename system actor to agent`.

### Task 2: CLI and Hook Internationalization

**Files:**
- Create: `src/i18n/catalog.ts`
- Create: `src/i18n/locale.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli/prompts.ts`
- Modify: `src/cli/configure.ts`
- Modify: `src/cli/integration.ts`
- Test: `tests/i18n.test.ts`
- Test: `tests/config.test.ts`

- [ ] Add failing tests for `auto`, `zh-CN`, `en`, environment detection, unknown-language Chinese fallback, and manual override.
- [ ] Run focused tests; expect missing module/schema failures.
- [ ] Add `locale` to user config, message catalog keys for Commander/Prompts/results/Hook text, and locale resolver.
- [ ] Build Commander descriptions with the resolved locale before parsing; keep JSON keys unchanged.
- [ ] Run focused tests, typecheck, and CLI help smoke in Chinese and English.
- [ ] Commit with `feat: localize CLI and hook messages`.

### Task 3: Quiet Hook Relevance Gate

**Files:**
- Create: `src/hooks/relevance.ts`
- Modify: `src/hooks/hookOutput.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/hookOutput.test.ts`
- Create: `tests/hookRelevance.test.ts`

- [ ] Add failing tests: unrelated/no-hit prompt returns empty stdout; below-threshold returns empty; reliable hit returns packet only; catalog intent returns at most five relevant items.
- [ ] Run focused tests; expect missing relevance API.
- [ ] Implement catalog-intent detection, score threshold decision, related catalog filtering, max-token/max-item limits, and decision logging.
- [ ] Remove runtime context and coarse/full catalog from ordinary `UserPromptSubmit` model context.
- [ ] Run focused tests, build, and hook stdin/stdout smoke.
- [ ] Commit with `fix: suppress irrelevant hook context`.

### Task 4: Remove Legacy Template Link Command

**Files:**
- Delete: `src/integration/templates.ts`
- Modify: `src/index.ts`
- Modify: `src/cli.ts`
- Modify: `AGENTS.md`
- Modify: `docs/guides/integrations.md`
- Modify: `docs/superpowers/specs/2026-07-19-agent-knowledge-evolution-design.md`
- Modify: `docs/superpowers/plans/2026-07-19-agent-knowledge-evolution.md`

- [ ] Add a CLI smoke assertion that the legacy template-link command is absent from help.
- [ ] Delete CLI registration, TypeScript exports, implementation, and compatibility documentation.
- [ ] Search the repository for the removed CLI/API identifiers; expect no live code or documentation references.
- [ ] Run typecheck/build.
- [ ] Commit with `refactor: remove legacy template link command`.

### Task 5: Embedding and Reranker Model Management

**Files:**
- Create: `src/retrieval/modelCache.ts`
- Modify: `src/core/config.ts`
- Modify: `src/retrieval/embeddings.ts`
- Modify: `src/cli.ts`
- Modify: `src/transformers-js.d.ts`
- Test: `tests/modelCache.test.ts`

- [ ] Add failing tests using an injected registry adapter for cached/missing files, embedding/reranker kinds, download progress, and no-network status.
- [ ] Implement Agent Knowledge cache dir and model descriptors.
- [ ] Implement `embedding status` and `embedding download`; status uses Transformers.js cache registry without network, download initializes the selected pipeline with progress.
- [ ] Keep query/embed-index/hook `local_files_only` behavior unchanged.
- [ ] Run focused tests, typecheck/build, and local-provider CLI smoke.
- [ ] Commit with `feat: manage local retrieval models`.

### Task 6: Complete Stage-One Evaluation Corpus

**Files:**
- Create: `tests/fixtures/eval-knowledge/knowledge/**/*.md`
- Create: `eval/cases/retrieval-complete.yaml`
- Modify: `src/retrieval/eval.ts`
- Modify: `src/cli.ts`
- Test: `tests/eval.test.ts`

- [ ] Create 17 sanitized topics with positive paraphrases and near-topic hard negatives; add cross-language, temporal, forbidden, and no-answer cases.
- [ ] Extend eval CLI options to lexical/hybrid/reranked and stable JSON output suitable for scheduled runs.
- [ ] Add deterministic CI tests requiring zero forbidden injection and expected aggregate floors.
- [ ] Run `pnpm exec vitest run tests/eval.test.ts` and the complete eval CLI with local provider.
- [ ] Commit with `test: complete retrieval evaluation corpus`.

### Task 7: Batch Cross-Encoder Reranker

**Files:**
- Create: `src/retrieval/reranker.ts`
- Modify: `src/retrieval/query.ts`
- Modify: `src/retrieval/scoring.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Test: `tests/reranker.test.ts`
- Test: `tests/query.test.ts`

- [ ] Add failing tests for deterministic batch scores, top-30 input, threshold filtering, top-8 output, and async pipeline compatibility.
- [ ] Define `BatchCandidateReranker`; add deterministic and Transformers.js BGE implementations.
- [ ] Change hybrid query to fuse/filter, batch rerank top 30, combine features, apply threshold, and keep top 8.
- [ ] Expose reranker decisions in debug and model management.
- [ ] Run focused tests, complete deterministic eval, typecheck/build.
- [ ] Commit with `feat: add batch cross encoder reranking`.

### Task 8: Retrieval Calibration

**Files:**
- Create: `src/retrieval/calibration.ts`
- Modify: `src/retrieval/feedback.ts`
- Modify: `src/cli.ts`
- Test: `tests/calibration.test.ts`

- [ ] Add failing tests for finite grid search, false-injection penalties, abstention penalties, usefulness feedback penalties, deterministic tie-breaking, and dry-run output.
- [ ] Implement calibration over minimum score, dense/RRF/reranker weights, and result K.
- [ ] Add `eval calibrate --input <suite>`; output suggestions only.
- [ ] Run focused tests and complete eval smoke.
- [ ] Commit with `feat: calibrate retrieval thresholds`.

### Task 9: Maintenance Proposal Worker

**Files:**
- Create: `src/memory/proposals.ts`
- Create: `src/memory/maintenance.ts`
- Modify: `src/core/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/hooks/staging.ts`
- Test: `tests/maintenance.test.ts`

- [ ] Add failing tests for bounded watermark consumption, duplicate/consolidation/update/conflict proposals, idempotency, lock recovery, run/watch, and no active Markdown writes.
- [ ] Define proposal JSON schemas and atomic `.memory/proposals/` writer.
- [ ] Implement deterministic grouping by normalized domain/title/aliases and supersedes/conflict evidence.
- [ ] Add `maintenance run` and `maintenance watch`.
- [ ] Run focused tests, typecheck/build.
- [ ] Commit with `feat: generate maintenance proposals`.

### Task 10: Episode Provenance and Skill Proposals

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/schema.ts`
- Modify: `src/memory/governance.ts`
- Modify: `src/memory/inbox.ts`
- Modify: `src/memory/organizer.ts`
- Modify: `src/memory/proposals.ts`
- Modify: `templates/trae/agents/memory-writer.md`
- Test: `tests/schema.test.ts`
- Test: `tests/maintenance.test.ts`
- Test: `tests/organizer.test.ts`

- [ ] Add failing tests for optional episode provenance, legacy Markdown compatibility, independent-session counting, and procedural Skill eligibility.
- [ ] Add structured provenance and preserve it through candidate/capture/promotion.
- [ ] Generate Skill proposals only for verified/owner-confirmed procedures with at least three independent episodes, no unresolved conflict, and positive feedback.
- [ ] Ensure proposal output contains a draft but never writes `.trae/skills`.
- [ ] Run focused tests, typecheck/build.
- [ ] Commit with `feat: propose temporal updates and reusable skills`.

### Task 11: Completion Report and Final Validation

**Files:**
- Modify: `docs/research/2026-07-18-hivemind-memory-and-embeddings-evaluation.md`
- Modify: `README.md`
- Modify: `docs/guides/configuration.md`
- Modify: `docs/guides/retrieval.md`
- Modify: `docs/guides/memory-governance.md`
- Modify: `AGENTS.md`

- [ ] Add a per-stage checklist marking each original item implemented with command/test evidence.
- [ ] Document locale, ActorType migration, quiet Hook behavior, model status/download, reranker/calibration, maintenance proposals, and provenance.
- [ ] Run `pnpm test`, `pnpm typecheck`, `pnpm build`, `git diff --check`.
- [ ] Run CLI smoke for both locales, empty Hook stdout, embedding status, full eval, maintenance run, and absence of legacy link command.
- [ ] Commit with `docs: complete hivemind implementation roadmap`.
