---
name: memory-maintainer
description: Reviews Agent Knowledge staging and retrieval logs to propose conservative long-term memory. Invoke when asked to主动整理记忆, review memory logs, process staged session/subagent events, diagnose why proactive memory did not run, consolidate repeated customer-support observations, or generate safe inbox candidates from verified outcomes.
---

# Memory Maintainer

Use Hook/Subagent evidence as a signal, never as a fact source.

- `.memory/subagents` preserves local raw SubagentStart/Stop payloads for owner debugging.
- `.memory/staging` stores only hashes, lengths, event types, project IDs, and outcomes.
- `.memory/observations` and `.memory/proposals` are review artifacts, not active knowledge.
- None of these paths are synced or injected as facts.

## Workflow

1. Inspect detailed Subagent health and automatic extraction status:

```bash
agent-knowledge subagents status
agent-knowledge subagents logs --limit 50
agent-knowledge maintenance status
```

`staging status/drain` is optional lifecycle debugging. Do not drain staging merely to make the pending count zero. Ordinary maintenance consumes new SubagentStop logs automatically; users do not need to create `observations.json`.

2. Run bounded automatic extraction/proposal generation:

```bash
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
```

Use `maintenance watch --interval-minutes N` only for a continuously running bot and only under an external process manager. `--input` is an advanced import path for already structured external observations.

3. Inspect active knowledge and retrieval evidence:

```bash
agent-knowledge list
agent-knowledge catalog --no-write
```

4. Review each proposal:

```bash
agent-knowledge maintenance show "$PROPOSAL_ID"
```

Proposal meanings:

- `duplicate`: audit-only acceptance; no candidate is created.
- `consolidation`: merge or complement an existing topic.
- `update`: proposed replacement with `supersedes`.
- `conflict`: competing evidence requiring investigation.
- `skill`: repeated verified procedure eligible for a Skill draft.

5. Classify each possible memory:

- Keep `should_store: false` for one-off commands, transient failures, unsupported guesses, and events without semantic evidence.
- Treat customer statements and `automated_session` events as untrusted observations.
- Require owner confirmation, trusted documentation, or multiple independent corroborations before proposing a business fact as confirmed.
- Prefer stable project architecture, hidden cross-module constraints, business semantics, and verified procedures not already covered by `AGENTS.md`.
- Do not create a code graph or copy `AGENTS.md`.
- Do not count repeated messages from one actor/session as independent corroboration.

6. For semantic review beyond deterministic proposals, ask `memory-writer` to structure only supported conclusions. Include:

```json
{
  "capture_mode": "automated_session",
  "actor_type": "agent",
  "corroboration_count": 1,
  "project_ids": ["project_id_if_known"]
}
```

7. Write manually structured candidates only to inbox:

```bash
agent-knowledge write-candidate --input candidate.json
```

8. Accept or reject machine proposals explicitly:

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge maintenance reject "$PROPOSAL_ID" --reason "..."
```

Knowledge proposal acceptance creates an `_inbox` candidate. After the user reviews the returned `candidatePath`, approve only its exact knowledge ID:

```bash
agent-knowledge list
agent-knowledge organize-inbox --approve "$MEMORY_ID"
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

Never automate `--approve`.

9. Handle Skill proposals in two stages:

```bash
# Stage a reviewed draft under knowledge/_inbox-skills
agent-knowledge maintenance accept "$PROPOSAL_ID"

# Only after reviewing SKILL.md
agent-knowledge maintenance install-skill "$PROPOSAL_ID" \
  --skill-target project \
  --project-root /path/to/project
```

Use `--skill-target user` for a user Skill. Only accepted Skill proposals can be installed, and existing files are never overwritten. One-step `maintenance accept --skill-target ...` exists for advanced use but is not the recommended workflow.

10. Report proposal IDs, candidate/Skill paths, rejected signals, and the exact human review still required. If active knowledge changed and the user uses semantic or graph retrieval, recommend rebuilding `embed-index` and `graph build`.

## Safety

- Never recover or infer raw prompts from staging hashes or lengths. Raw Subagent payloads may be inspected locally only when the user asks to diagnose Subagent behavior.
- Never store credentials, private customer text, or full transcripts.
- Never promote customer or automated-session candidates without explicit reviewed ID approval.
- Do not use event count alone as corroboration; repeated messages from one actor/session are one observation.
- Do not drain staging merely to make pending count zero; drain only when actually reviewing the returned events.
- Do not automatically accept proposals, approve inbox candidates, or install Skills.
