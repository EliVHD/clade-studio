import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { classificationSample } from '../src/structured/example.ts';
import { classificationLevels, classificationRank, projectClassification, layoutClassification, validateClassificationScene, validateClassificationSpec } from '../src/structured/classification.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, sceneRevision } from '../src/structured/layout.ts';
import { makeClassificationView, validateStructuredView, isStructuredStale, checkStructuredPins } from '../src/structured/view.ts';
import { makeArtisticCopy, applyArtisticEdit } from '../src/structured/artistic.ts';
import { semanticCapabilities } from '../src/model/semantics.ts';
import { acceptCommand, acceptBasisEdit } from '../src/commands.ts';
import { serializeProject, documentFromWorking, loadAnyProject } from '../src/project-v2.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { parseNewick } from '../src/newick.ts';
import { schemaValid } from './schema-check.ts';
import { History } from '../src/project.ts';
import type { StructuredSettings, ProjectionSpec, ClassificationSpec } from '../src/structured/types.ts';
const projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
async function fixture(kind:StructuredSettings['kind']='rectangular',angle=0){
  const f=await classificationSample(),settings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360,orientationDeg:angle},graph=projectClassification(f.source,projection),metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const view=makeClassificationView(f.project,f.source,projection,settings,metrics,f.spec,'classification-1','Synthetic classification');return {...f,settings,graph,metrics,view};
}
function commit(f:Awaited<ReturnType<typeof fixture>>){const p=structuredClone(f.project);p.authoring.structuredViews={[f.view.id]:f.view};p.authoring.activeStructuredViewId=f.view.id;return acceptCommand(f.project,p,f.source,{methods:['classification-projection','classification-rank-layout','classification-validation','compound-validation'],replace:true,parameters:{classificationSpec:f.spec}});}
test('T17: rectangular/circular/fan rank placement preserves supplied parent links, ranks and incidence across rotation',async()=>{
  for(const kind of ['rectangular','circular','fan'] as const)for(const angle of [0,67,180]){const f=await fixture(kind,angle),data=f.view.scene.classification!;assert.equal(data.topNodeId,f.source.rootId);assert.equal(data.levels.n000000,0);assert.equal(data.levels.n000001,.5);assert.equal(data.levels.n000002,.75);assert.equal(data.rankLevels.division,.25);assert.ok(!Object.values(f.spec.ranks).includes('division'));assert.equal(f.view.qa.incidencePassed,true);assert.equal(f.view.qa.coveragePassed,true);assert.equal(f.view.scene.metric,undefined);assert.doesNotThrow(()=>validateClassificationScene(f.source,f.graph,f.view.scene));}
});
test('classification top is independent of biological root/traversal and never offers ancestry/MRCA',async()=>{
  const f=await fixture(),cap=semanticCapabilities(f.project.authoring.root,'taxonomy',null,f.project.authoring.basis);assert.equal(cap.available,true);assert.equal(cap.canClaimAncestry,false);assert.equal(cap.quantitative,false);
  const p=structuredClone(f.project);p.recipe.root={kind:'edge',sourceEdge:['n000000','n000001'],fraction:.25,status:'declared_assumption'};p.authoring.root={status:'rooted',basis:'user-assumption',explanation:'Stored phylogenetic assumption is unused by classification.',referenceIds:[]};
  const v=makeClassificationView(p,f.source,projection,f.settings,f.metrics,f.spec,f.view.id,f.view.name);assert.deepEqual(v.graph,f.view.graph);assert.deepEqual(v.scene,f.view.scene);assert.doesNotThrow(()=>validateStructuredView(v,p,f.source));assert.equal(semanticCapabilities(p.authoring.root,'taxonomy',null,p.authoring.basis).canClaimAncestry,false);
  const bad={...f.project.authoring.basis,entityKind:'genes-sequences' as const};assert.equal(semanticCapabilities(f.project.authoring.root,'taxonomy',null,bad).available,false);
});
test('known, explicitly unranked and unknown ranks remain distinct; absent ranks create no taxa',async()=>{
  const f=await fixture(),spec=structuredClone(f.spec);delete spec.ranks.n000001;spec.ranks.n000004=null;const levels=classificationLevels(f.source,spec);
  assert.deepEqual(classificationRank(spec,'n000001'),{status:'unknown',rank:null});assert.deepEqual(classificationRank(spec,'n000004'),{status:'unranked',rank:null});assert.deepEqual(classificationRank(spec,'n000002'),{status:'ranked',rank:'unit'});
  assert.ok(levels.n000001>levels.n000000&&levels.n000001<levels.n000002);assert.equal(Object.keys(levels).length,f.source.order.length);assert.equal(f.graph.order.length,f.source.order.length);
});
test('rank interpolation keeps all-source levels stable through selection, collapse and unary-path suppression',async()=>{
  const f=await fixture('circular');for(const p of [{...projection,selection:{kind:'explicit-tips' as const,tipIds:['n000002','n000005']}},{...projection,collapse:['n000001']}]){
    const g=projectClassification(f.source,p),m=estimatedMeasurements(g,f.settings),scene=layoutClassification(f.source,g,f.settings,m,f.spec);assert.deepEqual(scene.classification!.levels,f.view.scene.classification!.levels);assert.equal(validateClassificationScene(f.source,g,scene).incidencePassed,true);
    if(p.collapse.length)assert.equal(scene.junctionGlyphs.find(x=>x.nodeId==='n000001')!.depth,.5);else assert.deepEqual(g.edges['display-edge-n000002'].sourcePath,['n000000','n000001','n000002']);
  }
});
test('conflicting parent-child ranks, foreign nodes, unknown policy names and forged authority/source are rejected',async()=>{
  const f=await fixture();for(const mutate of [(s:ClassificationSpec)=>s.ranks.n000001='unit',(s:ClassificationSpec)=>s.ranks.n000002='division',(s:ClassificationSpec)=>s.ranks.foreign='unit',(s:ClassificationSpec)=>s.ranks.constructor='unit',(s:ClassificationSpec)=>s.ranks.n000002='species',(s:ClassificationSpec)=>s.rankOrder.push('group'),(s:ClassificationSpec)=>s.sourceSha256='0'.repeat(64)]){const bad=structuredClone(f.spec);mutate(bad);assert.throws(()=>classificationLevels(f.source,bad));}
  const wrong=structuredClone(f.spec);wrong.authority='Other framework';assert.throws(()=>validateClassificationSpec(wrong,f.source,f.project.authoring.basis),/match/);
  const unversioned={...f.project.authoring.basis,release:null};assert.throws(()=>makeClassificationView({...f.project,authoring:{...f.project.authoring,basis:unversioned}},f.source,projection,f.settings,f.metrics,f.spec,'bad','Bad'),/release/);
});
test('classification ignores missing/negative source distances and handles root-only and unknown chains without rank invention',async()=>{
  for(const text of ['(A:-3,B);','(((A)X)Y)Top;','A;']){const source=await parseNewick(text),spec={...(await fixture()).spec,sourceSha256:source.sha256,ranks:{}},g=projectClassification(source,projection),m=estimatedMeasurements(g,DEFAULT_STRUCTURED),scene=layoutClassification(source,g,DEFAULT_STRUCTURED,m,spec);assert.equal(validateClassificationScene(source,g,scene).incidencePassed,true);assert.equal(Object.keys(scene.classification!.levels).length,source.order.length);assert.ok(source.order.every(id=>classificationRank(spec,id).status==='unknown'));for(const edge of Object.values(g.edges))assert.ok(scene.classification!.levels[edge.child]>scene.classification!.levels[edge.parent]);}
});
test('classification depth is locked; transverse/label edits and hard pins preserve declared levels',async()=>{
  const f=await fixture();assert.throws(()=>layoutClassification(f.source,f.graph,f.settings,f.metrics,f.spec,{n000001:{depth:.1,shift:0}}),/fixed/);
  const v=makeClassificationView(f.project,f.source,projection,f.settings,f.metrics,f.spec,f.view.id,f.view.name,undefined,{n000001:{depth:0,shift:.5}},{n000002:{x:2,y:1}});assert.deepEqual(v.scene.classification,f.view.scene.classification);assert.equal(v.qa.incidencePassed,true);const pinned=structuredClone(f.view);pinned.pinnedNodes=['n000001'];assert.throws(()=>checkStructuredPins(pinned,v),/Pinned/);
});
test('classification V4 schema/save/reopen/undo retain exact source and reject forged coordinates, policy and profile',async()=>{
  const f=await fixture('fan'),saved=commit(f),schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(documentFromWorking(saved),schema,schema),true);assert.deepEqual((await loadAnyProject(serializeProject(saved))).project.authoring.structuredViews,saved.authoring.structuredViews);
  const history=new History<typeof saved>();history.push(f.project);assert.equal(serializeProject(history.undo(saved)!),serializeProject(f.project));assert.equal(serializeProject(history.redo(f.project)!),serializeProject(saved));
  for(const mutate of [(v:typeof f.view)=>v.scene.classification!.levels.n000002=.9,(v:typeof f.view)=>v.scene.classification!.spec.ranks.n000002='group',(v:typeof f.view)=>v.scene.ports[0].point.x+=3,(v:typeof f.view)=>delete v.scene.classification,(v:typeof f.view)=>v.intent='cladogram']){const bad=structuredClone(f.view);mutate(bad);bad.scene.revision=sceneRevision(bad.scene);assert.throws(()=>validateStructuredView(bad,saved,f.source));}
});
test('authority/basis edits invalidate classification views without erasing their source records or geometry',async()=>{
  const f=await fixture(),saved=commit(f),changed=acceptBasisEdit(saved,{...saved.authoring.basis,release:'Changed framework version'},f.source);assert.equal(isStructuredStale(changed,f.view),true);assert.deepEqual(changed.authoring.structuredViews![f.view.id],f.view);await loadAnyProject(serializeProject(changed));assert.throws(()=>exportStructuredFiles(f.source,changed),/stale/);
});
test('classification exports pair identical artwork, parent paths, complete rank states, evidence and honest captions',async()=>{
  const f=await fixture('circular'),saved=commit(f),files=exportStructuredFiles(f.source,saved),group=(s:string)=>s.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];assert.equal(group(files['tree_unlabeled.svg']),group(files['tree_labeled.svg']));assert.match(files['tree-caption.txt'],/membership, not evolutionary ancestry/);assert.match(files['tree-caption.txt'],/No biological root is used/);assert.doesNotMatch(files['tree-caption.txt'],/one ancestor|Rooted .*phylogram|Nonmetric .*cladogram/);assert.match(files['sources-and-methods.html'],/classification-rank-layout/);assert.match(files['references.txt'],/NCBI/);assert.equal(JSON.parse(files['tree_provenance.json']).interpretation,'taxonomy');assert.equal(JSON.parse(files['classification_ranks.json']).records.length,8);assert.equal(files['metric_distances.json'],undefined);assert.equal(files['source_tree.nwk'],f.source.text);assert.match(files['classification_legend.html'],/division/);
  for(const f of JSON.parse(files['artifact_manifest.json']).files)assert.equal(createHash('sha256').update(files[f.path]).digest('hex'),f.sha256);
});
test('classification artistic copies preserve parent links and origin evidence without claiming rank placement or ancestors',async()=>{
  const f=await fixture('circular'),saved=commit(f),copy=makeArtisticCopy(f.view,'classification-art','Artistic classification');assert.equal(copy.scene.classification,undefined);assert.deepEqual(copy.scene.junctionGlyphs,f.view.scene.junctionGlyphs);const moved=applyArtisticEdit(copy,{kind:'move-junction',nodeIds:['n000001'],delta:{x:7,y:2}}),p=structuredClone(saved);p.authoring.structuredViews![copy.id]=moved;p.authoring.activeStructuredViewId=copy.id;
  const accepted=acceptCommand(saved,p,f.source,{methods:['classification-artistic-copy','compound-artistic-edit','compound-validation'],inputs:[`structured/${f.view.id}`]});await loadAnyProject(serializeProject(accepted));const files=exportStructuredFiles(f.source,accepted);assert.match(files['tree-caption.txt'],/active rank positioning removed/);assert.doesNotMatch(files['tree-caption.txt'],/one ancestor/);assert.equal(JSON.parse(files['classification_ranks.json']).originOnly,true);assert.deepEqual(accepted.authoring.structuredViews![f.view.id],f.view);
});
