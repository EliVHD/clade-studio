import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { BUNDLED_DATASETS, bundledDataset, sourceHeading } from '../src/datasets.ts';
import { prepareBundledDataset, prepareLocalImport, overviewRecipe } from '../src/import.ts';
import { documentFromWorking, serializeProject, loadAnyProject } from '../src/project-v2.ts';
import { acceptBasisEdit, acceptCommand } from '../src/commands.ts';
import { provenanceFiles } from '../src/export-provenance.ts';
import { searchSource } from '../src/search.ts';
import { parseNewick } from '../src/newick.ts';
import { sampleTree } from '../src/structured/example.ts';
import { projectTree } from '../src/structured/projection.ts';
import { makeStructuredView } from '../src/structured/view.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements } from '../src/structured/layout.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { schemaValid } from './schema-check.ts';

for (const d of BUNDLED_DATASETS) test(`${d.id}: pinned data, exhaustive bounded overview, curated references and V4 round trip`, async () => {
  const text=await readFile(`data/${d.file}`,'utf8'),f=await prepareBundledDataset(d.id,text,null);
  assert.equal(createHash('sha256').update(text).digest('hex'),d.sha256);
  assert.equal(f.source.tips.length,d.tipCount);assert.equal(f.source.order.length,d.nodeCount);
  assert.ok(f.reduction.frontier.length<=100);assert.equal(f.project.recipe.globalThreshold,0);
  const members=f.reduction.frontier.flatMap(n=>n.members);
  assert.equal(new Set(members).size,d.tipCount);assert.deepEqual([...members].sort(),[...f.source.tips].sort());
  assert.deepEqual(f.project.authoring.source.referenceIds,d.references.map(ref=>ref.id));
  assert.deepEqual(f.project.authoring.basis.rightsRecordIds,[d.rightsId]);
  assert.equal(f.project.authoring.source.metadataStatus,'curated');assert.ok(f.project.authoring.provenance.methods['bounded-overview@1.0.0']);
  if(d.id!=='hug-2016'){assert.equal(f.project.authoring.root.status,'rooted');assert.equal(f.project.authoring.edgeMeasure,null);}
  const {resolvedFrontierSourceNodeIds:_frontier,...recipe}=f.project.recipe;assert.deepEqual(overviewRecipe(f.source),recipe);
  const saved=serializeProject(f.project),restored=await loadAnyProject(saved);
  assert.equal(restored.source.text,text);assert.deepEqual(restored.project.authoring.basis,f.project.authoring.basis);assert.deepEqual(restored.project.authoring.provenance,f.project.authoring.provenance);
  const schema=JSON.parse(await readFile('public/project-v4.schema.json','utf8'));assert.ok(schemaValid(JSON.parse(saved),schema,schema));
  const files=provenanceFiles(f.project),report=files['sources-and-methods.html'];
  for(const ref of d.references){assert.ok(report.includes(ref.title.replaceAll('&','&amp;')));assert.ok(files['references.bib'].includes(ref.doi??ref.url!));}
  assert.ok(report.includes(d.licenseUrl));assert.ok(report.includes(d.release));assert.equal(JSON.parse(files['tree_provenance.json']).bundledDataset.sha256,d.sha256);
});

test('dataset bytes, not filenames or provenance labels, determine attribution and dynamic headings',async()=>{
  const current=await sampleTree(),d=BUNDLED_DATASETS[1],text=await readFile(`data/${d.file}`,'utf8');
  await assert.rejects(prepareBundledDataset(d.id,text+' ',null),/checksum/);
  await assert.rejects(prepareBundledDataset('missing',text,null),/Unknown/);
  const imported=await prepareLocalImport(text,'unrelated-filename.nwk',null,{source:current.source,recipe:current.project.recipe});if(imported.kind==='recipe')assert.fail();
  assert.equal(imported.project.authoring.basis.name,d.name);assert.equal(sourceHeading(d.sha256,{kind:'synthetic-sample-tree'}).title,d.shortCitation);
  const foreign=await prepareLocalImport('(Homo_sapiens:1,Pan_troglodytes:1);','upham-2019.nwk',null,{source:current.source,recipe:current.project.recipe});if(foreign.kind==='recipe')assert.fail();
  assert.equal(bundledDataset(foreign.source.sha256),undefined);assert.equal(foreign.project.authoring.source.metadataStatus,'incomplete');assert.deepEqual(foreign.project.authoring.source.referenceIds,[]);assert.equal(sourceHeading(foreign.source.sha256,foreign.project.provenance).title,'Imported Newick');
  assert.equal(sourceHeading(current.source.sha256,current.project.provenance).title,'Synthetic sample');
});
test('bundled rights and references survive basis edits and reject tampered saved citations',async()=>{
  const d=BUNDLED_DATASETS.find(d=>d.id==='dos-reis-2018')!,f=await prepareBundledDataset(d.id,await readFile(`data/${d.file}`,'utf8'),null),basis=structuredClone(f.project.authoring.basis);
  basis.rightsRecordIds=[];assert.throws(()=>acceptBasisEdit(f.project,basis,f.source),/redistribution/);
  basis.rightsRecordIds=[d.rightsId];basis.referenceIds=[];assert.throws(()=>acceptBasisEdit(f.project,basis,f.source),/citations/);
  const doc=documentFromWorking(f.project);doc.provenance.references[d.references[0].id].title='Changed citation';await assert.rejects(loadAnyProject(JSON.stringify(doc)));
  const renamed=structuredClone(f.project.authoring.basis);renamed.name='My primate design';const edited=acceptBasisEdit(f.project,renamed,f.source);assert.equal(sourceHeading(f.source.sha256,edited.provenance,renamed.name).title,d.shortCitation);
});
test('complete plant source stays searchable behind its overview and selected circular exports retain only its data citations',async()=>{
  const d=BUNDLED_DATASETS.find(d=>d.id==='kew-4-species')!,f=await prepareBundledDataset(d.id,await readFile(`data/${d.file}`,'utf8'),null);
  const matches=searchSource(f.source,'Arabidopsis thaliana');assert.ok(matches.total>0);assert.ok(searchSource(f.source,'Quercus').total>0);
  const selection={selection:{kind:'explicit-tips' as const,tipIds:[matches.results[0].id,f.source.tips[0]]},collapse:[],expand:[],reveal:[],childOrder:{}},graph=projectTree(f.source,f.rooted,selection),settings={...DEFAULT_STRUCTURED,kind:'circular' as const};
  const view=makeStructuredView(f.project,f.source,selection,settings,estimatedMeasurements(graph,settings),'plant-circle','Two sampled plants'),proposal=structuredClone(f.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(f.project,proposal,f.source,{methods:['selected-taxon-projection','clade-cluster','compound-validation'],replace:true});
  const files=exportStructuredFiles(f.source,project);assert.ok(files['sources-and-methods.html'].includes('Kew Tree of Life'));assert.ok(!files['references.bib'].includes('nmicrobiol.2016.48'));assert.ok(files['references.bib'].includes('https://treeoflife.kew.org/data-access'));assert.equal(view.graph.representedTips.length,2);assert.equal(view.graph.omittedTips.length,d.tipCount-2);
});
test('source counts and extraction audit match rights records for every new tree',async()=>{
  const audit=JSON.parse(await readFile('data/datasets/audit.json','utf8')),review=JSON.parse(await readFile('release/components.json','utf8'));
  for(const d of BUNDLED_DATASETS.slice(1)){const entry=audit.files.find((f:{path:string})=>f.path===`data/${d.file}`),component=review.components.find((c:{id:string})=>c.id===d.rightsId);assert.equal(entry.sha256,d.sha256);assert.equal(entry.terminals,d.tipCount);assert.equal(component.sha256[`data/${d.file}`],d.sha256);assert.equal(component.licenseExpression,d.license);}
  const s=await parseNewick('((A,B,C),D);');assert.throws(()=>overviewRecipe(s,1),/limit/);
});
