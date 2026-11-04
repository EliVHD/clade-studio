import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, createInspectionLayout, generateLayout, validateGeometry, flattenedEdge, pathData } from '../src/geometry.ts';
import { loadProject } from '../src/project.ts';
import type { Presentation, Project } from '../src/types.ts';

async function fixture(text: string, overrides: Partial<Presentation> = {}) {
  const source = await parseNewick(text), recipe = defaultRecipe(source);
  recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(entry => entry.id);
  const presentation = { ...structuredClone(DEFAULT_PRESENTATION), ...overrides };
  return { source, recipe, rooted, reduction, presentation };
}

test('inspection uses ordered finite shared junctions for feasible balanced, comb, polytomy and unary trees', async () => {
  let comb = 'T0:1';
  for (let index = 1; index < 9; index++) comb = `(${comb},T${index}:1):1`;
  const inputs = [
    '(A:1,B:1);', '(A:1,B:1,C:1,D:1);',
    '((A:1,B:1):1,(C:1,D:1):1);',
    '(((A:1,B:1):1,(C:1,D:1):1):1,((E:1,F:1):1,(G:1,H:1):1):1);',
    comb + ';', '(((A:1):1):1);', 'A;',
  ];
  for (const text of inputs) {
    const f = await fixture(text), before = structuredClone(f);
    const layout = createInspectionLayout(f.rooted, f.reduction, f.presentation);
    const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, layout, f.presentation);
    assert.equal(qa.incidencePassed, true, text);
    assert.equal(qa.crossingPassed, true, text);
    assert.equal(qa.issues.some(issue => issue.type === 'bounds'), false, text);
    assert.deepEqual(f, before);
    assert.equal(Object.keys(layout.nodes).length, f.reduction.visible.length);
    assert.ok(Object.values(layout.nodes).every(point => Number.isFinite(point.x) && Number.isFinite(point.y)));
    const tips = f.reduction.frontier.map(entry => layout.nodes[entry.id]);
    for (let index = 1; index < tips.length; index++) assert.ok(tips[index].y > tips[index - 1].y);
    for (const id of f.reduction.visible) {
      const parent = f.rooted.nodes[id].parent;
      if (!parent) continue;
      assert.ok(layout.nodes[id].x > layout.nodes[parent].x);
      assert.deepEqual(layout.routes[id].segments.at(-1)!.end, layout.nodes[id]);
      assert.deepEqual(flattenedEdge(f.rooted, layout, id, .001)[0], layout.nodes[parent]);
    }
    assert.deepEqual(generateLayout(f.rooted, f.reduction, f.presentation, 'scientific'), layout);
  }
});

test('nonmetric inspection geometry ignores source lengths and centers a single endpoint', async () => {
  const first = await fixture('((A:1,B:2):3,C:4);');
  const changed = await fixture('((A:1000,B:0):0.0001,C:20000);');
  assert.deepEqual(createInspectionLayout(first.rooted, first.reduction, first.presentation), createInspectionLayout(changed.rooted, changed.reduction, changed.presentation));
  const single = await fixture('A;'), layout = createInspectionLayout(single.rooted, single.reduction, single.presentation);
  assert.deepEqual(layout.nodes[single.rooted.rootId], { x: single.presentation.widthMm / 2, y: single.presentation.heightMm / 2 });
  assert.deepEqual(layout.routes, {});
});

test('inspection respects child ordering and line appearance without mutating accepted artwork', async () => {
  const f = await fixture('((A:1,B:1):1,(C:1,D:1):1);');
  const original = generateLayout(f.rooted, f.reduction, f.presentation, 'organic');
  original.childOrder[f.rooted.rootId] = [...f.rooted.nodes[f.rooted.rootId].children].reverse();
  original.pinnedNodes = [f.reduction.frontier[0].id];
  original.lineStyle = 'straight';
  const before = structuredClone(original);
  const straight = createInspectionLayout(f.rooted, f.reduction, f.presentation, original);
  assert.deepEqual(original, before);
  assert.equal(straight.lineStyle, 'straight');
  assert.deepEqual(straight.pinnedNodes, []);
  const children = original.childOrder[f.rooted.rootId];
  assert.ok(straight.nodes[children[0]].y < straight.nodes[children[1]].y);
  const curved = structuredClone(straight); curved.lineStyle = 'curved';
  const a = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, straight, f.presentation);
  const b = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, curved, f.presentation);
  assert.deepEqual(a.issues, b.issues);
  for (const id of Object.keys(straight.routes)) {
    assert.deepEqual(flattenedEdge(f.rooted, straight, id, .001), flattenedEdge(f.rooted, curved, id, .001));
    assert.match(pathData(f.rooted, straight, id), /L/);
    assert.match(pathData(f.rooted, curved, id), /C/);
  }
});

test('Hug 150-endpoint inspection reduces default contacts and clearance failures on the fixed page', async () => {
  const source = await parseNewick(await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8'));
  const recipe = { ...defaultRecipe(source), ...JSON.parse(await readFile(new URL('../data/example_reduction_recipe.json', import.meta.url), 'utf8')) };
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe, true);
  assert.equal(reduction.frontier.length, 150);
  for (const taper of [0, DEFAULT_PRESENTATION.taper]) {
    const presentation = { ...structuredClone(DEFAULT_PRESENTATION), taper };
    const layout = createInspectionLayout(rooted, reduction, presentation);
    const qa = validateGeometry(source, rooted, recipe, reduction, layout, presentation);
    assert.equal(qa.coveragePassed, true);
    assert.equal(qa.incidencePassed, true);
    assert.equal(qa.crossingPassed, true);
    assert.ok(qa.issues.filter(issue => issue.type === 'crossing').length < 203);
    assert.ok(qa.issues.filter(issue => issue.type === 'clearance').length <= 168);
    assert.deepEqual(presentation, { ...DEFAULT_PRESENTATION, labelOffsets: {}, taper });
    assert.deepEqual(layout, createInspectionLayout(rooted, reduction, presentation));
  }
});

test('physically crowded inspection remains a draft without changing page size or sampling', async () => {
  const f = await fixture('(' + Array.from({ length: 64 }, (_, index) => `T${index}:1`).join(',') + ');', { widthMm: 90, heightMm: 50, strokeMm: 1.2 });
  const before = structuredClone(f.presentation), layout = createInspectionLayout(f.rooted, f.reduction, f.presentation);
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, layout, f.presentation);
  assert.equal(qa.status, 'draft');
  assert.equal(qa.crossingPassed, false);
  assert.equal(Object.keys(layout.routes).length, 64);
  assert.deepEqual(f.presentation, before);
});

test('loading stored normalized inspection preserves legacy geometry rather than regenerating it', async () => {
  const f = await fixture('((A:1,B:2):3,C:4);');
  const layout = createInspectionLayout(f.rooted, f.reduction, f.presentation);
  for (const route of Object.values(layout.routes)) route.segments[0].c1.y += 5;
  layout.pinnedNodes = [f.rooted.rootId];
  const project: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Stored normalized inspection', sourceText: f.source.text, sourceSha256: f.source.sha256, provenance: {}, recipe: f.recipe, corrections: [], presentation: f.presentation, layout };
  const loaded = await loadProject(JSON.stringify(project));
  assert.deepEqual(loaded.project.layout, layout);
  assert.notDeepEqual(loaded.project.layout, createInspectionLayout(f.rooted, f.reduction, f.presentation));
});
