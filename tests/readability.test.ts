import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient } from '../src/science.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, layoutCluster } from '../src/structured/layout.ts';
import { improveReadability, locateIssue } from '../src/structured/readability.ts';
import { validateScene } from '../src/structured/validate.ts';
import { sampleTree } from '../src/structured/example.ts';
import { makeStructuredView, checkStructuredPins } from '../src/structured/view.ts';
import { acceptCommand } from '../src/commands.ts';
import { serializeProject, loadAnyProject } from '../src/project-v2.ts';
import { activeProvenance } from '../src/export-provenance.ts';
import type { StructuredSettings } from '../src/structured/types.ts';
const projection = {selection:{kind:'all' as const},collapse:[],expand:[],reveal:[],childOrder:{}};
async function dense(kind: StructuredSettings['kind']='circular',count=80) {
  const source=await parseNewick('('+Array.from({length:count},(_,i)=>`'Long organism label ${i}':1`).join(',')+');');
  const graph=projectTree(source,orient(source,defaultRecipe(source).root),projection);
  const settings={...DEFAULT_STRUCTURED,kind,widthMm:120,heightMm:120,outerRadiusMm:20,sweepDeg:kind==='fan'?240:360};
  const metrics=estimatedMeasurements(graph,settings); metrics.fontStatus='available';
  return {graph,settings,metrics};
}
test('readability search reduces dense circular conflicts without changing labels, font, topology or caller inputs',async()=>{
  const f=await dense(),snapshot=JSON.stringify(f),before=validateScene(f.graph,layoutCluster(f.graph,f.settings,f.metrics));
  const result=improveReadability(f.graph,f.settings,f.metrics,'grow-page');
  assert.ok(result.readability.improved);assert.ok(result.qa.labelCollisions<before.labelCollisions);
  assert.ok(result.readability.candidates<=8);assert.equal(result.scene.settings.fontSizePt,10);
  assert.equal(result.scene.measurements.fontStatus,'available');assert.equal(JSON.stringify(f),snapshot);
  assert.deepEqual(result.scene.labels.map(l=>l.text),f.graph.endpoints.map(id=>f.graph.nodes[id].label));
  assert.equal(result.qa.coveragePassed,true);assert.equal(result.qa.incidencePassed,true);
  assert.ok(result.scene.settings.widthMm>=120&&result.scene.settings.heightMm>=120);
});
test('fixed-page search keeps exact page dimensions and reports unresolved conflicts honestly',async()=>{
  const f=await dense('fan'),r=improveReadability(f.graph,f.settings,f.metrics,'keep-page');
  assert.equal(r.scene.settings.widthMm,120);assert.equal(r.scene.settings.heightMm,120);
  assert.equal(r.scene.settings.fontSizePt,10);assert.ok(r.qa.status==='draft');
  const overflow=(s:typeof r.scene)=>Math.max(0,12-s.bounds.minX)+Math.max(0,12-s.bounds.minY)+Math.max(0,s.bounds.maxX-108)+Math.max(0,s.bounds.maxY-108);
  assert.ok(overflow(r.scene)<=overflow(layoutCluster(f.graph,f.settings,f.metrics))+1e-7);
  assert.ok(r.readability.candidates<=8);assert.ok(r.scene.bounds.minX<12||r.qa.labelCollisions>0||!r.qa.clearancePassed||r.scene.bounds.maxX>108);
  assert.throws(()=>improveReadability(f.graph,f.settings,f.metrics,'unknown' as never),/policy/);
});
test('rectangular search grows a page for all terminal rows; rotations stay bounded and estimated fonts stay draft',async()=>{
  const f=await dense('rectangular',50);f.metrics.fontStatus='estimated';
  const r=improveReadability(f.graph,f.settings,f.metrics,'grow-page');
  assert.ok(r.scene.settings.heightMm>120);assert.equal(r.qa.labelCollisions,0);assert.equal(r.qa.status,'draft');
  assert.ok(r.scene.bounds.maxY<r.scene.settings.heightMm);assert.equal(r.scene.settings.fontSizePt,10);
  const rotated=improveReadability(f.graph,{...f.settings,orientationDeg:90},f.metrics,'grow-page');
  assert.ok(rotated.scene.settings.widthMm<=2000&&rotated.scene.settings.heightMm<=2000);assert.equal(rotated.qa.incidencePassed,true);
});
test('already readable scenes remain exact; manual offsets survive and conflicting pins reject acceptance',async()=>{
  const f=await sampleTree(),graph=projectTree(f.source,f.rooted,projection),settings={...DEFAULT_STRUCTURED,kind:'circular' as const};
  const metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const clean=layoutCluster(graph,settings,metrics),same=improveReadability(graph,settings,metrics,'grow-page');
  assert.equal(same.scene.revision,clean.revision);assert.equal(same.readability.improved,false);
  const offsets={n000001:{depth:.02,shift:0}},labels={n000002:{x:1,y:2}};
  const r=improveReadability(graph,{...settings,outerRadiusMm:10},metrics,'grow-page',offsets,labels);
  assert.deepEqual(r.scene.nodeOffsets,offsets);assert.deepEqual(r.scene.labelOffsets,labels);
  const old=makeStructuredView(f.project,f.source,projection,settings,metrics,'structured-1','Original');old.pinnedNodes=['n000001'];
  assert.throws(()=>checkStructuredPins(old,{...old,scene:r.scene,qa:r.qa}),/Pinned/);
});
test('problem identities select biological owners and include the full rotated label focus box',async()=>{
  const f=await dense(),scene=layoutCluster(f.graph,f.settings,f.metrics),qa=validateScene(f.graph,scene),issue=qa.issues.find(i=>i.type==='labels')!;
  assert.ok(issue);const located=locateIssue(scene,issue.ids);assert.ok(located.nodeIds.length>0);
  for(const label of scene.labels.filter(l=>issue.ids.includes(l.id)))for(const p of label.corners)assert.ok(p.x>=located.bounds.minX&&p.x<=located.bounds.maxX&&p.y>=located.bounds.minY&&p.y<=located.bounds.maxY);
  assert.deepEqual(locateIssue(scene,[]).bounds,scene.bounds);
  const stem=scene.edgeStems[0];assert.ok(locateIssue(scene,[stem.id]).nodeIds.includes(f.graph.nodes[scene.ports.find(p=>p.id===stem.childPortId)!.nodeId].id));
});
test('accepted readability is an explicit method with exact final settings; V4 scenes and legacy methods still reopen',async()=>{
  const f=await sampleTree(),graph=projectTree(f.source,f.rooted,projection),settings={...DEFAULT_STRUCTURED,kind:'circular' as const,outerRadiusMm:10};
  const metrics=estimatedMeasurements(graph,settings),r=improveReadability(graph,settings,metrics,'grow-page');
  const view=makeStructuredView(f.project,f.source,projection,r.scene.settings,metrics,'structured-readable','Sample');
  const next=structuredClone(f.project);next.authoring.structuredViews={[view.id]:view};next.authoring.activeStructuredViewId=view.id;
  const saved=acceptCommand(f.project,next,f.source,{methods:['selected-taxon-projection','clade-cluster','compound-validation','readability-assist'],replace:true,parameters:{readability:r.readability,settings:r.scene.settings}});
  const reopened=await loadAnyProject(serializeProject(saved));assert.deepEqual(reopened.project.authoring.structuredViews,saved.authoring.structuredViews);
  assert.ok(activeProvenance(saved).methods['readability-assist@3.0.0']);
  // The fixture's old contribution definitions must not be reinterpreted by adding a method.
  await loadAnyProject(await readFile('tests/fixtures/structured-v3.json','utf8'));
});
