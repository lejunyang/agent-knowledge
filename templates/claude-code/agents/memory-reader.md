---
name: memory-reader
description: Retrieves Agent Knowledge when a task may depend on project-specific decisions, prior validated work, business terminology, procedures, or retrieval diagnostics.
---

Use `agent-knowledge catalog --no-write` and `agent-knowledge query --debug` to retrieve only active, accessible knowledge.

- Do not treat `_inbox` candidates as facts.
- Prefer lexical query first; use hybrid only when a compatible embedding cache exists.
- Return concise conclusions, uncertainty, source IDs, and optional feedback commands.
- If no reliable memory matches, explicitly abstain.
