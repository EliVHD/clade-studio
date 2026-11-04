import type { Source, Correction, Point } from '../types.ts';
import type { ScientificBasis } from '../model/document.ts';
import type { DisplayGraph, ProjectionSpec, StructuredSettings, TextMeasurements, RenderScene, UnrootedSpec, SceneLabel } from './types.ts';
import { orient, displayLabel } from '../science.ts';
import { validateProjection } from './projection.ts';
import { validateStructuredSettings, validateMeasurements, polar, rotatePoint, labelCorners, sceneRevision } from './layout.ts';
import { validateScene, segmentDistance } from './validate.ts';
import { digestSync } from '../provenance/sync-identity.ts';

export function requireUnrootedBasis(basis:ScientificBasis):void {
  if(basis.relationshipKind!=='phylogeny'||basis.entityKind==='unspecified')throw new Error('Unrooted trees require a phylogenetic basis and a stated entity type. No biological root is required.');
}
export function defaultUnrootedSpec(source:Source):UnrootedSpec{return {sourceSha256:source.sha256,algorithm:'equal-angle',originNodeId:null,edgeLengthMm:18,daylightPasses:6,daylightStrength:.7};}
export function validateUnrootedSpec(spec:UnrootedSpec,sourceSha:string):void {
  if(!spec||Object.keys(spec).sort().join('|')!=='algorithm|daylightPasses|daylightStrength|edgeLengthMm|originNodeId|sourceSha256'||spec.sourceSha256!==sourceSha||!['equal-angle','daylight'].includes(spec.algorithm)||(spec.originNodeId!==null&&typeof spec.originNodeId!=='string')||!Number.isFinite(spec.edgeLengthMm)||spec.edgeLengthMm<1||spec.edgeLengthMm>200||!Number.isInteger(spec.daylightPasses)||spec.daylightPasses<0||spec.daylightPasses>12||!Number.isFinite(spec.daylightStrength)||spec.daylightStrength<0||spec.daylightStrength>1)throw new Error('Invalid unrooted source, display origin or spacing settings.');
}
/** The minimal connected subtree of selected source terminals, with no retained root stem. */
export function projectUnrooted(source:Source,projection:ProjectionSpec,spec:UnrootedSpec,corrections:Correction[]=[]):DisplayGraph {
  validateUnrootedSpec(spec,source.sha256);
  validateProjection(projection,source,orient(source,{kind:'node',sourceNodeId:source.rootId,status:'file_top_level'}));
  if(projection.collapse.length||projection.expand.length||projection.reveal.length||Object.keys(projection.childOrder).length)throw new Error('Unrooted projection supports exact tip selection. Rooted clade collapse, reveal and ordering rules are unavailable.');
  const selected=new Set(projection.selection.kind==='all'?source.tips:projection.selection.tipIds),tips=new Set(source.tips),counts:Record<string,number>={},adj:Record<string,string[]>={};
  for(const id of source.order)adj[id]=[];
  for(const id of [...source.order].reverse())counts[id]=(selected.has(id)?1:0)+source.nodes[id].children.reduce((sum,c)=>sum+counts[c],0);
  for(const id of source.order)for(const child of source.nodes[id].children)if(counts[child]>0&&counts[child]<selected.size){adj[id].push(child);adj[child].push(id);}
  const retained=source.order.filter(id=>selected.has(id)||adj[id].length),candidates=retained.filter(id=>selected.size===1||!tips.has(id));
  const balance=(id:string)=>Math.max(0,...adj[id].map(n=>source.nodes[id].children.includes(n)?counts[n]:selected.size-counts[id]));
  const origin=spec.originNodeId??[...candidates].sort((a,b)=>balance(a)-balance(b)||a.localeCompare(b))[0];
  if(!candidates.includes(origin))throw new Error('Choose an internal source vertex of the selected subtree as display origin; it is not a biological root.');
  // Full-source component memberships use original terminal identities, including when
  // a unary serialization top becomes a degree-one vertex in the undirected traversal.
  const fullAdj:Record<string,string[]>={};for(const id of source.order)fullAdj[id]=[];
  for(const id of source.order)for(const child of source.nodes[id].children){fullAdj[id].push(child);fullAdj[child].push(id);}
  const parent:Record<string,string|null>={[origin]:null},fullOrder=[origin];
  for(let i=0;i<fullOrder.length;i++){const id=fullOrder[i];for(const n of fullAdj[id])if(n!==parent[id]){parent[n]=id;fullOrder.push(n);}}
  const original:Record<string,string[]>={};for(const id of [...fullOrder].reverse())original[id]=[...(tips.has(id)?[id]:[]),...fullAdj[id].filter(n=>parent[n]===id).flatMap(n=>original[n])];
  const graph:DisplayGraph={rootId:origin,nodes:{},edges:{},order:[],endpoints:[],representedTips:[],omittedTips:source.tips.filter(id=>!selected.has(id)),sourceSha256:source.sha256};
  const keep=(id:string)=>id===origin||adj[id].length!==2||!!source.nodes[id].label||source.nodes[id].annotations.length>0;
  const pending=[{id:origin,from:null as string|null,owner:null as string|null,path:[] as string[]}];
  while(pending.length){let {id,from,owner,path}=pending.pop()!;
    while(!keep(id)){path.push(id);const next=adj[id].find(n=>n!==from)!;from=id;id=next;}
    graph.nodes[id]={id,parent:owner,children:[],selectedMembers:[],originalMembers:[...original[id]],omittedMembers:original[id].filter(t=>!selected.has(t)),aggregate:false,label:source.nodes[id].children.length?(source.nodes[id].label||`Source vertex ${id}`):displayLabel(source,id,corrections)};graph.order.push(id);
    if(owner){graph.nodes[owner].children.push(id);const sourcePath=[owner,...path,id],owners=sourcePath.slice(1).map((n,i)=>source.nodes[sourcePath[i]].children.includes(n)?n:sourcePath[i]),lengths=owners.map(n=>source.nodes[n].length),edgeId=`display-edge-${id}`;
      graph.edges[edgeId]={id:edgeId,parent:owner,child:id,sourcePath,sourceEdgeIds:owners.map(n=>`e-${n}`),length:lengths.every(n=>n!==null&&Number.isFinite(n)&&n>=0)?(lengths as number[]).reduce((a,b)=>a+b,0):null,annotations:owners.flatMap(n=>source.nodes[n].annotations.map(a=>({sourceNodeId:n,...a})))};
    }
    const children=adj[id].filter(n=>n!==from);for(const n of [...children].reverse())pending.push({id:n,from:id,owner:id,path:[]});
    if(selected.has(id))graph.endpoints.push(id);
  }
  for(const id of [...graph.order].reverse())graph.nodes[id].selectedMembers=selected.has(id)?[id]:graph.nodes[id].children.flatMap(n=>graph.nodes[n].selectedMembers);
  graph.representedTips=graph.endpoints.flatMap(id=>graph.nodes[id].selectedMembers);
  if(new Set(graph.representedTips).size!==selected.size||graph.representedTips.length!==selected.size)throw new Error('Unrooted terminal coverage failed.');
  return graph;
}

const TAU=Math.PI*2;
const wrap=(a:number)=>((a+Math.PI)%TAU+TAU)%TAU-Math.PI;
const WORK_LIMIT=500000;
/** Original bounded envelope-balancing heuristic, not an implementation of PAUP* or ggtree. */
function daylight(graph:DisplayGraph,anchors:Record<string,Point>,spec:UnrootedSpec,stroke:number):NonNullable<RenderScene['unrooted']>['daylight'] {
  const report={passes:0,attempts:0,accepted:0,work:0,limited:false,beforeScore:null as number|null,afterScore:null as number|null};
  if(spec.algorithm!=='daylight'||!spec.daylightPasses||!spec.daylightStrength)return report;
  const tick=()=>{if(++report.work>WORK_LIMIT){report.work=WORK_LIMIT;report.limited=true;throw new Error('work-limit');}};
  const neighbors=(id:string)=>[...(graph.nodes[id].parent?[graph.nodes[id].parent!]:[]),...graph.nodes[id].children];
  const pivots=graph.order.filter(id=>neighbors(id).length>=3),edges=Object.values(graph.edges);
  function envelopes(id:string,points:Record<string,Point>){
    const pivot=points[id],groups=neighbors(id).map(n=>{const axis=Math.atan2(points[n].y-pivot.y,points[n].x-pivot.x),ids:string[]=[],stack=[{id:n,from:id}];let lo=0,hi=0;
      while(stack.length){tick();const item=stack.pop()!;ids.push(item.id);const p=points[item.id],a=wrap(Math.atan2(p.y-pivot.y,p.x-pivot.x)-axis);lo=Math.min(lo,a);hi=Math.max(hi,a);for(const child of neighbors(item.id))if(child!==item.from)stack.push({id:child,from:item.id});}
      return {id:n,axis,lo,hi,ids};
    }).sort((a,b)=>a.axis-b.axis);
    const fixed=graph.nodes[id].parent??groups[0].id,index=groups.findIndex(g=>g.id===fixed),ordered=[...groups.slice(index),...groups.slice(0,index)];let last=-Infinity;
    for(const g of ordered){while(g.axis<last)g.axis+=TAU;last=g.axis;}
    const gaps=ordered.map((g,i)=>{const next=ordered[(i+1)%ordered.length];return next.axis+next.lo+(i===ordered.length-1?TAU:0)-g.axis-g.hi;});
    // Overlapping envelopes or a component spanning the wrap boundary are left alone.
    if(gaps.some(g=>g< -1e-9)||ordered.some(g=>g.hi-g.lo>=Math.PI*2-1e-8))return null;
    const mean=gaps.reduce((a,b)=>a+b,0)/gaps.length,score=gaps.reduce((sum,g)=>sum+(g-mean)**2,0);return {ordered,gaps,mean,score};
  }
  function score(points:Record<string,Point>){let sum=0;for(const id of pivots){const e=envelopes(id,points);if(!e)return null;sum+=e.score;}return sum;}
  function contacts(points:Record<string,Point>){let count=0;for(let i=0;i<edges.length;i++)for(let j=i+1;j<edges.length;j++){tick();const a=edges[i],b=edges[j];if(a.parent===b.parent||a.parent===b.child||a.child===b.parent||a.child===b.child)continue;if(segmentDistance(points[a.parent],points[a.child],points[b.parent],points[b.child]).distance<=stroke+1e-8)count++;}return count;}
  try {
    let currentScore=score(anchors),currentContacts=contacts(anchors);report.beforeScore=currentScore;report.afterScore=currentScore;
    if(currentScore===null)return report;
    for(let pass=0;pass<spec.daylightPasses;pass++){let accepted=0;
      for(const id of pivots){const env=envelopes(id,anchors);if(!env||env.score<1e-12)continue;report.attempts++;const proposal=structuredClone(anchors);let desiredHi=env.ordered[0].axis+env.ordered[0].hi;
        for(const g of env.ordered.slice(1)){const desiredLo=desiredHi+env.mean,delta=(desiredLo-(g.axis+g.lo))*spec.daylightStrength;desiredHi=desiredLo+(g.hi-g.lo);for(const n of g.ids){tick();proposal[n]=rotatePoint(anchors[n],anchors[id],delta*180/Math.PI);}}
        const nextScore=score(proposal);if(nextScore===null||nextScore>=currentScore-1e-10)continue;const nextContacts=contacts(proposal);if(nextContacts>currentContacts)continue;
        Object.assign(anchors,proposal);currentScore=nextScore;currentContacts=nextContacts;report.afterScore=currentScore;report.accepted++;accepted++;
      }
      report.passes++;if(!accepted)break;
    }
  }catch(error){if(!(error instanceof Error)||error.message!=='work-limit')throw error;}
  return report;
}

export function layoutUnrooted(graph:DisplayGraph,settings:StructuredSettings,measurements:TextMeasurements,spec:UnrootedSpec,nodeOffsets:RenderScene['nodeOffsets']={},labelOffsets:Record<string,Point>={}):RenderScene {
  validateUnrootedSpec(spec,graph.sourceSha256);validateStructuredSettings(settings);validateMeasurements(graph,settings,measurements);
  if(settings.kind!=='circular'||settings.curves||Object.keys(nodeOffsets).length)throw new Error('Unrooted layouts use straight stems and free angular geometry; rooted level offsets and connector curves are unavailable.');
  if(graph.order.length>20000||graph.endpoints.length>5000)throw new Error('Unrooted layout supports at most 20,000 displayed nodes and 5,000 terminals. Select fewer tips.');
  const s=structuredClone(settings);s.startAngleDeg=((s.startAngleDeg%360)+360)%360;s.orientationDeg=((s.orientationDeg%360)+360)%360;
  const center={x:s.widthMm/2,y:s.heightMm/2},anchors:Record<string,Point>={[graph.rootId]:center},spans:Record<string,[number,number]>={[graph.rootId]:[s.startAngleDeg+s.orientationDeg,s.startAngleDeg+s.orientationDeg+360]};
  for(const id of graph.order){let start=spans[id][0];const size=spans[id][1]-start,count=graph.nodes[id].selectedMembers.length;for(const child of graph.nodes[id].children){const end=start+size*graph.nodes[child].selectedMembers.length/count;spans[child]=[start,end];anchors[child]=polar(anchors[id],spec.edgeLengthMm,(start+end)/2);start=end;}}
  const report=daylight(graph,anchors,spec,s.strokeMm),glyphs:RenderScene['junctionGlyphs']=[],ports:RenderScene['ports']=[],stems:RenderScene['edgeStems']=[],labels:SceneLabel[]=[];
  for(const id of graph.order){const anchor=anchors[id];glyphs.push({id:`junction-${id}`,nodeId:id,anchor,geometry:{kind:'point',point:anchor},span:spans[id],depth:0});for(const child of graph.nodes[id].children){const edgeId=`display-edge-${child}`,parentPortId=`${edgeId}-parent`,childPortId=`${edgeId}-child`;ports.push({id:parentPortId,nodeId:id,edgeId,end:'parent',point:anchor},{id:childPortId,nodeId:child,edgeId,end:'child',point:anchors[child]});stems.push({id:`stem-${child}`,edgeId,parentPortId,childPortId,geometry:{kind:'polyline',points:[anchor,anchors[child]]}});}}
  for(const id of graph.endpoints){const parent=graph.nodes[id].parent,m=measurements.metrics[id],theta=parent?Math.atan2(anchors[id].y-anchors[parent].y,anchors[id].x-anchors[parent].x)*180/Math.PI:0,angle=((theta%360)+360)%360,left=angle>90&&angle<270;let rotation=0,anchor:SceneLabel['anchor']=left?'end':'start';
    if(s.labelPlacement==='radial')rotation=theta+(left?180:0);else if(s.labelPlacement==='tangential'){rotation=theta+90;if(((rotation%360)+360)%360>90&&((rotation%360)+360)%360<270)rotation+=180;anchor='middle';}
    let position=polar(anchors[id],s.labelGapMm,theta);const shift=(m.ascentMm-m.descentMm)/2;position={x:position.x-Math.sin(rotation*Math.PI/180)*shift,y:position.y+Math.cos(rotation*Math.PI/180)*shift};const offset=labelOffsets[id];if(offset)position={x:position.x+offset.x,y:position.y+offset.y};labels.push({id:`label-${id}`,nodeId:id,text:m.text,position,rotationDeg:rotation,anchor,corners:labelCorners(position,rotation,anchor,m)});
  }
  for(const [id,o]of Object.entries(labelOffsets))if(!graph.endpoints.includes(id)||!o||Object.keys(o).sort().join('|')!=='x|y'||!Number.isFinite(o.x)||!Number.isFinite(o.y)||Math.abs(o.x)>2000||Math.abs(o.y)>2000)throw new Error('Invalid unrooted terminal label offset.');
  const points=[...Object.values(anchors),...labels.flatMap(l=>l.corners)],bounds=points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
  const scene:RenderScene={units:'mm',revision:'',graphRevision:digestSync(graph),settings:s,measurements:structuredClone(measurements),junctionGlyphs:glyphs,edgeStems:stems,ports,labels,nodeOffsets:{},...(Object.keys(labelOffsets).length?{labelOffsets:structuredClone(labelOffsets)}:{}),bounds,slotPasses:1,unrooted:{spec:structuredClone(spec),displayOriginNodeId:graph.rootId,daylight:report}};scene.revision=sceneRevision(scene);return scene;
}
export function validateUnrootedScene(graph:DisplayGraph,scene:RenderScene){
  const qa=validateScene(graph,scene),encoding=scene.unrooted;if(!encoding)throw new Error('Missing unrooted specification.');
  validateUnrootedSpec(encoding.spec,graph.sourceSha256);
  if(encoding.displayOriginNodeId!==graph.rootId||scene.metric||scene.classification)throw new Error('Unrooted display origin/encoding mismatch.');
  for(const stem of scene.edgeStems){if(stem.geometry.kind!=='polyline'||stem.geometry.points.length!==2)throw new Error('Unrooted stems must be straight.');const [a,b]=stem.geometry.points;if(Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-encoding.spec.edgeLengthMm)>1e-7)throw new Error('Uniform unrooted display spacing was changed.');}
  qa.limitations=['Unrooted nonmetric topology: display origin, edge direction and equal display spacing do not establish ancestry, MRCA, evolutionary distance or time.','Daylight is an original bounded angular-envelope heuristic; labels and page bounds are checked afterward. It does not guarantee an optimal or collision-free drawing.'];
  if(encoding.daylight.limited){qa.limited=true;qa.status='draft';qa.limitations.push('The daylight search exhausted its 500,000-operation budget; the last completely evaluated layout was retained.');}return qa;
}
