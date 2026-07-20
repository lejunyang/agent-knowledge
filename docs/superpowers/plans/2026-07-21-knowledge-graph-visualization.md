# 知识图谱可视化改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用 Cytoscape.js 和子图优先策略，把离线知识图谱导出改造成可缩放、可自动布局、可按需展开的实用浏览器。

**Architecture:** 新增 `src/graph/view.ts` 负责从完整图谱计算默认精炼知识子图；`src/graph/html.ts` 内嵌 Cytoscape bundle 和视图数据，负责交互与渲染。完整 `.memory/graph.json` 不改变，HTML 只改变展示策略。

**Tech Stack:** TypeScript、Cytoscape.js、Vitest、离线自包含 HTML。

---

### Task 1: 图视图投影

**Files:**
- Create: `src/graph/view.ts`
- Modify: `src/index.ts`
- Test: `tests/graphView.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖 source memory/source evidence 默认隐藏，以及精炼知识的 domain/scenario/project 邻居保留。

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- tests/graphView.test.ts`

Expected: FAIL，因为 `buildKnowledgeGraphView` 尚不存在。

- [ ] **Step 3: 实现默认子图投影**

输出完整节点/边、默认节点 ID、节点统计与筛选选项；不修改原始 graph。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- tests/graphView.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/graph/view.ts src/index.ts tests/graphView.test.ts
git commit -m "feat: project readable graph views"
```

### Task 2: Cytoscape 离线渲染器

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/graph/html.ts`
- Test: `tests/graphHtml.test.ts`

- [ ] **Step 1: 安装 Cytoscape.js**

Run: `pnpm add cytoscape`

Expected: dependency 与 lockfile 更新。

- [ ] **Step 2: 扩展 HTML 失败测试**

要求 Cytoscape 初始化、视图模式、布局、缩放、适应、重置、邻域展开和离线自包含。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm test -- tests/graphHtml.test.ts`

Expected: FAIL，因为当前还是 SVG 圆环 renderer。

- [ ] **Step 4: 替换 renderer**

内嵌 Cytoscape minified bundle；使用 Canvas、COSE/Concentric/Breadthfirst/Grid 布局；加入筛选、节点详情、点击展开和相机控制。

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm test -- tests/graphHtml.test.ts tests/graphView.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add package.json pnpm-lock.yaml src/graph/html.ts tests/graphHtml.test.ts
git commit -m "feat: render interactive cytoscape graph"
```

### Task 3: 文档与真实图谱验收

**Files:**
- Modify: `README.md`
- Modify: `docs/guides/retrieval.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: 更新使用说明**

说明默认精炼知识视图、证据/全图模式、交互控件和大图浏览建议。

- [ ] **Step 2: 运行全量验证**

Run:

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm check:comments
node dist/cli.js graph build --root .
node dist/cli.js graph export --root . --format html --output local_exports/analysis/knowledge-graph.html
```

Expected: 全部通过；HTML 离线导出成功。

- [ ] **Step 3: 检查真实 HTML**

确认默认节点远少于 1458、可缩放平移、切换布局、点击展开邻域，并保留全图模式。

- [ ] **Step 4: 提交**

```bash
git add README.md docs/guides/retrieval.md AGENTS.md
git commit -m "docs: explain interactive graph browsing"
```
