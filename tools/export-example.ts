import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, validateGeometry } from '../src/geometry.ts';
import { routingDemo } from '../src/demo.ts';
import { exportFiles, zipFiles } from '../src/export.ts';
import type { Project } from '../src/types.ts';
import { startAuthoring } from '../src/project-v2.ts';
import { addArtifactManifest } from '../src/export-provenance.ts';
import { contentDigest } from '../src/provenance/identity.ts';

const source = await parseNewick(await readFile('data/source_tree.nwk', 'utf8'));
const provenance = JSON.parse(await readFile('data/source_manifest.json', 'utf8'));
const corrections = JSON.parse(await readFile('data/annotation_review.json', 'utf8'));
const fixture = JSON.parse(await readFile('data/example_reduction_recipe.json', 'utf8'));
// This CLI executes TypeScript sources directly, so never borrow a possibly stale browser stamp.
const { filesUnder } = await import('./distribution-policy.mjs');
const { readRegular, sha256 } = await import('./release-manifest.mjs');
const cliPaths = [...(await filesUnder('src')).map(name => `src/${name}`), 'tools/export-example.ts', 'tools/distribution-policy.mjs', 'tools/release-manifest.mjs', 'package-lock.json'].sort();
const cliFiles = await Promise.all(cliPaths.map(async path => { const bytes = await readRegular('.', path); return { path, bytes: bytes.length, sha256: sha256(bytes) }; }));
const cliManifest = { format: 'clade-build-manifest' as const, version: 1 as const, appVersion: '0.1.0', files: cliFiles };
const exportingBuild = { format: 'clade-build-info' as const, version: 1 as const, appVersion: '0.1.0', buildId: await contentDigest(cliManifest), manifest: 'build-manifest.json' as const };
const recipe = { ...defaultRecipe(source), ...fixture }, rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe, true);
const base: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Hug 2016 — initial arrangement', sourceText: source.text, sourceSha256: source.sha256, provenance, corrections, recipe, layout: generateLayout(rooted, reduction, DEFAULT_PRESENTATION, 'organic'), presentation: structuredClone(DEFAULT_PRESENTATION) };
const summary = [];
for (const [name, project] of [['example-150', base], ['routing-demo', { ...base, ...routingDemo(source), title: 'Hug source — crown-to-root routing demonstration' }]] as [string, Project][]) {
  const start = performance.now(), tree = orient(source, project.recipe.root), frontier = reduce(source, tree, project.recipe, true);
  const qa = validateGeometry(source, tree, project.recipe, frontier, project.layout, project.presentation);
  const tracked = startAuthoring(project, source, exportingBuild, 'new', ['newick-parser', 'maximal-frontier', name === 'routing-demo' ? 'routing-demo' : 'organic-initializer']);
  const files = exportFiles(source, tree, frontier, tracked, qa, exportingBuild), dir = `outputs/${name}`;
  files['build-manifest.json'] = JSON.stringify(cliManifest, null, 2);
  addArtifactManifest(files, tracked);
  await mkdir(dir, { recursive: true });
  for (const [filename, data] of Object.entries(files)) await writeFile(`${dir}/${filename}`, data);
  await writeFile(`outputs/${name}.zip`, zipFiles(files));
  summary.push({ name, endpoints: frontier.frontier.length, visibleEdges: frontier.visible.length - 1, validationAndExportMs: Math.round(performance.now() - start), status: qa.status, sourceCoverage: qa.coveragePassed, incidence: qa.incidencePassed, noStrokeContacts: qa.crossingPassed, clearance: qa.clearancePassed, labelCollisions: qa.annotationCollisions, issues: qa.issues.reduce((counts, issue) => { counts[issue.type] = (counts[issue.type] ?? 0) + 1; return counts; }, {} as Record<string, number>) });
}
await writeFile('outputs/example-verification.json', JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
