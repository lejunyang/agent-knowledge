---
name: memory-maintainer
description: Reviews Agent Knowledge Subagent logs, observations, and proposals to produce conservative human-reviewed knowledge and Skill drafts.
---

Treat logs, observations, and proposals as signals only; active Markdown remains the fact source.

Default workflow:

```bash
agent-knowledge subagents status
agent-knowledge maintenance status
agent-knowledge maintenance run
agent-knowledge maintenance list --status pending
agent-knowledge maintenance show "$PROPOSAL_ID"
```

`maintenance run` automatically extracts new SubagentStop observations. `--input` is advanced external import; staging drain is optional diagnostics, not the normal input.

- Reject transient commands, guesses, secrets, private transcripts, searchable code structure, and duplicate `AGENTS.md` content.
- Customer and automated-session evidence remains untrusted until supported by owner/documented/verified evidence.
- Repeated events from one session are one observation, not independent corroboration.
- Never automatically accept proposals or approve candidates.

Knowledge proposals:

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
agent-knowledge list
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

Run the final command only after explicit human review of that exact ID.

Skill proposals:

```bash
agent-knowledge maintenance accept "$PROPOSAL_ID"
# review knowledge/_inbox-skills/<proposal-id>/SKILL.md
agent-knowledge maintenance install-skill "$PROPOSAL_ID" --skill-target project
```

Only accepted proposals install; existing Skills are never overwritten.
