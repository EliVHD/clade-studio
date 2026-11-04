import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { platform, arch, cpus } from 'node:os';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, layoutCluster } from '../src/structured/layout.ts';
import { validateScene } from '../src/structured/validate.ts';
import { improveReadability } from '../src/structured/readability.ts';
import { contentDigest } from '../src/provenance/identity.ts';
import type { StructuredSettings, DisplayGraph } from '../src/structured/types.ts';

const { filesUnder } = await import('./distribution-policy.mjs');
const { readRegular, sha256 } = await import('./release-manifest.mjs');
const inputPaths = [...(await filesUnder('src')).map(path=>`src/${path}`),'tools/benchmark-structured.ts','tools/distribution-policy.mjs','tools/release-manifest.mjs','package-lock.json'].sort();
const implementationFiles = await Promise.all(inputPaths.map(async path=>{const bytes=await readRegular('.',path);return {path,sha256:sha256(bytes)};}));
const implementationDigest = await contentDigest(implementationFiles);
const source = await parseNewick(await readFile('data/source_tree.nwk', 'utf8'));
const recipe = { ...defaultRecipe(source), ...JSON.parse(await readFile('data/example_reduction_recipe.json', 'utf8')) };
const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe, true);
const projection = { selection: { kind: 'all' as const }, collapse: reduction.frontier.filter(n => rooted.nodes[n.id].children.length).map(n => n.id), expand: [], reveal: [], childOrder: {} };
const sourceGraph = projectTree(source, rooted, projection, JSON.parse(await readFile('data/annotation_review.json', 'utf8')));
const jobs: { name: string; graph: DisplayGraph; settings: StructuredSettings }[] = ['circular','rectangular'].map(kind => ({name:`Hug 3083 tips / 150 groups / ${kind}`,graph:sourceGraph,settings:{...DEFAULT_STRUCTURED,kind:kind as StructuredSettings['kind']}}));
for (const count of [80,300,600]) {
  const sample = await parseNewick('('+Array.from({length:count},(_,i)=>`'Synthetic long label ${i}':1`).join(',')+');');
  jobs.push({name:`Synthetic star ${count}`,graph:projectTree(sample,orient(sample,defaultRecipe(sample).root),{...projection,collapse:[]}),settings:{...DEFAULT_STRUCTURED,kind:'circular',outerRadiusMm:20,widthMm:120,heightMm:120}});
}
for (const count of [300,600]) {
  const sample = await parseNewick('('+Array.from({length:count},(_,i)=>`T${i}:1`).join(',')+');');
  jobs.push({name:`Spacious star ${count}`,graph:projectTree(sample,orient(sample,defaultRecipe(sample).root),{...projection,collapse:[]}),settings:{...DEFAULT_STRUCTURED,kind:'circular',innerRadiusMm:300,outerRadiusMm:500,widthMm:1200,heightMm:1200}});
}
let terminal=0;
const balanced=(depth:number):string=>depth?`(${balanced(depth-1)},${balanced(depth-1)}):1`:`B${terminal++}:1`;
const balancedSource=await parseNewick(`${balanced(8)};`);
jobs.push({name:'Balanced 256 tips',graph:projectTree(balancedSource,orient(balancedSource,defaultRecipe(balancedSource).root),{...projection,collapse:[]}),settings:{...DEFAULT_STRUCTURED,kind:'rectangular'}});
let comb='C0:1';
for(let i=1;i<150;i++)comb=`(${comb},C${i}:1):1`;
const combSource=await parseNewick(`${comb};`);
jobs.push({name:'Comb 150 tips',graph:projectTree(combSource,orient(combSource,defaultRecipe(combSource).root),{...projection,collapse:[]}),settings:{...DEFAULT_STRUCTURED,kind:'rectangular'}});
const results = [];
for (const job of jobs) {
  const metrics = estimatedMeasurements(job.graph,job.settings), start = performance.now();
  const baseline = layoutCluster(job.graph,job.settings,metrics), qa = validateScene(job.graph,baseline), baselineMs = performance.now()-start;
  const begin = performance.now(), improved = improveReadability(job.graph,job.settings,metrics,'grow-page');
  results.push({name:job.name,sourceSha256:job.graph.sourceSha256,settings:job.settings,nodes:job.graph.order.length,endpoints:job.graph.endpoints.length,baselineMs:Math.round(baselineMs),readabilityMs:Math.round(performance.now()-begin),...improved.readability,beforeLimited:qa.limited,afterLimited:improved.qa.limited,beforeCounts:qa.issueCounts,afterCounts:improved.qa.issueCounts,beforeCompleteness:qa.completeness,afterCompleteness:improved.qa.completeness,beforeWork:qa.work,afterWork:improved.qa.work,fontStatus:metrics.fontStatus});
}
const report={implementationDigest,implementationFiles,date:new Date().toISOString(),node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model,notes:['Single-run local timings; not a portable latency guarantee.','Estimated text metrics used, so outputs deliberately remain drafts. Browser measurement is tested separately.','Readability worker is cancellable; up to eight candidates, each with the existing 500000-comparison QA cap.'],results};
await mkdir('outputs',{recursive:true});await writeFile('outputs/structured-benchmark.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
