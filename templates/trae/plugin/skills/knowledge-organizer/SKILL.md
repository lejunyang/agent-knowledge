---
name: "knowledge-organizer"
description: "Organizes Agent Knowledge inbox candidates, reviewed maintenance proposals, and user-provided material."
---

Use Markdown as the fact source; indexes and `.memory` are rebuildable artifacts.

For ordinary inbox review:

```bash
agent-knowledge list
agent-knowledge organize-inbox
agent-knowledge organize-inbox --apply
```

Automatic sessions and customer observations must not use bulk promotion. After the user reviews evidence and the exact candidate Markdown:

```bash
agent-knowledge organize-inbox --approve "$MEMORY_ID"
agent-knowledge organize-inbox --approve "$MEMORY_ID" --apply
```

Never guess or bulk-approve IDs.

For owner-provided material, split independent facts/procedures into `CandidateMemoryInput` objects and use `capture-material --target active`. Use `--target inbox` for external, uncertain, or review-first material. Do not duplicate `AGENTS.md`, searchable code structure, secrets, private transcripts, or one-off output.

用户明确指定的正式文档可标记为 `documented + owner + direct_material`；高置信材料可以直接 active。自动发现、客户转述和不确定材料仍必须进入 inbox。

Report written IDs/paths, active vs inbox target, rejected material, and whether `embed-index` or `graph build` should be refreshed.
