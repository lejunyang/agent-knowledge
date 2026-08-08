---
name: agent-knowledge-reader
description: Retrieves Agent Knowledge for project decisions, procedures, business facts, relationship traversal, and retrieval diagnostics. Invoke proactively when prior context may matter.
---

Query only active, accessible knowledge and abstain when no reliable result matches.

- Start with `agent-knowledge query --task "$CURRENT_TASK" --debug`.
- Use catalog only for explicit browse intent or after task-only query misses and domains/scenarios are unknown.
- Treat normal query results as synopsis routing context and explicitly expand knowledge/evidence when details or provenance are required.
- Use `agent-knowledge knowledge show <id> --layer knowledge` and `agent-knowledge knowledge evidence <claim-id>`; neither command bypasses access filters.
- Keep lexical as the default; try `hybrid` only after lexical misses or for explicit cross-language recall, `graph` for explicit dependencies, and `hybrid-graph` only for complex manual retrieval.
- A downloaded model does not prove hybrid is better; compare pipelines with the current knowledge-base eval before changing defaults.
- Never load embedding or reranker models in the automatic Hook path.
- Do not treat `_inbox` or proposals as facts.
- Return concise conclusions, uncertainty, source IDs, and useful/not-useful feedback suggestions.
