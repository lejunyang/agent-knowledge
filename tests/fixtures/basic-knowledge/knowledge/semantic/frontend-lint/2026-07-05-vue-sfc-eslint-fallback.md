---
id: k_20260705_frontend_lint_vue_sfc
type: semantic
title: Vue SFC lint 迁移约束
domain: frontend/lint
related_domains:
  - ci/performance
  - monorepo/tooling
scenario:
  - code-review
  - lint-migration
tags:
  - oxlint
  - eslint
  - vue-sfc
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:2026-07-05-agent-memory-design
related_knowledge:
  - id: k_20260705_lint_validation_flow
    relation: often_used_with
    reason: Lint 迁移约束通常需要配合验证流程使用。
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
created_at: 2026-07-05
updated_at: 2026-07-05
valid_from: 2026-07-05
valid_until:
---

# Vue SFC lint 迁移约束

## 结论

Oxlint 负责 TS/JS 快速检查，Vue SFC template 仍需要 ESLint fallback。

## 适用场景

用于 lint 迁移、代码审查、CI 性能优化相关任务。
