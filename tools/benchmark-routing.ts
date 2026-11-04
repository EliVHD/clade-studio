import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cpus, platform, arch } from 'node:os';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, validateGeometry } from '../src/geometry.ts';
import { DEFAULT_FIT_SETTINGS } from '../src/fit-settings.ts';
import { bindBorder, scopedEndpoints } from '../src/design.ts';
import type { EndpointBorder } from '../src/types.ts';

// An optional local module path allows same-machine comparison with a captured fitter.
const moduleUrl = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../src/fitting.ts', import.meta.url);
const fitterText = await readFile(moduleUrl, 'utf8');
const routingImport = fitterText.match(/from ['"]([^'"]*routing[^'"]*\.ts)['"]/);
const routingUrl = routingImport ? new URL(routingImport[1], moduleUrl) : null;
const executedRouting = routingUrl ? { module: routingUrl.href, sha256: createHash('sha256').update(await readFile(routingUrl)).digest('hex') } : null;
const { fitSilhouette } = await import(moduleUrl.href) as typeof import('../src/fitting.ts');
const source = await parseNewick(await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8'));
const recipe = { ...defaultRecipe(source), ...JSON.parse(await readFile(new URL('../data/example_reduction_recipe.json', import.meta.url), 'utf8')) };
const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe, true);
const presentation = structuredClone(DEFAULT_PRESENTATION);
const layout = generateLayout(rooted, reduction, presentation, 'organic');
const border: EndpointBorder = { id: 'bacteria', name: 'Bacterial crown', points: [{ x: 6, y: 116 }, { x: 8, y: 56 }, { x: 25, y: 22 }, { x: 40, y: 18 }], closed: false, placement: 'spread', insetMm: 1.5, variationMm: 1, seed: 7, assignments: [] };
bindBorder(border, scopedEndpoints(rooted, reduction, ['n000001']), rooted, layout);
const runs = [];
for (const smart of [false, true]) {
  const settings = { ...DEFAULT_FIT_SETTINGS, routing: smart ? .75 : 0, forkSpread: smart ? .65 : 0 };
  const start = performance.now();
  const result = fitSilhouette(rooted, reduction, layout, presentation, { borders: [border], activeBorderId: border.id, showBorders: true }, settings);
  const fitMs = performance.now() - start, qaStart = performance.now();
  const qa = validateGeometry(source, rooted, recipe, reduction, result.layout, presentation);
  runs.push({ smart, settings, fitMs: Math.round(fitMs), validationMs: Math.round(performance.now() - qaStart), contacts: qa.issues.filter(i => i.type === 'crossing' || i.type === 'self-intersection').length, clearanceIssues: qa.issues.filter(i => i.type === 'clearance').length, boundsIssues: qa.issues.filter(i => i.type === 'bounds').length, omittedIssueCount: qa.omittedIssueCount, minClearanceMm: qa.minClearanceMm, workLimitReached: result.routingLimited, refinedRoutes: result.refinedRoutes, diagnostics: result.routingDiagnostics ?? null, targetErrorMm: result.errorAfterMm, directionConflicts: result.directionConflicts, coveragePassed: qa.coveragePassed, incidencePassed: qa.incidencePassed, status: qa.status });
}
const inputPaths = ['src/geometry.ts', 'src/routing.ts', 'src/fitting.ts', 'tools/benchmark-routing.ts'];
const implementationFiles = await Promise.all(inputPaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(new URL('../' + path, import.meta.url))).digest('hex') })));
console.log(JSON.stringify({ format: 'clade-routing-benchmark', version: 1, node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, executedRouting, fitterModule: moduleUrl.href, fitterSha256: createHash('sha256').update(await readFile(moduleUrl)).digest('hex'), implementationFiles, sourceSha256: source.sha256, visibleEndpoints: reduction.frontier.length, assignedEndpoints: border.assignments.length, presentation, border, notes: ['Single-run timings are informational and require the same machine and settings for comparison.', 'Organic QA issue totals are exact only when omittedIssueCount is zero.', 'Partial-strength proposals receive their own final QA in the worker; no full-strength QA is reused.'], runs }, null, 2));
