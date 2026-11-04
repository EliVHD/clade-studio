import { schemaValid } from './schema-check.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe,orient,reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION,generateLayout } from '../src/geometry.ts';
import { startAuthoring,serializeProject,loadAnyProject,documentFromWorking,treeRevision } from '../src/project-v2.ts';
import { acceptCommand,isCurrentResult,acceptBasisEdit } from '../src/commands.ts';
import { History } from '../src/project.ts';
import { projectTree,sourceMRCA } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED,estimatedMeasurements,layoutCluster,sceneRevision,primitivePoints } from '../src/structured/layout.ts';
import { makeStructuredView,validateStructuredView,structuredInputRevision,checkStructuredPins,isStructuredStale,effectiveViewId } from '../src/structured/view.ts';
import { validateScene } from '../src/structured/validate.ts';
import { sceneArtwork,sceneAnnotations,hitScene,primitivePath,highlightedNodes } from '../src/structured/render.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { activeProvenance,provenanceFiles } from '../src/export-provenance.ts';
import type { Project } from '../src/types.ts';
import type { ProjectionSpec,StructuredSettings,StructuredView } from '../src/structured/types.ts';
import type { WorkingProject } from '../src/model/document.ts';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function fixture(text='((A:1,B:2):3,(C:1,D:1,E:1):2);'){
  const source=await parseNewick(text),recipe=defaultRecipe(source);recipe.globalThreshold=0;recipe.root.status='declared_assumption';
  const rooted=orient(source,recipe.root),reduction=reduce(source,rooted,recipe);recipe.resolvedFrontierSourceNodeIds=reduction.frontier.map(e=>e.id);
  const legacy:Project={format:'phylogenetic-tree-studio',version:1,appVersion:'0.1.0',title:'Hypothetical teaching example',sourceText:text,sourceSha256:source.sha256,provenance:{hypothetical:true},recipe,corrections:[],layout:generateLayout(rooted,reduction,DEFAULT_PRESENTATION,'organic'),presentation:structuredClone(DEFAULT_PRESENTATION)};
  let project=startAuthoring(legacy,source,null,'new',['newick-parser','maximal-frontier','organic-initializer']);
  project=acceptBasisEdit(project,{...project.authoring.basis,name:'Hypothetical topology',question:'Demonstrate source clades',relationshipKind:'phylogeny',entityKind:'taxon-concepts',edgeMeaning:'Hypothetical ancestry',evidenceBasis:'Invented topology for testing, no empirical evidence',epistemicStatus:'teaching-example'},source);
  const projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
  const tip=(name:string)=>source.tips.find(id=>source.nodes[id].label===name)!;
  return {source,rooted,recipe,reduction,legacy,project,projection,tip};
}
async function viewFixture(kind:StructuredSettings['kind']='circular'){
  const f=await fixture(),settings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360},graph=projectTree(f.source,f.rooted,f.projection),metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const view=makeStructuredView(f.project,f.source,f.projection,settings,metrics,'structured-1','Synthetic '+kind);
  return {...f,view,settings,metrics,graph};
}
function commitView(project:WorkingProject,view:StructuredView,source:Awaited<ReturnType<typeof fixture>>['source']){
  const next=structuredClone(project);next.authoring.structuredViews??={};next.authoring.structuredViews[view.id]=view;next.authoring.activeStructuredViewId=view.id;
  return acceptCommand(project,next,source,{methods:['selected-taxon-projection','clade-cluster','compound-validation'],replace:true});
}
test('T01/T06: rectangular, circle and fan preserve rooted clades, polytomy and one connector per ancestor',async()=>{
  const f=await fixture(),mrca=sourceMRCA(f.rooted,[f.tip('C'),f.tip('E')]);
  for(const kind of ['rectangular','circular','fan'] as const){const settings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360},graph=projectTree(f.source,f.rooted,f.projection),metrics=estimatedMeasurements(graph,settings),scene=layoutCluster(graph,settings,metrics);
    assert.equal(graph.nodes[mrca].children.length,3);assert.equal(scene.junctionGlyphs.length,graph.order.length);assert.equal(scene.edgeStems.length,graph.order.length-1);assert.equal(scene.ports.length,(graph.order.length-1)*2);assert.equal(validateScene(graph,scene).incidencePassed,true);
    const glyph=scene.junctionGlyphs.find(g=>g.nodeId===mrca)!;assert.equal(scene.junctionGlyphs.filter(g=>g.nodeId===mrca).length,1);assert.equal(hitScene(scene,glyph.anchor,.01),mrca);
    assert.equal(sourceMRCA(f.rooted,[f.tip('C'),f.tip('E')]),mrca);assert.equal(f.source.text,f.legacy.sourceText);
  }
});
test('T02/T03: projection retains root/stem, exact partitions, ordered suppressed paths and single-tip views',async()=>{
  const f=await fixture(),projection={...f.projection,selection:{kind:'explicit-tips' as const,tipIds:[f.tip('A'),f.tip('C'),f.tip('E')]}};
  const graph=projectTree(f.source,f.rooted,projection);assert.equal(graph.representedTips.length,3);assert.equal(graph.omittedTips.length,2);assert.equal(graph.rootId,f.rooted.rootId);
  const edge=graph.edges[`display-edge-${f.tip('A')}`];assert.equal(edge.length,4);assert.deepEqual(edge.sourcePath,[f.rooted.rootId,'n000001',f.tip('A')]);assert.equal(edge.sourceEdgeIds.length,2);
  const single=projectTree(f.source,f.rooted,{...projection,selection:{kind:'explicit-tips',tipIds:[f.tip('A')]}});assert.equal(single.nodes[single.rootId].children.length,1);assert.equal(single.order.length,2);assert.equal(single.edges[`display-edge-${f.tip('A')}`].length,4);
  for(const kind of ['rectangular','circular','fan'] as const){const s={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?180:360},scene=layoutCluster(single,s,estimatedMeasurements(single,s));assert.equal(scene.edgeStems.length,1);assert.ok(primitivePoints(scene.edgeStems[0].geometry).length===2);assert.ok(validateScene(single,scene).incidencePassed);}
  assert.throws(()=>projectTree(f.source,f.rooted,{...projection,selection:{kind:'explicit-tips',tipIds:[]}}),/at least one/);
  assert.throws(()=>projectTree(f.source,f.rooted,{...projection,selection:{kind:'explicit-tips',tipIds:['unknown']}}),/identities/);
});
test('T04: annotations and numeric labels survive, duplicate labels retain IDs and unknown path length stays unknown',async()=>{
  const f=await fixture('((A:1,A:2)98[&support=x]:3,(B,C:1):2);'),ids=[f.source.tips[0],f.tip('B')],graph=projectTree(f.source,f.rooted,{...f.projection,selection:{kind:'explicit-tips',tipIds:ids}});
  assert.equal(graph.nodes.n000001.label,'98');assert.ok(graph.nodes.n000001);assert.equal(graph.edges[`display-edge-${f.tip('B')}`].length,null);
  assert.equal(f.source.nodes.n000001.annotations[0].text,'&support=x');assert.notEqual(f.source.tips[0],f.source.tips[1]);
});
test('explicit collapse uses selected/original/omitted memberships and never invokes selected-tip thresholds',async()=>{
  const f=await fixture(),projection={...f.projection,selection:{kind:'explicit-tips' as const,tipIds:[f.tip('A'),f.tip('C')]},collapse:['n000001']},graph=projectTree(f.source,f.rooted,projection);
  assert.equal(graph.nodes.n000001.aggregate,true);assert.equal(graph.nodes.n000001.selectedMembers.length,1);assert.equal(graph.nodes.n000001.originalMembers.length,2);assert.equal(graph.nodes.n000001.omittedMembers.length,1);assert.ok(graph.nodes.n000001.label.includes('Source clade'));
  assert.throws(()=>projectTree(f.source,f.rooted,{...projection,reveal:['n000001']}),/protected/);assert.throws(()=>projectTree(f.source,f.rooted,{...projection,collapse:[f.rooted.rootId]}),/root/);
});
test('T05: circular seam slots differ, arcs remain open, labels stay upright, and long labels produce review issues',async()=>{
  const f=await fixture('('+Array.from({length:36},(_,i)=>`'Long terminal label number ${i}':1`).join(',')+');'),graph=projectTree(f.source,f.rooted,f.projection),s={...DEFAULT_STRUCTURED,kind:'circular' as const,startAngleDeg:350,innerRadiusMm:0,outerRadiusMm:25,widthMm:100,heightMm:100},scene=layoutCluster(graph,s,estimatedMeasurements(graph,s));
  assert.ok(scene.slotPasses<=8);const first=scene.junctionGlyphs.find(g=>g.nodeId===graph.endpoints[0])!,last=scene.junctionGlyphs.find(g=>g.nodeId===graph.endpoints.at(-1))!;assert.ok(Math.hypot(first.anchor.x-last.anchor.x,first.anchor.y-last.anchor.y)>0);
  for(const g of scene.junctionGlyphs)if(g.geometry.kind==='arc')assert.ok(g.geometry.endDeg-g.geometry.startDeg<360);
  for(const label of scene.labels){const a=((label.rotationDeg%360)+360)%360;assert.ok(a<=90+1e-8||a>=270-1e-8);}
  const qa=validateScene(graph,scene);assert.equal(qa.status,'draft');assert.ok(qa.labelCollisions>0||qa.issues.some(i=>i.type==='bounds'));assert.equal(scene.settings.fontSizePt,10);
});
test('T07: unrelated stem/connector contact is detected, and straight connectors create no biological nodes',async()=>{
  const f=await viewFixture(),curved=f.view.scene,straight=layoutCluster(f.graph,{...f.settings,curves:false},f.metrics);
  assert.equal(straight.junctionGlyphs.length,curved.junctionGlyphs.length);assert.equal(straight.edgeStems.length,curved.edgeStems.length);assert.ok(straight.junctionGlyphs.every(g=>g.geometry.kind!=='arc'));assert.ok(!sceneArtwork(straight).includes(' A'));
  const bad=structuredClone(curved),glyph=bad.junctionGlyphs.find(g=>g.nodeId==='n000001')!,stem=bad.edgeStems.find(e=>e.edgeId===`display-edge-${f.tip('D')}`)!;
  stem.geometry={kind:'polyline',points:[{x:glyph.anchor.x-5,y:glyph.anchor.y},glyph.anchor,{x:glyph.anchor.x+5,y:glyph.anchor.y}]};bad.revision=sceneRevision(bad);
  const qa=validateScene(f.graph,bad);assert.equal(qa.incidencePassed,false);assert.equal(qa.crossingPassed,false);assert.ok(qa.issues.some(i=>i.type==='contact'));
});
test('T08: whole child permutations are safe; pin conflicts and out-of-sector/level adjustments are rejected',async()=>{
  const f=await viewFixture(),projection=structuredClone(f.projection);projection.childOrder[f.rooted.rootId]=[...f.rooted.nodes[f.rooted.rootId].children].reverse();
  const graph=projectTree(f.source,f.rooted,projection),metrics=estimatedMeasurements(graph,f.settings),rotated=makeStructuredView(f.project,f.source,projection,f.settings,metrics,'structured-1','rotated');
  const pinned=structuredClone(f.view);pinned.pinnedNodes=[f.tip('A')];assert.throws(()=>checkStructuredPins(pinned,rotated),/Pinned/);
  assert.throws(()=>projectTree(f.source,f.rooted,{...f.projection,childOrder:{[f.rooted.rootId]:[f.tip('A'),f.tip('C')]}}),/permutations/);
  assert.throws(()=>layoutCluster(f.graph,f.settings,f.metrics,{'n000001':{depth:1,shift:0}}),/level/);
  assert.throws(()=>layoutCluster(f.graph,f.settings,f.metrics,{'n000001':{depth:0,shift:360}}),/sector/);
  const adjusted=layoutCluster(f.graph,f.settings,f.metrics,{'n000001':{depth:.05,shift:0}});assert.notDeepEqual(adjusted.junctionGlyphs.find(g=>g.nodeId==='n000001')!.anchor,f.view.scene.junctionGlyphs.find(g=>g.nodeId==='n000001')!.anchor);assert.ok(validateScene(f.graph,adjusted).incidencePassed);
});
test('root-only tree is a finite single marker with nearby label, and invalid settings/metrics fail',async()=>{
  const f=await fixture('A;'),graph=projectTree(f.source,f.rooted,f.projection),s={...DEFAULT_STRUCTURED,kind:'circular' as const},metrics=estimatedMeasurements(graph,s),scene=layoutCluster(graph,s,metrics);
  assert.equal(scene.edgeStems.length,0);assert.equal(scene.junctionGlyphs.length,1);assert.ok(Math.hypot(scene.labels[0].position.x-scene.junctionGlyphs[0].anchor.x,scene.labels[0].position.y-scene.junctionGlyphs[0].anchor.y)<10);
  for(const changes of [{innerRadiusMm:1000},{sweepDeg:0},{fontSizePt:NaN},{marginMm:200},{kind:'fan',sweepDeg:360}])assert.throws(()=>layoutCluster(graph,{...s,...changes} as StructuredSettings,metrics));
  assert.throws(()=>layoutCluster(graph,s,{...metrics,fontSizePt:20}),/measurements/);
});
test('T11/T14/T15: accepted views preserve old artwork, save/reopen exact scenes, undo and reject stale replies',async()=>{
  const f=await viewFixture(),before=serializeProject(f.project),history=new History<WorkingProject>(),committed=commitView(f.project,f.view,f.source);history.push(f.project);
  assert.deepEqual(committed.layout,f.project.layout);assert.equal(serializeProject(f.project),before);assert.equal(effectiveViewId(committed),f.view.id);
  const loaded=await loadAnyProject(serializeProject(committed));assert.deepEqual(loaded.project.authoring.structuredViews,committed.authoring.structuredViews);assert.equal(documentFromWorking(committed).version,4);
  const base=treeRevision(documentFromWorking(f.project));assert.equal(isCurrentResult(committed,base,f.project.authoring.activeViewId),false);assert.equal(isCurrentResult(committed,treeRevision(documentFromWorking(committed)),f.view.id),true);
  const undone=history.undo(committed)!;assert.equal(serializeProject(undone),before);assert.deepEqual(history.redo(undone),committed);
  const basis={...committed.authoring.basis,limitations:'New interpretation caveat'},changed=acceptBasisEdit(committed,basis,f.source);assert.equal(isStructuredStale(changed,f.view),true);await loadAnyProject(serializeProject(changed));assert.throws(()=>exportStructuredFiles(f.source,changed),/stale/);
});
test('structured snapshots replay independently after root/correction changes; corrupt stale scenes cannot bypass checks',async()=>{
  const f=await viewFixture(),committed=commitView(f.project,f.view,f.source),changed=structuredClone(committed);changed.corrections=[{source_node_id:f.tip('A'),raw_label:'A',status:'user supplied',display_taxonomy:'Alternate display label',evidence_url:null,review_date:'2026-10-28'}];
  const accepted=acceptCommand(committed,changed,f.source);assert.equal(isStructuredStale(accepted,f.view),true);await loadAnyProject(serializeProject(accepted));
  const bad=structuredClone(accepted);bad.authoring.structuredViews![f.view.id].scene.junctionGlyphs[0].anchor.x+=10;assert.throws(()=>validateStructuredView(bad.authoring.structuredViews![f.view.id],bad,f.source));
});
test('paired structured exports share artwork and complete source paths, sampling, references and hashes',async()=>{
  const f=await viewFixture(),p=commitView(f.project,f.view,f.source),files=exportStructuredFiles(f.source,p),manifest=JSON.parse(files['artifact_manifest.json']);
  const group=(s:string)=>s.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];assert.equal(group(files['tree_labeled.svg']),group(files['tree_unlabeled.svg']));assert.equal(files['source_tree.nwk'],f.source.text);
  assert.deepEqual(JSON.parse(files['display_graph.json']),f.graph);assert.ok(files['tree-caption.txt'].includes('Nonmetric circular'));assert.ok(files['references.txt'].includes('Drawing Phylogenetic Trees'));assert.ok(files['references.txt'].includes('D3 hierarchy'));
  for(const entry of manifest.files){assert.equal(hash(files[entry.path]),entry.sha256);assert.equal(Buffer.byteLength(files[entry.path]),entry.bytes);}
  assert.equal(manifest.activeViewId,f.view.id);assert.equal(JSON.parse(files['tree_provenance.json']).activeViewId,f.view.id);assert.ok(Object.keys(activeProvenance(p).methods).includes('clade-cluster@1.0.0'));
  assert.deepEqual((await loadAnyProject(files['tree.treeproject.json'])).project.authoring.structuredViews,p.authoring.structuredViews);
  assert.ok(provenanceFiles(p)['sources-and-methods.html'].includes('Junction')||provenanceFiles(p)['sources-and-methods.html'].includes('Concentric'));
});
test('V3 migration adds only an empty structured envelope and retains every contributing operation/head',async()=>{
  const text=await readFile('tests/fixtures/structured-v3.json','utf8'),old=JSON.parse(text),loaded=await loadAnyProject(text),doc=documentFromWorking(loaded.project);assert.equal(old.version,3);assert.equal(loaded.migrated,true);assert.equal(doc.version,4);assert.deepEqual(doc.structuredViews,{});assert.deepEqual(doc.views,old.views);assert.deepEqual(doc.provenance,old.provenance);
  const reopened=await loadAnyProject(serializeProject(loaded.project));assert.equal(reopened.migrated,false);assert.deepEqual(reopened.project.authoring.structuredViews,{});
});
test('T16: hostile labels are escaped; forged projections, ports, snapshots, geometry and QA are rejected atomically',async()=>{
  const f=await fixture("('<script>bad</script>':1,B:1);"),s={...DEFAULT_STRUCTURED,kind:'circular' as const},graph=projectTree(f.source,f.rooted,f.projection),m=estimatedMeasurements(graph,s),view=makeStructuredView(f.project,f.source,f.projection,s,m,'structured-1','test'),p=commitView(f.project,view,f.source);
  assert.ok(!sceneAnnotations(view.scene).includes('<script>'));assert.ok(sceneAnnotations(view.scene).includes('&lt;script&gt;'));
  for(const change of [(v:StructuredView)=>v.graph.omittedTips.push(v.graph.representedTips[0]),(v:StructuredView)=>v.scene.ports[0].point.x+=10,(v:StructuredView)=>v.input.root.status='unrooted',(v:StructuredView)=>v.qa.status='checked',(v:StructuredView)=>v.scene.labels[0].text='forged']){const candidate=structuredClone(p);change(candidate.authoring.structuredViews![view.id]);assert.throws(()=>acceptCommand(p,candidate,f.source));}
  assert.ok(primitivePath({kind:'arc',center:{x:0,y:0},radius:10,startDeg:350,endDeg:600}).includes(' 1 1 '));assert.equal(structuredInputRevision(p),view.inputRevision);
});

test('clade highlights include descendants only, including partial sampling, and hypothetical examples state their evidence/rights',async()=>{
  const f=await fixture(),projection={...f.projection,selection:{kind:'explicit-tips' as const,tipIds:[f.tip('C'),f.tip('E')]},reveal:['n000004']},graph=projectTree(f.source,f.rooted,projection),highlighted=highlightedNodes(graph,['n000004']);
  assert.ok(!highlighted.includes(graph.rootId));assert.deepEqual(new Set(highlighted),new Set(['n000004',f.tip('C'),f.tip('E')]));
  const {sampleTree}=await import('../src/structured/example.ts');const example=await sampleTree();assert.equal(example.project.authoring.root.status,'rooted');assert.equal(example.project.authoring.basis.epistemicStatus,'teaching-example');assert.equal(example.project.provenance.license,'0BSD');assert.equal(example.project.provenance.empiricalEvidence,false);assert.ok(provenanceFiles(example.project)['sources-and-methods.html'].includes('Synthetic sample tree'));
});

test('V4 schema covers structured scenes, optional measured ink bearings and label adjustments',async()=>{
  const f=await viewFixture(),metrics=structuredClone(f.metrics),id=f.tip('A');metrics.metrics[id]={...metrics.metrics[id],advanceMm:2,leftMm:-.4,rightMm:2.2};
  const offsets={[id]:{x:2,y:-1}},scene=layoutCluster(f.graph,f.settings,metrics,{},offsets),base=layoutCluster(f.graph,f.settings,metrics);
  const a=scene.labels.find(l=>l.nodeId===id)!,b=base.labels.find(l=>l.nodeId===id)!;assert.equal(a.position.x-b.position.x,2);assert.equal(a.position.y-b.position.y,-1);assert.deepEqual(scene.edgeStems,base.edgeStems);assert.deepEqual(scene.junctionGlyphs,base.junctionGlyphs);
  const view={...f.view,scene,qa:validateScene(f.graph,scene)},p=commitView(f.project,view,f.source),doc=documentFromWorking(p),schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(doc,schema,schema),true);
  assert.equal(schemaValid({...doc,structuredViews:{'wrong':{...view,unexpected:true}}},schema,schema),false);
  await loadAnyProject(serializeProject(p));
  assert.throws(()=>layoutCluster(f.graph,f.settings,metrics,{}, {'unknown':{x:0,y:0}}),/Label offsets/);
});
test('dense layouts disclose validation work limits instead of asserting an all-clear',async()=>{
  const f=await fixture('('+Array.from({length:600},(_,i)=>`X${i}:1`).join(',')+');'),graph=projectTree(f.source,f.rooted,f.projection),s={...DEFAULT_STRUCTURED,kind:'circular' as const,innerRadiusMm:0,outerRadiusMm:1,strokeMm:2},scene=layoutCluster(graph,s,estimatedMeasurements(graph,s)),qa=validateScene(graph,scene);
  assert.equal(qa.status,'draft');assert.equal(qa.limited,true);assert.ok(qa.issues.some(i=>i.type==='legibility')||qa.omittedIssueCount>0);
});
