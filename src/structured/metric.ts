import type { Point } from '../types.ts';
import type { DisplayGraph, MetricSpec, RenderScene, StructuredSettings, TextMeasurements, SceneQA } from './types.ts';
import { primitivePoints, labelCorners, sceneRevision } from './layout.ts';
import { coordinateScene } from './coordinates.ts';
import { validateScene, polygonsOverlap, segmentDistance } from './validate.ts';
import { digestSync } from '../provenance/sync-identity.ts';
import { HUG_SHA } from '../science.ts';

export const HUG_MEASURE_EVIDENCE='Hug et al. 2016, Figure 2 legend identifies substitutions per site and links the same ribosomal-protein tree to Supplementary Dataset 2. Input inference was performed by the source authors.';
export const scaleBarText=(spec:MetricSpec)=>`${spec.scaleBarValue} ${spec.measure.unit}`;
const exact=(object:object,keys:string[])=>!!object&&!Array.isArray(object)&&Object.keys(object).sort().join('|')===keys.sort().join('|');
export function validateMetricSpec(spec:MetricSpec,sourceSha256:string):void {
  if(!spec||!exact(spec,['measure','mmPerUnit','scaleBarValue'])||!Number.isFinite(spec.mmPerUnit)||spec.mmPerUnit<.000001||spec.mmPerUnit>1e6||!Number.isFinite(spec.scaleBarValue)||spec.scaleBarValue<=0||spec.scaleBarValue>1e12)throw new Error('A phylogram requires a positive physical scale and scale-bar value.');
  const m=spec.measure;
  if(!m||!exact(m,['meaning','unit','evidence','referenceIds','sourceSha256','declaration'])||!['substitutions-per-site','expected-changes','other-distance'].includes(m.meaning)||typeof m.unit!=='string'||!m.unit.trim()||m.unit.length>100||typeof m.evidence!=='string'||!m.evidence.trim()||m.evidence.length>5000||m.sourceSha256!==sourceSha256||!['curated','user-supplied'].includes(m.declaration)||!Array.isArray(m.referenceIds)||m.referenceIds.length>100||new Set(m.referenceIds).size!==m.referenceIds.length||m.referenceIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(id)))throw new Error('Declare branch-length meaning, units and evidence for this exact source. Newick numbers do not establish their own meaning.');
  if((m.meaning==='substitutions-per-site'&&m.unit!=='substitutions/site')||(m.meaning==='expected-changes'&&m.unit!=='expected changes'))throw new Error('Metric meaning and units disagree.');
  if(m.declaration==='curated'&&(sourceSha256!==HUG_SHA||m.meaning!=='substitutions-per-site'||m.evidence!==HUG_MEASURE_EVIDENCE||!m.referenceIds.includes('hug-2016')))throw new Error('Only the exact bundled source has curated branch-unit evidence.');
}
export function metricDistances(graph:DisplayGraph):Record<string,number>{
  const distances:Record<string,number>={[graph.rootId]:0};
  for(const id of graph.order){if(id===graph.rootId)continue;const edge=graph.edges[`display-edge-${id}`];
    if(!edge||edge.length===null||!Number.isFinite(edge.length)||edge.length<0)throw new Error(`Path to ${id} has missing or invalid lengths. A scaled view cannot invent a zero or use normalized depth.`);
    const distance=distances[edge.parent]+edge.length;if(!Number.isFinite(distance))throw new Error('Cumulative branch lengths exceed the supported numeric range.');distances[id]=distance;
  }return distances;
}
const box=(points:Point[])=>points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
const segments=(points:Point[]):[Point,Point][]=>points.length===1?[[points[0],points[0]]]:points.slice(1).map((p,i)=>[points[i],p]);
export function layoutMetric(graph:DisplayGraph,settings:StructuredSettings,measurements:TextMeasurements,spec:MetricSpec,nodes:RenderScene['nodeOffsets']={},labels:RenderScene['labelOffsets']={}):RenderScene{
  validateMetricSpec(spec,graph.sourceSha256);const distances=metricDistances(graph);
  if(Object.values(nodes).some(offset=>offset.depth!==0))throw new Error('Metric depth is locked to source distance. Return to Cladogram to reset depth offsets, or choose New view before building a phylogram. Across-clade and label adjustments remain available.');
  const barMetric=measurements.scaleBar;
  if(!barMetric||barMetric.text!==scaleBarText(spec)||[barMetric.widthMm,barMetric.ascentMm,barMetric.descentMm].some(n=>!Number.isFinite(n)||n<0||n>100000)||barMetric.ascentMm+barMetric.descentMm<=0||['advanceMm','leftMm','rightMm'].some(key=>{const n=barMetric[key as keyof typeof barMetric];return n!==undefined&&(typeof n!=='number'||!Number.isFinite(n)||Math.abs(n)>100000);}))throw new Error('Measure the scale-bar label along with the terminal labels.');
  if(Math.max(...Object.values(distances))*spec.mmPerUnit>100000||spec.mmPerUnit*spec.scaleBarValue>100000)throw new Error('Physical metric coordinates exceed 100,000 mm. Reduce mm per source unit.');
  const scene=coordinateScene(graph,settings,measurements,distances,spec.mmPerUnit,nodes,labels),s=scene.settings;
  const from={x:s.marginMm,y:s.heightMm-s.marginMm/2},to={x:s.marginMm+spec.mmPerUnit*spec.scaleBarValue,y:from.y},position={x:from.x,y:from.y-s.labelGapMm-1};
  const scaleBar={value:spec.scaleBarValue,from,to,label:scaleBarText(spec),position,corners:labelCorners(position,0,'start',barMetric)};
  const points=[...scaleBar.corners,{x:from.x,y:from.y-1},{x:to.x,y:to.y+1},{x:scene.bounds.minX,y:scene.bounds.minY},{x:scene.bounds.maxX,y:scene.bounds.maxY}];
  scene.bounds=box(points);scene.metric={spec:structuredClone(spec),distances,scaleBar};scene.revision=sceneRevision(scene);return scene;
}
export function validateMetricScene(graph:DisplayGraph,scene:RenderScene):SceneQA{
  const qa=validateScene(graph,scene),metric=scene.metric;if(!metric)throw new Error('A phylogram must retain its distance encoding and scale guide.');
  validateMetricSpec(metric.spec,graph.sourceSha256);const distances=metricDistances(graph),s=scene.settings,k=metric.spec.mmPerUnit,center={x:s.widthMm/2,y:s.heightMm/2},a=s.orientationDeg*Math.PI/180;
  const coordinate=(p:Point)=>s.kind==='rectangular'?((p.x-center.x)*Math.cos(a)+(p.y-center.y)*Math.sin(a)+center.x-s.marginMm)/k:(Math.hypot(p.x-center.x,p.y-center.y)-s.innerRadiusMm)/k;
  const tolerance=(d:number)=>1e-8/k+1e-9*Math.max(1,Math.abs(d));
  const issue=(ids:string[],detail:string)=>{qa.status='draft';if(qa.issues.length<200)qa.issues.push({type:'legibility',ids,detail});else qa.omittedIssueCount++;};
  if(digestSync(distances)!==digestSync(metric.distances)||scene.junctionGlyphs.some(g=>Math.abs(coordinate(g.anchor)-distances[g.nodeId])>tolerance(distances[g.nodeId]))||scene.ports.some(p=>Math.abs(coordinate(p.point)-distances[p.nodeId])>tolerance(distances[p.nodeId])))throw new Error('Metric coordinates do not encode the exact source distances.');
  if(Math.abs(Math.hypot(metric.scaleBar.to.x-metric.scaleBar.from.x,metric.scaleBar.to.y-metric.scaleBar.from.y)-metric.spec.scaleBarValue*k)>1e-7||metric.scaleBar.label!==scaleBarText(metric.spec))throw new Error('The scale guide disagrees with the declared physical scale.');
  const zero=Object.values(graph.edges).filter(e=>e.length===0);if(zero.length)issue(zero.slice(0,10).map(e=>`stem-${e.child}`),`${zero.length} zero-length source paths retain coincident metric positions. No positive length was invented; visual separation needs review.`);
  // Keep historical compound QA unchanged. Check the new guide explicitly.
  const bar=metric.scaleBar,guideSegments:[Point,Point][]=[[bar.from,bar.to],[{x:bar.from.x,y:bar.from.y-1},{x:bar.from.x,y:bar.from.y+1}],[{x:bar.to.x,y:bar.to.y-1},{x:bar.to.x,y:bar.to.y+1}]],boundary=segments([...bar.corners,bar.corners[0]]);
  if(guideSegments.some(([p,q])=>polygonsOverlap(bar.corners,[p,q,q,p])||boundary.some(([r,t])=>segmentDistance(p,q,r,t).distance<=s.strokeMm/2+s.toleranceMm))){qa.labelCollisions++;issue(['metric-scale-guide','metric-scale-label'],'The measured scale label overlaps its guide. Increase the label gap.');}
  let work=12;
  const guideLabelHit=(points:Point[])=>segments(points).some(([p,q])=>polygonsOverlap(bar.corners,[p,q,q,p])||boundary.some(([r,t])=>segmentDistance(p,q,r,t).distance<=s.strokeMm/2+s.toleranceMm));
  for(const shape of [...scene.junctionGlyphs.map(g=>({id:g.id,geometry:g.geometry})),...scene.edgeStems.map(e=>({id:e.id,geometry:e.geometry}))]){
    const points=primitivePoints(shape.geometry,s.toleranceMm);work+=points.length*7;if(work>500000){qa.limited=true;issue([],'Scale-guide checks reached their 500,000-segment-comparison budget; no all-clear is asserted.');break;}
    if(guideLabelHit(points)||segments(points).some(([p,q])=>guideSegments.some(([r,t])=>segmentDistance(p,q,r,t).distance<=s.strokeMm+s.clearanceMm+2*s.toleranceMm))){qa.labelCollisions++;issue([shape.id],'The scale guide intersects or crowds a tree stroke. Increase page height/margins or change the explicit metric scale.');}
  }
  for(const label of scene.labels){work+=label.corners.length*guideSegments.length;if(work>500000){qa.limited=true;issue([],'Scale-guide checks reached their 500,000-segment-comparison budget; no all-clear is asserted.');break;}if(polygonsOverlap(label.corners,bar.corners)||guideSegments.some(([p,q])=>polygonsOverlap(label.corners,[p,q,q,p])||segments([...label.corners,label.corners[0]]).some(([r,t])=>segmentDistance(p,q,r,t).distance<=s.strokeMm/2+s.toleranceMm))){qa.labelCollisions++;issue([label.id],'A terminal label overlaps the scale guide. Adjust its offset or the page dimensions.');}}
  qa.limitations=['Phylogram: cumulative source distance is encoded by the rectangular axis or radius. Connector length and the inner hole carry no distance; lengths do not establish elapsed time.',`Logical coordinate tolerance: 1e-8 mm absolute plus 1e-9 relative; SVG coordinate rounding tolerance: 1e-6 mm. Units: ${metric.spec.measure.unit}; evidence is ${metric.spec.measure.declaration}.`,...qa.limitations.filter(l=>!l.startsWith('Nonmetric cladogram:'))];return qa;
}
