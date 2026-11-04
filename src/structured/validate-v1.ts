import type { Point } from '../types.ts';
import type { DisplayGraph, RenderScene, SceneQA, SceneIssue, Primitive } from './types.ts';
import { primitivePoints, sceneRevision } from './layout.ts';
import { digestSync } from '../provenance/sync-identity.ts';
const dist=(a:Point,b:Point)=>Math.hypot(a.x-b.x,a.y-b.y);
function closest(p:Point,a:Point,b:Point):Point {const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)):0;return{x:a.x+t*dx,y:a.y+t*dy};}
export function segmentDistance(a:Point,b:Point,c:Point,d:Point):{distance:number;p:Point;q:Point}{
  const dx=b.x-a.x,dy=b.y-a.y,ex=d.x-c.x,ey=d.y-c.y,den=dx*ey-dy*ex;
  if(Math.abs(den)>1e-12){const t=((c.x-a.x)*ey-(c.y-a.y)*ex)/den,u=((c.x-a.x)*dy-(c.y-a.y)*dx)/den;if(t>=0&&t<=1&&u>=0&&u<=1){const p={x:a.x+t*dx,y:a.y+t*dy};return{distance:0,p,q:p};}}
  const pairs:[[Point,Point],[Point,Point],[Point,Point],[Point,Point]]=[[a,closest(a,c,d)],[b,closest(b,c,d)],[closest(c,a,b),c],[closest(d,a,b),d]];
  return pairs.map(([p,q])=>({distance:dist(p,q),p,q})).sort((x,y)=>x.distance-y.distance)[0];
}
const bounds=(points:Point[],pad=0)=>points.reduce((b,p)=>({minX:Math.min(b.minX,p.x-pad),minY:Math.min(b.minY,p.y-pad),maxX:Math.max(b.maxX,p.x+pad),maxY:Math.max(b.maxY,p.y+pad)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
const overlaps=(a:ReturnType<typeof bounds>,b:ReturnType<typeof bounds>)=>a.minX<=b.maxX&&b.minX<=a.maxX&&a.minY<=b.maxY&&b.minY<=a.maxY;
const segments=(points:Point[]):[Point,Point][]=>points.length===1?[[points[0],points[0]]]:points.slice(1).map((p,i)=>[points[i],p]);
export function polygonsOverlap(a:Point[],b:Point[]):boolean{
  for(const polygon of [a,b])for(let i=0;i<polygon.length;i++){const p=polygon[i],q=polygon[(i+1)%polygon.length],axis={x:q.y-p.y,y:p.x-q.x};const project=(points:Point[])=>points.map(v=>v.x*axis.x+v.y*axis.y);const aa=project(a),bb=project(b);if(Math.max(...aa)<Math.min(...bb)-1e-8||Math.max(...bb)<Math.min(...aa)-1e-8)return false;}return true;
}
export function validateScene(graph:DisplayGraph,scene:RenderScene):SceneQA{
  const issues:SceneIssue[]=[];let omittedIssueCount=0,checkedPairs=0,limited=false;
  const add=(type:SceneIssue['type'],ids:string[],detail:string)=>{if(issues.length<200)issues.push({type,ids,detail});else omittedIssueCount++;};
  const s=scene.settings,tol=s.toleranceMm,epsilon=1e-7;
  const represented=new Set(graph.representedTips),omitted=new Set(graph.omittedTips);
  const original=graph.nodes[graph.rootId].originalMembers;
  const coveragePassed=original.length===represented.size+omitted.size&&original.every(id=>represented.has(id)||omitted.has(id))&&represented.size===graph.representedTips.length&&omitted.size===graph.omittedTips.length&&!graph.omittedTips.some(id=>represented.has(id))&&digestSync(graph.endpoints.flatMap(id=>graph.nodes[id].selectedMembers))===digestSync(graph.representedTips);
  let incidencePassed=true;
  const incidence=(ids:string[],detail:string)=>{incidencePassed=false;add('incidence',ids,detail);};
  if(scene.revision!==sceneRevision(scene)||scene.graphRevision!==digestSync(graph))incidence([], 'Scene identity does not match its graph or geometry.');
  const glyphs=new Map(scene.junctionGlyphs.map(g=>[g.nodeId,g])),ports=new Map(scene.ports.map(p=>[p.id,p]));
  if(glyphs.size!==graph.order.length||scene.junctionGlyphs.length!==glyphs.size||scene.edgeStems.length!==Object.keys(graph.edges).length||ports.size!==scene.edgeStems.length*2||scene.ports.length!==ports.size)incidence([],'Junction/stem/port inventory does not match the display graph.');
  const onPrimitive=(point:Point,primitive:Primitive)=>segments(primitivePoints(primitive,tol)).some(([a,b])=>dist(point,closest(point,a,b))<=tol+epsilon);
  for(const g of scene.junctionGlyphs){if(!graph.nodes[g.nodeId]||!onPrimitive(g.anchor,g.geometry))incidence([g.id],'Junction anchor is outside its owned connector.');if(g.geometry.kind==='arc'&&(g.geometry.endDeg-g.geometry.startDeg>=360-epsilon||g.geometry.endDeg<g.geometry.startDeg))incidence([g.id],'A junction connector must be an open ordered arc, never a ring.');}
  for(const stem of scene.edgeStems){const edge=graph.edges[stem.edgeId],a=ports.get(stem.parentPortId),b=ports.get(stem.childPortId),points=primitivePoints(stem.geometry,tol);
    if(!edge||!a||!b||a.edgeId!==edge.id||b.edgeId!==edge.id||a.end!=='parent'||b.end!=='child'||a.nodeId!==edge.parent||b.nodeId!==edge.child||dist(a.point,points[0])>epsilon||dist(b.point,points.at(-1)!)>epsilon||!glyphs.has(edge.parent)||!glyphs.has(edge.child)||!onPrimitive(a.point,glyphs.get(edge.parent)!.geometry)||!onPrimitive(b.point,glyphs.get(edge.child)!.geometry))incidence([stem.id],'Stem port does not attach to its correct parent/child junction.');
  }
  type Shape={id:string;nodeIds:string[];points:Point[];box:ReturnType<typeof bounds>;ports:{nodeId:string;point:Point}[]};
  const nodePorts=new Map<string,{nodeId:string;point:Point}[]>();for(const p of scene.ports){const list=nodePorts.get(p.nodeId)??[];list.push({nodeId:p.nodeId,point:p.point});nodePorts.set(p.nodeId,list);}
  const pad=s.strokeMm/2+s.clearanceMm/2+tol;
  const shapes:Shape[]=[...scene.junctionGlyphs.map(g=>({id:g.id,nodeIds:[g.nodeId],points:primitivePoints(g.geometry,tol),box:bounds(primitivePoints(g.geometry,tol),pad),ports:nodePorts.get(g.nodeId)??[]})),...scene.edgeStems.map(e=>{const a=ports.get(e.parentPortId),b=ports.get(e.childPortId),points=primitivePoints(e.geometry,tol);return{id:e.id,nodeIds:[a?.nodeId??'',b?.nodeId??''],points,box:bounds(points,pad),ports:[...(a?[a]:[]),...(b?[b]:[])]};})];
  let crossingPassed=true,clearancePassed=true;const seen=new Set<string>();let work=0;
  const workLimit=500000;
  shapes.sort((a,b)=>a.box.minX-b.box.minX||a.id.localeCompare(b.id));
  for(let i=0;i<shapes.length&&!limited;i++)for(let j=i+1;j<shapes.length&&shapes[j].box.minX<=shapes[i].box.maxX;j++){
    if(++work>workLimit){limited=true;break;}const a=shapes[i],b=shapes[j];if(!overlaps(a.box,b.box))continue;checkedPairs++;
    const common=a.nodeIds.filter(id=>b.nodeIds.includes(id));let collision=false,clearance=false;
    outer:for(const [p,q]of segments(a.points))for(const [r,t]of segments(b.points)){
      if(++work>workLimit){limited=true;break outer;}const near=segmentDistance(p,q,r,t);if(near.distance>s.strokeMm+s.clearanceMm+2*tol)continue;
      const allowed=common.some(id=>{
        const pa=a.ports.filter(port=>port.nodeId===id),pb=b.ports.filter(port=>port.nodeId===id);
        return pa.some(x=>dist(near.p,x.point)<=s.junctionMm+s.strokeMm/2)&&pb.some(x=>dist(near.q,x.point)<=s.junctionMm+s.strokeMm/2);
      });
      if(allowed)continue;
      if(near.distance<=s.strokeMm+2*tol){collision=true;break outer;}clearance=true;
    }
    const key=[a.id,b.id].sort().join('|');if(collision){crossingPassed=false;clearancePassed=false;if(!seen.has(key)){add('contact',[a.id,b.id],'Unrelated strokes touch, or incident strokes overlap beyond their declared junction neighbourhood.');seen.add(key);}}else if(clearance){clearancePassed=false;if(!seen.has(key)){add('clearance',[a.id,b.id],'Stroke clearance is below the requested physical spacing.');seen.add(key);}}
  }
  let labelCollisions=0;const labels=scene.labels.map(l=>({...l,box:bounds(l.corners)})).sort((a,b)=>a.box.minX-b.box.minX||a.id.localeCompare(b.id));
  for(let i=0;i<labels.length&&!limited;i++)for(let j=i+1;j<labels.length&&labels[j].box.minX<=labels[i].box.maxX;j++){
    if(++work>workLimit){limited=true;break;}if(overlaps(labels[i].box,labels[j].box)&&polygonsOverlap(labels[i].corners,labels[j].corners)){labelCollisions++;add('labels',[labels[i].id,labels[j].id],'Measured label boxes overlap, including across the circular seam.');}
  }
  for(const label of labels){if(limited)break;for(const shape of shapes){if(++work>workLimit){limited=true;break;}if(!overlaps(label.box,shape.box))continue;const boundary=segments([...label.corners,label.corners[0]]);if(segments(shape.points).some(([a,b])=>boundary.some(([c,d])=>segmentDistance(a,b,c,d).distance<=s.strokeMm/2+tol)||polygonsOverlap(label.corners,[a,b,b,a]))){labelCollisions++;add('labels',[label.id,shape.id],'A measured label box intersects a tree stroke.');break;}}}
  const b=scene.bounds,inside=b.minX-s.strokeMm/2>=0&&b.minY-s.strokeMm/2>=0&&b.maxX+s.strokeMm/2<=s.widthMm&&b.maxY+s.strokeMm/2<=s.heightMm;
  if(!inside)add('bounds',[],'Tree or labels extend beyond the page. Enlarge the page, reduce displayed taxa or change label placement; text was not shrunk.');
  if(scene.measurements.fontStatus!=='available')add('font',[],scene.measurements.fontStatus==='estimated'?'Text metrics are estimates. Browser-measured fonts are required for a checked authoring output.':'The requested font is unavailable; saved coordinates remain unchanged. Review the substituted labels.');
  if(limited)add('legibility',[],'Validation reached its 500,000-comparison work limit; no all-clear is asserted. Reduce displayed taxa or collapse groups.');
  return {status:coveragePassed&&incidencePassed&&crossingPassed&&clearancePassed&&!labelCollisions&&inside&&!limited&&scene.measurements.fontStatus==='available'?'checked':'draft',coveragePassed,incidencePassed,crossingPassed,clearancePassed,labelCollisions,issues,omittedIssueCount,checkedPairs,limited,limitations:['Nonmetric cladogram: depth and connector length do not encode time, evolutionary distance or confidence.','Stroke contacts use tolerance-bounded arc subdivision and local junction neighbourhoods; label boxes use the saved font metrics.','Computational checks do not establish biological support or usability for authors.']};
}
