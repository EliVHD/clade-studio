import { schemaValid } from './schema-check.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, moveNodes, splitRoute, validateGeometry } from '../src/geometry.ts';
import { History } from '../src/project.ts';
import { startAuthoring, loadAnyProject, serializeProject, documentFromWorking, treeRevision } from '../src/project-v2.ts';
import { acceptCommand, acceptBasisEdit, userReference, isCurrentResult } from '../src/commands.ts';
import { semanticCapabilities } from '../src/model/semantics.ts';
import { activeView, seedCheckpoint, validateProvenance, operationId } from '../src/provenance/operations.ts';
import { HUG_REFERENCE } from '../src/provenance/registry.ts';
import { sha256TextSync, persisted } from '../src/provenance/sync-identity.ts';
import { activeProvenance, provenanceFiles, addArtifactManifest } from '../src/export-provenance.ts';
import { artworkGroup, exportFiles } from '../src/export.ts';
import { DEFAULT_FIT_SETTINGS } from '../src/fit-settings.ts';
import type { Project } from '../src/types.ts';
import { defaultScientificBasis, validateScientificBasis } from '../src/model/basis.ts';
import type { ScientificBasis, WorkingProject } from '../src/model/document.ts';

async function fixture(origin: 'legacy' | 'new' = 'legacy', text = '((A:1,B:1)98[comment]:1,(C:1,D:1):1);') {
  const source = await parseNewick(text), recipe = defaultRecipe(source); recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(x => x.id);
  const legacy: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Test tree', sourceText: text, sourceSha256: source.sha256, provenance: {}, corrections: [], recipe, layout: generateLayout(rooted, reduction, DEFAULT_PRESENTATION, 'organic'), presentation: structuredClone(DEFAULT_PRESENTATION) };
  const project = startAuthoring(legacy, source, null, origin, ['newick-parser','maximal-frontier','organic-initializer']);
  return { source, rooted, reduction, legacy, project };
}
const revision = (p: WorkingProject) => treeRevision(documentFromWorking(p));
const methods = (p: WorkingProject) => Object.keys(activeProvenance(p).methods).sort();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('synchronous content SHA256 matches independent crypto at padding and Unicode boundaries', async () => {
  for (const text of ['', 'abc', ...[55,56,63,64,65,127,128,1000000].map(n => 'a'.repeat(n)), '🌳 αβ ä\u0000\ufeff', await readFile('data/source_tree.nwk', 'utf8')]) assert.equal(sha256TextSync(text), hash(text));
});
test('V1 migration preserves exact geometry, pins, waypoints, borders, image and normalized inspection', async () => {
  const f = await fixture(); splitRoute(f.legacy.layout, f.rooted, 'n000002'); moveNodes(f.legacy.layout, f.rooted, ['n000001'], { x: 2.31, y: -1.29 });
  f.legacy.layout.lineStyle = 'straight'; f.legacy.layout.pinnedNodes = ['n000001']; f.legacy.layout.pinnedEdges = ['n000005'];
  f.legacy.presentation.labelOffsets.n000002 = { x: 4, y: -3 }; f.legacy.selection = ['n000001'];
  f.legacy.design = { borders: [{ id: 'border-a', name: 'A', points: [{x:10,y:10},{x:50,y:20}], closed:false, placement:'spread', insetMm:1, variationMm:2, seed:42, assignments:[{sourceNodeId:'n000002',fraction:.3,normalSign:1}], direction: {angleDeg:270,strength:.8} }], showBorders:true, activeBorderId:'border-a', fitSettings: structuredClone(DEFAULT_FIT_SETTINGS), referenceImage: { name:'synthetic pixel', dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/fLsAAAAASUVORK5CYII=', pixelWidth:1,pixelHeight:1,x:2,y:3,widthMm:10,heightMm:10,rotationDeg:5,opacity:.3,visible:true,layer:'behind' } };
  for (const mode of ['organic','scientific'] as const) {
    f.legacy.layout.mode = mode;
    const loaded = await loadAnyProject(JSON.stringify(f.legacy));
    assert.equal(loaded.migrated,true); assert.deepEqual(loaded.project.layout,f.legacy.layout); assert.deepEqual(loaded.project.design,f.legacy.design); assert.deepEqual(loaded.project.presentation,f.legacy.presentation);
    assert.equal(loaded.source.text,f.source.text); assert.equal(artworkGroup(f.rooted,f.reduction,loaded.project),artworkGroup(f.rooted,f.reduction,f.legacy));
    const reopened = await loadAnyProject(serializeProject(loaded.project)); assert.equal(reopened.migrated,false); assert.deepEqual(reopened.project,loaded.project);
    assert.deepEqual(methods(reopened.project),[]); assert.equal(reopened.project.authoring.compatibility.historyStatus,'incomplete');
    assert.equal(documentFromWorking(reopened.project).views['view-1'].intent,mode === 'organic' ? 'artistic' : 'legacy-inspection');
  }
});
test('unrelated numeric labels and lengths do not acquire support types, units or bundled citations', async () => {
  const f = await fixture('new'); const loaded = await loadAnyProject(serializeProject(f.project));
  assert.equal(loaded.source.nodes.n000001.rawLabel,'98'); assert.equal(loaded.source.nodes.n000001.annotations[0].text,'comment');
  assert.equal(loaded.project.authoring.edgeMeasure,null); assert.deepEqual(activeProvenance(loaded.project).references,{});
  assert.ok(provenanceFiles(loaded.project)['sources-and-methods.html'].includes('citation is incomplete'));
  assert.equal(semanticCapabilities(loaded.project.authoring.root,'phylogram').available,false);
});
test('biological-root capabilities distinguish unrooted and traversal-only data', async () => {
  const f = await fixture(); assert.equal(f.project.authoring.root.status,'unspecified');
  for (const status of ['unrooted','unspecified'] as const) {
    const p = structuredClone(f.project); p.authoring.root = {status, explanation:'No biological root declared.',referenceIds:[]};
    const committed = acceptCommand(f.project,p,f.source);
    assert.equal(semanticCapabilities(committed.authoring.root,'artistic').canClaimAncestry,false);
    await loadAnyProject(serializeProject(committed));
  }
  const declared = acceptBasisEdit(f.project, phylogeneticBasis(f.project), f.source);
  const p = structuredClone(declared); p.authoring.root = {status:'rooted',basis:'user-assumption',explanation:'Explicit teaching assumption.',referenceIds:[]};
  const committed = acceptCommand(declared,p,f.source); assert.equal(semanticCapabilities(committed.authoring.root,'artistic',null,committed.authoring.basis).canClaimAncestry,true);
  assert.equal(semanticCapabilities(committed.authoring.root,'taxonomy').canClaimAncestry,false);
  assert.equal(semanticCapabilities(committed.authoring.root,'legacy-inspection').quantitative,false);
});
test('unused controls, selections and operation timestamps do not change tree revision or claim a fit', async () => {
  const f = await fixture('new'), p = structuredClone(f.project);
  p.selection = ['n000002']; p.design = {borders:[], showBorders:false,fitSettings:{...DEFAULT_FIT_SETTINGS,strength:.2}};
  const changed = acceptCommand(f.project,p,f.source); assert.equal(revision(changed),revision(f.project)); assert.deepEqual(changed.authoring.provenance,f.project.authoring.provenance);
  const doc = documentFromWorking(changed); for (const op of Object.values(doc.provenance.operations)) op.recordedAt = '2020-01-01T00:00:00Z';
  assert.equal(treeRevision(doc),revision(changed)); assert.ok(!methods(changed).includes('junction-fit@1.0.0'));
});
test('accepted edits are atomic and undo/redo restores geometry and full provenance together', async () => {
  const f = await fixture('new'), before = serializeProject(f.project), p = structuredClone(f.project), history = new History<WorkingProject>();
  moveNodes(p.layout,f.rooted,['n000001'],{x:4,y:3});
  const committed = acceptCommand(f.project,p,f.source,{notes:'Accepted manual move.'}); history.push(f.project);
  assert.notEqual(revision(committed),revision(f.project)); assert.equal(serializeProject(f.project),before);
  const undone = history.undo(committed)!; assert.equal(revision(undone),revision(f.project)); assert.deepEqual(history.redo(undone),committed);
  const invalid = structuredClone(committed); invalid.layout.routes.n000002.segments[0].end.x += 5;
  assert.throws(() => acceptCommand(committed,invalid,f.source), /Detached/); assert.equal(serializeProject(f.project),before);
  await loadAnyProject(serializeProject(committed));
});
test('separate partial replacements retain other contributing methods; complete replacement drops obsolete fits', async () => {
  const f = await fixture('new');
  const a = structuredClone(f.project); moveNodes(a.layout,f.rooted,['n000002'],{x:2,y:3});
  const fitA = acceptCommand(f.project,a,f.source,{methods:['junction-fit'],parameters:{strength:.5},replace:true});
  const b = structuredClone(fitA); moveNodes(b.layout,f.rooted,['n000005'],{x:-2,y:1});
  const fitB = acceptCommand(fitA,b,f.source,{methods:['endpoint-border'],parameters:{seed:17},replace:true});
  const c = structuredClone(fitB); moveNodes(c.layout,f.rooted,['n000002'],{x:7,y:1});
  const partial = acceptCommand(fitB,c,f.source,{methods:['organic-initializer'],replace:true});
  assert.ok(methods(partial).includes('endpoint-border@1.0.0')); assert.ok(!methods(partial).includes('junction-fit@1.0.0'));
  const d = structuredClone(partial); moveNodes(d.layout,f.rooted,f.reduction.visible,{x:1,y:2});
  const replaced = acceptCommand(partial,d,f.source,{methods:['organic-initializer'],replace:true});
  assert.deepEqual(methods(replaced),['maximal-frontier@1.0.0','newick-parser@1.0.0','organic-initializer@1.0.0']);
  assert.ok(Object.keys(replaced.authoring.provenance.operations).length < Object.keys(partial.authoring.provenance.operations).length);
  await loadAnyProject(serializeProject(replaced));
});
test('manual adjustment retains the fitted geometry it consumed', async () => {
  const f = await fixture('new'), p = structuredClone(f.project); moveNodes(p.layout,f.rooted,['n000002'],{x:1,y:2});
  const fit = acceptCommand(f.project,p,f.source,{methods:['junction-fit'],replace:true});
  const q = structuredClone(fit); moveNodes(q.layout,f.rooted,['n000002'],{x:3,y:4});
  const manual = acceptCommand(fit,q,f.source); assert.ok(methods(manual).includes('junction-fit@1.0.0'));
  assert.ok(Object.values(activeProvenance(manual).operations).some(op => op.kind === 'manual'));
});
test('active-view provenance excludes operations unique to a different saved view', async () => {
  const f = await fixture('new'); const p = structuredClone(f.project);
  p.authoring.activeViewId = 'view-other'; p.authoring.viewName = 'Other';
  p.authoring.provenance = {references:{},methods:{},operations:{},heads:{},replayCoverage:'source-and-final-geometry'};
  seedCheckpoint(p,'new',null,['newick-parser','maximal-frontier','routing-demo']);
  const active = structuredClone(f.project); active.authoring.otherViews['view-other'] = activeView(p);
  Object.assign(active.authoring.provenance.operations,p.authoring.provenance.operations); Object.assign(active.authoring.provenance.methods,p.authoring.provenance.methods);
  Object.assign(active.authoring.provenance.heads,Object.fromEntries(Object.entries(p.authoring.provenance.heads).filter(([key]) => key.startsWith('view/view-other/'))));
  validateProvenance(active); assert.ok(!methods(active).includes('routing-demo@1.0.0'));
  const reopened = await loadAnyProject(serializeProject(active)); assert.deepEqual(reopened.project.authoring.otherViews,active.authoring.otherViews);
});
test('export snapshot shares revisions, original source, identical artwork and verifiable artifact hashes', async () => {
  const f = await fixture('new'), qa = validateGeometry(f.source,f.rooted,f.project.recipe,f.reduction,f.project.layout,f.project.presentation);
  const files = exportFiles(f.source,f.rooted,f.reduction,f.project,qa);
  files['build-manifest.json'] = '{}'; addArtifactManifest(files,f.project);
  const manifest = JSON.parse(files['artifact_manifest.json']); assert.equal(manifest.treeRevision,revision(f.project));
  assert.equal(manifest.files.length,Object.keys(files).length-1);
  for (const entry of manifest.files) { assert.equal(entry.sha256,hash(files[entry.path])); assert.equal(entry.bytes,Buffer.byteLength(files[entry.path])); }
  for (const name of ['qa_report.json','tree_provenance.json']) assert.equal(JSON.parse(files[name]).treeRevision,manifest.treeRevision);
  for (const name of ['tree_labeled.svg','tree_unlabeled.svg','sources-and-methods.html']) assert.ok(files[name].includes(manifest.treeRevision));
  assert.equal(files['source_tree.nwk'],f.source.text);
  const group = (svg: string) => svg.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0]; assert.equal(group(files['tree_labeled.svg']),group(files['tree_unlabeled.svg']));
  const reopened = await loadAnyProject(files['tree.treeproject.json']); assert.equal(revision(reopened.project),manifest.treeRevision);
});
test('corrupt sources, future formats, unsupported projections and broken contributions are rejected', async () => {
  const f = await fixture('new');
  const corruptions = [
    (d: any) => d.version = 99,
    (d: any) => d.sources[d.scientific.primarySourceId].content += 'X',
    (d: any) => d.scientific.selection = {kind:'subset',tips:['n000002']},
    (d: any) => d.views['view-1'].intent = 'chronogram',
    (d: any) => d.provenance.heads.source.revision = '0'.repeat(64),
    (d: any) => delete d.provenance.operations[d.provenance.heads.source.operationId],
    (d: any) => d.provenance.methods['organic-initializer@1.0.0'].specification += 'silently changed',
    (d: any) => d.scientific.root.basis = 'forged',
    (d: any) => d.ui.selection = ['missing'],
    (d: any) => d.scientific.traversal.sourceNodeId = 'missing',
  ];
  for (const change of corruptions) { const doc = documentFromWorking(f.project); change(doc); await assert.rejects(loadAnyProject(JSON.stringify(doc))); }
  validateProvenance(f.project);
});
test('invented dependencies, planned methods and unknown source citations cannot be applied', async () => {
  const f = await fixture('new'); const doc = documentFromWorking(f.project);
  const op = doc.provenance.operations[doc.provenance.heads.source.operationId]; op.inputs.fake = {revision:'f'.repeat(64),operationId:'missing'};
  const oldId = op.id; op.id = operationId(op); doc.provenance.operations[op.id] = op; delete doc.provenance.operations[oldId];
  await assert.rejects(loadAnyProject(JSON.stringify(doc)));
  const p = structuredClone(f.project); moveNodes(p.layout,f.rooted,['n000002'],{x:1,y:1});
  assert.throws(() => acceptCommand(f.project,p,f.source,{methods:['future-layout']}), /not available/);
  const missingRef = structuredClone(f.project); missingRef.authoring.root.referenceIds.push('missing');
  assert.throws(() => acceptCommand(f.project,missingRef,f.source), /unknown citation/);
  const unrelated = documentFromWorking(f.project); unrelated.sources[unrelated.scientific.primarySourceId].referenceIds = ['hug-2016']; unrelated.provenance.references['hug-2016'] = HUG_REFERENCE;
  await assert.rejects(loadAnyProject(JSON.stringify(unrelated)),/Unrelated/);
});
test('hostile reference text is escaped in HTML and BibTeX; executable URLs are rejected', async () => {
  const f = await fixture(); const p = structuredClone(f.project);
  p.authoring.provenance.references.custom = {id:'custom',type:'article',title:'<script>alert(1)</script> {x} \\input{bad}',authors:['A & B'],year:2026,doi:null,url:'https://example.org/?x=%22',license:null,verification:'unverified'};
  p.authoring.source.referenceIds.push('custom');
  const loaded = await loadAnyProject(serializeProject(p)); const files = provenanceFiles(loaded.project);
  assert.ok(!files['sources-and-methods.html'].includes('<script>')); assert.ok(files['sources-and-methods.html'].includes('&lt;script&gt;'));
  assert.ok(files['references.bib'].includes('\\textbackslash{}input\\{bad\\}'));
  p.authoring.provenance.references.custom.url = 'javascript:alert(1)'; assert.throws(() => serializeProject(p),/HTTP/);
});
test('bundled source keeps verified citation and measurable-source evidence across migration', async () => {
  const text = await readFile('data/source_tree.nwk','utf8'), source = await parseNewick(text);
  const recipe = {...defaultRecipe(source),...JSON.parse(await readFile('data/example_reduction_recipe.json','utf8'))}, rooted = orient(source,recipe.root), reduction = reduce(source,rooted,recipe,true);
  const f = await fixture(); const legacy: Project = {...f.legacy,sourceText:text,sourceSha256:source.sha256,recipe,layout:generateLayout(rooted,reduction,DEFAULT_PRESENTATION,'organic')};
  const p = startAuthoring(legacy,source,null); const loaded = await loadAnyProject(serializeProject(p));
  assert.deepEqual(activeProvenance(loaded.project).references['hug-2016'],HUG_REFERENCE); assert.equal(loaded.project.authoring.edgeMeasure?.unit,'substitutions/site');
  assert.equal(semanticCapabilities(loaded.project.authoring.root,'artistic',loaded.project.authoring.edgeMeasure).quantitative,false);
  assert.equal(artworkGroup(rooted,reduction,loaded.project),artworkGroup(rooted,reduction,legacy));
});
test('invalid persisted nonfinite coordinates cannot be silently converted to null', async () => {
  assert.throws(() => persisted({x:NaN})); assert.throws(() => persisted({x:Infinity}));
  const f = await fixture(), p = structuredClone(f.project); p.layout.nodes.n000002.x = Infinity;
  assert.throws(() => acceptCommand(f.project,p,f.source));
});
test('legacy inspection requires explicit artistic intent before geometry editing', async () => {
  const f = await fixture(); f.legacy.layout.mode = 'scientific';
  const loaded = await loadAnyProject(JSON.stringify(f.legacy)), p = structuredClone(loaded.project);
  moveNodes(p.layout,f.rooted,['n000002'],{x:1,y:2}); assert.throws(() => acceptCommand(loaded.project,p,f.source), /read-only/);
  const adopted = structuredClone(loaded.project); adopted.layout.mode = 'organic';
  const committed = acceptCommand(loaded.project,adopted,f.source); assert.deepEqual(committed.layout.nodes,loaded.project.layout.nodes); assert.deepEqual(committed.layout.routes,loaded.project.layout.routes);
  assert.equal(documentFromWorking(committed).views['view-1'].intent,'artistic');
});

// Dependency-free structural check of this published schema's keyword subset.
// Scientific/topology/digest constraints remain covered by runtime import tests above.
test('published JSON Schema accepts serialized checkpoints and rejects unsupported envelope fields', async () => {
  const schema = JSON.parse(await readFile('public/project-v4.schema.json','utf8'));
  const valid=(value:any,rule:any)=>schemaValid(value,rule,schema);
  const f = await fixture('new'), document = JSON.parse(serializeProject(f.project));
  assert.equal(valid(document,schema),true);
  for (const bad of [{...document,version:5},{...document,unexpected:true},{...document,ui:{selection:'not-an-array'}},{...document,views:{}}]) assert.equal(valid(bad,schema),false);
});

function phylogeneticBasis(project: WorkingProject): ScientificBasis {
  return { ...structuredClone(project.authoring.basis), name: 'Test hypothesis', question: 'Relationships in this synthetic example', relationshipKind: 'phylogeny', entityKind: 'taxon-concepts', edgeMeaning: 'Inferred ancestry', evidenceBasis: 'Explicit synthetic teaching example', epistemicStatus: 'teaching-example', limitations: 'Invented example, not empirical evidence.' };
}
test('T22: separate imported hypotheses and basis edits retain each source, geometry and view identity', async () => {
  const a = await fixture('new'), b = await fixture('new','((A:1,C:1):1,(B:1,D:1):1);');
  const aBefore = serializeProject(a.project), aArt = artworkGroup(a.rooted,a.reduction,a.project), bBefore = serializeProject(b.project);
  const ref = userReference({title:'Synthetic source A', authors:['Test author'],year:2026,doi:null,url:'https://example.org/a',license:'Rights not supplied'});
  const basis = phylogeneticBasis(a.project); basis.referenceIds=[ref.id]; basis.provider='Teacher supplied';basis.release='Example 1';basis.retrievedAt='2026-10-28';
  const edited = acceptBasisEdit(a.project,basis,a.source,null,[ref]);
  assert.equal(serializeProject(a.project),aBefore); assert.equal(serializeProject(b.project),bBefore);
  assert.notEqual(a.project.sourceSha256,b.project.sourceSha256); assert.notEqual(a.project.authoring.documentId,b.project.authoring.documentId);
  assert.equal(artworkGroup(a.rooted,a.reduction,edited),aArt); assert.deepEqual(edited.layout,a.project.layout); assert.deepEqual(edited.recipe,a.project.recipe); assert.deepEqual(edited.authoring.otherViews,a.project.authoring.otherViews);
  assert.deepEqual((await loadAnyProject(serializeProject(edited))).project.authoring.basis,basis);
  assert.equal(edited.authoring.provenance.references[ref.id].verification,'unverified');
});
test('T24: ancestry requires phylogeny, known entities and a declared root; gene history is explicitly scoped', async () => {
  const f=await fixture(), rooted={status:'rooted' as const,basis:'user-assumption' as const,explanation:'Assumed root',referenceIds:[]};
  assert.equal(semanticCapabilities(rooted,'artistic',null,f.project.authoring.basis).canClaimAncestry,false);
  const p=structuredClone(f.project);p.authoring.root=rooted;
  assert.throws(()=>acceptCommand(f.project,p,f.source),/phylogenetic basis/);
  const basis=phylogeneticBasis(f.project);
  for(const relationshipKind of ['classification','similarity','ecological-interaction'] as const){
    const unsupported={...basis,relationshipKind}; const cap=semanticCapabilities(rooted,'artistic',null,unsupported);
    assert.equal(cap.canClaimAncestry,false);assert.equal(cap.available,false);assert.equal(cap.canEditGeometry,false);
    const described=acceptBasisEdit(f.project,unsupported,f.source), moved=structuredClone(described);moveNodes(moved.layout,f.rooted,['n000002'],{x:1,y:1});
    assert.throws(()=>acceptCommand(described,moved,f.source),/adapter/);
    await loadAnyProject(serializeProject(described));
  }
  assert.equal(semanticCapabilities(rooted,'artistic',null,{...basis,entityKind:'unspecified'}).canClaimAncestry,false);
  const genes={...basis,entityKind:'genes-sequences' as const};
  assert.equal(semanticCapabilities(rooted,'artistic',null,genes).canClaimAncestry,true);
  assert.match(semanticCapabilities(rooted,'artistic',null,genes).reasons.join(' '),/does not establish species ancestry/);
  assert.equal(semanticCapabilities(rooted,'unrooted',null,basis).available,true);assert.equal(semanticCapabilities(rooted,'unrooted',null,basis).canClaimAncestry,false);
  for(const intent of ['phylogram','chronogram','taxonomy'] as const) assert.equal(semanticCapabilities(rooted,intent,null,basis).available,false);
});
test('T25: genuine V2 checkpoint migrates only basis metadata, preserving every old contribution and geometry', async () => {
  const text=await readFile('tests/fixtures/scientific-basis-v2.json','utf8'), old=JSON.parse(text);
  assert.equal(old.version,2);assert.equal(old.scientific.basis,undefined);
  const loaded=await loadAnyProject(text), project=loaded.project, doc=documentFromWorking(project);
  assert.equal(loaded.migrated,true);assert.equal(doc.version,4);assert.deepEqual(doc.sources,old.sources);assert.deepEqual(doc.views,old.views);
  for(const [id,op] of Object.entries(old.provenance.operations)) assert.deepEqual(doc.provenance.operations[id],op);
  for(const [key,head] of Object.entries(old.provenance.heads)) assert.deepEqual(doc.provenance.heads[key],head);
  assert.equal(Object.keys(doc.provenance.operations).length,Object.keys(old.provenance.operations).length+1);
  assert.deepEqual(doc.scientific.basis,defaultScientificBasis(project.sourceSha256));
  const saved=serializeProject(project), reloaded=await loadAnyProject(saved);assert.equal(reloaded.migrated,false);assert.equal(serializeProject(reloaded.project),saved);
  const corrupt=JSON.parse(text);corrupt.provenance.heads.scientific.revision='0'.repeat(64);await assert.rejects(loadAnyProject(JSON.stringify(corrupt)),/Provenance/);
  const disguised=JSON.parse(text);disguised.scientific.basis=defaultScientificBasis(project.sourceSha256);await assert.rejects(loadAnyProject(JSON.stringify(disguised)),/fields/);
});
test('T25: basis edits invalidate worker results and undo/redo restores basis, citations and revision atomically', async () => {
  const f=await fixture('new'),history=new History<WorkingProject>(), base=revision(f.project),view=f.project.authoring.activeViewId;
  assert.equal(isCurrentResult(f.project,base,view),true);
  const ref=userReference({title:'Example evidence',authors:[],year:null,doi:null,url:null,license:null}),basis=phylogeneticBasis(f.project);basis.referenceIds=[ref.id];
  const edited=acceptBasisEdit(f.project,basis,f.source,null,[ref]);history.push(f.project);
  assert.equal(isCurrentResult(edited,base,view),false);assert.equal(isCurrentResult(edited,revision(edited),'other-view'),false);
  const undone=history.undo(edited)!;assert.equal(revision(undone),base);assert.deepEqual(activeProvenance(undone).references,{});assert.equal(isCurrentResult(undone,base,view),true);
  assert.deepEqual(history.redo(undone),edited);await loadAnyProject(serializeProject(edited));
});
test('T25: basis metadata, escaped captions and unverified citations follow all finished-tree exports', async () => {
  const f=await fixture('new'),basis=phylogeneticBasis(f.project);basis.name='<script>Example</script>';basis.provider='My framework';basis.release='2026';basis.limitations='One hypothesis';
  const ref=userReference({title:'<b>Evidence</b>',authors:['A & B'],year:2026,doi:null,url:'https://example.org/',license:null});basis.referenceIds=[ref.id];
  const p=acceptBasisEdit(f.project,basis,f.source,null,[ref]),qa=validateGeometry(f.source,f.rooted,p.recipe,f.reduction,p.layout,p.presentation),files=exportFiles(f.source,f.rooted,f.reduction,p,qa);
  const provenance=JSON.parse(files['tree_provenance.json']);assert.equal(provenance.version,2);assert.deepEqual(provenance.basis,basis);
  assert.ok(Object.values(provenance.operations).some((op:any)=>op.notes.startsWith('Edited scientific-basis')));
  assert.deepEqual(provenance.heads.basis,p.authoring.provenance.heads.basis);
  assert.ok(files['tree-caption.txt'].includes(basis.name));
  for(const path of ['legend.html','print-sheet.html','sources-and-methods.html','tree_unlabeled.svg','tree_labeled.svg']){assert.ok(!files[path].includes('<script>'));assert.ok(files[path].includes('&lt;script&gt;Example&lt;/script&gt;'));}
  assert.match(files['sources-and-methods.html'],/unverified/);assert.ok(files['references.txt'].includes(ref.title));assert.ok(files['references.bib'].includes(ref.title));
  assert.equal(JSON.parse(files['artifact_manifest.json']).treeRevision,revision(p));
  assert.deepEqual((await loadAnyProject(files['tree.treeproject.json'])).project.authoring.basis,basis);
});
test('basis cannot forge rights, source ownership, evidence, citation identity or its own stable ID', async () => {
  const f=await fixture('new'),before=serializeProject(f.project);
  const changes=[(b:ScientificBasis)=>b.sourceIds=['source-'+ '0'.repeat(64)],(b:ScientificBasis)=>b.rightsRecordIds=['hug-2016-source'],(b:ScientificBasis)=>b.referenceIds=['unknown'],(b:ScientificBasis)=>b.id='different', (b:ScientificBasis)=>b.retrievedAt='2026-02-30', (b:ScientificBasis)=>b.evidenceBasis='', (b:ScientificBasis)=>b.name='', (b:ScientificBasis)=>Object.assign(b,{injected:true})];
  for(const change of changes){const basis=phylogeneticBasis(f.project);change(basis);assert.throws(()=>acceptBasisEdit(f.project,basis,f.source));assert.equal(serializeProject(f.project),before);}
  const forged={...userReference({title:'Example',authors:[],year:null,doi:null,url:null,license:null}),verification:'verified-source' as const};
  const basis=phylogeneticBasis(f.project);basis.referenceIds=[forged.id];assert.throws(()=>acceptBasisEdit(f.project,basis,f.source,null,[forged]),/unverified/);
  const malicious=userReference({title:'Example',authors:[],year:null,doi:null,url:'javascript:alert(1)',license:null});basis.referenceIds=[malicious.id];assert.throws(()=>acceptBasisEdit(f.project,basis,f.source,null,[malicious]),/HTTP/);
  const known=defaultScientificBasis('9829bbe7c058d7807c10fa63f7e6977087206e4355b60162ece4a45086540c61');known.rightsRecordIds=[];assert.throws(()=>validateScientificBasis(known,known.sourceIds[0].slice(7)),/obligations/);
});

test('replacing basis citations removes obsolete descriptions unless artwork still depends on them', async () => {
  const f=await fixture('new'),firstRef=userReference({title:'First source description',authors:[],year:null,doi:null,url:null,license:null}),secondRef=userReference({title:'Corrected source description',authors:[],year:null,doi:null,url:null,license:null});
  const firstBasis=phylogeneticBasis(f.project);firstBasis.referenceIds=[firstRef.id];
  const first=acceptBasisEdit(f.project,firstBasis,f.source,null,[firstRef]),secondBasis={...firstBasis,referenceIds:[secondRef.id]};
  const second=acceptBasisEdit(first,secondBasis,f.source,null,[secondRef]);
  assert.equal(activeProvenance(second).references[firstRef.id],undefined);assert.ok(activeProvenance(second).references[secondRef.id]);
  assert.equal(documentFromWorking(second).provenance.references[firstRef.id],undefined);
  const moved=structuredClone(first);moveNodes(moved.layout,f.rooted,['n000002'],{x:1,y:2});const withArtwork=acceptCommand(first,moved,f.source);
  const changed=acceptBasisEdit(withArtwork,secondBasis,f.source,null,[secondRef]);
  assert.ok(activeProvenance(changed).references[firstRef.id]);assert.ok(activeProvenance(changed).references[secondRef.id]);
  await loadAnyProject(serializeProject(changed));
});
