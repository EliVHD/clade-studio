import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, reconcileLayout, moveNodes, splitRoute, flattenedEdge, validateGeometry, transformSubtree, pathData, edgeWidth } from '../src/geometry.ts';
import { loadProject, History } from '../src/project.ts';
import { svgPair, exportFiles, zipFiles } from '../src/export.ts';
import type { Project, Point } from '../src/types.ts';
import { routingDemo } from '../src/demo.ts';

async function fixture(text = '((A:1,B:1):1,(C:1,D:1):1);') {
  const source = await parseNewick(text), recipe = defaultRecipe(source); recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), presentation = structuredClone(DEFAULT_PRESENTATION);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(x => x.id);
  const layout = generateLayout(rooted, reduction, presentation, 'organic');
  const project: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Test', sourceText: text, sourceSha256: source.sha256, provenance: {}, corrections: [], recipe, layout, presentation };
  return { source, recipe, rooted, reduction, presentation, layout, project };
}
test('moving a scientific junction updates every incident endpoint and keeps splits', async () => {
  const f = await fixture(), before = structuredClone(f.rooted.nodes);
  moveNodes(f.layout, f.rooted, ['n000001'], { x: 3, y: -2 });
  assert.deepEqual(f.layout.routes.n000001.segments.at(-1)!.end, f.layout.nodes.n000001);
  assert.deepEqual(f.rooted.nodes, before);
  for (const child of f.rooted.nodes.n000001.children) assert.deepEqual(flattenedEdge(f.rooted, f.layout, child, .01)[0], f.layout.nodes.n000001);
});
test('pinned edges lock endpoints and pinned nodes survive movement', async () => {
  const f = await fixture(); f.layout.pinnedNodes = ['n000002']; f.layout.pinnedEdges = ['n000005'];
  const before = structuredClone(f.layout);
  moveNodes(f.layout, f.rooted, f.reduction.visible, { x: 10, y: 10 });
  for (const id of ['n000002', 'n000004', 'n000005']) assert.deepEqual(f.layout.nodes[id], before.nodes[id]);
  assert.deepEqual(f.layout.routes.n000005, before.routes.n000005);
  assert.throws(() => transformSubtree(f.layout, f.rooted, 'n000004', 45, 1), /pinned/);
});
test('waypoint insertion exactly preserves cubic shape and does not add scientific nodes', async () => {
  const f = await fixture(), before = flattenedEdge(f.rooted, f.layout, 'n000002', .0001), count = f.rooted.order.length;
  splitRoute(f.layout, f.rooted, 'n000002'); const after = flattenedEdge(f.rooted, f.layout, 'n000002', .0001);
  assert.equal(f.rooted.order.length, count); assert.equal(f.layout.routes.n000002.segments.length, 2);
  assert.ok(before.every(p => after.some(q => Math.hypot(p.x - q.x, p.y - q.y) < .001)));
});
test('collapse/expand preserves existing and pinned artwork including hidden descendants', async () => {
  const f = await fixture(); moveNodes(f.layout, f.rooted, ['n000002'], { x: 9, y: 4 }); f.layout.pinnedNodes = ['n000002'];
  const before = structuredClone(f.layout); const recipe = { ...f.recipe, collapse: ['n000001'], resolvedFrontierSourceNodeIds: undefined };
  const reduced = reduce(f.source, f.rooted, recipe), collapsed = reconcileLayout(f.rooted, reduced, f.presentation, f.layout);
  const expanded = reconcileLayout(f.rooted, f.reduction, f.presentation, collapsed);
  assert.deepEqual(expanded, before);
});
test('save/load validates replay and restores identical geometry with corrections separate', async () => {
  const f = await fixture(); splitRoute(f.layout, f.rooted, 'n000002'); moveNodes(f.layout, f.rooted, ['n000001'], { x: 2, y: 3 });
  const loaded = await loadProject(JSON.stringify(f.project)); assert.deepEqual(loaded.project, f.project);
  assert.deepEqual(loaded.reduction, f.reduction);
  await assert.rejects(loadProject(JSON.stringify({ ...f.project, sourceText: 'changed' })));
  const bad = structuredClone(f.project); bad.layout.routes.n000001.segments[0].end.x += 1;
  await assert.rejects(loadProject(JSON.stringify(bad)), /Detached/);
});
test('forged geometry, invalid physical dimensions and corrupt child rotations are rejected', async () => {
  const f = await fixture();
  const bad = structuredClone(f.project); bad.presentation.widthMm = -1; await assert.rejects(loadProject(JSON.stringify(bad)));
  bad.presentation.widthMm = 90; bad.layout.childOrder.n000001 = ['n000002', 'n000005']; await assert.rejects(loadProject(JSON.stringify(bad)), /topology/);
});
function straight(f: Awaited<ReturnType<typeof fixture>>, id: string, a: Point, b: Point) {
  f.layout.nodes[f.rooted.nodes[id].parent!] = { ...a }; f.layout.nodes[id] = { ...b };
  f.layout.routes[id] = { segments: [{ c1: { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }, c2: { x: a.x + (b.x - a.x) * 2 / 3, y: a.y + (b.y - a.y) * 2 / 3 }, end: { ...b } }] };
}
test('crossing and tangent stroke envelopes are detected without a false all-clear', async () => {
  const f = await fixture();
  straight(f, 'n000002', { x: 10, y: 20 }, { x: 30, y: 40 });
  straight(f, 'n000005', { x: 10, y: 40 }, { x: 30, y: 20 });
  // Repair shared endpoint copies on the incoming edges after moving these parents.
  for (const id of ['n000001', 'n000004']) f.layout.routes[id].segments.at(-1)!.end = { ...f.layout.nodes[id] };
  let qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  assert.equal(qa.crossingPassed, false); assert.ok(qa.issues.some(x => x.edges.includes('n000002') && x.edges.includes('n000005')));
  straight(f, 'n000002', { x: 10, y: 20 }, { x: 30, y: 20 }); straight(f, 'n000005', { x: 10, y: 20.25 }, { x: 30, y: 20.25 });
  for (const id of ['n000001', 'n000004']) f.layout.routes[id].segments.at(-1)!.end = { ...f.layout.nodes[id] };
  qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation); assert.equal(qa.crossingPassed, false);
});
test('adjacent branches may not overlap beyond their genuine junction neighborhood', async () => {
  const f = await fixture('(A:1,B:1);'); straight(f, 'n000001', { x: 20, y: 20 }, { x: 40, y: 20 }); straight(f, 'n000002', { x: 20, y: 20 }, { x: 35, y: 20 });
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  assert.equal(qa.crossingPassed, false); assert.ok(qa.issues.some(x => x.type === 'crossing'));
});
test('a simple well-separated Y passes stroke checks at a stated tolerance', async () => {
  const f = await fixture('(A:1,B:1);'); straight(f, 'n000001', { x: 45, y: 100 }, { x: 15, y: 30 }); straight(f, 'n000002', { x: 45, y: 100 }, { x: 75, y: 30 });
  f.presentation.clearanceMm = .1;
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  assert.equal(qa.incidencePassed, true); assert.equal(qa.crossingPassed, true); assert.equal(qa.clearancePassed, true);
});
test('nonadjacent portions of a self-crossing cubic are detected', async () => {
  const f = await fixture('(A:1,B:1);'); straight(f, 'n000002', { x: 45, y: 100 }, { x: 75, y: 30 });
  f.layout.nodes.n000001 = { x: 50, y: 100 }; f.layout.routes.n000001 = { segments: [{ c1: { x: 90, y: 10 }, c2: { x: 5, y: 10 }, end: { x: 50, y: 100 } }] };
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  assert.equal(qa.crossingPassed, false); assert.ok(qa.issues.some(x => x.type === 'self-intersection'));
});
test('paired exports share identical artwork, dimensions, transforms and styling', async () => {
  const f = await fixture(), qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation), pair = svgPair(f.rooted, f.reduction, f.project, qa);
  const group = (s: string) => s.match(/<g id="tree-artwork"[\s\S]*?<\/g>/)![0];
  assert.equal(group(pair.unlabeled), group(pair.labeled)); assert.ok(!pair.unlabeled.includes('id="annotations"')); assert.ok(pair.labeled.includes('id="annotations"'));
  assert.equal(pair.unlabeled.match(/<svg[^>]+>/)![0], pair.labeled.match(/<svg[^>]+>/)![0]);
  const files = exportFiles(f.source, f.rooted, f.reduction, f.project, qa); assert.equal(files['source_tree.nwk'], f.source.text);
  assert.equal(new DataView(zipFiles(files).buffer).getUint32(0, true), 0x04034b50);
});
test('undo/redo stores independent geometry snapshots', async () => {
  const f = await fixture(), history = new History<Project>(), before = structuredClone(f.project);
  history.push(f.project); moveNodes(f.layout, f.rooted, ['n000001'], { x: 4, y: 2 }); const after = structuredClone(f.project);
  const undone = history.undo(f.project)!; assert.deepEqual(undone, before); assert.deepEqual(history.redo(undone), after);
});
test('bundled layout includes a genuine upward edge followed by a downward descendant', async () => {
  const text = await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8'), source = await parseNewick(text);
  const recipe = { ...defaultRecipe(source), ...JSON.parse(await readFile(new URL('../data/example_reduction_recipe.json', import.meta.url), 'utf8')) };
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), layout = generateLayout(rooted, reduction, DEFAULT_PRESENTATION, 'organic');
  assert.ok(reduction.visible.some(id => {
    const parent = rooted.nodes[id].parent, grand = parent && rooted.nodes[parent].parent;
    return parent && grand && layout.nodes[parent].y < layout.nodes[grand].y && layout.nodes[id].y > layout.nodes[parent].y;
  }));
});
test('source-derived six-endpoint demo covers every tip and passes contacts, clearance and labels', async () => {
  const source = await parseNewick(await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8'));
  const demo = routingDemo(source), rooted = orient(source, demo.recipe.root), reduction = reduce(source, rooted, demo.recipe, true);
  assert.equal(reduction.tipCount, 3083); assert.equal(reduction.frontier.length, 6);
  assert.equal(rooted.nodes.n006158.parent, 'n005368');
  assert.ok(demo.layout.nodes.n005368.y < demo.layout.nodes.n000000.y);
  assert.ok(demo.layout.nodes.n006158.y > demo.layout.nodes.n005368.y);
  const qa = validateGeometry(source, rooted, demo.recipe, reduction, demo.layout, demo.presentation);
  assert.equal(qa.status, 'checked'); assert.equal(qa.issues.length, 0);
});


test('straight mode uses identical segments for SVG and QA while retaining reversible curve handles', async () => {
  const f = await fixture(), id = 'n000002', original = structuredClone(f.layout), history = new History<Project>();
  history.push(f.project); f.layout.lineStyle = 'straight';
  const a = f.layout.nodes[f.rooted.nodes[id].parent!], b = f.layout.nodes[id];
  assert.deepEqual(flattenedEdge(f.rooted, f.layout, id, .001), [a, b]);
  assert.ok(pathData(f.rooted, f.layout, id).includes('L')); assert.ok(!pathData(f.rooted, f.layout, id).includes('C'));
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  const reference = structuredClone(f.layout);
  for (const [edge, route] of Object.entries(reference.routes)) {
    const start = reference.nodes[f.rooted.nodes[edge].parent!], end = reference.nodes[edge];
    route.segments = [{ c1: start, c2: end, end }];
  }
  delete reference.lineStyle;
  const expected = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, reference, f.presentation);
  assert.deepEqual(qa.issues, expected.issues); assert.equal(qa.minClearanceMm, expected.minClearanceMm);
  for (const svg of Object.values(svgPair(f.rooted, f.reduction, f.project, qa))) {
    const paths = [...svg.matchAll(/<path[^>]+d="([^"]+)"/g)].map(m => m[1]);
    assert.ok(paths.length > 0 && paths.every(path => !path.includes('C') && path.includes('L')));
  }
  assert.deepEqual(f.layout.routes, original.routes);
  assert.deepEqual(history.undo(f.project)!.layout, original);
  f.layout.lineStyle = 'curved'; assert.ok(pathData(f.rooted, f.layout, id).includes('C')); assert.deepEqual(f.layout.routes, original.routes);
});
test('straight waypoint insertion, manual movement, regeneration and frontier changes retain line mode', async () => {
  const f = await fixture(); f.layout.lineStyle = 'straight'; const id = 'n000002';
  const a = f.layout.nodes.n000001, b = f.layout.nodes[id];
  splitRoute(f.layout, f.rooted, id);
  assert.deepEqual(f.layout.routes[id].segments[0].end, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  moveNodes(f.layout, f.rooted, ['n000001'], { x: 3, y: 1 });
  assert.equal(flattenedEdge(f.rooted, f.layout, id, .001).length, 3);
  assert.equal(generateLayout(f.rooted, f.reduction, f.presentation, 'organic', f.layout).lineStyle, 'straight');
  const collapsed = reduce(f.source, f.rooted, { ...f.recipe, collapse: ['n000001'], resolvedFrontierSourceNodeIds: undefined });
  const hidden = reconcileLayout(f.rooted, collapsed, f.presentation, f.layout), expanded = reconcileLayout(f.rooted, f.reduction, f.presentation, hidden);
  assert.equal(expanded.lineStyle, 'straight'); assert.deepEqual(expanded.routes[id], f.layout.routes[id]);
  assert.deepEqual((await loadProject(JSON.stringify(f.project))).project.layout, f.layout);
});
test('physical line width and zero taper produce uniform, matching SVG stroke widths', async () => {
  const f = await fixture(); f.presentation.strokeMm = .7; f.presentation.taper = 0;
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, f.layout, f.presentation);
  for (const id of f.reduction.visible) if (f.rooted.nodes[id].parent) assert.equal(edgeWidth(f.rooted, id, f.presentation), .7);
  for (const svg of Object.values(svgPair(f.rooted, f.reduction, f.project, qa))) assert.ok([...svg.matchAll(/stroke-width="([^"]+)"/g)].every(m => Number(m[1]) === .7));
});
