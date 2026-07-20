# 知识图谱可视化改造设计

## 目标

把当前一次性绘制全部节点的 SVG 圆环图改成可实际浏览的离线交互图：

- 使用现成图组件完成缩放、平移、拖拽和自动布局。
- 默认只展示精炼知识及其 domain/scenario/project 邻居。
- 原始 source 知识、source 证据、episode 和 proposal 默认隐藏，按需展开。
- 点击节点自动展开一跳邻域，并可聚焦、重新布局和恢复默认视图。
- 全图仍可显式查看，但不作为首次打开的默认视图。

## 现状与根因

真实图谱包含 1458 个节点、3593 条边：

- knowledge：689，其中 656 条是完整 source 原文对应的知识节点。
- source：693。
- domain：10。
- scenario：65。
- project：1。

当前 renderer 把全部节点放在同一个圆环上，使用 SVG 绘制所有边和标签。该方案没有力导向布局、缩放平移、标签降噪或分层加载，节点规模超过几十后必然不可读。

## 组件选择

采用 `Cytoscape.js`：

- 自带 Canvas renderer、缩放、平移、拖拽、选择和事件。
- 内置 `cose`、`breadthfirst`、`concentric`、`grid` 等布局，不需要额外布局扩展。
- 1458 节点/3593 边可以渲染；默认子图只有约百级节点，交互成本更低。
- 可把浏览器 bundle 内嵌到导出的 HTML，继续保持无 CDN、离线可打开。

未选择：

- Sigma.js：WebGL 大图性能更强，但需要 Graphology 和额外布局链，当前规模与子图优先策略不需要这层复杂度。
- vis-network：接入简单，但大图物理布局稳定性和可定制过滤不如 Cytoscape。

## 架构

### `src/graph/view.ts`

负责把完整 `KnowledgeGraph` 转换为浏览器视图数据：

- 标记 source memory：`node.type=knowledge && metadata.memoryType=source`。
- 计算默认精炼知识节点。
- 加入与精炼知识直接相连的 domain/scenario/project 节点。
- 输出节点类型、状态、domain、project 的筛选选项和数量摘要。
- 不修改 `.memory/graph.json`，只生成导出视图。

### `src/graph/html.ts`

负责：

- 内嵌 Cytoscape 浏览器 bundle 和完整 graph/view 数据。
- 初始化 Canvas 图。
- 提供三种视图：
  - 精炼知识：默认。
  - 精炼知识 + 直接证据。
  - 全部节点。
- 提供搜索、节点类型、知识状态、domain、project 筛选。
- 点击节点展开一跳邻域并展示详情。
- 提供自动布局、适应视图、放大、缩小、重置和清除展开。
- 低缩放级别隐藏普通标签，只保留选中节点标签。

## 交互规则

1. 首次打开只显示非 source 类型的 active 精炼知识及其结构邻居。
2. 搜索命中隐藏节点时，临时显示命中节点和一跳邻域。
3. 点击节点后：
   - 选中节点；
   - 加入一跳邻居；
   - 更新详情面板；
   - 聚焦节点邻域。
4. 切换到全图时不自动执行高成本动画；使用 draft COSE 或用户选择的布局。
5. 所有筛选和展开只影响可视化，不改变 graph 索引。

## 离线与安全

- 不加载 CDN、远程字体、远程脚本或网络资源。
- Cytoscape minified bundle 在导出时内嵌。
- Graph JSON 中的 `<` 继续转义，防止数据闭合 script 标签。
- 详情面板使用文本输出，不执行 metadata HTML。

## 测试与验收

- 单元测试默认视图排除 source memory/source evidence。
- 单元测试保留精炼知识与 domain/scenario/project 邻居。
- HTML 测试包含 Cytoscape、视图模式、布局、缩放、重置、邻域和筛选控件。
- HTML 不包含外部 `<script src>`。
- 对真实图谱重新导出后：
  - 默认可见节点显著少于全图；
  - 可缩放、拖拽、自动布局；
  - 点击可展开邻域；
  - 全图模式可选；
  - 文件离线打开。
