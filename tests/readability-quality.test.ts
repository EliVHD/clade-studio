import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient } from '../src/science.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, layoutCluster } from '../src/structured/layout.ts';
import { improveReadability } from '../src/structured/readability.ts';
import { validateScene } from '../src/structured/validate.ts';
import { sceneChecksComplete, sceneContactSummary, sceneIncidenceSummary, sceneIssueCount } from '../src/structured/qa-summary.ts';

const projection={selection:{kind:'all' as const},collapse:[],expand:[],reveal:[],childOrder:{}};

test('readability reports full conflict totals beyond the bounded issue examples',async()=>{
  const source=await parseNewick('('+Array.from({length:180},(_,i)=>`'Long terminal ${i}':1`).join(',')+');');
  const graph=projectTree(source,orient(source,defaultRecipe(source).root),projection);
  const settings={...DEFAULT_STRUCTURED,kind:'circular' as const,strokeMm:1.5,outerRadiusMm:20,widthMm:120,heightMm:120};
  const metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const baseline=validateScene(graph,layoutCluster(graph,settings,metrics));
  assert.ok(baseline.omittedIssueCount>0,'fixture must exceed the example cap');
  assert.ok(baseline.issueCounts);
  const result=improveReadability(graph,settings,metrics,'keep-page');
  assert.equal(result.readability.before.contacts,baseline.issueCounts.contact);
  assert.equal(result.readability.before.clearanceIssues,baseline.issueCounts.clearance);
  assert.equal(result.readability.after.contacts,result.qa.issueCounts!.contact);
  assert.equal(result.readability.after.clearanceIssues,result.qa.issueCounts!.clearance);
  assert.equal(result.scene.settings.widthMm,settings.widthMm);
  assert.equal(result.scene.settings.heightMm,settings.heightMm);
  assert.deepEqual(result.scene.measurements,metrics);
});

test('spacious larger drawings retain exact settings and fully checked zero-conflict summaries',async()=>{
  const source=await parseNewick('('+Array.from({length:600},(_,i)=>`T${i}:1`).join(',')+');');
  const graph=projectTree(source,orient(source,defaultRecipe(source).root),projection);
  const settings={...DEFAULT_STRUCTURED,kind:'circular' as const,innerRadiusMm:300,outerRadiusMm:500,widthMm:1200,heightMm:1200};
  const metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const before=layoutCluster(graph,settings,metrics);
  const result=improveReadability(graph,settings,metrics,'grow-page');
  assert.equal(sceneChecksComplete(result.qa),true);
  assert.equal(sceneContactSummary(result.qa),'No detected contacts');
  assert.equal(result.readability.before.contacts,0);
  assert.equal(result.readability.after.contacts,0);
  assert.equal(result.readability.improved,false);
  assert.equal(result.scene.revision,before.revision);
  assert.equal(result.readability.candidates,1);
});

test('status reporting distinguishes incomplete checks from historical bounded examples',()=>{
  const qa={status:'draft' as const,coveragePassed:true,incidencePassed:true,crossingPassed:true,clearancePassed:true,labelCollisions:0,issues:[],omittedIssueCount:0,checkedPairs:0,limited:true,limitations:[]};
  assert.equal(sceneChecksComplete(qa),false);
  assert.equal(sceneContactSummary(qa),'Contact check incomplete');
  assert.equal(sceneIssueCount(qa,'contact'),0);
  assert.equal(sceneContactSummary({...qa,completeness:{strokes:true,labels:false}}),'No detected contacts');
  assert.equal(sceneChecksComplete({...qa,limited:false,completeness:{strokes:false,labels:true}}),false);
  assert.equal(sceneChecksComplete({...qa,limited:false,completeness:{incidence:false,strokes:true,labels:true}}),false);
  assert.equal(sceneIncidenceSummary({...qa,completeness:{incidence:false,strokes:false,labels:false}}),'incomplete');
  assert.equal(sceneIncidenceSummary({...qa,limited:false,incidencePassed:false}),'review');
  assert.equal(sceneIncidenceSummary({...qa,limited:false}),'pass');
});

test('a readable rectangular scene does not grow repeatedly around its fixed left margin',async()=>{
  const source=await parseNewick('((A:1,B:1):1,(C:1,D:1):1);');
  const graph=projectTree(source,orient(source,defaultRecipe(source).root),projection);
  const settings={...DEFAULT_STRUCTURED};
  const metrics=estimatedMeasurements(graph,settings);metrics.fontStatus='available';
  const before=layoutCluster(graph,settings,metrics);
  assert.equal(validateScene(graph,before).status,'checked');
  const result=improveReadability(graph,settings,metrics,'grow-page');
  assert.equal(result.readability.improved,false);
  assert.equal(result.readability.candidates,1);
  assert.equal(result.scene.revision,before.revision);
});
