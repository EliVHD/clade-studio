import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sampleTree } from '../src/structured/example.ts';
import { parseNewick } from '../src/newick.ts';
import { orient, defaultRecipe } from '../src/science.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, sceneRevision } from '../src/structured/layout.ts';
import { layoutMetric, validateMetricScene, validateMetricSpec, metricDistances, scaleBarText } from '../src/structured/metric.ts';
import { makeMetricView, validateStructuredView, checkStructuredPins } from '../src/structured/view.ts';
import { makeArtisticCopy, applyArtisticEdit } from '../src/structured/artistic.ts';
import { acceptCommand } from '../src/commands.ts';
import { serializeProject, loadAnyProject, documentFromWorking } from '../src/project-v2.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { activeProvenance } from '../src/export-provenance.ts';
import { semanticCapabilities } from '../src/model/semantics.ts';
import { schemaValid } from './schema-check.ts';
import type { MetricSpec, StructuredSettings, TextMeasurements, ProjectionSpec } from '../src/structured/types.ts';
const projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
const specFor=(sha:string):MetricSpec=>({measure:{meaning:'other-distance',unit:'synthetic distance units',evidence:'Invented A–E distances; no empirical measurements.',referenceIds:[],sourceSha256:sha,declaration:'user-supplied'},mmPerUnit:15,scaleBarValue:1});
function measurements(graph:ReturnType<typeof projectTree>,settings:StructuredSettings,spec:MetricSpec):TextMeasurements{
  const m=estimatedMeasurements(graph,settings),mm=settings.fontSizePt*25.4/72,text=scaleBarText(spec);m.fontStatus='available';m.scaleBar={text,widthMm:text.length*mm*.6,ascentMm:mm*.8,descentMm:mm*.2};return m;
}
async function fixture(kind:StructuredSettings['kind']='rectangular',rotation=0){
  const f=await sampleTree(),settings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360,orientationDeg:rotation},graph=projectTree(f.source,f.rooted,projection),spec=specFor(f.source.sha256),metrics=measurements(graph,settings,spec),view=makeMetricView(f.project,f.source,projection,settings,metrics,spec,'metric-1','Synthetic distances');return {...f,settings,graph,spec,metrics,view};
}
function commit(f:Awaited<ReturnType<typeof fixture>>){const proposal=structuredClone(f.project);proposal.authoring.structuredViews={[f.view.id]:f.view};proposal.authoring.activeStructuredViewId=f.view.id;return acceptCommand(f.project,proposal,f.source,{methods:['selected-taxon-projection','metric-distance-layout','metric-distance-validation','compound-validation'],replace:true,parameters:{metricSpec:f.spec}});}
const near=(a:number,b:number,epsilon=1e-7)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} differs from ${b}`);
test('T09: all rooted phylogram shapes encode A=4, B=5, C/D/E=3 at every junction and port, including rotations',async()=>{
  for(const kind of ['rectangular','circular','fan'] as const)for(const rotation of [0,67,180,300]){
    const f=await fixture(kind,rotation),scene=f.view.scene,metric=scene.metric!,center={x:f.settings.widthMm/2,y:f.settings.heightMm/2},a=rotation*Math.PI/180;
    for(const [name,d]of Object.entries({A:4,B:5,C:3,D:3,E:3})){const id=f.source.tips.find(id=>f.source.nodes[id].label===name)!;assert.equal(metric.distances[id],d);}
    const coordinate=(p:{x:number;y:number})=>kind==='rectangular'?((p.x-center.x)*Math.cos(a)+(p.y-center.y)*Math.sin(a)+center.x-f.settings.marginMm)/f.spec.mmPerUnit:(Math.hypot(p.x-center.x,p.y-center.y)-f.settings.innerRadiusMm)/f.spec.mmPerUnit;
    for(const glyph of scene.junctionGlyphs)near(coordinate(glyph.anchor),metric.distances[glyph.nodeId]);
    for(const port of scene.ports)near(coordinate(port.point),metric.distances[port.nodeId]);
    assert.equal(f.view.qa.incidencePassed,true);assert.equal(f.view.qa.coveragePassed,true);
    assert.equal(metric.scaleBar.to.x-metric.scaleBar.from.x,15);assert.match(metric.scaleBar.label,/1 synthetic distance units/);
    if(kind!=='rectangular'){const radii=scene.junctionGlyphs.filter(g=>f.graph.endpoints.includes(g.nodeId)).map(g=>Math.hypot(g.anchor.x-center.x,g.anchor.y-center.y));assert.ok(Math.max(...radii)-Math.min(...radii)>29.99);}
  }
});
test('source-path suppression, single-tip projections and collapsed clades retain actual ancestral distances',async()=>{
  const f=await fixture('fan');for(const p of [{...projection,selection:{kind:'explicit-tips' as const,tipIds:['n000002']}},{...projection,collapse:['n000001']}]){
    const graph=projectTree(f.source,f.rooted,p),scene=layoutMetric(graph,f.settings,measurements(graph,f.settings,f.spec),f.spec);assert.equal(validateMetricScene(graph,scene).incidencePassed,true);
    if(p.collapse.length){assert.equal(scene.metric!.distances.n000001,3);assert.equal(graph.nodes.n000001.selectedMembers.length,2);}else{assert.equal(scene.metric!.distances.n000002,4);assert.equal(graph.edges['display-edge-n000002'].sourcePath.length,3);}
  }
});
test('missing, negative, nonfinite and overflowing displayed lengths block metric layout; unrelated omitted paths do not',async()=>{
  for(const text of ['(A,B:1);','(A:-1,B:2);','((A:1e308):1e308,B:1);']){
    const source=await parseNewick(text),rooted=orient(source,defaultRecipe(source).root),graph=projectTree(source,rooted,projection);assert.throws(()=>metricDistances(graph),/missing|invalid|numeric/);
  }
  const f=await fixture(),graph=structuredClone(f.graph);graph.edges[Object.keys(graph.edges)[0]].length=Infinity;assert.throws(()=>metricDistances(graph),/invalid/);
  const source=await parseNewick('(A,B:2);'),rooted=orient(source,defaultRecipe(source).root),id=source.tips.find(id=>source.nodes[id].label==='B')!,subset=projectTree(source,rooted,{...projection,selection:{kind:'explicit-tips',tipIds:[id]}});assert.equal(metricDistances(subset)[id],2);
});
test('zero lengths remain coincident and draft rather than being stretched into invented distance',async()=>{
  for(const text of ['(A:0,B:0);','A;'])for(const kind of ['rectangular','circular'] as const){
    const source=await parseNewick(text),rooted=orient(source,defaultRecipe(source).root),graph=projectTree(source,rooted,projection),s={...DEFAULT_STRUCTURED,kind,innerRadiusMm:0},spec=specFor(source.sha256),scene=layoutMetric(graph,s,measurements(graph,s,spec),spec),qa=validateMetricScene(graph,scene);
    assert.ok(Object.values(scene.metric!.distances).every(d=>d===0));assert.equal(qa.incidencePassed,true);
    if(graph.order.length>1){assert.equal(qa.status,'draft');assert.ok(qa.issues.some(i=>i.detail.includes('zero-length')));for(const stem of scene.edgeStems)if(stem.geometry.kind==='polyline')assert.deepEqual(stem.geometry.points[0],stem.geometry.points.at(-1));}
  }
});
test('metric depth edits are refused, transverse/label offsets preserve distances, and pins remain hard constraints',async()=>{
  const f=await fixture();assert.throws(()=>layoutMetric(f.graph,f.settings,f.metrics,f.spec,{n000001:{depth:.01,shift:0}}),/locked/);
  const moved=makeMetricView(f.project,f.source,projection,f.settings,f.metrics,f.spec,f.view.id,f.view.name,undefined,{n000001:{depth:0,shift:.5}},{n000002:{x:1,y:2}});assert.deepEqual(moved.scene.metric!.distances,f.view.scene.metric!.distances);assert.equal(moved.qa.incidencePassed,true);assert.deepEqual(makeMetricView(f.project,f.source,projection,f.settings,f.metrics,f.spec,moved.id,moved.name,moved).scene,moved.scene);
  const pinned=structuredClone(f.view);pinned.pinnedNodes=['n000001'];assert.throws(()=>checkStructuredPins(pinned,moved),/Pinned/);
  const largerInner=layoutMetric(f.graph,{...f.settings,kind:'circular',innerRadiusMm:90,outerRadiusMm:65},f.metrics,f.spec);assert.equal(largerInner.settings.innerRadiusMm,90);assert.equal(validateMetricScene(f.graph,largerInner).incidencePassed,true);
});
test('units and evidence are explicit, source-bound, validated and never implicitly established by numbers',async()=>{
  const f=await fixture();for(const change of [(s:MetricSpec)=>s.measure.evidence='',(s:MetricSpec)=>s.measure.sourceSha256='0'.repeat(64),(s:MetricSpec)=>s.measure.declaration='curated',(s:MetricSpec)=>s.mmPerUnit=0,(s:MetricSpec)=>s.scaleBarValue=NaN,(s:MetricSpec)=>s.measure.meaning='substitutions-per-site']){const bad=structuredClone(f.spec);change(bad);assert.throws(()=>validateMetricSpec(bad,f.source.sha256));}
  const bad=structuredClone(f.spec);bad.measure.referenceIds=['unknown'];assert.throws(()=>makeMetricView(f.project,f.source,projection,f.settings,f.metrics,bad,'bad','Bad'),/citation/);
  assert.equal(semanticCapabilities(f.project.authoring.root,'phylogram',null,f.project.authoring.basis).available,false);assert.equal(semanticCapabilities(f.project.authoring.root,'phylogram',f.spec.measure,f.project.authoring.basis).quantitative,true);
  const unit=structuredClone(f.spec);unit.measure.meaning='expected-changes';unit.measure.unit='expected changes';assert.doesNotThrow(()=>validateMetricSpec(unit,f.source.sha256));
});
test('scale-guide collisions, clipping, own-label overlaps and extreme physical scales are disclosed or rejected',async()=>{
  const f=await fixture(),tooLong={...f.spec,scaleBarValue:100};const scene=layoutMetric(f.graph,f.settings,measurements(f.graph,f.settings,tooLong),tooLong);assert.ok(validateMetricScene(f.graph,scene).issues.some(i=>i.type==='bounds'));
  const huge={...f.spec,mmPerUnit:1e6};assert.throws(()=>layoutMetric(f.graph,f.settings,measurements(f.graph,f.settings,huge),huge),/100,000/);
  const s={...f.settings,fontSizePt:72,labelGapMm:0},self=layoutMetric(f.graph,s,measurements(f.graph,s,f.spec),f.spec);assert.ok(validateMetricScene(f.graph,self).issues.some(i=>i.detail.includes('own')||i.detail.includes('its guide')));
  const l=f.view.scene.metric!.scaleBar,old=f.view.scene.labels[0],hit=layoutMetric(f.graph,f.settings,f.metrics,f.spec,{}, {[old.nodeId]:{x:l.from.x+1-old.position.x,y:l.from.y-old.position.y}});assert.ok(validateMetricScene(f.graph,hit).issues.some(i=>i.detail.includes('terminal label overlaps')));
});
test('V4 metric views save/reopen under the published schema and reject forged scale, coordinates or intent',async()=>{
  const f=await fixture('circular'),saved=commit(f),schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(documentFromWorking(saved),schema,schema),true);assert.deepEqual((await loadAnyProject(serializeProject(saved))).project.authoring.structuredViews,saved.authoring.structuredViews);
  for(const change of [(v:typeof f.view)=>v.scene.metric!.distances.n000002=10,(v:typeof f.view)=>v.scene.metric!.scaleBar.to.x+=1,(v:typeof f.view)=>v.scene.junctionGlyphs[1].anchor.x+=1,(v:typeof f.view)=>delete v.scene.metric,(v:typeof f.view)=>v.intent='cladogram']){const bad=structuredClone(f.view);change(bad);bad.scene.revision=sceneRevision(bad.scene);assert.throws(()=>validateStructuredView(bad,saved,f.source));}
});
test('paired metric SVGs have identical calibrated artwork, exact rounded scale, honest captions and cited executed methods',async()=>{
  const f=await fixture('circular'),saved=commit(f),files=exportStructuredFiles(f.source,saved),group=(s:string)=>s.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];assert.equal(group(files['tree_unlabeled.svg']),group(files['tree_labeled.svg']));assert.match(group(files['tree_unlabeled.svg']),/metric-scale-guide/);assert.match(files['tree-caption.txt'],/Rooted circular phylogram/);assert.match(files['tree-caption.txt'],/8 mm inner radial gap/);assert.doesNotMatch(files['tree-caption.txt'],/Nonmetric/);assert.match(files['sources-and-methods.html'],/metric-distance-layout/);assert.match(files['references.txt'],/Emmanuel Paradis/);assert.equal(JSON.parse(files['tree_provenance.json']).interpretation,'phylogram');assert.deepEqual(JSON.parse(files['metric_distances.json']),f.view.scene.metric);assert.equal(files['source_tree.nwk'],f.source.text);
  const scale=files['tree_unlabeled.svg'].match(/id="metric-scale-guide"[^>]*d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)/)!;near(Math.hypot(Number(scale[3])-Number(scale[1]),Number(scale[4])-Number(scale[2])),15,1e-6);
  for(const entry of JSON.parse(files['artifact_manifest.json']).files)assert.equal(createHash('sha256').update(files[entry.path]).digest('hex'),entry.sha256);
  assert.ok(activeProvenance(saved).methods['metric-distance-layout@1.0.0']);assert.equal(activeProvenance(saved).methods['clade-cluster@1.0.0'],undefined);
});
test('artistic copies of phylograms preserve tree geometry and verified origin but remove calibrated scale before any movement',async()=>{
  const f=await fixture('circular'),saved=commit(f),copy=makeArtisticCopy(f.view,'artistic-from-metric','Free placement');assert.equal(copy.scene.metric,undefined);assert.deepEqual(copy.scene.junctionGlyphs,f.view.scene.junctionGlyphs);assert.deepEqual(copy.scene.ports,f.view.scene.ports);assert.deepEqual(copy.artistic!.baseScene.metric,f.view.scene.metric);
  const moved=applyArtisticEdit(copy,{kind:'move-junction',nodeIds:['n000001'],delta:{x:5,y:1}}),proposal=structuredClone(saved);proposal.authoring.structuredViews![copy.id]=moved;proposal.authoring.activeStructuredViewId=copy.id;
  const accepted=acceptCommand(saved,proposal,f.source,{methods:['metric-artistic-copy','compound-artistic-edit','compound-validation'],inputs:[`structured/${f.view.id}`]});await loadAnyProject(serializeProject(accepted));const files=exportStructuredFiles(f.source,accepted);assert.doesNotMatch(files['tree_labeled.svg'],/id="metric-scale-guide"/);assert.equal(files['metric_distances.json'],undefined);assert.match(files['tree-caption.txt'],/calibrated scale guide was removed/);assert.match(files['sources-and-methods.html'],/metric-artistic-copy/);
  const schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(documentFromWorking(accepted),schema,schema),true);
});
test('curated Hug units require the exact source, canonical evidence and attached source citation',async()=>{
  const {HUG_MEASURE_EVIDENCE}=await import('../src/structured/metric.ts'),{HUG_SHA}=await import('../src/science.ts'),{HUG_REFERENCE}=await import('../src/provenance/registry.ts');
  const source=await parseNewick(await readFile('data/source_tree.nwk','utf8'));assert.equal(source.sha256,HUG_SHA);
  const p={...projection,selection:{kind:'explicit-tips' as const,tipIds:source.tips.slice(0,3)}},graph=projectTree(source,orient(source,defaultRecipe(source).root),p),spec:MetricSpec={measure:{meaning:'substitutions-per-site',unit:'substitutions/site',evidence:HUG_MEASURE_EVIDENCE,referenceIds:[HUG_REFERENCE.id],sourceSha256:source.sha256,declaration:'curated'},mmPerUnit:100,scaleBarValue:.1};
  validateMetricSpec(spec,source.sha256);const scene=layoutMetric(graph,DEFAULT_STRUCTURED,measurements(graph,DEFAULT_STRUCTURED,spec),spec);assert.equal(validateMetricScene(graph,scene).incidencePassed,true);near(scene.metric!.scaleBar.to.x-scene.metric!.scaleBar.from.x,10);
  const bad=structuredClone(spec);bad.measure.evidence='Newick numbers imply substitutions';assert.throws(()=>validateMetricSpec(bad,source.sha256),/curated/);
});
test('edge-root fractional lengths and reversed child order change placement without changing path distances',async()=>{
  const f=await fixture('fan');
  const root={kind:'edge' as const,sourceEdge:['n000000','n000001'] as [string,string],fraction:.25,status:'declared_assumption' as const},rooted=orient(f.source,root),graph=projectTree(f.source,rooted,projection),s=f.settings,m=measurements(graph,s,f.spec),scene=layoutMetric(graph,s,m,f.spec);assert.equal(validateMetricScene(graph,scene).incidencePassed,true);
  for(const e of Object.values(graph.edges))near(scene.metric!.distances[e.child]-scene.metric!.distances[e.parent],e.length!);
  const reverse={...projection,childOrder:{[rooted.rootId]:[...rooted.nodes[rooted.rootId].children].reverse()}},g=projectTree(f.source,rooted,reverse),flipped=layoutMetric(g,s,measurements(g,s,f.spec),f.spec);assert.deepEqual(flipped.metric!.distances,scene.metric!.distances);assert.notDeepEqual(flipped.junctionGlyphs,scene.junctionGlyphs);
});
