import { describe, expect, it } from "vitest";
import { parseKnowledgeMarkdown, serializeKnowledgeMarkdown } from "../src/storage/markdown.js";

describe("parseKnowledgeMarkdown", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseKnowledgeMarkdown(
      "knowledge/semantic/frontend-lint/example.md",
      `---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
related_domains:
  - ci/performance
scenario:
  - code-review
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
---

# Vue SFC lint 迁移约束

## 结论

Vue SFC template 仍需要 ESLint fallback。
`
    );

    expect(parsed.frontmatter.id).toBe("k_20260705_frontend_lint_vue_sfc");
    expect(parsed.frontmatter.related_domains).toEqual(["ci/performance"]);
    expect(parsed.body).toContain("Vue SFC template");
  });
});

describe("serializeKnowledgeMarkdown", () => {
  it("round-trips a knowledge document", () => {
    const document = parseKnowledgeMarkdown(
      "knowledge/semantic/frontend-lint/example.md",
      `---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
scenario:
  - code-review
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
---

# Vue SFC lint 迁移约束
`
    );

    const markdown = serializeKnowledgeMarkdown(document);
    expect(markdown).toContain("id: k_20260705_frontend_lint_vue_sfc");
    expect(markdown).toContain("# Vue SFC lint 迁移约束");
  });
});
