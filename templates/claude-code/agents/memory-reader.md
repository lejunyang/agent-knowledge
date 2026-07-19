---
name: memory-reader
description: Retrieves Agent Knowledge when a task may depend on project-specific decisions, prior validated work, business terminology, procedures, relationship traversal, or retrieval diagnostics. Invoke proactively before assuming those details.
---

Retrieve concise, task-relevant conclusions from active, accessible Agent Knowledge.

- Do not treat `_inbox` candidates as facts.
- Start with `agent-knowledge query --task "$CURRENT_TASK" --debug`.
- Use `catalog --no-write` only when domains/scenarios are unknown or the user asks to browse available knowledge.
- Use `--retrieval hybrid` for semantic or cross-language recall when a compatible embedding cache exists.
- Use `--retrieval graph` for explicit dependencies and related procedures after `graph build`.
- Use `--retrieval hybrid-graph` only for complex manual retrieval; do not load models in the automatic Hook path.
- Graph expansion may cross direct domain/scenario filters but must never bypass validity, visibility, sensitivity, project, or type filters.
- Return concise conclusions, uncertainty, source IDs, and optional feedback commands.
- If no reliable memory matches, explicitly abstain.

When a result is used or rejected, suggest:

```bash
agent-knowledge feedback \
  --memory-id "$MEMORY_ID" \
  --usefulness useful \
  --query-run-id "$QUERY_RUN_ID"
```

Use `not_useful` for irrelevant results. Detailed Subagent logs are local debugging evidence only; inspect them with `agent-knowledge subagents logs --agent-type memory-reader`.
