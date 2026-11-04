import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareLocalImport } from '../src/import.ts';
import { sampleTree, classificationSample } from '../src/structured/example.ts';
import { serializeProject } from '../src/project-v2.ts';
import { searchSource } from '../src/search.ts';
import { makeClassificationView } from '../src/structured/view.ts';
import { projectClassification } from '../src/structured/classification.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements } from '../src/structured/layout.ts';
import { acceptCommand } from '../src/commands.ts';
const selection={selection:{kind:'all' as const},collapse:[],expand:[],reveal:[],childOrder:{}};

test('staged Newick import keeps exact source, duplicate identities and searchable labels without mutating the current project',async()=>{
  const f=await sampleTree(),before=structuredClone(f),text='((Homo_sapiens:1,Homo_sapiens:2)Primates:3,Quercus_robur:4);\n';
  const imported=await prepareLocalImport(text,'my-relations.nwk',null,{source:f.source,recipe:f.project.recipe});assert.equal(imported.kind,'newick');if(imported.kind==='recipe')return;
  assert.equal(imported.source.text,text);assert.equal(imported.project.title,'my-relations');assert.equal(imported.project.authoring.basis.relationshipKind,'unspecified');assert.equal(imported.project.authoring.root.status,'unspecified');assert.deepEqual(imported.project.authoring.source.referenceIds,[]);
  assert.equal(searchSource(imported.source,'homo sapiens').total,2);assert.equal(searchSource(imported.source,'Primates').results[0].kind,'group');assert.deepEqual(imported.project.recipe.resolvedFrontierSourceNodeIds,imported.reduction.frontier.map(n=>n.id));assert.equal(imported.scientificLayout.mode,'scientific');assert.deepEqual(f,before);
});
test('staged project import retains exact artwork, pins and provenance before any UI replacement',async()=>{
  const f=await sampleTree(),proposal=structuredClone(f.project);proposal.layout.pinnedNodes=[f.rooted.rootId];f.project=acceptCommand(f.project,proposal,f.source,{notes:'Pin the source junction before import testing.'});const text=serializeProject(f.project),current=await sampleTree(),before=structuredClone(current);
  const imported=await prepareLocalImport(text,'saved.treeproject.json',null,{source:current.source,recipe:current.project.recipe});assert.equal(imported.kind,'project');if(imported.kind==='recipe')return;
  assert.deepEqual(imported.project.layout,f.project.layout);assert.deepEqual(imported.project.authoring.provenance,f.project.authoring.provenance);assert.equal(imported.source.text,f.source.text);assert.equal(imported.migrated,false);assert.deepEqual(current,before);
});
test('malformed, foreign, future and tampered files fail staging with the existing source, recipe and geometry unchanged',async()=>{
  const f=await sampleTree(),before=structuredClone(f),bad=JSON.parse(serializeProject(f.project));bad.sources[bad.scientific.primarySourceId].sha256='0'.repeat(64);
  for(const text of ['((broken;', '{bad json}', '{"unrelated":true}', '{"format":"phylogenetic-tree-studio","version":999}',JSON.stringify(bad)])await assert.rejects(prepareLocalImport(text,'invalid',null,{source:f.source,recipe:f.project.recipe}));
  assert.deepEqual(f,before);
});
test('reduction recipes are staged separately, replayed against current source and rejected on a different root or source',async()=>{
  const f=await sampleTree(),before=structuredClone(f),recipe=structuredClone(f.project.recipe);recipe.globalThreshold=0;
  const imported=await prepareLocalImport(JSON.stringify(recipe),'recipe.json',null,{source:f.source,recipe:f.project.recipe});assert.equal(imported.kind,'recipe');if(imported.kind!=='recipe')return;assert.deepEqual(imported.recipe,recipe);
  const wrongRoot={...recipe,root:{kind:'node',sourceNodeId:'n000001',status:'declared_assumption'}};
  await assert.rejects(prepareLocalImport(JSON.stringify(wrongRoot),'root.json',null,{source:f.source,recipe:f.project.recipe}),/different root|frontier/);
  await assert.rejects(prepareLocalImport(JSON.stringify({...recipe,sourceSha256:'0'.repeat(64)}),'foreign.json',null,{source:f.source,recipe:f.project.recipe}),/source|Source|checksum/);assert.deepEqual(f,before);
});
test('local classification projects preserve their accepted rank scene, unknown status and independent input during staging',async()=>{
  const f=await classificationSample(),g=projectClassification(f.source,selection),measurements=estimatedMeasurements(g,DEFAULT_STRUCTURED),view=makeClassificationView(f.project,f.source,selection,DEFAULT_STRUCTURED,measurements,f.spec,'classification-import','Local hierarchy'),proposal=structuredClone(f.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(f.project,proposal,f.source,{methods:['classification-projection','classification-rank-layout','classification-validation'],replace:true}),imported=await prepareLocalImport(serializeProject(project),'hierarchy.json',null,{source:f.source,recipe:f.project.recipe});assert.equal(imported.kind,'project');if(imported.kind==='recipe')return;
  assert.equal(imported.project.authoring.activeStructuredViewId,view.id);assert.deepEqual(imported.project.authoring.structuredViews![view.id],view);assert.equal(imported.project.authoring.basis.relationshipKind,'classification');
});
test('staging rejects excessive input before JSON parsing or source replacement',async()=>{
  const f=await sampleTree(),before=structuredClone(f);await assert.rejects(prepareLocalImport(' '.repeat(50_000_001),'too-large.txt',null,{source:f.source,recipe:f.project.recipe}),/50 MB/);assert.deepEqual(f,before);
});
