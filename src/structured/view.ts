import { requireUnrootedBasis, projectUnrooted, layoutUnrooted, validateUnrootedScene } from './unrooted.ts';
import type { Source } from '../types.ts';
import type { WorkingProject } from '../model/document.ts';
import type { StructuredView, ProjectionSpec, StructuredSettings, TextMeasurements, MetricSpec, ClassificationSpec, UnrootedSpec } from './types.ts';
import { orient } from '../science.ts';
import { digestSync } from '../provenance/sync-identity.ts';
import { projectTree } from './projection.ts';
import { layoutCluster, validateMeasurements } from './layout.ts';
import { validateScene } from './validate.ts';
import { validateScientificBasis } from '../model/basis.ts';
import { validateRootState } from '../model/semantics.ts';
import { layoutMetric, validateMetricScene, validateMetricSpec } from './metric.ts';
import { requireClassificationBasis, validateClassificationSpec, projectClassification, layoutClassification, validateClassificationScene } from './classification.ts';
import { validateArtistic } from './artistic.ts';
import { semanticCapabilities } from '../model/semantics.ts';
export function structuredInputRevision(project:WorkingProject):string{return digestSync({source:project.sourceSha256,basis:project.authoring.basis,root:project.authoring.root,traversal:project.recipe.root,corrections:project.corrections});}
export function activeStructuredView(project:WorkingProject):StructuredView|null {const state=project.authoring;return state.activeStructuredViewId?state.structuredViews?.[state.activeStructuredViewId]??null:null;}
export function effectiveViewId(project:WorkingProject):string{return activeStructuredView(project)?.id??project.authoring.activeViewId;}
export function isStructuredStale(project:WorkingProject,view:StructuredView):boolean{return view.inputRevision!==structuredInputRevision(project);}
export function requireCladogram(project:WorkingProject):void{
  const capability=semanticCapabilities(project.authoring.root,'cladogram',project.authoring.edgeMeasure,project.authoring.basis);
  if(!capability.available)throw new Error('A rooted cladogram requires a declared phylogenetic basis, known entities and an explicit biological root. Set Scientific basis and declare the root first.');
}
export function makeStructuredView(project:WorkingProject,source:Source,projection:ProjectionSpec,settings:StructuredSettings,measurements:TextMeasurements,id:string,name:string,previous?:StructuredView,offsets=previous?.scene.nodeOffsets??{}, labelOffsets=previous?.scene.labelOffsets??{}):StructuredView{
  requireCladogram(project);const graph=projectTree(source,orient(source,project.recipe.root),projection,project.corrections),scene=layoutCluster(graph,settings,measurements,offsets,labelOffsets);
  const view:StructuredView={id,name,intent:'cladogram',adapter:'clade-cluster-v1',inputRevision:structuredInputRevision(project),input:structuredClone({basis:project.authoring.basis,root:project.authoring.root,traversal:project.recipe.root,corrections:project.corrections}),projection:structuredClone(projection),graph,scene,qa:validateScene(graph,scene),pinnedNodes:previous?.pinnedNodes??[],pinnedEdges:previous?.pinnedEdges??[],highlights:previous?.highlights??[]};
  if(previous){
    for(const nodeId of previous.pinnedNodes){const a=previous.scene.junctionGlyphs.find(g=>g.nodeId===nodeId),b=scene.junctionGlyphs.find(g=>g.nodeId===nodeId);if(!a||!b||digestSync(a.anchor)!==digestSync(b.anchor))throw new Error(`Pinned junction ${nodeId} conflicts with this proposal. Explicitly unpin it, create a separate view or cancel.`);}
    for(const edgeId of previous.pinnedEdges){const a=previous.scene.edgeStems.find(e=>e.edgeId===edgeId),b=scene.edgeStems.find(e=>e.edgeId===edgeId);if(!a||!b||digestSync(a.geometry)!==digestSync(b.geometry))throw new Error(`Pinned stem ${edgeId} conflicts with this proposal. Explicitly unpin it first.`);}
  }
  return view;
}
export function makeMetricView(project:WorkingProject,source:Source,projection:ProjectionSpec,settings:StructuredSettings,measurements:TextMeasurements,spec:MetricSpec,id:string,name:string,previous?:StructuredView,offsets:StructuredView['scene']['nodeOffsets']=previous?.scene.nodeOffsets??{},labelOffsets:StructuredView['scene']['labelOffsets']=previous?.scene.labelOffsets??{}):StructuredView{
  requireCladogram(project);validateMetricSpec(spec,source.sha256);if(spec.measure.referenceIds.some(id=>!Object.hasOwn(project.authoring.provenance.references,id)))throw new Error('Metric evidence references an unknown source citation.');
  const graph=projectTree(source,orient(source,project.recipe.root),projection,project.corrections),scene=layoutMetric(graph,settings,measurements,spec,offsets,labelOffsets);
  const view:StructuredView={id,name,intent:'phylogram',adapter:'metric-distance-v1',inputRevision:structuredInputRevision(project),input:structuredClone({basis:project.authoring.basis,root:project.authoring.root,traversal:project.recipe.root,corrections:project.corrections}),projection:structuredClone(projection),graph,scene,qa:validateMetricScene(graph,scene),pinnedNodes:previous?.pinnedNodes??[],pinnedEdges:previous?.pinnedEdges??[],highlights:previous?.highlights??[]};
  if(previous)checkStructuredPins(previous,view);return view;
}
export function makeClassificationView(project:WorkingProject,source:Source,projection:ProjectionSpec,settings:StructuredSettings,measurements:TextMeasurements,spec:ClassificationSpec,id:string,name:string,previous?:StructuredView,offsets:StructuredView['scene']['nodeOffsets']=previous?.scene.nodeOffsets??{},labels:StructuredView['scene']['labelOffsets']=previous?.scene.labelOffsets??{}):StructuredView{
  requireClassificationBasis(project.authoring.basis);validateClassificationSpec(spec,source,project.authoring.basis);if(spec.referenceIds.some(id=>!Object.hasOwn(project.authoring.provenance.references,id)))throw new Error('Unknown classification rank citation.');
  const graph=projectClassification(source,projection,project.corrections),scene=layoutClassification(source,graph,settings,measurements,spec,offsets,labels);
  const view:StructuredView={id,name,intent:'taxonomy',adapter:'classification-rank-v1',inputRevision:structuredInputRevision(project),input:structuredClone({basis:project.authoring.basis,root:project.authoring.root,traversal:project.recipe.root,corrections:project.corrections}),projection:structuredClone(projection),graph,scene,qa:validateClassificationScene(source,graph,scene),pinnedNodes:previous?.pinnedNodes??[],pinnedEdges:previous?.pinnedEdges??[],highlights:previous?.highlights??[]};if(previous)checkStructuredPins(previous,view);return view;
}
export function makeUnrootedView(project:WorkingProject,source:Source,projection:ProjectionSpec,settings:StructuredSettings,measurements:TextMeasurements,spec:UnrootedSpec,id:string,name:string,previous?:StructuredView,labelOffsets=previous?.scene.labelOffsets??{}):StructuredView{
  requireUnrootedBasis(project.authoring.basis);const graph=projectUnrooted(source,projection,spec,project.corrections),scene=layoutUnrooted(graph,settings,measurements,spec,{},labelOffsets);
  const view:StructuredView={id,name,intent:'unrooted',adapter:'unrooted-angle-v1',inputRevision:structuredInputRevision(project),input:structuredClone({basis:project.authoring.basis,root:project.authoring.root,traversal:project.recipe.root,corrections:project.corrections}),projection:structuredClone(projection),graph,scene,qa:validateUnrootedScene(graph,scene),pinnedNodes:previous?.pinnedNodes??[],pinnedEdges:previous?.pinnedEdges??[],highlights:[]};if(previous)checkStructuredPins(previous,view);return view;
}
export function checkStructuredPins(before:StructuredView,next:StructuredView):void{
  if(digestSync(before.scene)===digestSync(next.scene))return;
  for(const id of before.pinnedNodes){const a=before.scene.junctionGlyphs.find(g=>g.nodeId===id),b=next.scene.junctionGlyphs.find(g=>g.nodeId===id);if(!next.pinnedNodes.includes(id)||!a||!b||digestSync(a.anchor)!==digestSync(b.anchor))throw new Error(`Pinned junction ${id} conflicts with this edit; unpin it explicitly first.`);}
  for(const id of before.pinnedEdges){const a=before.scene.edgeStems.find(e=>e.edgeId===id),b=next.scene.edgeStems.find(e=>e.edgeId===id);if(!next.pinnedEdges.includes(id)||!a||!b||digestSync(a.geometry)!==digestSync(b.geometry))throw new Error(`Pinned stem ${id} conflicts with this edit; unpin it explicitly first.`);}
}
export function validateStructuredView(view:StructuredView,project:WorkingProject,source:Source):void{
  if(!view||typeof view!=='object'||Object.keys(view).sort().join('|')!==['id','name','intent','adapter','inputRevision','input','projection','graph','scene','qa','pinnedNodes','pinnedEdges','highlights',...(view.adapter==='compound-artistic-v1'?['artistic']:[])].sort().join('|')||typeof view.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(view.id)||typeof view.name!=='string'||!view.name.trim()||view.name.length>500||!((view.intent==='cladogram'&&view.adapter==='clade-cluster-v1')||(view.intent==='artistic'&&view.adapter==='compound-artistic-v1')||(view.intent==='phylogram'&&view.adapter==='metric-distance-v1')||(view.intent==='taxonomy'&&view.adapter==='classification-rank-v1')||(view.intent==='unrooted'&&view.adapter==='unrooted-angle-v1'))||!/^[0-9a-f]{64}$/.test(view.inputRevision))throw new Error('Invalid structured view.');
  for(const [ids,allowed]of [[view.pinnedNodes,new Set(view.graph.order)],[view.highlights,new Set(view.graph.order)],[view.pinnedEdges,new Set(Object.keys(view.graph.edges))]] as [string[],Set<string>][])if(!Array.isArray(ids)||new Set(ids).size!==ids.length||ids.some(id=>!allowed.has(id)))throw new Error('Invalid structured pin/highlight identity.');
  if(project.sourceSha256!==source.sha256)throw new Error('Structured source identity mismatch.');
  const snapshot=view.input;
  if(!snapshot||Object.keys(snapshot).sort().join('|')!=='basis|corrections|root|traversal'||view.inputRevision!==digestSync({source:source.sha256,...snapshot}))throw new Error('Structured scientific snapshot/revision mismatch.');
  validateScientificBasis(snapshot.basis,source.sha256);validateRootState(snapshot.root,snapshot.traversal,source);
  const classification=view.adapter==='classification-rank-v1'?view.scene.classification:view.artistic?.baseScene.classification;
  const unrooted=view.adapter==='unrooted-angle-v1'?view.scene.unrooted:view.artistic?.baseScene.unrooted;
  if(unrooted){requireUnrootedBasis(snapshot.basis);if(view.highlights.length)throw new Error('Rooted clade highlights are unavailable for unrooted views.');}
  if(view.adapter==='unrooted-angle-v1'&&!unrooted)throw new Error('Missing unrooted specification.');
  if(classification)validateClassificationSpec(classification.spec,source,snapshot.basis);
  if(!unrooted&&!classification&&!semanticCapabilities(snapshot.root,'cladogram',null,snapshot.basis).available)throw new Error('Saved structured snapshot lacks rooted phylogenetic meaning.');
  if(!Array.isArray(snapshot.corrections)||snapshot.corrections.some(c=>!source.nodes[c.source_node_id]||source.nodes[c.source_node_id].rawLabel!==c.raw_label||(c.display_taxonomy!==null&&typeof c.display_taxonomy!=='string')))throw new Error('Invalid stored structured label corrections.');
  if(view.adapter==='classification-rank-v1'&&!classification)throw new Error('Missing classification specification.');
  const graph=unrooted?projectUnrooted(source,view.projection,unrooted.spec,snapshot.corrections):classification?projectClassification(source,view.projection,snapshot.corrections):projectTree(source,orient(source,snapshot.traversal),view.projection,snapshot.corrections);
  if(digestSync(graph)!==digestSync(view.graph))throw new Error('Structured display graph does not replay from its exact source selection.');
  validateMeasurements(graph,view.scene.settings,view.scene.measurements);
  if(view.adapter==='metric-distance-v1'&&!view.scene.metric)throw new Error('A phylogram is missing its metric specification.');
  for(const ref of [...(view.scene.metric?.spec.measure.referenceIds??[]),...(view.artistic?.baseScene.metric?.spec.measure.referenceIds??[]),...(classification?.spec.referenceIds??[])])if(!Object.hasOwn(project.authoring.provenance.references,ref))throw new Error('Unknown metric evidence citation.');
  const scene=view.adapter==='compound-artistic-v1'?validateArtistic(view,source):view.adapter==='unrooted-angle-v1'?layoutUnrooted(graph,view.scene.settings,view.scene.measurements,unrooted!.spec,view.scene.nodeOffsets,view.scene.labelOffsets):view.adapter==='classification-rank-v1'?layoutClassification(source,graph,view.scene.settings,view.scene.measurements,view.scene.classification!.spec,view.scene.nodeOffsets,view.scene.labelOffsets):view.adapter==='metric-distance-v1'?layoutMetric(graph,view.scene.settings,view.scene.measurements,view.scene.metric!.spec,view.scene.nodeOffsets,view.scene.labelOffsets):layoutCluster(graph,view.scene.settings,view.scene.measurements,view.scene.nodeOffsets,view.scene.labelOffsets);
  const qaContent=({limitations:_l,...rest}:StructuredView['qa'])=>rest;
  if(!Array.isArray(view.qa.limitations)||view.qa.limitations.some(text=>typeof text!=='string'||text.length>2000)||digestSync(scene)!==digestSync(view.scene)||digestSync(qaContent(view.intent==='unrooted'?validateUnrootedScene(graph,scene):view.intent==='taxonomy'?validateClassificationScene(source,graph,scene):view.intent==='phylogram'?validateMetricScene(graph,scene):validateScene(graph,scene)))!==digestSync(qaContent(view.qa)))throw new Error('Structured scene, measurements or QA do not replay.');
}
