import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, validateGeometry } from '../src/geometry.ts';
import { applyBorder, assignBorder, bindBorder, borderTargets, fitReference, nearestBorderFraction, pointOnBorder, scopedEndpoints, simplifyStroke, validateDesign } from '../src/design.ts';
import { History, loadProject, validateLayout } from '../src/project.ts';
import { exportFiles, svgPair } from '../src/export.ts';
import type { EndpointBorder, Project, ReferenceImage } from '../src/types.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR5kAAAAASUVORK5CYII=';
async function fixture() {
  const text = '((A:1,B:1):1,(C:1,D:1):1);', source = await parseNewick(text), recipe = defaultRecipe(source);
  recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), presentation = structuredClone(DEFAULT_PRESENTATION);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(e => e.id);
  const layout = generateLayout(rooted, reduction, presentation, 'organic');
  const project: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Guides test', sourceText: text, sourceSha256: source.sha256, provenance: {}, corrections: [], recipe, layout, presentation };
  const border: EndpointBorder = { id: 'border-test', name: 'Crown', points: [{ x: 10, y: 20 }, { x: 80, y: 20 }], closed: false, placement: 'spread', insetMm: 0, variationMm: 0, seed: 1, assignments: [] };
  const image: ReferenceImage = { name: 'Test.png', dataUrl: PNG, pixelWidth: 1, pixelHeight: 1, x: 4, y: 12, widthMm: 60, heightMm: 60, rotationDeg: 12, opacity: .3, visible: true, layer: 'behind' };
  return { source, rooted, reduction, project, layout, border, image };
}
test('stroke simplification preserves endpoints and a corner; projection uses arc length', async () => {
  const f = await fixture();
  const points = simplifyStroke([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }, { x: 5, y: 10 }, { x: 10, y: 10 }]);
  assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }]);
  f.border.points = points;
  assert.deepEqual(pointOnBorder(f.border, .75).point, { x: 5, y: 10 });
  assert.equal(nearestBorderFraction(f.border, { x: 5, y: 13 }), .75);
});
test('a border places terminals on the line without changing internal junctions or science', async () => {
  const f = await fixture(), science = structuredClone(f.rooted), before = structuredClone(f.layout);
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  assert.equal(f.border.assignments[0].fraction, 0); assert.equal(f.border.assignments.at(-1)!.fraction, 1);
  assert.deepEqual(applyBorder(f.border, f.rooted, f.reduction, f.layout), { moved: 4, pinned: 0, hidden: 0 });
  for (const e of f.reduction.frontier) assert.equal(f.layout.nodes[e.id].y, 20);
  for (const id of f.reduction.visible) if (!f.reduction.frontier.some(e => e.id === id)) assert.deepEqual(f.layout.nodes[id], before.nodes[id]);
  assert.deepEqual(f.rooted, science); assert.equal(f.project.sourceText, f.source.text);
  validateLayout(f.layout, f.rooted, f.reduction);
});
test('insets point inward on a closed loop in either direction and the seam has no duplicate', async () => {
  const f = await fixture();
  f.border.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  f.border.closed = true; f.border.insetMm = 3;
  for (let direction = 0; direction < 2; direction++) {
    bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
    assert.deepEqual(f.border.assignments.map(a => a.fraction), [0, .25, .5, .75]);
    for (const t of borderTargets(f.border, f.rooted, f.reduction, f.layout)) assert.ok(t.point.x >= 0 && t.point.x <= 100 && t.point.y >= 0 && t.point.y <= 100);
    const first = borderTargets(f.border, f.rooted, f.reduction, f.layout)[0];
    assert.ok(direction ? first.point.y === 97 : first.point.y === 3);
    f.border.points.reverse();
  }
});
test('variation is bounded, deterministic per endpoint and does not accumulate on repeated Apply', async () => {
  const f = await fixture(); f.border.insetMm = 5; f.border.variationMm = 2;
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const targets = borderTargets(f.border, f.rooted, f.reduction, f.layout);
  for (const t of targets) assert.ok(t.point.y >= 23 && t.point.y <= 27);
  applyBorder(f.border, f.rooted, f.reduction, f.layout); const once = structuredClone(f.layout);
  applyBorder(f.border, f.rooted, f.reduction, f.layout); assert.deepEqual(f.layout, once);
  f.border.assignments.reverse(); assert.deepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout).reverse(), targets);
  f.border.seed++; assert.notDeepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout).map(t => t.point), targets.map(t => t.point).reverse());
});
test('selected-clade scope, node pins and edge pins limit which endpoints move', async () => {
  const f = await fixture(), before = structuredClone(f.layout);
  assert.deepEqual(scopedEndpoints(f.rooted, f.reduction, ['n000001']), ['n000002', 'n000003']);
  assert.deepEqual(scopedEndpoints(f.rooted, f.reduction, []), []);
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  f.layout.pinnedNodes = ['n000002']; f.layout.pinnedEdges = ['n000005'];
  assert.deepEqual(applyBorder(f.border, f.rooted, f.reduction, f.layout), { moved: 2, pinned: 2, hidden: 0 });
  for (const id of ['n000002', 'n000005']) assert.deepEqual(f.layout.nodes[id], before.nodes[id]);
  assert.deepEqual(f.layout.routes.n000005, before.routes.n000005);
  const g = await fixture(); bindBorder(g.border, scopedEndpoints(g.rooted, g.reduction, ['n000001']), g.rooted, g.layout);
  applyBorder(g.border, g.rooted, g.reduction, g.layout);
  for (const id of ['n000005', 'n000006']) assert.deepEqual(g.layout.nodes[id], before.nodes[id]);
});
test('saved assignments never redirect to new collapsed endpoints and skip hidden descendants', async () => {
  const f = await fixture(); bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const original = structuredClone(f.border.assignments), before = structuredClone(f.layout);
  const collapsed = reduce(f.source, f.rooted, { ...f.project.recipe, collapse: ['n000001'], resolvedFrontierSourceNodeIds: undefined });
  assert.deepEqual(applyBorder(f.border, f.rooted, collapsed, f.layout), { moved: 2, pinned: 0, hidden: 2 });
  assert.deepEqual(f.border.assignments, original);
  for (const id of ['n000001', 'n000002', 'n000003']) assert.deepEqual(f.layout.nodes[id], before.nodes[id]);
});
test('changing a guide previews new targets without moving branches until Apply', async () => {
  const f = await fixture(); bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const before = structuredClone(f.layout), targets = borderTargets(f.border, f.rooted, f.reduction, f.layout);
  f.border.points = f.border.points.map(p => ({ x: p.x, y: p.y + 10 }));
  const updated = borderTargets(f.border, f.rooted, f.reduction, f.layout);
  assert.deepEqual(f.layout, before); updated.forEach((t, i) => assert.equal(t.point.y, targets[i].point.y + 10));
});
test('image fitting preserves aspect ratio, centres on page and resets rotation', async () => {
  const f = await fixture(); f.image.pixelWidth = 478; f.image.pixelHeight = 640;
  fitReference(f.image, f.project.presentation);
  assert.ok(Math.abs(f.image.widthMm / f.image.heightMm - 478 / 640) < 1e-12);
  assert.equal(f.image.x * 2 + f.image.widthMm, f.project.presentation.widthMm);
  assert.equal(f.image.y * 2 + f.image.heightMm, f.project.presentation.heightMm);
  assert.equal(f.image.rotationDeg, 0);
});
test('old projects and new projects with embedded images/borders round-trip; history restores both', async () => {
  const f = await fixture(); const old = await loadProject(JSON.stringify(f.project)); assert.equal(old.project.design, undefined);
  const history = new History<Project>(); history.push(f.project);
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  f.project.design = { borders: [f.border], activeBorderId: f.border.id, showBorders: true, referenceImage: f.image };
  const loaded = await loadProject(JSON.stringify(f.project)); assert.deepEqual(loaded.project, f.project);
  const undone = history.undo(f.project)!; assert.equal(undone.design, undefined);
  assert.deepEqual(history.redo(undone)!.design, f.project.design);
});
test('malformed guides, unknown identities, invalid opacity and executable/remote image inputs are rejected', async () => {
  const f = await fixture(); bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  f.project.design = { borders: [f.border], activeBorderId: f.border.id, showBorders: true, referenceImage: f.image };
  const invalid = [
    (p: Project) => { p.design!.borders[0].points[0].x = NaN; },
    (p: Project) => { p.design!.borders[0].points = [{ x: 1, y: 1 }, { x: 1, y: 1 }]; },
    (p: Project) => { p.design!.borders[0].assignments[0].sourceNodeId = 'missing'; },
    (p: Project) => { p.design!.borders[0].assignments[0].fraction = 2; },
    (p: Project) => { p.design!.borders[0].variationMm = -1; },
    (p: Project) => { p.design!.referenceImage!.opacity = 1.2; },
    (p: Project) => { p.design!.referenceImage!.dataUrl = 'https://example.com/image.png'; },
    (p: Project) => { p.design!.referenceImage!.dataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='; },
    (p: Project) => { p.design!.referenceImage!.dataUrl = 'data:image/png;base64,PHN2Zz48L3N2Zz4='; },
    (p: Project) => { p.design!.referenceImage!.pixelWidth = 40_000_001; },
  ];
  for (const corrupt of invalid) {
    const bad = structuredClone(f.project); corrupt(bad);
    assert.throws(() => validateDesign(bad.design, f.rooted)); await assert.rejects(loadProject(JSON.stringify(bad)));
  }
});
test('image and guide layers stay out of both SVGs while the project export retains them', async () => {
  const f = await fixture();
  const qa = validateGeometry(f.source, f.rooted, f.project.recipe, f.reduction, f.layout, f.project.presentation), before = svgPair(f.rooted, f.reduction, f.project, qa);
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  f.project.design = { borders: [f.border], activeBorderId: f.border.id, showBorders: true, referenceImage: f.image };
  assert.deepEqual(svgPair(f.rooted, f.reduction, f.project, qa), before);
  const files = exportFiles(f.source, f.rooted, f.reduction, f.project, qa);
  const saved = JSON.parse(files['tree.treeproject.json']); assert.deepEqual(saved.design, f.project.design);
});
test('nearest placement retains projected locations and open-border inset follows the parent side', async () => {
  const f = await fixture(); f.border.placement = 'nearest'; f.border.insetMm = 4;
  const id = 'n000002', parent = f.rooted.nodes[id].parent!;
  f.layout.nodes[id] = { x: 35, y: 10 }; f.layout.nodes[parent] = { x: 35, y: 40 };
  bindBorder(f.border, [id], f.rooted, f.layout);
  assert.deepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout)[0].point, { x: 35, y: 24 });
  f.layout.nodes[parent].y = 5; bindBorder(f.border, [id], f.rooted, f.layout);
  assert.deepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout)[0].point, { x: 35, y: 16 });
  f.border.insetMm = -4;
  assert.deepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout)[0].point, { x: 35, y: 24 });
});
test('one selected endpoint goes to the midpoint and a long jagged stroke stays bounded', async () => {
  const f = await fixture(); bindBorder(f.border, ['n000002'], f.rooted, f.layout);
  assert.equal(f.border.assignments[0].fraction, .5);
  assert.deepEqual(borderTargets(f.border, f.rooted, f.reduction, f.layout)[0].point, { x: 45, y: 20 });
  const raw = Array.from({ length: 2000 }, (_, i) => ({ x: i / 20, y: i % 2 }));
  const simplified = simplifyStroke(raw);
  assert.ok(simplified.length <= 512 && simplified.length >= 2);
  assert.deepEqual(simplified[0], raw[0]); assert.deepEqual(simplified.at(-1), raw.at(-1));
});

test('endpoint-only selection excludes interior junctions even when their descendants are visible', async () => {
  const f = await fixture();
  assert.deepEqual(scopedEndpoints(f.rooted, f.reduction, ['n000001', 'n000005'], false), ['n000005']);
  assert.deepEqual(scopedEndpoints(f.rooted, f.reduction, ['n000002', 'n000006'], false), ['n000002', 'n000006']);
  assert.deepEqual(scopedEndpoints(f.rooted, f.reduction, [], false), []);
});
test('assigning a second endpoint group transfers overlap without redistributing the first border', async () => {
  const f = await fixture(), beforeLayout = structuredClone(f.layout);
  const second = { ...structuredClone(f.border), id: 'second', name: 'Roots', points: [{ x: 15, y: 180 }, { x: 75, y: 195 }] };
  const design = { borders: [f.border, second], showBorders: true };
  assignBorder(design, f.border.id, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const remaining = structuredClone(f.border.assignments.filter(a => !['n000005', 'n000006'].includes(a.sourceNodeId)));
  assert.deepEqual(assignBorder(design, second.id, ['n000005', 'n000006', 'n000006'], f.rooted, f.layout), { assigned: 2, transferred: 2 });
  assert.deepEqual(f.border.assignments, remaining);
  assert.deepEqual(f.layout, beforeLayout);
  const unchanged = structuredClone(design);
  assert.throws(() => assignBorder(design, second.id, [], f.rooted, f.layout), /No visible endpoints/);
  assert.deepEqual(design, unchanged);
  applyBorder(f.border, f.rooted, f.reduction, f.layout);
  const firstPositions = remaining.map(a => ({ ...f.layout.nodes[a.sourceNodeId] }));
  applyBorder(second, f.rooted, f.reduction, f.layout);
  assert.deepEqual(remaining.map(a => f.layout.nodes[a.sourceNodeId]), firstPositions);
  for (const t of borderTargets(second, f.rooted, f.reduction, f.layout)) assert.deepEqual(f.layout.nodes[t.id], t.point);
});
test('separate border memberships and reassignment survive project loading and undo', async () => {
  const f = await fixture(), second = { ...structuredClone(f.border), id: 'second', name: 'Second' };
  f.project.design = { borders: [f.border, second], activeBorderId: second.id, showBorders: true };
  assignBorder(f.project.design, f.border.id, ['n000002', 'n000003'], f.rooted, f.layout);
  assignBorder(f.project.design, second.id, ['n000005', 'n000006'], f.rooted, f.layout);
  const before = structuredClone(f.project), history = new History<Project>(); history.push(before);
  assignBorder(f.project.design, second.id, ['n000003', 'n000005'], f.rooted, f.layout);
  assert.deepEqual(f.border.assignments.map(a => a.sourceNodeId), ['n000002']);
  const loaded = await loadProject(JSON.stringify(f.project)); assert.deepEqual(loaded.project.design, f.project.design);
  assert.deepEqual(history.undo(f.project), before);
  assert.deepEqual(history.redo(before), f.project);
});
