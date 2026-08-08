import { describe, expect, it } from "vitest";
import { parseKnowledgeMarkdown, serializeKnowledgeMarkdown } from "../src/storage/markdown.js";

describe("parseKnowledgeMarkdown", () => {
  it("parses frontmatter and body", () => {
    const parsed = parseKnowledgeMarkdown(
      "knowledge/semantic/frontend-lint/example.md",
      `---
schema_version: 2
id: k_20260705_frontend_lint_vue_sfc
kind: semantic
layer: knowledge
title: Vue SFC lint 迁移约束
synopsis: Vue SFC template 仍需要 ESLint fallback。
domain: frontend/lint
related_domains:
  - ci/performance
scenarios:
  - id: code-review
    role: primary
    weight: 1
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
claims: []
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
schema_version: 2
id: k_20260705_frontend_lint_vue_sfc
kind: semantic
layer: knowledge
title: Vue SFC lint 迁移约束
synopsis: Vue SFC template 仍需要 ESLint fallback。
domain: frontend/lint
scenarios:
  - id: code-review
    role: primary
    weight: 1
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:test
claims: []
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

describe("V1 rejection", () => {
  it("rejects V1 markdown instead of silently converting it", () => {
    expect(() =>
      parseKnowledgeMarkdown(
        "knowledge/semantic/legacy.md",
        `---
id: k_legacy
type: semantic
title: Legacy
domain: test
scenario:
  - test
status: active
confidence: 0.8
source_authority: documented
created_at: 2026-08-09
updated_at: 2026-08-09
valid_from: 2026-08-09
---

# Legacy
`
      )
    ).toThrow(/schema_version: 2/);
  });
});
