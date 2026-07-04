---
id: k_20260705_lint_validation_flow
type: procedural
title: Lint 迁移验证流程
domain: frontend/lint
related_domains:
  - ci/performance
scenario:
  - lint-migration
  - code-review
tags:
  - oxlint
  - eslint
  - oxfmt
status: active
confidence: 0.8
source_authority: verified_task
source:
  - conversation:2026-07-05-agent-memory-design
related_knowledge: []
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
valid_until:
---

# Lint 迁移验证流程

## 结论

迁移 lint 配置后，应按 Oxlint -> ESLint fallback -> Oxfmt 的顺序验证。

## 适用场景

用于 lint 迁移、CI 性能优化和代码审查任务。
