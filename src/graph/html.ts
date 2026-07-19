/** Self-contained offline HTML visualization for a knowledge graph. */
import type { KnowledgeGraph } from "./types.js";

/** Embeds graph data and a small SVG renderer without external scripts or stylesheets. */
export function renderKnowledgeGraphHtml(graph: KnowledgeGraph): string {
  const data = JSON.stringify(graph).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Knowledge Graph</title>
<style>
:root{font-family:Inter,system-ui,sans-serif;color:#172033;background:#f4f6fb}
body{margin:0;display:grid;grid-template-columns:320px 1fr;height:100vh}
aside{padding:18px;background:#fff;border-right:1px solid #dce1ec;overflow:auto}
main{position:relative;overflow:hidden}
label{display:block;font-size:12px;font-weight:700;margin-top:12px;color:#536079}
input,select{width:100%;box-sizing:border-box;padding:8px;margin-top:4px;border:1px solid #cbd3e1;border-radius:6px;background:#fff}
#graph{width:100%;height:100%;background:#f8f9fc}
#details{white-space:pre-wrap;font-size:12px;background:#f7f8fb;border:1px solid #e0e4ed;border-radius:6px;padding:10px;margin-top:16px;min-height:120px}
.edge{stroke:#aeb8ca;stroke-width:1.2}
.edge.conflicts_with{stroke:#d83b3b;stroke-width:2;stroke-dasharray:5 4}
.edge.supersedes{stroke:#e78b1f;stroke-width:2}
.node{cursor:pointer;stroke:#fff;stroke-width:2}
.node.knowledge{fill:#3867d6}.node.domain{fill:#20bf6b}.node.scenario{fill:#8854d0}
.node.project{fill:#f7b731}.node.episode{fill:#45aaf2}.node.source{fill:#778ca3}.node.proposal{fill:#eb3b5a}
.label{font-size:11px;pointer-events:none;fill:#172033}
</style>
</head>
<body>
<aside>
<h2>知识关系图</h2>
<div id="summary"></div>
<label for="search">搜索</label><input id="search" placeholder="title / domain / id">
<label for="type-filter">节点类型</label><select id="type-filter"><option value="">全部</option></select>
<label for="status-filter">知识状态</label><select id="status-filter"><option value="">全部</option></select>
<label for="domain-filter">Domain</label><select id="domain-filter"><option value="">全部</option></select>
<label for="project-filter">Project</label><select id="project-filter"><option value="">全部</option></select>
<div id="details">点击节点查看详情</div>
</aside>
<main><svg id="graph" viewBox="0 0 1200 800"></svg></main>
<script>
const data=${data};
const svg=document.getElementById('graph'),details=document.getElementById('details');
const controls={search:document.getElementById('search'),type:document.getElementById('type-filter'),status:document.getElementById('status-filter'),domain:document.getElementById('domain-filter'),project:document.getElementById('project-filter')};
document.getElementById('summary').textContent=data.nodes.length+' nodes · '+data.edges.length+' edges';
function values(field){return [...new Set(data.nodes.flatMap(n=>{const v=n.metadata[field];return Array.isArray(v)?v:(v?[v]:[])}))].sort()}
function fill(select,items){items.forEach(v=>{const o=document.createElement('option');o.value=v;o.textContent=v;select.appendChild(o)})}
fill(controls.type,[...new Set(data.nodes.map(n=>n.type))].sort());fill(controls.status,values('status'));fill(controls.domain,values('domain'));fill(controls.project,values('projectIds'));
const positions=new Map();data.nodes.forEach((n,i)=>{const a=2*Math.PI*i/Math.max(1,data.nodes.length);positions.set(n.id,{x:600+320*Math.cos(a),y:400+300*Math.sin(a)})});
function el(name,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',name);Object.entries(attrs).forEach(([k,v])=>e.setAttribute(k,String(v)));return e}
function visible(n){const q=controls.search.value.toLowerCase();const text=(n.id+' '+n.label+' '+JSON.stringify(n.metadata)).toLowerCase();return(!q||text.includes(q))&&(!controls.type.value||n.type===controls.type.value)&&(!controls.status.value||n.metadata.status===controls.status.value)&&(!controls.domain.value||n.metadata.domain===controls.domain.value)&&(!controls.project.value||(n.metadata.projectIds||[]).includes(controls.project.value))}
function render(){svg.innerHTML='';const shown=new Set(data.nodes.filter(visible).map(n=>n.id));data.edges.filter(e=>shown.has(e.source)&&shown.has(e.target)).forEach(e=>{const a=positions.get(e.source),b=positions.get(e.target);if(!a||!b)return;svg.appendChild(el('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,class:'edge '+e.type,'data-type':e.type}))});data.nodes.filter(n=>shown.has(n.id)).forEach(n=>{const p=positions.get(n.id);const c=el('circle',{cx:p.x,cy:p.y,r:n.type==='knowledge'?13:9,class:'node '+n.type});c.addEventListener('click',()=>details.textContent=JSON.stringify(n,null,2));svg.appendChild(c);const t=el('text',{x:p.x+15,y:p.y+4,class:'label'});t.textContent=n.label.slice(0,42);svg.appendChild(t)})}
Object.values(controls).forEach(c=>c.addEventListener('input',render));render();
</script>
</body>
</html>`;
}
