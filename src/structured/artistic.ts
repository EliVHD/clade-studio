import { layoutUnrooted } from './unrooted.ts';
import type { Source, Point } from '../types.ts';
import type { ArtisticEdit, DisplayGraph, RenderScene, StructuredView, Primitive } from './types.ts';
import { labelCorners, layoutCluster, primitivePoints, sceneRevision, validateMeasurements } from './layout.ts';
import { layoutClassification } from './classification.ts';
import { layoutMetric } from './metric.ts';
import { validateScene } from './validate.ts';
import { digestSync } from '../provenance/sync-identity.ts';

const point = (p:Point) => !!p && Object.keys(p).sort().join('|')==='x|y' && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x)<=2000 && Math.abs(p.y)<=2000;
const exact = (object:object,keys:string[]) => !!object && !Array.isArray(object) && Object.keys(object).sort().join('|')===keys.sort().join('|');
const add = (a:Point,b:Point):Point => ({x:a.x+b.x,y:a.y+b.y});
function translate(primitive:Primitive,delta:Point):Primitive {
  if(primitive.kind==='point') return {kind:'point',point:add(primitive.point,delta)};
  if(primitive.kind==='arc') return {...primitive,center:add(primitive.center,delta)};
  return {kind:'polyline',points:primitive.points.map(p=>add(p,delta))};
}
function finish(scene:RenderScene):RenderScene {
  for(const label of scene.labels) label.corners=labelCorners(label.position,label.rotationDeg,label.anchor,scene.measurements.metrics[label.nodeId]);
  const points=[...scene.junctionGlyphs.flatMap(g=>[g.anchor,...primitivePoints(g.geometry,scene.settings.toleranceMm)]),...scene.edgeStems.flatMap(e=>primitivePoints(e.geometry,scene.settings.toleranceMm)),...scene.labels.flatMap(l=>l.corners)];
  if(points.some(p=>!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>10000||Math.abs(p.y)>10000))throw new Error('Artistic geometry exceeds the supported coordinate range.');
  scene.bounds=points.reduce((b,p)=>({minX:Math.min(b.minX,p.x),minY:Math.min(b.minY,p.y),maxX:Math.max(b.maxX,p.x),maxY:Math.max(b.maxY,p.y)}),{minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity});
  scene.revision=sceneRevision(scene);return scene;
}
/** Replay original editing commands over an exact, independently verified structured scene. */
export function replayArtistic(graph:DisplayGraph,base:RenderScene,edits:ArtisticEdit[]):RenderScene {
  if(!Array.isArray(edits)||edits.length>1000)throw new Error('An artistic copy supports at most 1,000 accepted geometry edits.');
  const scene=structuredClone(base);delete scene.unrooted;delete scene.metric;delete scene.classification;let curves=base.settings.curves;
  for(const edit of edits){
    if(edit.kind==='move-junction'){
      if(!exact(edit,['kind','nodeIds','delta'])||!Array.isArray(edit.nodeIds)||!edit.nodeIds.length||new Set(edit.nodeIds).size!==edit.nodeIds.length||edit.nodeIds.some(id=>!graph.nodes[id])||!point(edit.delta))throw new Error('Invalid artistic junction movement.');
      const selected=new Set(edit.nodeIds);
      for(const glyph of scene.junctionGlyphs)if(selected.has(glyph.nodeId)){glyph.anchor=add(glyph.anchor,edit.delta);glyph.geometry=translate(glyph.geometry,edit.delta);}
      for(const port of scene.ports)if(selected.has(port.nodeId))port.point=add(port.point,edit.delta);
      const ports=new Map(scene.ports.map(p=>[p.id,p]));
      for(const stem of scene.edgeStems){if(stem.geometry.kind!=='polyline')throw new Error('Unsupported artistic stem.');const a=ports.get(stem.parentPortId)!,b=ports.get(stem.childPortId)!;
        if(selected.has(a.nodeId)&&selected.has(b.nodeId))stem.geometry.points=stem.geometry.points.map(p=>add(p,edit.delta));
        stem.geometry.points[0]={...a.point};stem.geometry.points[stem.geometry.points.length-1]={...b.point};
      }
      for(const label of scene.labels)if(selected.has(label.nodeId))label.position=add(label.position,edit.delta);
    }else if(edit.kind==='move-label'){
      if(!exact(edit,['kind','nodeId','delta'])||!point(edit.delta))throw new Error('Invalid artistic label movement.');
      const label=scene.labels.find(l=>l.nodeId===edit.nodeId);if(!label)throw new Error('Select a displayed terminal label.');
      label.position=add(label.position,edit.delta);scene.labelOffsets??={};scene.labelOffsets[edit.nodeId]=add(scene.labelOffsets[edit.nodeId]??{x:0,y:0},edit.delta);
    }else if(edit.kind==='stem-waypoints'){
      if(!exact(edit,['kind','edgeId','points'])||!Array.isArray(edit.points)||edit.points.length>24||edit.points.some(p=>!point(p)))throw new Error('Use at most 24 finite stem waypoints.');
      const stem=scene.edgeStems.find(e=>e.edgeId===edit.edgeId);if(!stem)throw new Error('Select a stem with a parent.');
      const a=scene.ports.find(p=>p.id===stem.parentPortId)!,b=scene.ports.find(p=>p.id===stem.childPortId)!;
      stem.geometry={kind:'polyline',points:[{...a.point},...structuredClone(edit.points),{...b.point}]};
    }else if(edit.kind==='measure-labels'){
      if(!exact(edit,['kind','measurements']))throw new Error('Invalid artistic font measurements.');validateMeasurements(graph,scene.settings,edit.measurements);scene.measurements=structuredClone(edit.measurements);
    }else if(edit.kind==='appearance'){
      if(!exact(edit,['kind','strokeMm','curves'])||!Number.isFinite(edit.strokeMm)||edit.strokeMm<.01||edit.strokeMm>10||typeof edit.curves!=='boolean')throw new Error('Invalid artistic line appearance.');
      scene.settings.strokeMm=edit.strokeMm;curves=edit.curves;
    }else throw new Error('Unsupported artistic edit.');
  }
  scene.settings.curves=curves;
  if(!curves)for(const glyph of scene.junctionGlyphs)if(glyph.geometry.kind==='arc'){const points=primitivePoints(glyph.geometry,scene.settings.toleranceMm);glyph.geometry=points.length===1?{kind:'point',point:points[0]}:{kind:'polyline',points};}
  return finish(scene);
}
export function makeArtisticCopy(original:StructuredView,id:string,name:string):StructuredView {
  if(!['clade-cluster-v1','metric-distance-v1','classification-rank-v1','unrooted-angle-v1'].includes(original.adapter))throw new Error('Select a structured layout to create an artistic copy.');
  const copy=structuredClone(original);copy.id=id;copy.name=name;copy.intent='artistic';copy.adapter='compound-artistic-v1';
  copy.artistic={viewId:original.id,sceneRevision:original.scene.revision,baseScene:structuredClone(original.scene),edits:[]};
  // Tree geometry stays exact; a metric origin loses only the active scale guide and claim.
  if(original.scene.unrooted||original.scene.metric||original.scene.classification){copy.scene=replayArtistic(copy.graph,copy.artistic.baseScene,[]);copy.qa=validateScene(copy.graph,copy.scene);}
  return copy;
}
export function applyArtisticEdit(view:StructuredView,edit:ArtisticEdit):StructuredView {
  if(view.adapter!=='compound-artistic-v1'||!view.artistic)throw new Error('Create or select an artistic copy first.');
  const next=structuredClone(view);next.artistic!.edits.push(structuredClone(edit));next.scene=replayArtistic(next.graph,next.artistic!.baseScene,next.artistic!.edits);next.qa=validateScene(next.graph,next.scene);return next;
}
export function validateArtistic(view:StructuredView,source?:Source):RenderScene {
  const origin=view.artistic;
  if(!origin||!exact(origin,['viewId','sceneRevision','baseScene','edits'])||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(origin.viewId)||origin.viewId===view.id||origin.sceneRevision!==origin.baseScene.revision)throw new Error('Invalid artistic-copy origin.');
  const base=origin.baseScene;if(base.classification&&!source)throw new Error('Classification origin requires its exact source.');const expected=base.unrooted?layoutUnrooted(view.graph,base.settings,base.measurements,base.unrooted.spec,base.nodeOffsets,base.labelOffsets):base.classification?layoutClassification(source!,view.graph,base.settings,base.measurements,base.classification.spec,base.nodeOffsets,base.labelOffsets):base.metric?layoutMetric(view.graph,base.settings,base.measurements,base.metric.spec,base.nodeOffsets,base.labelOffsets):layoutCluster(view.graph,base.settings,base.measurements,base.nodeOffsets,base.labelOffsets);
  if(digestSync(base)!==digestSync(expected))throw new Error('Artistic origin does not replay from its scientific input.');
  // An unchanged copy retains every original byte, including optional fields.
  return origin.edits.length||base.unrooted||base.metric||base.classification?replayArtistic(view.graph,base,origin.edits):structuredClone(base);
}
