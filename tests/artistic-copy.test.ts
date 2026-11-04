import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleTree } from '../src/structured/example.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements } from '../src/structured/layout.ts';
import { makeStructuredView, checkStructuredPins, validateStructuredView } from '../src/structured/view.ts';
import { makeArtisticCopy, applyArtisticEdit, validateArtistic } from '../src/structured/artistic.ts';
import { validateScene } from '../src/structured/validate.ts';
import { documentFromWorking, serializeProject, loadAnyProject } from '../src/project-v2.ts';
import { acceptCommand } from '../src/commands.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { schemaValid } from './schema-check.ts';
import type { StructuredView, ArtisticEdit } from '../src/structured/types.ts';
async function fixture(){
  const f=await sampleTree(),projection={selection:{kind:'explicit-tips' as const,tipIds:['n000002','n000005','n000007']},collapse:[],expand:[],reveal:[],childOrder:{}};
  const graph=projectTree(f.source,f.rooted,projection),settings={...DEFAULT_STRUCTURED,kind:'circular' as const},metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const original=makeStructuredView(f.project,f.source,projection,settings,metrics,'structured-original','Original');
  const p=structuredClone(f.project);p.authoring.structuredViews={[original.id]:original};p.authoring.activeStructuredViewId=original.id;
  const project=acceptCommand(f.project,p,f.source,{methods:['selected-taxon-projection','clade-cluster','compound-validation'],replace:true});
  const copy=makeArtisticCopy(original,'artistic-copy','Artistic copy');return{...f,project,original,copy};
}
test('artistic copying retains exact scene/source selection and keeps the original view untouched',async()=>{
  const f=await fixture(),before=JSON.stringify(f.original);assert.equal(f.copy.intent,'artistic');assert.equal(f.copy.adapter,'compound-artistic-v1');
  assert.deepEqual(f.copy.scene,f.original.scene);assert.deepEqual(f.copy.graph,f.original.graph);assert.equal(f.copy.graph.omittedTips.length,2);assert.equal(JSON.stringify(f.original),before);
  assert.deepEqual(validateArtistic(f.copy),f.original.scene);assert.throws(()=>makeArtisticCopy(f.copy,'another','Copy'),/structured/);
});
test('free junction movement transports owned connector, ports, labels and attached stem endpoints without reparenting',async()=>{
  const f=await fixture(),old=structuredClone(f.copy),id='n000004',delta={x:-35,y:18};
  const moved=applyArtisticEdit(old,{kind:'move-junction',nodeIds:[id],delta});assert.deepEqual(moved.graph,old.graph);
  const a=old.scene.junctionGlyphs.find(g=>g.nodeId===id)!,b=moved.scene.junctionGlyphs.find(g=>g.nodeId===id)!;
  assert.equal(b.anchor.x-a.anchor.x,-35);assert.equal(b.anchor.y-a.anchor.y,18);
  for(const p of moved.scene.ports.filter(p=>p.nodeId===id)){const previous=old.scene.ports.find(x=>x.id===p.id)!;assert.equal(p.point.x-previous.point.x,-35);}
  assert.equal(validateScene(moved.graph,moved.scene).incidencePassed,true);assert.equal(JSON.stringify(old),JSON.stringify(f.copy));
  // Crossing old radial levels is allowed in the artistic copy, with QA reporting geometry.
  const distant=applyArtisticEdit(moved,{kind:'move-junction',nodeIds:[id],delta:{x:250,y:-100}});assert.equal(distant.qa.incidencePassed,true);assert.equal(distant.qa.status,'draft');
});
test('labels and stem waypoints are editable with endpoint attachment and subtree translations preserved',async()=>{
  const f=await fixture(),id='n000005',edgeId=`display-edge-${id}`;
  const bent=applyArtisticEdit(f.copy,{kind:'stem-waypoints',edgeId,points:[{x:140,y:100},{x:150,y:95}]});
  const label=bent.scene.labels.find(l=>l.nodeId===id)!,moved=applyArtisticEdit(bent,{kind:'move-label',nodeId:id,delta:{x:4,y:7}});
  assert.equal(moved.scene.labels.find(l=>l.nodeId===id)!.position.x-label.position.x,4);assert.deepEqual(moved.scene.edgeStems,bent.scene.edgeStems);
  const all=applyArtisticEdit(bent,{kind:'move-junction',nodeIds:f.copy.graph.order,delta:{x:2,y:3}}),stem=all.scene.edgeStems.find(e=>e.edgeId===edgeId)!;
  assert.equal(stem.geometry.kind,'polyline');if(stem.geometry.kind==='polyline')assert.deepEqual(stem.geometry.points.slice(1,-1),[{x:142,y:103},{x:152,y:98}]);
  assert.equal(all.qa.incidencePassed,true);
  const measurements=structuredClone(moved.scene.measurements);measurements.metrics[id].widthMm+=5;const remeasured=applyArtisticEdit(moved,{kind:'measure-labels',measurements});assert.deepEqual(remeasured.scene.labels.find(l=>l.nodeId===id)!.position,moved.scene.labels.find(l=>l.nodeId===id)!.position);assert.notDeepEqual(remeasured.scene.labels.find(l=>l.nodeId===id)!.corners,moved.scene.labels.find(l=>l.nodeId===id)!.corners);assert.deepEqual(validateArtistic(remeasured),remeasured.scene);
});
test('line appearance uses the same straight connectors for canvas/checks/export and restores original arcs',async()=>{
  const f=await fixture(),straight=applyArtisticEdit(f.copy,{kind:'appearance',strokeMm:.8,curves:false});
  assert.ok(straight.scene.junctionGlyphs.every(g=>g.geometry.kind!=='arc'));assert.equal(straight.scene.settings.strokeMm,.8);assert.equal(straight.qa.incidencePassed,true);
  const curved=applyArtisticEdit(straight,{kind:'appearance',strokeMm:.3,curves:true});assert.ok(curved.scene.junctionGlyphs.some(g=>g.geometry.kind==='arc'));
  assert.deepEqual(curved.scene.junctionGlyphs,f.copy.scene.junctionGlyphs);
});
test('pins reject conflicting free placement and malformed or forged edits cannot bypass replay',async()=>{
  const f=await fixture(),pinned=structuredClone(f.copy);pinned.pinnedNodes=['n000004'];const moved=applyArtisticEdit(pinned,{kind:'move-junction',nodeIds:['n000004'],delta:{x:2,y:0}});assert.throws(()=>checkStructuredPins(pinned,moved),/Pinned/);
  for(const edit of [{kind:'move-junction',nodeIds:['unknown'],delta:{x:0,y:0}},{kind:'move-label',nodeId:'n000004',delta:{x:1,y:1}},{kind:'stem-waypoints',edgeId:'missing',points:[]},{kind:'appearance',strokeMm:NaN,curves:true},{kind:'move-label',nodeId:'n000005',delta:{x:Infinity,y:0}}])assert.throws(()=>applyArtisticEdit(f.copy,edit as ArtisticEdit));
  const bad=structuredClone(f.copy);bad.artistic!.baseScene.ports[0].point.x+=1;assert.throws(()=>validateArtistic(bad),/origin/);
  const corrupt=structuredClone(f.copy);corrupt.scene.junctionGlyphs[0].anchor.x+=1;assert.throws(()=>validateStructuredView(corrupt,f.project,f.source),/replay/);
});
test('artistic profiles save/reopen strictly, preserve the structured original and export honest captions/methods',async()=>{
  const f=await fixture(),copy=applyArtisticEdit(f.copy,{kind:'move-junction',nodeIds:['n000004'],delta:{x:-4,y:1}}),proposal=structuredClone(f.project);
  proposal.authoring.structuredViews![copy.id]=copy;proposal.authoring.activeStructuredViewId=copy.id;
  const saved=acceptCommand(f.project,proposal,f.source,{methods:['compound-artistic-copy','compound-artistic-edit','compound-validation'],inputs:[`structured/${f.original.id}`],parameters:{originSceneRevision:f.original.scene.revision}});
  const schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.equal(schemaValid(documentFromWorking(saved),schema,schema),true);
  const reopened=await loadAnyProject(serializeProject(saved));assert.deepEqual(reopened.project.authoring.structuredViews,saved.authoring.structuredViews);assert.deepEqual(saved.authoring.structuredViews![f.original.id],f.original);
  const files=exportStructuredFiles(f.source,saved);assert.match(files['tree-caption.txt'],/artistic arrangement/);assert.equal(JSON.parse(files['tree_provenance.json']).interpretation,'artistic');assert.match(files['sources-and-methods.html'],/compound-artistic-copy/);
  const group=(s:string)=>s.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];assert.equal(group(files['tree_unlabeled.svg']),group(files['tree_labeled.svg']));assert.equal(files['source_tree.nwk'],f.source.text);
  const forged=structuredClone(saved),v=forged.authoring.structuredViews![copy.id];v.scene.edgeStems[0].geometry={kind:'point',point:{x:0,y:0}};assert.throws(()=>acceptCommand(saved,forged,f.source));
  const wrong=structuredClone(copy);wrong.intent='cladogram';assert.equal(schemaValid(wrong,schema.$defs.structuredView,schema),false);
});
