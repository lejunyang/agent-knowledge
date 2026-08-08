---
schema_version: 2
id: k_20260705_lint_validation_flow
kind: procedural
layer: knowledge
title: Lint 迁移验证流程
synopsis: 迁移 lint 配置后，应按 Oxlint -> ESLint fallback -> Oxfmt 的顺序验证。
aliases:
  - value: lint-checklist
    kind: user_phrase
    weight: 0.8
    source: documented
  - value: validation-flow
    kind: technical_identifier
    weight: 0.8
    source: documented
domain: frontend/lint
related_domains:
  - ci/performance
scenarios:
  - id: lint-migration
    role: primary
    weight: 1
  - id: code-review
    role: secondary
    weight: 0.8
tags:
  - value: oxlint
    weight: 0.9
    source: taxonomy
    retrieval: true
  - value: eslint
    weight: 0.9
    source: taxonomy
    retrieval: true
  - value: oxfmt
    weight: 0.9
    source: taxonomy
    retrieval: true
status: active
confidence: 0.8
source_authority: verified_task
source:
  - conversation:2026-07-05-agent-memory-design
claims: []
related_knowledge: []
supersedes: []
conflicts_with: []
visibility: project
sensitivity: internal
project_keys: []
capture_mode: verified_task
actor_type: agent
corroboration_count: 1
episodes: []
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
