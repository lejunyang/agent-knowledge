/**
 * 知识关系图的自包含离线 HTML 可视化。
 *
 * Cytoscape 浏览器 bundle 在导出时内嵌；浏览器只加载当前视图需要的元素，避免完整图中大量
 * source 原文和证据节点即使隐藏也参与布局计算。
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { KnowledgeGraph } from "./types.js";
import { buildKnowledgeGraphView } from "./view.js";

const require = createRequire(import.meta.url);
let cytoscapeBrowserBundle: string | undefined;

/** 读取并缓存 Cytoscape minified 浏览器 bundle，同时防止内容意外闭合外层 script。 */
function readCytoscapeBrowserBundle(): string {
  cytoscapeBrowserBundle ??= readFileSync(
    require.resolve("cytoscape/dist/cytoscape.min.js"),
    "utf8"
  ).replace(/<\/script/gi, "<\\/script");
  return cytoscapeBrowserBundle;
}

/** 把 graph node 转成 Cytoscape 可直接消费且可筛选的扁平数据。 */
function browserNode(node: KnowledgeGraph["nodes"][number]): {
  data: Record<string, unknown>;
  classes: string;
} {
  const projectKeys = Array.isArray(node.metadata.projectKeys)
    ? node.metadata.projectKeys
    : [];
  const sourceMemory =
    node.type === "knowledge" && node.metadata.memoryType === "source";
  return {
    data: {
      id: node.id,
      label: node.label,
      type: node.type,
      metadata: node.metadata,
      memoryType: node.metadata.memoryType ?? "",
      status: node.metadata.status ?? "",
      domain:
        node.metadata.domain ?? (node.type === "domain" ? node.label : ""),
      projectKeys,
      searchText: [
        node.id,
        node.label,
        JSON.stringify(node.metadata)
      ]
        .join("\n")
        .toLowerCase()
    },
    classes: `${node.type}${sourceMemory ? " source-memory" : ""}`
  };
}

/** 把 graph edge 转成 Cytoscape 元素并保留类型与 metadata。 */
function browserEdge(edge: KnowledgeGraph["edges"][number]): {
  data: Record<string, unknown>;
  classes: string;
} {
  return {
    data: {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      metadata: edge.metadata
    },
    classes: `relation ${edge.type}`
  };
}

/** 内嵌 graph/view 数据和 Cytoscape renderer，不依赖外部脚本、样式或 CDN。 */
export function renderKnowledgeGraphHtml(graph: KnowledgeGraph): string {
  const view = buildKnowledgeGraphView(graph);
  const payload = JSON.stringify({
    view,
    nodes: graph.nodes.map(browserNode),
    edges: graph.edges.map(browserEdge)
  }).replace(/</g, "\\u003c");
  const cytoscapeBundle = readCytoscapeBrowserBundle();
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Knowledge Graph</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f6fb}
*{box-sizing:border-box}
body{margin:0;display:grid;grid-template-columns:350px minmax(0,1fr);height:100vh;overflow:hidden}
aside{padding:18px;background:#fff;border-right:1px solid #dce1ec;overflow:auto;z-index:3}
main{position:relative;overflow:hidden;min-width:0}
h2{margin:0 0 8px}.hint{font-size:12px;line-height:1.5;color:#66738b}
.summary{font-size:12px;color:#536079;background:#f4f7fb;border-radius:8px;padding:10px;line-height:1.5}
label{display:block;font-size:12px;font-weight:700;margin-top:12px;color:#536079}
input,select,button{font:inherit}
input,select{width:100%;padding:8px;margin-top:4px;border:1px solid #cbd3e1;border-radius:6px;background:#fff;color:#172033}
button{border:1px solid #cbd3e1;background:#fff;color:#27334a;border-radius:7px;padding:7px 10px;cursor:pointer}
button:hover{background:#eef3fb;border-color:#9daac0}
.button-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:8px}
.toolbar{position:absolute;top:14px;left:14px;right:14px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;z-index:2;pointer-events:none}
.toolbar>*{pointer-events:auto;box-shadow:0 2px 8px rgba(37,51,78,.12)}
.toolbar select{width:auto;min-width:130px;margin:0}
#graph{width:100%;height:100%;background:radial-gradient(circle at 50% 45%,#fff 0,#f7f9fd 55%,#edf1f8 100%)}
#details{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;background:#f7f8fb;border:1px solid #e0e4ed;border-radius:6px;padding:10px;margin-top:16px;min-height:140px;line-height:1.5}
#status{position:absolute;left:14px;bottom:14px;z-index:2;padding:7px 10px;border-radius:7px;background:rgba(255,255,255,.92);box-shadow:0 2px 8px rgba(37,51,78,.12);font-size:12px;color:#536079}
.legend{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:12px;font-size:11px;color:#536079}
.legend span::before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:var(--color)}
@media(max-width:800px){body{grid-template-columns:1fr;grid-template-rows:auto minmax(0,1fr)}aside{max-height:42vh;border-right:0;border-bottom:1px solid #dce1ec}.toolbar{top:8px;left:8px;right:8px}}
</style>
</head>
<body>
<aside>
<h2>知识关系图</h2>
<p class="hint">默认只展示精炼知识。点击节点展开一跳邻域；滚轮缩放，拖动画布平移，拖动节点调整位置。</p>
<div id="summary" class="summary"></div>
<label for="view-mode">视图</label>
<select id="view-mode">
  <option value="refined">精炼知识</option>
  <option value="evidence">精炼知识 + 直接证据</option>
  <option value="all">全部节点（较慢）</option>
</select>
<label for="search">搜索</label><input id="search" placeholder="title / domain / id">
<label for="type-filter">节点类型</label><select id="type-filter"><option value="">全部</option></select>
<label for="status-filter">知识状态</label><select id="status-filter"><option value="">全部</option></select>
<label for="domain-filter">Domain</label><select id="domain-filter"><option value="">全部</option></select>
<label for="project-filter">Project</label><select id="project-filter"><option value="">全部</option></select>
<div class="button-row">
  <button id="clear-expansion-button" type="button">清除展开</button>
  <button id="reset-button" type="button">重置视图</button>
</div>
<div class="legend">
  <span style="--color:#3867d6">知识</span>
  <span style="--color:#20bf6b">Domain</span>
  <span style="--color:#8854d0">Scenario</span>
  <span style="--color:#f7b731">Project</span>
  <span style="--color:#778ca3">Source</span>
  <span style="--color:#eb3b5a">Proposal</span>
</div>
<div id="details">点击节点查看详情</div>
</aside>
<main>
  <div class="toolbar">
    <select id="layout-select" aria-label="布局">
      <option value="cose">COSE 自动布局</option>
      <option value="concentric">同心布局</option>
      <option value="breadthfirst">层级布局</option>
      <option value="grid">网格布局</option>
    </select>
    <button id="layout-button" type="button">自动整理</button>
    <button id="fit-button" type="button">适应视图</button>
    <button id="zoom-in-button" type="button">放大</button>
    <button id="zoom-out-button" type="button">缩小</button>
  </div>
  <div id="graph"></div>
  <div id="status"></div>
</main>
<script>${cytoscapeBundle}</script>
<script>
/* 视图数据由 buildKnowledgeGraphView 生成。 */
const payload=${payload};
const graph=payload.view.graph;
const nodesById=new Map(payload.nodes.map(function(node){return[node.data.id,node]}));
const edges=payload.edges;
const adjacency=new Map();
edges.forEach(function(edge){
  const source=edge.data.source,target=edge.data.target;
  if(!adjacency.has(source))adjacency.set(source,new Set());
  if(!adjacency.has(target))adjacency.set(target,new Set());
  adjacency.get(source).add(target);adjacency.get(target).add(source);
});
const controls={
  view:document.getElementById('view-mode'),
  search:document.getElementById('search'),
  type:document.getElementById('type-filter'),
  status:document.getElementById('status-filter'),
  domain:document.getElementById('domain-filter'),
  project:document.getElementById('project-filter'),
  layout:document.getElementById('layout-select')
};
const details=document.getElementById('details'),status=document.getElementById('status');
const expandedIds=new Set();
let selectedId=null,searchTimer=null;
function fill(select,items){items.forEach(function(value){const option=document.createElement('option');option.value=value;option.textContent=value;select.appendChild(option)})}
fill(controls.type,payload.view.filters.nodeTypes);
fill(controls.status,payload.view.filters.statuses);
fill(controls.domain,payload.view.filters.domains);
fill(controls.project,payload.view.filters.projects);
const summary=payload.view.summary;
document.getElementById('summary').textContent=
  summary.refinedKnowledge+' 条精炼知识 · '+summary.defaultNodes+' 个默认节点\\n'+
  summary.totalNodes+' 个总节点 · '+summary.totalEdges+' 条边\\n'+
  summary.sourceMemories+' 条原始 source 知识默认隐藏';
const cy=cytoscape({
  container:document.getElementById('graph'),
  elements:[],
  minZoom:.08,maxZoom:6,wheelSensitivity:.18,
  textureOnViewport:true,hideEdgesOnViewport:true,motionBlur:false,
  style:[
    {selector:'node',style:{'background-color':'#3867d6','border-color':'#fff','border-width':2,'width':20,'height':20,'label':'','font-size':10,'text-wrap':'ellipsis','text-max-width':150,'text-background-color':'#fff','text-background-opacity':.82,'text-background-padding':3,'text-border-color':'#dce1ec','text-border-width':1,'color':'#172033'}},
    {selector:'node.show-label, node:selected',style:{'label':'data(label)','text-valign':'bottom','text-margin-y':7}},
    {selector:'node.knowledge',style:{'background-color':'#3867d6','width':24,'height':24}},
    {selector:'node.knowledge.source-memory',style:{'background-color':'#95a5b5','shape':'diamond'}},
    {selector:'node.domain',style:{'background-color':'#20bf6b','shape':'round-rectangle','width':18,'height':18}},
    {selector:'node.scenario',style:{'background-color':'#8854d0','shape':'hexagon','width':16,'height':16}},
    {selector:'node.project',style:{'background-color':'#f7b731','shape':'rectangle','width':18,'height':18}},
    {selector:'node.episode',style:{'background-color':'#45aaf2','shape':'diamond','width':14,'height':14}},
    {selector:'node.source',style:{'background-color':'#778ca3','shape':'vee','width':14,'height':14}},
    {selector:'node.proposal',style:{'background-color':'#eb3b5a','shape':'star','width':18,'height':18}},
    {selector:'edge',style:{'curve-style':'haystack','line-color':'#b7c0d1','width':1,'opacity':.38,'target-arrow-shape':'none'}},
    {selector:'edge.depends_on,edge.refines,edge.supports,edge.often_used_with',style:{'curve-style':'bezier','target-arrow-shape':'triangle','target-arrow-color':'#778ca3','opacity':.7,'width':1.5}},
    {selector:'edge.conflicts_with',style:{'line-color':'#d83b3b','target-arrow-color':'#d83b3b','line-style':'dashed','target-arrow-shape':'triangle','opacity':.9,'width':2}},
    {selector:'edge.supersedes',style:{'line-color':'#e78b1f','target-arrow-color':'#e78b1f','target-arrow-shape':'triangle','opacity':.9,'width':2}},
    {selector:':selected',style:{'border-color':'#172033','border-width':4,'z-index':999}}
  ]
});
function idsForMode(){
  const mode=controls.view.value;
  if(mode==='all')return new Set(payload.nodes.map(function(node){return node.data.id}));
  return new Set(mode==='evidence'?payload.view.evidenceNodeIds:payload.view.defaultNodeIds);
}
function addNeighborhood(ids,id){
  ids.add(id);
  const neighbors=adjacency.get(id);
  if(neighbors)neighbors.forEach(function(neighbor){ids.add(neighbor)});
}
function candidateIds(){
  const ids=idsForMode();
  expandedIds.forEach(function(id){addNeighborhood(ids,id)});
  const query=controls.search.value.trim().toLowerCase();
  if(query){
    payload.nodes.forEach(function(node){
      if(String(node.data.searchText).includes(query))addNeighborhood(ids,node.data.id);
    });
  }
  return ids;
}
function passesFilters(node){
  const data=node.data;
  if(controls.type.value&&data.type!==controls.type.value)return false;
  if(controls.status.value&&data.status!==controls.status.value)return false;
  if(controls.domain.value&&data.domain!==controls.domain.value)return false;
  if(controls.project.value){
    const projects=Array.isArray(data.projectKeys)?data.projectKeys:[];
    if(data.type!=='project'&&!projects.includes(controls.project.value))return false;
    if(data.type==='project'&&data.label!==controls.project.value)return false;
  }
  return true;
}
function selectedElements(){
  const ids=candidateIds();
  const selectedNodes=payload.nodes.filter(function(node){return ids.has(node.data.id)&&passesFilters(node)});
  const visibleIds=new Set(selectedNodes.map(function(node){return node.data.id}));
  const selectedEdges=edges.filter(function(edge){return visibleIds.has(edge.data.source)&&visibleIds.has(edge.data.target)});
  return selectedNodes.concat(selectedEdges);
}
function layoutOptions(name){
  if(name==='cose')return{name:'cose',quality:'draft',animate:false,fit:true,padding:55,nodeRepulsion:220000,idealEdgeLength:85,edgeElasticity:80,gravity:.3,numIter:700,randomize:true};
  if(name==='concentric')return{name:'concentric',animate:false,fit:true,padding:55,minNodeSpacing:36,levelWidth:function(){return 2}};
  if(name==='breadthfirst')return{name:'breadthfirst',animate:false,fit:true,padding:55,directed:true,spacingFactor:1.25};
  return{name:'grid',animate:false,fit:true,padding:55,avoidOverlap:true,spacingFactor:1.15};
}
function updateLabels(){
  const show=cy.zoom()>=1.05&&cy.nodes().length<=260;
  cy.nodes().toggleClass('show-label',show);
  if(selectedId)cy.getElementById(selectedId).addClass('show-label');
}
function runLayout(){
  const requested=controls.layout.value;
  const safeLayout=cy.nodes().length>700&&requested==='cose'?'grid':requested;
  status.textContent=(safeLayout!==requested?'全图节点较多，已使用网格布局 · ':'')+'正在整理 '+cy.nodes().length+' 个节点';
  cy.layout(layoutOptions(safeLayout)).run();
  cy.fit(cy.elements(),55);updateLabels();updateStatus();
}
function updateStatus(){
  status.textContent=cy.nodes().length+' nodes · '+cy.edges().length+' edges · '+Math.round(cy.zoom()*100)+'%';
}
function render(runLayoutAfter){
  const elements=selectedElements();
  cy.startBatch();cy.elements().remove();cy.add(elements);cy.endBatch();
  if(selectedId&&cy.getElementById(selectedId).length)cy.getElementById(selectedId).select();
  if(runLayoutAfter)runLayout();else{cy.fit(cy.elements(),55);updateLabels();updateStatus()}
}
function showDetails(node){
  const data=node.data();
  details.textContent=JSON.stringify({id:data.id,label:data.label,type:data.type,metadata:data.metadata,neighbors:node.neighborhood('node').map(function(item){return{ id:item.id(),label:item.data('label'),type:item.data('type')}})},null,2);
}
cy.on('tap','node',function(event){
  selectedId=event.target.id();expandedIds.add(selectedId);render(true);
  const selected=cy.getElementById(selectedId);selected.select();showDetails(selected);
  const connectedEdges=selected.connectedEdges();
  const focus=selected.union(selected.neighborhood()).union(connectedEdges);cy.animate({fit:{eles:focus,padding:90},duration:350});
});
cy.on('tap',function(event){if(event.target===cy){selectedId=null;details.textContent='点击节点查看详情'}});
cy.on('zoom pan',function(){updateLabels();updateStatus()});
controls.view.addEventListener('change',function(){expandedIds.clear();selectedId=null;render(true)});
[controls.type,controls.status,controls.domain,controls.project].forEach(function(control){control.addEventListener('change',function(){render(true)})});
controls.search.addEventListener('input',function(){clearTimeout(searchTimer);searchTimer=setTimeout(function(){render(true)},180)});
document.getElementById('layout-button').addEventListener('click',runLayout);
document.getElementById('fit-button').addEventListener('click',function(){cy.animate({fit:{eles:cy.elements(),padding:55},duration:300})});
document.getElementById('zoom-in-button').addEventListener('click',function(){cy.animate({zoom:{level:Math.min(6,cy.zoom()*1.35),position:{x:cy.width()/2,y:cy.height()/2}},duration:220})});
document.getElementById('zoom-out-button').addEventListener('click',function(){cy.animate({zoom:{level:Math.max(.08,cy.zoom()/1.35),position:{x:cy.width()/2,y:cy.height()/2}},duration:220})});
document.getElementById('clear-expansion-button').addEventListener('click',function(){expandedIds.clear();selectedId=null;details.textContent='点击节点查看详情';render(true)});
document.getElementById('reset-button').addEventListener('click',function(){
  controls.view.value='refined';controls.search.value='';controls.type.value='';controls.status.value='';controls.domain.value='';controls.project.value='';controls.layout.value='cose';expandedIds.clear();selectedId=null;details.textContent='点击节点查看详情';render(true)
});
render(true);
</script>
</body>
</html>`;
}
