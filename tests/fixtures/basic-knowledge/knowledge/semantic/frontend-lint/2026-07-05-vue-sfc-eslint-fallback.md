---
schema_version: 2
id: k_20260705_frontend_lint_vue_sfc
kind: semantic
layer: knowledge
title: Vue SFC lint 迁移约束
synopsis: Oxlint 负责 TS/JS 快速检查，Vue SFC template 仍需要 ESLint fallback。
aliases:
  - value: vue-lint
    kind: user_phrase
    weight: 0.8
    source: user_confirmed
  - value: sfc-lint
    kind: technical_identifier
    weight: 0.9
    source: documented
domain: frontend/lint
related_domains:
  - ci/performance
  - monorepo/tooling
scenarios:
  - id: code-review
    role: primary
    weight: 0.9
  - id: lint-migration
    role: primary
    weight: 1
tags:
  - value: oxlint
    weight: 0.9
    source: taxonomy
    retrieval: true
  - value: eslint
    weight: 0.9
    source: taxonomy
    retrieval: true
  - value: vue-sfc
    weight: 1
    source: taxonomy
    retrieval: true
status: active
confidence: 0.86
source_authority: user_confirmed
source:
  - conversation:2026-07-05-agent-memory-design
claims: []
related_knowledge:
  - id: k_20260705_lint_validation_flow
    relation: often_used_with
    reason: Lint 迁移约束通常需要配合验证流程使用。
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
project_keys: []
capture_mode: direct_material
actor_type: owner
corroboration_count: 1
episodes: []
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
