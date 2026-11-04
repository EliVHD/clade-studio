import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleTree } from '../src/structured/example.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements } from '../src/structured/layout.ts';
import { makeStructuredView, checkStructuredPins, validateStructuredView } from '../src/structured/view.ts';
import { makeArtisticCopy, applyArtisticEdit, validateArtistic } from '../src/structured/artistic.ts';
import { validateScene } from '../src/structured/validate.ts';
import { validateScene as validateV2 } from '../src/structured/validate-v2.ts';
import { validateScene as validateV1 } from '../src/structured/validate-v1.ts';
import { StructuredController } from '../src/structured/ui.ts';
import { CURRENT_VALIDATION_PROFILE } from '../src/structured/validation-profile.ts';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { generateLayout, DEFAULT_PRESENTATION } from '../src/geometry.ts';
import { History } from '../src/project.ts';
import { startAuthoring } from '../src/project-v2.ts';
import { acceptBasisEdit } from '../src/commands.ts';
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

test('historical 600-tip artistic drags defer QA until release and remain one undoable edit', async () => {
  const sample = await sampleTree(), source = await parseNewick('(' + Array.from({ length: 600 }, (_, i) => `T${i}:1`).join(',') + ');');
  const recipe = { ...defaultRecipe(source), globalThreshold: 0 }; recipe.root.status = 'declared_assumption';
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe);
  const { authoring: _authoring, ...legacy } = sample.project;
  let base = startAuthoring({ ...legacy, sourceText: source.text, sourceSha256: source.sha256, recipe, layout: generateLayout(rooted, reduction, DEFAULT_PRESENTATION, 'organic') }, source, null);
  base = acceptBasisEdit(base, { ...sample.project.authoring.basis, sourceIds: [`source-${source.sha256}`] }, source);
  const declared = structuredClone(base); declared.authoring.root = structuredClone(sample.project.authoring.root);
  base = acceptCommand(base, declared, source, { notes: 'Declared the synthetic drag-test root.' });
  const projection = { selection: { kind: 'all' as const }, collapse: [], expand: [], reveal: [], childOrder: {} };
  const graph = projectTree(source, rooted, projection), settings = { ...DEFAULT_STRUCTURED, kind: 'circular' as const, innerRadiusMm: 300, outerRadiusMm: 500, widthMm: 1200, heightMm: 1200 };
  const metrics = estimatedMeasurements(graph, settings); metrics.fontStatus = 'available';
  const original = makeStructuredView(base, source, projection, settings, metrics, 'original', 'Original');
  const id = graph.endpoints[0], copy = applyArtisticEdit(makeArtisticCopy(original, 'copy', 'Historical artistic copy'), { kind: 'stem-waypoints', edgeId: `display-edge-${id}`, points: [{ x: 900, y: 600 }] });
  copy.validationProfile = 'compound-v2'; copy.qa = validateV2(copy.graph, copy.scene);
  const proposal = structuredClone(base); proposal.authoring.structuredViews = { original, copy }; proposal.authoring.activeStructuredViewId = copy.id;
  const saved = acceptCommand(base, proposal, source, { methods: ['compound-artistic-copy', 'compound-artistic-edit', 'compound-validation@2.0.0'], replace: true });

  // A small DOM surface exercises the real controller render/status/summary paths.
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, innerHTML: '', textContent: '', addEventListener() {}, querySelectorAll() { return []; } });
    return elements.get(id);
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: element, querySelectorAll: () => [],
    fonts: { ready: Promise.resolve(), load: async () => [], check: () => true },
    createElement: () => ({ getContext: () => ({ font: '', measureText: () => ({ width: 10, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 10, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) }) }),
  } });
  try {
    for (const profile of [undefined, 'compound-v2'] as const) {
      let historical = saved;
      if (profile === undefined) {
        const legacyProposal = structuredClone(saved), legacyView = legacyProposal.authoring.structuredViews!.copy;
        delete legacyView.validationProfile; legacyView.qa = validateV1(legacyView.graph, legacyView.scene);
        historical = acceptCommand(saved, legacyProposal, source, { methods: ['compound-validation@1.0.0'], notes: 'Captured a pre-profile artistic view for drag coverage.' });
      }
    for (const kind of ['node', 'label', 'waypoint'] as const) {
      let project = structuredClone(historical), lookups = 0, status = '', summary = '';
      const history = new History<typeof project>();
      const controller = new StructuredController({ project: () => project, source: () => source, rooted: () => rooted, selected: () => [id],
        commit: (next, evidence) => { const accepted = acceptCommand(project, next, source, evidence); history.push(project); project = accepted; },
        render: () => { controller.render(); status = controller.qaStatus(); summary = controller.summary(controller.view!); },
        fit() {}, focus() {}, calculate: async () => { throw new Error('Unexpected layout calculation.'); }, cancel() {}, toast() {}, canWork: () => true,
      });
      controller.enabled = true; controller.selected.add(id);
      const qaFor = controller.qaFor.bind(controller);
      controller.qaFor = view => { lookups++; assert.equal(controller.dragging, false, 'rendering must not ask for QA while moving'); return qaFor(view); };
      controller.qaStatus(); // Cache a current check of the accepted historical geometry.
      const before = structuredClone(project), beforeLookups = lookups;
      assert.equal(controller.beginArtisticPointer(id, kind, { x: 900, y: 600 }), true);
      for (let i = 1; i <= 4; i++) {
        controller.moveArtisticPointer({ x: 900 + i, y: 600 + i });
        assert.equal(status, 'MOVING · geometry unchecked');
        assert.match(summary, /MOVING.*geometry unchecked/);
        assert.equal(controller.exportable, false);
      }
      assert.equal(lookups, beforeLookups, 'no QA lookup or full validation on pointer movement');
      assert.deepEqual(project, before, 'movement only changes the preview');
      controller.endArtisticPointer();
      const accepted = controller.view!;
      assert.equal(accepted.validationProfile, CURRENT_VALIDATION_PROFILE);
      assert.deepEqual(accepted.qa, validateScene(accepted.graph, accepted.scene));
      assert.notEqual(accepted.scene.revision, copy.scene.revision);
      assert.equal(accepted.artistic!.edits.length, copy.artistic!.edits.length + 1);
      assert.equal(history.past.length, 1);
      assert.deepEqual(history.undo(project), before);
      assert.deepEqual(project.authoring.structuredViews!.original, original);

      const beforeCancel = structuredClone(project);
      controller.beginArtisticPointer(id, kind, { x: 900, y: 600 });
      controller.moveArtisticPointer({ x: 910, y: 610 });
      controller.endArtisticPointer(true);
      assert.deepEqual(project, beforeCancel, 'Escape/pointer cancellation discards the unvalidated preview');
      assert.equal(history.past.length, 0, 'cancellation creates no undo entry');
      controller.beginArtisticPointer(id, kind, { x: 900, y: 600 });
      controller.endArtisticPointer();
      assert.deepEqual(project, beforeCancel, 'a click without movement creates no edit');
      await new Promise(resolve => setImmediate(resolve)); // Finish font-status renders before removing the DOM.
    }
    }
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
