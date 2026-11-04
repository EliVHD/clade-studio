import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleTree } from '../src/structured/example.ts';
import { defaultUnrootedSpec, projectUnrooted, layoutUnrooted, validateUnrootedScene } from '../src/structured/unrooted.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements } from '../src/structured/layout.ts';
import { makeUnrootedView, validateStructuredView, checkStructuredPins } from '../src/structured/view.ts';
import { makeArtisticCopy, applyArtisticEdit } from '../src/structured/artistic.ts';
import { semanticCapabilities } from '../src/model/semantics.ts';
import { acceptCommand } from '../src/commands.ts';
import { serializeProject, documentFromWorking, loadAnyProject } from '../src/project-v2.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { parseNewick } from '../src/newick.ts';
import { schemaValid } from './schema-check.ts';
import type { ProjectionSpec, DisplayGraph, UnrootedSpec } from '../src/structured/types.ts';
const projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
async function fixture(algorithm:UnrootedSpec['algorithm']='equal-angle'){
  const f=await sampleTree(),spec={...defaultUnrootedSpec(f.source),algorithm},settings={...DEFAULT_STRUCTURED,kind:'circular' as const,curves:false},graph=projectUnrooted(f.source,projection,spec),metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const view=makeUnrootedView(f.project,f.source,projection,settings,metrics,spec,'unrooted-1','Synthetic unrooted');return {...f,spec,settings,graph,metrics,view};
}
function splits(g:DisplayGraph){const all=new Set(g.representedTips);return [...new Set(Object.values(g.edges).map(e=>{const a=g.nodes[e.child].selectedMembers,b=[...all].filter(id=>!a.includes(id));return [a.slice().sort().join(','),b.sort().join(',')].sort().join('|');}))].sort();}
function committed(f:Awaited<ReturnType<typeof fixture>>,view=f.view){const p=structuredClone(f.project);p.authoring.structuredViews={[view.id]:view};p.authoring.activeStructuredViewId=view.id;return acceptCommand(f.project,p,f.source,{methods:['unrooted-projection','unrooted-equal-angle',...(f.spec.algorithm==='daylight'?['unrooted-daylight']:[]),'unrooted-validation','compound-validation'],replace:true,parameters:{unrootedSpec:f.spec}});}
test('T18: unrooted projection prunes root stem and preserves exact restricted source splits across all internal display origins',async()=>{
  const f=await fixture();assert.equal(f.graph.rootId,'n000004');assert.ok(!f.graph.nodes.n000000);assert.deepEqual(f.graph.edges['display-edge-n000001'].sourcePath,['n000004','n000000','n000001']);assert.equal(f.graph.edges['display-edge-n000001'].length,5);
  for(const id of f.source.order.filter(id=>!f.source.tips.includes(id))){const g=projectUnrooted(f.source,projection,{...f.spec,originNodeId:id});assert.deepEqual(splits(g),splits(f.graph));assert.deepEqual(new Set(g.representedTips),new Set(f.source.tips));assert.equal(g.nodes[g.rootId].originalMembers.length,5);}
});
test('display origin and stored biological root are independent, and unrooted ancestry/MRCA is unavailable',async()=>{
  const f=await fixture(),p=structuredClone(f.project);p.authoring.root={status:'unrooted',explanation:'No biological rooting evidence.',referenceIds:[]};p.recipe.root={kind:'edge',sourceEdge:['n000000','n000001'],fraction:.2,status:'legacy-traversal'};
  const view=makeUnrootedView(p,f.source,projection,f.settings,f.metrics,f.spec,'unrooted-1','Synthetic unrooted');assert.deepEqual(view.scene,f.view.scene);assert.deepEqual(view.graph,f.view.graph);validateStructuredView(view,p,f.source);
  for(const root of [f.project.authoring.root,p.authoring.root]){const c=semanticCapabilities(root,'unrooted',null,p.authoring.basis);assert.equal(c.available,true);assert.equal(c.canClaimAncestry,false);assert.equal(c.quantitative,false);}
  assert.equal(semanticCapabilities(p.authoring.root,'unrooted',null,{...p.authoring.basis,relationshipKind:'classification'}).available,false);
});
test('every nonempty A–E subset preserves the source edge bipartitions under every available display origin',async()=>{
  const f=await fixture(),source=f.source,adj=Object.fromEntries(source.order.map(id=>[id,[] as string[]]));for(const id of source.order)for(const c of source.nodes[id].children){adj[id].push(c);adj[c].push(id);}
  for(let mask=1;mask<32;mask++){
    const chosen=source.tips.filter((_,i)=>mask&(1<<i)),expected=new Set<string>();
    for(const a of source.order)for(const b of source.nodes[a].children){const side:string[]=[],stack=[{id:b,parent:a}];while(stack.length){const item=stack.pop()!;if(chosen.includes(item.id))side.push(item.id);for(const n of adj[item.id])if(n!==item.parent)stack.push({id:n,parent:item.id});}const other=chosen.filter(id=>!side.includes(id));if(side.length&&other.length)expected.add([side.sort().join(','),other.sort().join(',')].sort().join('|'));}
    const p:ProjectionSpec={...projection,selection:{kind:'explicit-tips',tipIds:chosen}},auto=projectUnrooted(source,p,f.spec);
    for(const id of auto.order.filter(id=>chosen.length===1||!source.tips.includes(id))){const g=projectUnrooted(source,p,{...f.spec,originNodeId:id});assert.deepEqual(splits(g),[...expected].sort());assert.deepEqual(new Set(g.representedTips),new Set(chosen));}
  }
});
test('unrooted sampling preserves only selected-terminal connecting paths and original component memberships',async()=>{
  const f=await fixture(),p={...projection,selection:{kind:'explicit-tips' as const,tipIds:['n000002','n000003']}},g=projectUnrooted(f.source,p,f.spec);assert.deepEqual(new Set(g.order),new Set(['n000001','n000002','n000003']));assert.equal(g.nodes.n000001.originalMembers.length,5);assert.equal(g.omittedTips.length,3);assert.equal(Object.keys(g.edges).length,2);
  const one=projectUnrooted(f.source,{...p,selection:{kind:'explicit-tips',tipIds:['n000002']}},f.spec);assert.deepEqual(one.order,['n000002']);assert.deepEqual(one.endpoints,['n000002']);assert.equal(one.nodes.n000002.originalMembers.length,5);
  const scene=layoutUnrooted(one,f.settings,estimatedMeasurements(one,f.settings),f.spec);assert.equal(validateUnrootedScene(one,scene).coveragePassed,true);
});
test('unrooted projection preserves original edge identities and annotation owners when traversing backwards',async()=>{
  const source=await parseNewick('(((A:1,B:2)X[keep]:3)Y:4,(C:5,D:6):7);'),spec={...defaultUnrootedSpec(source),originNodeId:'n000005'},g=projectUnrooted(source,projection,spec);
  const used=Object.values(g.edges).flatMap(e=>e.sourceEdgeIds);assert.equal(new Set(used).size,used.length);assert.equal(used.length,source.order.length-1);
  assert.ok(Object.values(g.edges).some(e=>e.annotations.some(a=>a.text==='keep'&&a.sourceNodeId==='n000002')));assert.ok(g.nodes.n000001);assert.ok(g.nodes.n000002);
});
test('unrooted layouts preserve unresolved polytomies and ignore invalid or absent metric values',async()=>{
  for(const text of ['(A:-2,B,C:0,D:3);','(((A,B)));','A;']){const source=await parseNewick(text),spec=defaultUnrootedSpec(source),g=projectUnrooted(source,projection,spec),settings=(await fixture()).settings,scene=layoutUnrooted(g,settings,estimatedMeasurements(g,settings),spec),qa=validateUnrootedScene(g,scene);assert.equal(qa.coveragePassed,true);assert.equal(qa.incidencePassed,true);assert.equal(scene.metric,undefined);assert.equal(scene.classification,undefined);assert.deepEqual(new Set(g.endpoints),new Set(source.tips));if(source.tips.length===4)assert.equal(g.nodes[g.rootId].children.length,4);}
});
test('daylight improves measured angular-envelope variance without changing splits, origin or uniform edge lengths',async()=>{
  const seed=await fixture(),f=await fixture('daylight'),r=f.view.scene.unrooted!.daylight;assert.ok(r.accepted>0);assert.ok(r.afterScore!<r.beforeScore!);assert.equal(r.limited,false);assert.ok(r.work<=500000);assert.deepEqual(f.graph,seed.graph);assert.equal(f.view.qa.incidencePassed,true);assert.equal(f.view.qa.crossingPassed,true);assert.equal(f.view.qa.coveragePassed,true);assert.equal(f.view.qa.labelCollisions,0);assert.deepEqual(f.view.scene.junctionGlyphs[0].anchor,seed.view.scene.junctionGlyphs[0].anchor);validateStructuredView(f.view,f.project,f.source);
  for(const e of f.view.scene.edgeStems){assert.equal(e.geometry.kind,'polyline');if(e.geometry.kind==='polyline'){const [a,b]=e.geometry.points;assert.ok(Math.abs(Math.hypot(a.x-b.x,a.y-b.y)-f.spec.edgeLengthMm)<1e-7);}}
  assert.deepEqual(f.view.scene,layoutUnrooted(f.graph,f.settings,f.metrics,f.spec));
});
test('daylight zero passes/strength keeps the exact equal-angle geometry',async()=>{
  const f=await fixture();for(const s of [{...f.spec,algorithm:'daylight' as const,daylightPasses:0},{...f.spec,algorithm:'daylight' as const,daylightStrength:0}]){const scene=layoutUnrooted(f.graph,f.settings,f.metrics,s);assert.deepEqual(scene.edgeStems,f.view.scene.edgeStems);assert.equal(scene.unrooted!.daylight.accepted,0);}
});
test('daylight budget exhaustion retains a fully evaluated layout and is explicitly draft',async()=>{
  const source=await parseNewick('('+Array.from({length:1050},(_,i)=>'T'+i).join(',')+');'),spec={...defaultUnrootedSpec(source),algorithm:'daylight' as const},g=projectUnrooted(source,projection,spec),settings=(await fixture()).settings,scene=layoutUnrooted(g,settings,estimatedMeasurements(g,settings),spec),qa=validateUnrootedScene(g,scene);assert.equal(scene.unrooted!.daylight.work,500000);assert.equal(scene.unrooted!.daylight.limited,true);assert.equal(scene.unrooted!.daylight.accepted,0);assert.equal(qa.limited,true);assert.equal(qa.status,'draft');assert.ok(qa.limitations.some(x=>x.includes('500,000')));assert.equal(qa.incidencePassed,true);
});
test('invalid origins, source IDs, rooted rules, settings and level offsets are rejected',async()=>{
  const f=await fixture();for(const spec of [{...f.spec,originNodeId:'n000002'},{...f.spec,originNodeId:'foreign'},{...f.spec,sourceSha256:'0'.repeat(64)},{...f.spec,daylightPasses:13},{...f.spec,edgeLengthMm:0},{...f.spec,daylightStrength:NaN}])assert.throws(()=>projectUnrooted(f.source,projection,spec));
  for(const p of [{...projection,collapse:['n000001']},{...projection,reveal:['n000001']},{...projection,childOrder:{n000000:['n000004','n000001']}}])assert.throws(()=>projectUnrooted(f.source,p,f.spec));
  assert.throws(()=>layoutUnrooted(f.graph,{...f.settings,curves:true},f.metrics,f.spec));assert.throws(()=>layoutUnrooted(f.graph,f.settings,f.metrics,f.spec,{n000001:{depth:0,shift:1}}));
});
test('pin conflicts remain hard constraints when regenerating unrooted origin or spacing',async()=>{
  const f=await fixture('daylight'),v=structuredClone(f.view);v.pinnedNodes=['n000001'];const moved=makeUnrootedView(f.project,f.source,projection,f.settings,f.metrics,{...f.spec,edgeLengthMm:30},v.id,v.name);moved.pinnedNodes=v.pinnedNodes;assert.throws(()=>checkStructuredPins(v,moved),/Pinned/);assert.throws(()=>makeUnrootedView(f.project,f.source,projection,f.settings,f.metrics,{...f.spec,edgeLengthMm:30},v.id,v.name,v),/Pinned/);
});
test('unrooted save/load and V4 schema replay exact graph, scene and bounded-search evidence',async()=>{
  const schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));for(const algorithm of ['equal-angle','daylight'] as const){const f=await fixture(algorithm),p=committed(f),doc=documentFromWorking(p);assert.equal(schemaValid(schema,doc),true);const loaded=await loadAnyProject(serializeProject(p));assert.deepEqual(loaded.project.authoring.structuredViews![f.view.id],f.view);}
});
test('forged paths, origin, spacing, daylight statistics or biological adapter claims fail replay',async()=>{
  const f=await fixture('daylight');for(const mutate of [(v:typeof f.view)=>v.graph.edges['display-edge-n000001'].sourceEdgeIds.reverse(),(v:typeof f.view)=>v.scene.unrooted!.displayOriginNodeId='n000001',(v:typeof f.view)=>v.scene.unrooted!.daylight.accepted++,(v:typeof f.view)=>v.scene.unrooted!.spec.edgeLengthMm=19,(v:typeof f.view)=>v.intent='cladogram']){const v=structuredClone(f.view);mutate(v);assert.throws(()=>validateStructuredView(v,f.project,f.source));}
});
test('unrooted artistic copies retain verified split origin, remove active spacing claims and replay free edits',async()=>{
  const f=await fixture('daylight'),copy=makeArtisticCopy(f.view,'unrooted-art','Artistic unrooted');assert.equal(copy.scene.unrooted,undefined);assert.deepEqual(copy.artistic!.baseScene.unrooted,f.view.scene.unrooted);assert.deepEqual(copy.scene.edgeStems,f.view.scene.edgeStems);const edited=applyArtisticEdit(copy,{kind:'move-junction',nodeIds:['n000001'],delta:{x:3,y:4}});assert.deepEqual(edited.graph,f.view.graph);validateStructuredView(edited,f.project,f.source);const p=committed(f,edited),schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(schema,documentFromWorking(p)),true);await loadAnyProject(serializeProject(p));const files=exportStructuredFiles(f.source,p);assert.match(files['tree-caption.txt'],/no longer follows uniform/);assert.match(files['tree-caption.txt'],/Unrooted/);assert.equal(JSON.parse(files['unrooted_splits.json']).originOnly,true);
});
test('paired unrooted exports disclose unordered splits, methods, actual search, sampling and origin without ancestor claims',async()=>{
  const f=await fixture('daylight'),files=exportStructuredFiles(f.source,committed(f)),s=JSON.parse(files['unrooted_splits.json']);assert.deepEqual(new Set(s.selectedTipUniverse),new Set(f.source.tips));assert.equal(s.edges.length,Object.keys(f.graph.edges).length);assert.ok(files['reduced_tree.nwk'].startsWith('[&U]'));assert.match(files['sources-and-methods.html'],/unrooted-daylight@1.0.0/);assert.match(files['references.txt'],/Guangchuang Yu/);assert.match(files['tree-caption.txt'],/not a biological root/);assert.doesNotMatch(files['tree-caption.txt'],/one ancestor|Root retained/);assert.match(files['qa_report.json'],/unrooted_validation_v1/);assert.equal(files['tree_unlabeled.svg'].split('id="tree-artwork"')[1].split('</g>')[0],files['tree_labeled.svg'].split('id="tree-artwork"')[1].split('</g>')[0]);
});
