import type { Point } from '../types.ts';
import type { Primitive, RenderScene, DisplayGraph } from './types.ts';
import { primitivePoints, polar } from './layout.ts';
const esc=(value:unknown)=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const f=(n:number)=>Number(n.toFixed(7));
export function primitivePath(p:Primitive):string{
  if(p.kind==='point')return `M${f(p.point.x)},${f(p.point.y)}l0,0`;
  if(p.kind==='polyline')return p.points.map((v,i)=>`${i?'L':'M'}${f(v.x)},${f(v.y)}`).join(' ');
  const a=polar(p.center,p.radius,p.startDeg),b=polar(p.center,p.radius,p.endDeg),sweep=p.endDeg-p.startDeg;
  if(p.radius===0||sweep===0)return `M${f(a.x)},${f(a.y)}l0,0`;
  return `M${f(a.x)},${f(a.y)} A${f(p.radius)},${f(p.radius)} 0 ${sweep>180?1:0} 1 ${f(b.x)},${f(b.y)}`;
}
export function sceneArtwork(scene:RenderScene,selected:string[]=[],highlights:string[]=[]):string{
  const portMap=new Map(scene.ports.map(p=>[p.id,p]));
  const selectedSet=new Set(selected),highlightSet=new Set(highlights),color=(id:string)=>selectedSet.has(id)?'#1a66a4':highlightSet.has(id)?'#955100':'#111111';
  const guide=scene.metric?.scaleBar;const scale=guide?`<path id="metric-scale-guide" pointer-events="none" stroke="#111111" d="M${f(guide.from.x)},${f(guide.from.y)}L${f(guide.to.x)},${f(guide.to.y)} M${f(guide.from.x)},${f(guide.from.y-1)}L${f(guide.from.x)},${f(guide.from.y+1)} M${f(guide.to.x)},${f(guide.to.y-1)}L${f(guide.to.x)},${f(guide.to.y+1)}"/><text id="metric-scale-label" pointer-events="none" stroke="none" fill="#111111" font-family="${esc(scene.settings.fontFamily)}" font-size="${scene.settings.fontSizePt*25.4/72}" x="${f(guide.position.x)}" y="${f(guide.position.y)}">${esc(guide.label)}</text>`:'';
  return `<g id="tree-artwork" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${scene.settings.strokeMm}">\n`+scene.junctionGlyphs.map(g=>`<path id="${esc(g.id)}" data-junction="${esc(g.nodeId)}" stroke="${color(g.nodeId)}" d="${primitivePath(g.geometry)}"/>`).join('\n')+'\n'+scene.edgeStems.map(e=>`<path id="${esc(e.id)}" data-display-edge="${esc(e.edgeId)}" stroke="${color(portMap.get(e.childPortId)!.nodeId)}" d="${primitivePath(e.geometry)}"/>`).join('\n')+'\n'+scale+'\n</g>';
}
export function sceneAnnotations(scene:RenderScene,interactive=false):string{return `<g id="annotations" fill="#222222" font-family="${esc(scene.settings.fontFamily)}" font-size="${scene.settings.fontSizePt*25.4/72}">`+scene.labels.map(l=>`<text ${interactive?`data-structured-node="${esc(l.nodeId)}" `:''}data-source-node="${esc(l.nodeId)}" x="${f(l.position.x)}" y="${f(l.position.y)}" text-anchor="${l.anchor}" transform="rotate(${f(l.rotationDeg)} ${f(l.position.x)} ${f(l.position.y)})">${esc(l.text)}</text>`).join('\n')+'</g>';}
export function sceneHits(scene:RenderScene):string{
  const portMap=new Map(scene.ports.map(p=>[p.id,p]));
  // Junction hit regions are last so a connector, including its ports, selects its owner.
  return `<g fill="none" stroke="transparent" stroke-width="${Math.max(2,scene.settings.strokeMm+1)}" pointer-events="stroke">`+scene.edgeStems.map(e=>`<path data-structured-node="${esc(portMap.get(e.childPortId)!.nodeId)}" d="${primitivePath(e.geometry)}"/>`).join('')+scene.junctionGlyphs.map(g=>g.geometry.kind==='point'?`<circle data-structured-node="${esc(g.nodeId)}" cx="${f(g.anchor.x)}" cy="${f(g.anchor.y)}" r=".8" fill="transparent" pointer-events="all"><title>Source node ${esc(g.nodeId)}</title></circle>`:`<path data-structured-node="${esc(g.nodeId)}" d="${primitivePath(g.geometry)}"><title>Source node ${esc(g.nodeId)}</title></path>`).join('')+'</g>';
}
export function hitScene(scene:RenderScene,point:Point,tolerance=1):string|null{
  let result:string|null=null,best=tolerance;
  for(const glyph of scene.junctionGlyphs){const points=primitivePoints(glyph.geometry,scene.settings.toleranceMm);for(let i=0;i<Math.max(1,points.length-1);i++){const a=points[i],b=points[Math.min(points.length-1,i+1)],dx=b.x-a.x,dy=b.y-a.y,len=dx*dx+dy*dy,t=len?Math.max(0,Math.min(1,((point.x-a.x)*dx+(point.y-a.y)*dy)/len)):0,d=Math.hypot(point.x-a.x-t*dx,point.y-a.y-t*dy);if(d<=best){best=d;result=glyph.nodeId;}}}return result;
}

export function highlightedNodes(graph:DisplayGraph,roots:string[]):string[]{
  const selected=new Set<string>(),stack=[...roots];while(stack.length){const id=stack.pop()!;if(selected.has(id)||!graph.nodes[id])continue;selected.add(id);stack.push(...graph.nodes[id].children);}return graph.order.filter(id=>selected.has(id));
}
