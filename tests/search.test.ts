import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewick } from '../src/newick.ts';
import { searchSource } from '../src/search.ts';
import type { Correction } from '../src/types.ts';

test('local search finds imported organism and group labels with spaces, underscores, case and source IDs',async()=>{
  const source=await parseNewick('((Homo_sapiens,Pan_troglodytes)Primates,Quercus_robur)Life;'),human=source.tips.find(id=>source.nodes[id].label==='Homo_sapiens')!;
  for(const query of ['homo sapiens','HOMO_SAPIENS','  Homo   sapiens ',human.toUpperCase()])assert.deepEqual(searchSource(source,query).results.map(r=>r.id),[human]);
  assert.equal(searchSource(source,'Primates').results[0].kind,'group');assert.equal(searchSource(source,'Primates',[],{tipsOnly:true}).total,0);assert.equal(searchSource(source,'troglodytes Pan').total,1);
});
test('corrected names and original names both find the same exact tip without mutating imported data',async()=>{
  const source=await parseNewick('(old_identifier,Other);'),id=source.tips[0],before=structuredClone(source),corrections:Correction[]=[{source_node_id:id,raw_label:source.nodes[id].rawLabel,display_taxonomy:'Common organism name',status:'author-supplied',evidence_url:null,review_date:'2026-10-28'}];
  for(const query of ['Common organism','old identifier',id]){const found=searchSource(source,query,corrections,{tipsOnly:true});assert.equal(found.total,1);assert.equal(found.results[0].id,id);assert.equal(found.results[0].label,'Common organism name');assert.equal(found.results[0].originalLabel,'old_identifier');}assert.deepEqual(source,before);
});
test('duplicate organism names remain separate source identities and exact matches precede partial matches',async()=>{
  const source=await parseNewick('(A_long,A,A);'),result=searchSource(source,'A',[],{tipsOnly:true});assert.equal(result.total,3);assert.deepEqual(result.results.map(r=>r.label),['A','A','A_long']);assert.equal(new Set(result.results.map(r=>r.id)).size,3);
});
test('every local search result is reachable across pages, including endpoints hidden in a reduced view',async()=>{
  const source=await parseNewick('('+Array.from({length:81},(_,i)=>'Organism_'+i).join(',')+');'),ids:string[]=[];
  for(let offset=0;offset<81;offset+=25){const page=searchSource(source,'Organism',[],{tipsOnly:true,offset,limit:25});assert.equal(page.total,81);assert.equal(page.offset,offset);ids.push(...page.results.map(r=>r.id));}assert.deepEqual(ids,source.tips);assert.equal(searchSource(source,'Organism',[],{offset:1000}).offset,0);
});
test('search follows only the currently supplied file and does not resolve names absent from that file',async()=>{
  const a=await parseNewick('(Homo_sapiens,A);'),b=await parseNewick('(Quercus_robur,B);');assert.equal(searchSource(a,'Homo').total,1);assert.equal(searchSource(b,'Homo').total,0);assert.equal(searchSource(a,'human').total,0);assert.equal(searchSource(b,'Quercus').total,1);
});
test('literal punctuation, Unicode compatibility and empty queries behave predictably without regex interpretation',async()=>{
  const source=await parseNewick("('C++ [literal]','Fullwidth Ａ','Å organism');");assert.equal(searchSource(source,'C++ [literal]').total,1);assert.equal(searchSource(source,'.*').total,0);assert.equal(searchSource(source,'Fullwidth A').total,1);assert.equal(searchSource(source,'Å ORGANISM').total,1);assert.equal(searchSource(source,'  ').total,0);
  for(const options of [{limit:0},{limit:101},{offset:-1},{offset:1.5}])assert.throws(()=>searchSource(source,'A',[],options),/page/);
});
