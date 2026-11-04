import type { Point } from '../types.ts';
import type { DisplayGraph, RenderScene, StructuredSettings, TextMeasurements, SceneLabel, Primitive } from './types.ts';
import { digestSync } from '../provenance/sync-identity.ts';
export const DEFAULT_STRUCTURED: StructuredSettings = { kind:'rectangular',widthMm:297,heightMm:210,marginMm:12,strokeMm:.3,junctionMm:1,clearanceMm:.5,toleranceMm:.025,fontFamily:'sans-serif',fontSizePt:10,labelGapMm:2,terminalGapMm:1.5,innerRadiusMm:8,outerRadiusMm:65,startAngleDeg:-90,sweepDeg:360,orientationDeg:0,labelPlacement:'radial',curves:true };
export function validateStructuredSettings(s: StructuredSettings): void {
  if (!s || Object.keys(s).sort().join('|') !== Object.keys(DEFAULT_STRUCTURED).sort().join('|')) throw new Error('Unsupported structured settings.');
  for (const [key,lo,hi] of [['widthMm',20,2000],['heightMm',20,2000],['marginMm',0,500],['strokeMm',.01,10],['junctionMm',.05,10],['clearanceMm',0,20],['toleranceMm',.001,.5],['fontSizePt',4,72],['labelGapMm',0,100],['terminalGapMm',0,100],['innerRadiusMm',0,1000],['outerRadiusMm',.01,1000],['startAngleDeg',-36000,36000],['orientationDeg',-36000,36000],['sweepDeg',.01,360]] as const) if (!Number.isFinite(s[key]) || s[key]<lo || s[key]>hi) throw new Error(`${key} is outside its supported range.`);
  if (!['rectangular','circular','fan'].includes(s.kind) || !['radial','horizontal','tangential'].includes(s.labelPlacement) || typeof s.curves !== 'boolean' || typeof s.fontFamily !== 'string' || !s.fontFamily.trim() || s.fontFamily.length>100 || /[<>;{}]/.test(s.fontFamily)) throw new Error('Invalid layout/font/connector settings.');
  if (s.marginMm*2 >= Math.min(s.widthMm,s.heightMm) || s.innerRadiusMm>=s.outerRadiusMm) throw new Error('Margins must leave page space, and outer radius must exceed the nonnegative inner radius.');
  if ((s.kind==='circular' && s.sweepDeg!==360) || (s.kind==='fan' && s.sweepDeg>=360)) throw new Error('Circular layout needs 360°; fan layout needs a sweep below 360°.');
}
export function estimatedMeasurements(graph: DisplayGraph, settings: StructuredSettings): TextMeasurements {
  const mm=settings.fontSizePt*25.4/72;
  return {fontFamily:settings.fontFamily,fontSizePt:settings.fontSizePt,fontStatus:'estimated',metrics:Object.fromEntries(graph.endpoints.map(id=>[id,{text:graph.nodes[id].label,widthMm:Array.from(graph.nodes[id].label).length*mm*.6,ascentMm:mm*.8,descentMm:mm*.2}]))};
}
export function validateMeasurements(graph: DisplayGraph, s: StructuredSettings, measurements: TextMeasurements): void {
  if (!measurements || measurements.fontFamily!==s.fontFamily || measurements.fontSizePt!==s.fontSizePt || !['available','substituted','estimated'].includes(measurements.fontStatus) || !measurements.metrics || Object.keys(measurements.metrics).length!==graph.endpoints.length) throw new Error('Font measurements do not match the requested view.');
  for (const id of graph.endpoints) { const m=measurements.metrics[id]; if (!m || m.text!==graph.nodes[id].label || [m.widthMm,m.ascentMm,m.descentMm].some(v=>!Number.isFinite(v)||v<0||v>100000) || m.ascentMm+m.descentMm<=0 || ['advanceMm','leftMm','rightMm'].some(key=>{const v=m[key as keyof typeof m];return v!==undefined&&(typeof v!=='number'||!Number.isFinite(v)||Math.abs(v)>100000);})) throw new Error('Invalid terminal text measurement.'); }
}
export const polar = (center: Point,radius: number,deg: number): Point => ({x:center.x+radius*Math.cos(deg*Math.PI/180),y:center.y+radius*Math.sin(deg*Math.PI/180)});
export function rotatePoint(p: Point, center: Point, deg: number): Point { const a=deg*Math.PI/180,x=p.x-center.x,y=p.y-center.y;return {x:center.x+x*Math.cos(a)-y*Math.sin(a),y:center.y+x*Math.sin(a)+y*Math.cos(a)}; }
export function primitivePoints(p: Primitive,tolerance=.025): Point[] {
  if(p.kind==='point')return [p.point];if(p.kind==='polyline')return p.points;
  const sweep=(p.endDeg-p.startDeg)*Math.PI/180;
  if(p.radius===0 || Math.abs(sweep)<1e-12)return [polar(p.center,p.radius,p.startDeg)];
  const step=2*Math.acos(Math.max(-1,Math.min(1,1-tolerance/Math.max(p.radius,tolerance))));
  const count=Math.max(1,Math.ceil(Math.abs(sweep)/Math.max(step,1e-5)));
  if(count>20000)throw new Error('Connector subdivision exceeds its work limit.');
  return Array.from({length:count+1},(_,i)=>polar(p.center,p.radius,p.startDeg+(p.endDeg-p.startDeg)*i/count));
}
export function labelCorners(position: Point,rotation: number,anchor: SceneLabel['anchor'],metric: TextMeasurements['metrics'][string]): Point[] {
  const advance=metric.advanceMm??metric.widthMm,shift=anchor==='start'?0:anchor==='end'?-advance:-advance/2,left=shift+Math.min(0,metric.leftMm??0),right=shift+Math.max(advance,metric.rightMm??metric.widthMm);
  return [{x:left,y:-metric.ascentMm},{x:right,y:-metric.ascentMm},{x:right,y:metric.descentMm},{x:left,y:metric.descentMm}].map(p=>{const a=rotation*Math.PI/180;return{x:position.x+p.x*Math.cos(a)-p.y*Math.sin(a),y:position.y+p.x*Math.sin(a)+p.y*Math.cos(a)};});
}
/** Original clade_cluster_v1: ordered terminal intervals and maximum descendant height. */
export function layoutCluster(graph: DisplayGraph, settings: StructuredSettings, measurements: TextMeasurements, nodeOffsets: RenderScene['nodeOffsets'] = {}, labelOffsets: Record<string,Point> = {}): RenderScene {
  validateStructuredSettings(settings);validateMeasurements(graph,settings,measurements);
  const s=structuredClone(settings);s.startAngleDeg=((s.startAngleDeg%360)+360)%360;s.orientationDeg=((s.orientationDeg%360)+360)%360;
  if(graph.order.length>20000 || graph.endpoints.length>5000)throw new Error('Structured views support at most 20,000 displayed nodes and 5,000 endpoints; select fewer taxa or collapse groups.');
  const ids=graph.endpoints,center={x:s.widthMm/2,y:s.heightMm/2};
  const slots:Record<string,number>={}, spans:Record<string,[number,number]>={}, heights:Record<string,number>={};
  let weights=ids.map(id=>measurements.metrics[id].ascentMm+measurements.metrics[id].descentMm+s.terminalGapMm),passes=1;
  const labelRadius=s.outerRadiusMm+s.labelGapMm;
  if(s.kind==='rectangular') {let y=s.marginMm;ids.forEach((id,i)=>{slots[id]=y+weights[i]/2;y+=weights[i];});}
  else {
    for(let pass=0;pass<8;pass++){
      let sum=0;const total=weights.reduce((a,b)=>a+b,0);ids.forEach((id,i)=>{slots[id]=s.startAngleDeg+s.sweepDeg*(sum+weights[i]/2)/total;sum+=weights[i];});passes=pass+1;
      const next=ids.map(id=>{const m=measurements.metrics[id],a=slots[id]*Math.PI/180,h=m.ascentMm+m.descentMm;const extent=s.labelPlacement==='radial'?h:s.labelPlacement==='tangential'?m.widthMm:Math.abs(Math.sin(a))*m.widthMm+Math.abs(Math.cos(a))*h;return Math.max(.001,extent+s.terminalGapMm);});
      if(next.every((w,i)=>Math.abs(w-weights[i])<1e-7))break;weights=next;
    }
  }
  for(const id of [...graph.order].reverse()) {const children=graph.nodes[id].children;if(!children.length){spans[id]=[slots[id],slots[id]];heights[id]=0;}else{spans[id]=[spans[children[0]][0],spans[children.at(-1)!][1]];heights[id]=1+Math.max(...children.map(c=>heights[c]));}}
  const maxH=heights[graph.rootId],anchors:Record<string,Point>={},depths:Record<string,number>={},coordinates:Record<string,number>={};
  const maxLabel=Math.max(0,...ids.map(id=>measurements.metrics[id].widthMm));
  const usable=Math.max(10,s.widthMm-2*s.marginMm-maxLabel-s.labelGapMm);
  const glyphs:RenderScene['junctionGlyphs']=[],ports:RenderScene['ports']=[],stems:RenderScene['edgeStems']=[],labels:SceneLabel[]=[];
  for(const [id,offset] of Object.entries(nodeOffsets)) if(!graph.nodes[id] || !graph.nodes[id].children.length || !offset || Object.keys(offset).sort().join('|')!=='depth|shift' || !Number.isFinite(offset.depth) || !Number.isFinite(offset.shift) || Math.abs(offset.depth)>1 || Math.abs(offset.shift)>3600 || (id===graph.rootId&&offset.depth!==0)) throw new Error('Junction offsets require a displayed internal node; root depth is fixed.');
  for(const id of graph.order){depths[id]=(maxH?1-heights[id]/maxH:0)+(nodeOffsets[id]?.depth??0);coordinates[id]=(spans[id][0]+spans[id][1])/2+(nodeOffsets[id]?.shift??0);}
  for(const id of graph.order){const node=graph.nodes[id],t=depths[id],transverse=coordinates[id];
    if(t<0||t>1||node.children.some(c=>depths[c]<=t+1e-10)||(node.children.length&&(transverse<coordinates[node.children[0]]-1e-8||transverse>coordinates[node.children.at(-1)!]+1e-8))||transverse<spans[id][0]-1e-8||transverse>spans[id][1]+1e-8)throw new Error(`Junction ${id} would leave its clade sector or cross a parent/child level. Reduce the adjustment.`);
    anchors[id]=!maxH?center:s.kind==='rectangular'?{x:s.marginMm+t*usable,y:transverse}:polar(center,s.innerRadiusMm+t*(s.outerRadiusMm-s.innerRadiusMm),transverse);
  }
  for(const id of graph.order){const children=graph.nodes[id].children,anchor=anchors[id];let geometry:Primitive={kind:'point',point:anchor};
    if(children.length>1){
      if(s.kind==='rectangular')geometry={kind:'polyline',points:[{x:anchor.x,y:anchors[children[0]].y},{x:anchor.x,y:anchors[children.at(-1)!].y}]};
      else geometry={kind:'arc',center,radius:s.innerRadiusMm+depths[id]*(s.outerRadiusMm-s.innerRadiusMm),startDeg:coordinates[children[0]],endDeg:coordinates[children.at(-1)!]};
    }
    if(geometry.kind==='arc' && (!s.curves || geometry.radius===0)) {const points=primitivePoints(geometry,s.toleranceMm);geometry=points.length===1?{kind:'point',point:points[0]}:{kind:'polyline',points};}
    glyphs.push({id:`junction-${id}`,nodeId:id,anchor,geometry,span:spans[id],depth:depths[id]});
    for(const child of children){const edgeId=`display-edge-${child}`,p=s.kind==='rectangular'?{x:anchor.x,y:anchors[child].y}:polar(center,s.innerRadiusMm+depths[id]*(s.outerRadiusMm-s.innerRadiusMm),coordinates[child]);
      const parentPortId=`${edgeId}-parent`,childPortId=`${edgeId}-child`;
      ports.push({id:parentPortId,nodeId:id,edgeId,end:'parent',point:p},{id:childPortId,nodeId:child,edgeId,end:'child',point:anchors[child]});
      stems.push({id:`stem-${child}`,edgeId,parentPortId,childPortId,geometry:{kind:'polyline',points:[p,anchors[child]]}});
    }
  }
  for(const id of ids){const m=measurements.metrics[id],theta=coordinates[id];let position:Point,rotation=0,anchor:SceneLabel['anchor']='start';
    if(!maxH)position={x:anchors[id].x+s.labelGapMm,y:anchors[id].y+(m.ascentMm-m.descentMm)/2};
    else if(s.kind==='rectangular')position={x:anchors[id].x+s.labelGapMm,y:anchors[id].y+(m.ascentMm-m.descentMm)/2};
    else {
      position=polar(center,labelRadius,theta);const angle=((theta%360)+360)%360,left=angle>90&&angle<270;
      if(s.labelPlacement==='radial'){rotation=theta+(left?180:0);anchor=left?'end':'start';}
      else if(s.labelPlacement==='tangential'){rotation=theta+90;const norm=((rotation%360)+360)%360;if(norm>90&&norm<270)rotation+=180;anchor='middle';}
      else anchor=left?'end':'start';
      const shift=(m.ascentMm-m.descentMm)/2;position={x:position.x-Math.sin(rotation*Math.PI/180)*shift,y:position.y+Math.cos(rotation*Math.PI/180)*shift};
    }
    labels.push({id:`label-${id}`,nodeId:id,text:m.text,position,rotationDeg:rotation,anchor,corners:labelCorners(position,rotation,anchor,m)});
  }
  if(s.orientationDeg){
    const transform=(p:Point)=>rotatePoint(p,center,s.orientationDeg);
    const transformPrimitive=(p:Primitive):Primitive=>p.kind==='point'?{kind:'point',point:transform(p.point)}:p.kind==='polyline'?{kind:'polyline',points:p.points.map(transform)}:{...p,center:transform(p.center),startDeg:p.startDeg+s.orientationDeg,endDeg:p.endDeg+s.orientationDeg};
    for(const g of glyphs){g.anchor=transform(g.anchor);g.geometry=transformPrimitive(g.geometry);}for(const p of ports)p.point=transform(p.point);for(const e of stems)e.geometry=transformPrimitive(e.geometry);
    for(const l of labels){l.position=transform(l.position);l.rotationDeg+=s.orientationDeg;if(s.kind!=='rectangular'){const angle=((l.rotationDeg%360)+360)%360;if(angle>90&&angle<270){l.rotationDeg+=180;l.anchor=l.anchor==='start'?'end':l.anchor==='end'?'start':'middle';}}l.corners=labelCorners(l.position,l.rotationDeg,l.anchor,measurements.metrics[l.nodeId]);}
  }
  for(const [id,offset] of Object.entries(labelOffsets)){const label=labels.find(l=>l.nodeId===id);if(!label||!offset||Object.keys(offset).sort().join('|')!=='x|y'||!Number.isFinite(offset.x)||!Number.isFinite(offset.y)||Math.abs(offset.x)>2000||Math.abs(offset.y)>2000)throw new Error('Label offsets require a displayed endpoint and finite millimetre coordinates.');label.position={x:label.position.x+offset.x,y:label.position.y+offset.y};label.corners=labelCorners(label.position,label.rotationDeg,label.anchor,measurements.metrics[id]);}
  const points=[...glyphs.flatMap(g=>[g.anchor,...primitivePoints(g.geometry,s.toleranceMm)]),...stems.flatMap(e=>primitivePoints(e.geometry,s.toleranceMm)),...labels.flatMap(l=>l.corners)];
  const bounds=points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
  const scene:RenderScene={units:'mm',revision:'',graphRevision:digestSync(graph),settings:s,measurements:structuredClone(measurements),junctionGlyphs:glyphs,edgeStems:stems,ports,labels,nodeOffsets:structuredClone(nodeOffsets),...(Object.keys(labelOffsets).length?{labelOffsets:structuredClone(labelOffsets)}:{}),bounds,slotPasses:passes};
  scene.revision=sceneRevision(scene);return scene;
}
export function sceneRevision(scene: RenderScene): string { const { revision:_revision,...content }=scene;return digestSync(content); }
