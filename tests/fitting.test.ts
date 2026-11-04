import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, moveNodes, splitRoute, reconcileLayout, validateGeometry, distance, pathData } from '../src/geometry.ts';
import { assignBorder, bindBorder, borderTargets, scopedEndpoints } from '../src/design.ts';
import { fitSilhouette, fittingTargets } from '../src/fitting.ts';
import { refineRouting } from '../src/routing.ts';
import { DEFAULT_FIT_SETTINGS, validateFitSettings, directionAngle, fitMethodIds } from '../src/fit-settings.ts';
import { History, loadProject, validateLayout } from '../src/project.ts';
import type { Design, EndpointBorder, FitSettings, Project } from '../src/types.ts';

async function fixture() {
  const text = '((A:1,B:1):1,(C:1,D:1):1);', source = await parseNewick(text), recipe = defaultRecipe(source);
  recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), presentation = structuredClone(DEFAULT_PRESENTATION);
  recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(e => e.id);
  const layout = generateLayout(rooted, reduction, presentation, 'organic');
  const positions = [[45, 185], [20, 145], [12, 70], [32, 50], [65, 130], [60, 65], [79, 50]];
  positions.forEach(([x, y], i) => { const id = `n${String(i).padStart(6, '0')}`; moveNodes(layout, rooted, [id], { x: x - layout.nodes[id].x, y: y - layout.nodes[id].y }); });
  const border: EndpointBorder = { id: 'crown', name: 'Crown', points: [{ x: 8, y: 35 }, { x: 30, y: 20 }, { x: 60, y: 20 }, { x: 82, y: 35 }], closed: false, placement: 'spread', insetMm: 1, variationMm: .3, seed: 1, assignments: [] };
  bindBorder(border, scopedEndpoints(rooted, reduction), rooted, layout);
  const design: Design = { borders: [border], activeBorderId: border.id, showBorders: true, fitSettings: { ...DEFAULT_FIT_SETTINGS } };
  const project: Project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'Fitting', sourceText: text, sourceSha256: source.sha256, provenance: {}, corrections: [], recipe, layout, presentation, design };
  return { source, recipe, rooted, reduction, presentation, layout, border, design, project };
}
function run(f: Awaited<ReturnType<typeof fixture>>, settings: Partial<FitSettings> = {}) {
  return fitSilhouette(f.rooted, f.reduction, f.layout, f.presentation, f.design, { ...DEFAULT_FIT_SETTINGS, ...settings });
}
test('fit provenance records executed fork-only optimization and excludes an unexecuted search', async () => {
  const f = await fixture();
  const forkOnly = run(f, { routing: 0, forkSpread: .65 });
  assert.ok(forkOnly.routingDiagnostics!.attempts > 0);
  assert.deepEqual(fitMethodIds(forkOnly), ['junction-fit', 'route-search']);
  assert.deepEqual(fitMethodIds(run(f, { routing: 0, forkSpread: 0 })), ['junction-fit']);
  assert.deepEqual(fitMethodIds(run(f, { strength: 0 })), ['junction-fit']);
});
test('silhouette fitting repositions scientific junctions and endpoints, without mutating inputs', async () => {
  const f = await fixture(), before = structuredClone(f), result = run(f);
  assert.equal(result.movedJunctions.length, 2); assert.equal(result.movedEndpoints, 4);
  assert.ok(result.errorAfterMm < 1e-8 && result.errorBeforeMm > 10);
  assert.deepEqual(result.layout.nodes[f.rooted.rootId], f.layout.nodes[f.rooted.rootId]);
  assert.deepEqual(f, before); assert.deepEqual(Object.keys(result.layout.nodes), Object.keys(f.layout.nodes));
  assert.deepEqual(Object.keys(result.layout.routes), Object.keys(f.layout.routes));
  validateLayout(result.layout, f.rooted, f.reduction);
});
test('the branching-depth dial moves forks earlier or later while keeping endpoint targets identical', async () => {
  const f = await fixture(), early = run(f, { junctionDepth: 0, preserveFlow: 0, junctionSpacingMm: .1 }), late = run(f, { junctionDepth: 1, preserveFlow: 0, junctionSpacingMm: .1 });
  for (const id of ['n000001', 'n000004']) assert.ok(distance(late.layout.nodes[id], f.layout.nodes.n000000) > distance(early.layout.nodes[id], f.layout.nodes.n000000) + 10);
  for (const tip of f.reduction.frontier) assert.deepEqual(early.layout.nodes[tip.id], late.layout.nodes[tip.id]);
});
test('junction spacing separates crowded forks and reports constraints that remain unresolved', async () => {
  const f = await fixture();
  // A narrow outline gives both sister forks nearly the same attraction point.
  f.border.points = [{ x: 44, y: 30 }, { x: 46, y: 30 }]; bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const close = run(f, { junctionSpacingMm: .1, preserveFlow: 0 }), spaced = run(f, { junctionSpacingMm: 10, preserveFlow: 0 });
  assert.ok(distance(spaced.layout.nodes.n000001, spaced.layout.nodes.n000004) > distance(close.layout.nodes.n000001, close.layout.nodes.n000004) + 2);
  assert.ok(Number.isInteger(spaced.crowdedJunctionPairs));
});
test('junction anchors and pinned edge endpoints/routes survive fitting exactly', async () => {
  const f = await fixture(); f.layout.pinnedNodes = ['n000001']; f.layout.pinnedEdges = ['n000005']; splitRoute(f.layout, f.rooted, 'n000006');
  const result = run(f);
  for (const id of ['n000000', 'n000001', 'n000004', 'n000005']) assert.deepEqual(result.layout.nodes[id], f.layout.nodes[id]);
  assert.deepEqual(result.layout.routes.n000005, f.layout.routes.n000005);
  assert.equal(result.pinnedEndpoints, 1); assert.equal(result.layout.routes.n000006.segments.length, 2);
  assert.equal(result.movedJunctions.length, 0); assert.equal(result.movedEndpoints, 3);
  validateLayout(result.layout, f.rooted, f.reduction);
});
test('partial-clade fitting leaves shared ancestors and unrelated clades unchanged', async () => {
  const f = await fixture(); bindBorder(f.border, ['n000002', 'n000003'], f.rooted, f.layout);
  const result = run(f); assert.deepEqual(result.movedJunctions.map(j => j.id), ['n000001']);
  for (const id of ['n000000', 'n000004', 'n000005', 'n000006']) assert.deepEqual(result.layout.nodes[id], f.layout.nodes[id]);
  for (const id of ['n000004', 'n000005', 'n000006']) assert.deepEqual(result.layout.routes[id], f.layout.routes[id]);
  bindBorder(f.border, ['n000002'], f.rooted, f.layout);
  const single = run(f); assert.equal(single.movedJunctions.length, 0); assert.deepEqual(single.layout.nodes.n000001, f.layout.nodes.n000001);
});
test('fit strength zero is an exact no-op and halfway fitting interpolates without compounding', async () => {
  const f = await fixture(), zero = run(f, { strength: 0 }), half = run(f, { strength: .5 }), full = run(f);
  assert.deepEqual(zero.layout, f.layout); assert.equal(zero.movedJunctions.length, 0);
  for (const id of f.reduction.visible) {
    assert.ok(Math.abs(half.layout.nodes[id].x - (f.layout.nodes[id].x + full.layout.nodes[id].x) / 2) < 1e-8);
    assert.ok(Math.abs(half.layout.nodes[id].y - (f.layout.nodes[id].y + full.layout.nodes[id].y) / 2) < 1e-8);
  }
  assert.deepEqual(run(f, { strength: .5 }), half);
});
test('flow retention changes junction placement and smoothing changes curves without changing splits', async () => {
  const f = await fixture(), rebuilt = run(f, { preserveFlow: 0 }), retained = run(f, { preserveFlow: 1 });
  assert.notDeepEqual(rebuilt.layout.nodes.n000001, retained.layout.nodes.n000001);
  const straight = run(f, { smoothing: 0, routing: 0, forkSpread: 0 }), smooth = run(f, { smoothing: 1, routing: 0, forkSpread: 0 });
  assert.deepEqual(straight.layout.nodes, smooth.layout.nodes); assert.notDeepEqual(straight.layout.routes.n000001, smooth.layout.routes.n000001);
  validateLayout(smooth.layout, f.rooted, f.reduction);
});
test('fitting a collapsed clade preserves hidden descendant coordinates and incident continuity', async () => {
  const f = await fixture(); f.recipe.collapse = ['n000001']; delete f.recipe.resolvedFrontierSourceNodeIds;
  f.reduction = reduce(f.source, f.rooted, f.recipe); f.layout = reconcileLayout(f.rooted, f.reduction, f.presentation, f.layout);
  bindBorder(f.border, scopedEndpoints(f.rooted, f.reduction), f.rooted, f.layout);
  const result = run(f);
  for (const id of ['n000002', 'n000003']) {
    assert.deepEqual(result.layout.nodes[id], f.layout.nodes[id]);
    assert.deepEqual(result.layout.routes[id].segments.at(-1)!.end, result.layout.nodes[id]);
  }
  validateLayout(result.layout, f.rooted, f.reduction);
});
test('conflicting guide targets are rejected; active-guide scope and hidden assignments are explicit', async () => {
  const f = await fixture(), second = structuredClone(f.border); second.id = 'other'; second.points.forEach(p => { p.x += 10; }); f.design.borders.push(second);
  assert.throws(() => run(f), /different targets/);
  assert.equal(run(f, { borderScope: 'active' }).assignedEndpoints, 4);
  f.design.borders.pop(); const reduced = reduce(f.source, f.rooted, { ...f.recipe, collapse: ['n000001'], resolvedFrontierSourceNodeIds: undefined });
  const targets = fittingTargets(f.design, f.rooted, reduced, f.layout, DEFAULT_FIT_SETTINGS);
  assert.equal(targets.hidden, 2); assert.equal(targets.targets.size, 2);
  f.design.borders = []; delete f.design.activeBorderId; assert.throws(() => run(f), /Draw and assign/);
});
test('accepted fits and their settings round-trip and undo restores the original artwork', async () => {
  const f = await fixture(), result = run(f), before = structuredClone(f.project), history = new History<Project>();
  history.push(f.project); f.project.layout = result.layout;
  const loaded = await loadProject(JSON.stringify(f.project)); assert.deepEqual(loaded.project, f.project);
  assert.deepEqual(history.undo(f.project), before);
  assert.deepEqual(history.redo(before), f.project);
  const bad = structuredClone(f.project); bad.design!.fitSettings!.junctionDepth = 2; await assert.rejects(loadProject(JSON.stringify(bad)), /junctionDepth/);
  assert.throws(() => validateFitSettings({ ...DEFAULT_FIT_SETTINGS, strength: NaN }));
});
test('geometry checks remain authoritative and report source coverage after fitting', async () => {
  const f = await fixture(), result = run(f);
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, result.layout, f.presentation);
  assert.equal(qa.coveragePassed, true); assert.equal(qa.incidencePassed, true);
  f.layout.pinnedNodes = f.reduction.visible; const pinned = run(f);
  assert.deepEqual(pinned.layout, f.layout); assert.ok(pinned.errorAfterMm > 0); assert.equal(pinned.movedEndpoints, 0);
});
test('bundled 150-endpoint fit moves internal junctions and retains all 3,083 source tips', async () => {
  const source = await parseNewick(await readFile(new URL('../data/source_tree.nwk', import.meta.url), 'utf8'));
  const recipe = { ...defaultRecipe(source), ...JSON.parse(await readFile(new URL('../data/example_reduction_recipe.json', import.meta.url), 'utf8')) };
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), p = structuredClone(DEFAULT_PRESENTATION), layout = generateLayout(rooted, reduction, p, 'organic');
  const border: EndpointBorder = { id: 'bacteria', name: 'Bacterial crown', points: [{ x: 6, y: 116 }, { x: 8, y: 56 }, { x: 25, y: 22 }, { x: 40, y: 18 }], closed: false, placement: 'spread', insetMm: 1.5, variationMm: 1, seed: 7, assignments: [] };
  bindBorder(border, scopedEndpoints(rooted, reduction, ['n000001']), rooted, layout);
  const result = fitSilhouette(rooted, reduction, layout, p, { borders: [border], activeBorderId: border.id, showBorders: true }, DEFAULT_FIT_SETTINGS);
  assert.equal(result.assignedEndpoints, 61); assert.ok(result.movedJunctions.length > 20); assert.ok(result.errorAfterMm < 1e-8);
  const before = JSON.stringify(rooted), qa = validateGeometry(source, rooted, recipe, reduction, result.layout, p);
  assert.equal(qa.sourceTips, 3083); assert.equal(qa.coveragePassed, true); assert.equal(qa.incidencePassed, true); assert.equal(JSON.stringify(rooted), before);
  validateLayout(result.layout, rooted, reduction);
  for (const t of borderTargets(border, rooted, reduction, layout)) assert.ok(distance(result.layout.nodes[t.id], t.point) < 1e-8);
});

test('two endpoint groups fit their own borders together; active-only fitting isolates the other group', async () => {
  const f = await fixture();
  const second = { ...structuredClone(f.border), id: 'roots', name: 'Roots', points: [{ x: 15, y: 190 }, { x: 75, y: 205 }], assignments: [] };
  f.design.borders.push(second);
  assignBorder(f.design, second.id, ['n000005', 'n000006'], f.rooted, f.layout);
  const firstTargets = borderTargets(f.border, f.rooted, f.reduction, f.layout), result = run(f);
  assert.equal(result.assignedEndpoints, 4); assert.ok(result.errorAfterMm < 1e-8);
  for (const b of f.design.borders) for (const t of borderTargets(b, f.rooted, f.reduction, f.layout)) assert.deepEqual(result.layout.nodes[t.id], t.point);
  f.design.activeBorderId = second.id;
  const active = run(f, { borderScope: 'active' }); assert.equal(active.assignedEndpoints, 2);
  for (const id of ['n000001', 'n000002', 'n000003']) {
    assert.deepEqual(active.layout.nodes[id], f.layout.nodes[id]);
    assert.deepEqual(active.layout.routes[id], f.layout.routes[id]);
  }
  second.points = second.points.map(p => ({ x: p.x, y: p.y - 25 }));
  const revised = run(f);
  for (const t of firstTargets) assert.deepEqual(revised.layout.nodes[t.id], t.point);
  assert.notDeepEqual(revised.layout.nodes.n000005, result.layout.nodes.n000005);
  validateLayout(revised.layout, f.rooted, f.reduction);
  const qa = validateGeometry(f.source, f.rooted, f.recipe, f.reduction, revised.layout, f.presentation);
  assert.equal(qa.coveragePassed, true); assert.equal(qa.incidencePassed, true);
});

test('common direction places junctions behind their targets and aligns incident tangents', async () => {
  const f = await fixture(), up = run(f, { direction: { angleDeg: 270, strength: 1 }, preserveFlow: 0, routing: 0, forkSpread: 0 }), down = run(f, { direction: { angleDeg: 90, strength: 1 }, preserveFlow: 0, routing: 0, forkSpread: 0 });
  for (const id of ['n000001', 'n000004']) assert.ok(up.layout.nodes[id].y > down.layout.nodes[id].y + 10);
  for (const tip of f.reduction.frontier) assert.deepEqual(up.layout.nodes[tip.id], down.layout.nodes[tip.id]);
  for (const id of f.reduction.visible) {
    const parent = f.rooted.nodes[id].parent; if (!parent) continue;
    const route = up.layout.routes[id], a = up.layout.nodes[parent], b = up.layout.nodes[id];
    assert.ok(Math.abs(route.segments[0].c1.x - a.x) < 1e-8);
    assert.ok(route.segments[0].c1.y < a.y);
    assert.ok(Math.abs(route.segments.at(-1)!.c2.x - b.x) < 1e-8);
    assert.ok(route.segments.at(-1)!.c2.y > b.y);
  }
  assert.equal(up.directedEdges, 6); assert.equal(up.directionConflicts, 0);
  assert.ok(down.directionConflicts > 0); // The fixed origin cannot feed downward into an upper crown.
  validateLayout(up.layout, f.rooted, f.reduction);
});
test('direction operates independently of smoothing, retains waypoints and honors zero strength', async () => {
  const f = await fixture(); splitRoute(f.layout, f.rooted, 'n000002');
  const off = run(f), zero = run(f, { direction: { angleDeg: 80, strength: 0 } }); assert.deepEqual(zero.layout, off.layout);
  assert.equal(zero.directedEdges, 0);
  const noOp = run(f, { direction: { angleDeg: 270, strength: 1 }, strength: 0 }); assert.deepEqual(noOp.layout, f.layout);
  const fitted = run(f, { direction: { angleDeg: 270, strength: 1 }, smoothing: 0, routing: 0, forkSpread: 0 });
  assert.equal(fitted.layout.routes.n000002.segments.length, 2);
  let start = fitted.layout.nodes.n000001;
  for (const segment of fitted.layout.routes.n000002.segments) {
    assert.ok(Math.abs(segment.c1.x - start.x) < 1e-8); assert.ok(segment.c1.y < start.y);
    assert.ok(Math.abs(segment.c2.x - segment.end.x) < 1e-8); assert.ok(segment.c2.y > segment.end.y); start = segment.end;
  }
  assert.deepEqual(run(f, { direction: { angleDeg: 270, strength: 1 }, smoothing: 0, routing: 0, forkSpread: 0 }), fitted);
  validateLayout(fitted.layout, f.rooted, f.reduction);
});
test('per-border direction overrides allow opposite groups and explicit automatic direction', async () => {
  const f = await fixture(), second = { ...structuredClone(f.border), id: 'roots', name: 'Roots', points: [{ x: 55, y: 205 }, { x: 80, y: 205 }], assignments: [], direction: { angleDeg: 90, strength: 1 } };
  f.design.borders.push(second); assignBorder(f.design, second.id, ['n000005', 'n000006'], f.rooted, f.layout);
  const settings = { direction: { angleDeg: 270, strength: 1 } }, fitted = run(f, settings);
  for (const id of ['n000002', 'n000003']) assert.ok(fitted.layout.routes[id].segments.at(-1)!.c2.y > fitted.layout.nodes[id].y);
  for (const id of ['n000005', 'n000006']) assert.ok(fitted.layout.routes[id].segments.at(-1)!.c2.y < fitted.layout.nodes[id].y);
  for (const b of f.design.borders) for (const t of borderTargets(b, f.rooted, f.reduction, f.layout)) assert.deepEqual(fitted.layout.nodes[t.id], t.point);
  f.design.borders[1].direction = null;
  assert.equal(run(f, settings).directedEdges, 3);
  delete f.design.borders[1].direction;
  assert.equal(run(f, settings).directedEdges, 6);
});
test('direction keeps pinned routes exact and confines active-border fitting to its assigned clade', async () => {
  const f = await fixture(); f.layout.pinnedNodes = ['n000001']; f.layout.pinnedEdges = ['n000002'];
  bindBorder(f.border, ['n000002', 'n000003'], f.rooted, f.layout);
  const result = run(f, { direction: { angleDeg: 180, strength: 1 } });
  for (const id of ['n000000', 'n000001', 'n000002', 'n000004', 'n000005', 'n000006']) assert.deepEqual(result.layout.nodes[id], f.layout.nodes[id]);
  for (const id of ['n000002', 'n000004', 'n000005', 'n000006']) assert.deepEqual(result.layout.routes[id], f.layout.routes[id]);
  validateLayout(result.layout, f.rooted, f.reduction);
});
test('direction settings persist, reject malformed inputs and remain optional for older projects', async () => {
  const f = await fixture(); f.design.fitSettings!.direction = { angleDeg: 315, strength: .75 }; f.border.direction = { angleDeg: 90, strength: 1 };
  const old = structuredClone(f.project), history = new History<Project>(); history.push(old);
  f.project.layout = run(f, f.design.fitSettings).layout;
  assert.deepEqual((await loadProject(JSON.stringify(f.project))).project, f.project);
  assert.deepEqual(history.undo(f.project), old); assert.deepEqual(history.redo(old), f.project);
  f.border.direction = null; assert.equal((await loadProject(JSON.stringify(f.project))).project.design!.borders[0].direction, null);
  const invalid = structuredClone(f.project); invalid.design!.borders[0].direction = { angleDeg: 361, strength: 1 };
  await assert.rejects(loadProject(JSON.stringify(invalid)), /Branch direction/);
  assert.throws(() => validateFitSettings({ ...DEFAULT_FIT_SETTINGS, direction: { angleDeg: 0, strength: NaN } }), /Branch direction/);
  delete f.border.direction; delete f.design.fitSettings!.direction;
  assert.deepEqual((await loadProject(JSON.stringify(f.project))).project, f.project);
  assert.equal(directionAngle({ x: 4, y: 8 }, { x: 4, y: 2 }), 270);
  assert.equal(directionAngle({ x: 4, y: 8 }, { x: 10, y: 8 }), 0);
  assert.throws(() => directionAngle({ x: 4, y: 8 }, { x: 4, y: 8 }), /at least 1 mm/);
});


test('spacing-aware routing removes crowded parallel forks while preserving common forward flow', async () => {
  const f = await fixture(), direction = { angleDeg: 270, strength: 1 };
  const aligned = run(f, { direction, routing: 0, forkSpread: 0 }), natural = run(f, { direction });
  const qa = (layout: typeof f.layout) => validateGeometry(f.source, f.rooted, f.recipe, f.reduction, layout, f.presentation);
  assert.ok(qa(aligned.layout).issues.filter(i => i.type === 'crossing').length >= 3);
  assert.equal(qa(natural.layout).crossingPassed, true); assert.equal(qa(natural.layout).clearancePassed, true);
  assert.ok(qa(natural.layout).minClearanceMm! > f.presentation.clearanceMm);
  assert.equal(natural.directionConflicts, 0); assert.ok(natural.refinedRoutes > 0); assert.equal(natural.routingLimited, false);
  for (const parent of ['n000000', 'n000001', 'n000004']) {
    const a = natural.layout.nodes[parent], tangents = f.rooted.nodes[parent].children.map(id => {
      const b = natural.layout.routes[id].segments[0].c1; return { x: b.x - a.x, y: b.y - a.y };
    });
    const [v, w] = tangents, cosine = (v.x * w.x + v.y * w.y) / (Math.hypot(v.x, v.y) * Math.hypot(w.x, w.y));
    assert.ok(cosine < Math.cos(20 * Math.PI / 180));
  }
  for (const t of borderTargets(f.border, f.rooted, f.reduction, f.layout)) assert.deepEqual(natural.layout.nodes[t.id], t.point);
  assert.deepEqual(run(f, { direction }), natural);
});
test('stroke width informs routing and impossible thick-stroke clearances remain reported', async () => {
  const f = await fixture(), settings = { direction: { angleDeg: 270, strength: 1 } }, thin = run(f, settings);
  f.presentation.strokeMm = 1;
  const thick = run(f, settings), unrefined = run(f, { ...settings, routing: 0, forkSpread: 0 });
  assert.notDeepEqual(thin.layout.routes, thick.layout.routes);
  const qa = (layout: typeof f.layout) => validateGeometry(f.source, f.rooted, f.recipe, f.reduction, layout, f.presentation);
  const before = qa(unrefined.layout), after = qa(thick.layout);
  // The former scalar test rewarded a 3-to-7 increase in contact pairs to gain
  // 1 mm of worst clearance. Contact non-regression takes priority instead.
  assert.ok(after.issues.filter(i => i.type === 'crossing' || i.type === 'self-intersection').length <= before.issues.filter(i => i.type === 'crossing' || i.type === 'self-intersection').length);
  assert.ok(after.minClearanceMm! > before.minClearanceMm!);
  for (const target of borderTargets(f.border, f.rooted, f.reduction, f.layout)) assert.deepEqual(thick.layout.nodes[target.id], target.point);
  assert.equal(qa(thick.layout).status, 'draft');
  assert.equal(qa(thick.layout).coveragePassed, true); assert.equal(qa(thick.layout).incidencePassed, true);
});
test('straight fitting moves junctions while preserving straight segments, pins and waypoints', async () => {
  const f = await fixture(); f.layout.lineStyle = 'straight'; splitRoute(f.layout, f.rooted, 'n000002');
  f.layout.pinnedEdges = ['n000005'];
  const fit = run(f, { direction: { angleDeg: 270, strength: 1 } });
  assert.equal(fit.layout.lineStyle, 'straight'); assert.equal(fit.layout.routes.n000002.segments.length, 2);
  assert.deepEqual(fit.layout.routes.n000005, f.layout.routes.n000005);
  assert.ok(fit.movedJunctions.length > 0);
  for (const id of f.reduction.visible.filter(id => f.rooted.nodes[id].parent)) {
    assert.ok(!pathData(f.rooted, fit.layout, id).includes('C'));
    assert.equal((pathData(f.rooted, fit.layout, id).match(/L/g) ?? []).length, fit.layout.routes[id].segments.length);
  }
  assert.deepEqual(run(f, { smoothing: 0 }).layout, run(f, { smoothing: 1 }).layout);
  assert.equal(validateGeometry(f.source, f.rooted, f.recipe, f.reduction, fit.layout, f.presentation).incidencePassed, true);
});
test('routing controls and straight mode round-trip, reject invalid settings, and preserve older project defaults', async () => {
  const f = await fixture(); f.project.layout.lineStyle = 'straight';
  f.project.design!.fitSettings = { ...DEFAULT_FIT_SETTINGS, routing: .8, forkSpread: .3 };
  assert.deepEqual((await loadProject(JSON.stringify(f.project))).project, f.project);
  const bad = structuredClone(f.project); (bad.layout as { lineStyle: string }).lineStyle = 'broken';
  await assert.rejects(loadProject(JSON.stringify(bad)), /line style/);
  for (const key of ['routing', 'forkSpread']) for (const value of [-1, 2, NaN, null, '1']) assert.throws(() => validateFitSettings({ ...DEFAULT_FIT_SETTINGS, [key]: value }), new RegExp(key));
  const old = { ...DEFAULT_FIT_SETTINGS }; delete old.routing; delete old.forkSpread; validateFitSettings(old);
  assert.deepEqual(run(f, { ...old, routing: undefined, forkSpread: undefined }).layout, run(f, { routing: 0, forkSpread: 0 }).layout);
});

test('path search clears a bowed branch from a pinned route without moving scientific junctions', async () => {
  const source = await parseNewick('(A:1,B:1);'), recipe = defaultRecipe(source); recipe.globalThreshold = 0;
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe), p = structuredClone(DEFAULT_PRESENTATION), layout = generateLayout(rooted, reduction, p, 'organic');
  layout.nodes = { n000000: { x: 10, y: 100 }, n000001: { x: 75, y: 40 }, n000002: { x: 75, y: 100 } };
  layout.routes = {
    n000001: { segments: [{ c1: { x: 30, y: 103 }, c2: { x: 45, y: 40 }, end: { ...layout.nodes.n000001 } }] },
    n000002: { segments: [{ c1: { x: 30, y: 100 }, c2: { x: 55, y: 100 }, end: { ...layout.nodes.n000002 } }] },
  };
  layout.pinnedEdges = ['n000002']; const before = structuredClone(layout);
  const check = () => validateGeometry(source, rooted, recipe, reduction, layout, p), oldQA = check();
  assert.equal(oldQA.crossingPassed, false);
  const result = refineRouting(rooted, reduction, layout, p, [], new Set(['n000001']), DEFAULT_FIT_SETTINGS, {});
  const afterQA = check(); assert.equal(afterQA.crossingPassed, true);
  assert.ok(afterQA.minClearanceMm! > oldQA.minClearanceMm! + .5);
  assert.equal(result.refinedRoutes, 1); assert.equal(result.routingLimited, false);
  assert.deepEqual(layout.nodes, before.nodes); assert.deepEqual(layout.routes.n000002, before.routes.n000002);
  validateLayout(layout, rooted, reduction);
});
