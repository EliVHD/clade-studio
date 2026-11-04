import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient, reduce } from '../src/science.ts';
import { DEFAULT_PRESENTATION, generateLayout, validateGeometry, splitRoute } from '../src/geometry.ts';
import { DEFAULT_FIT_SETTINGS } from '../src/fit-settings.ts';
import { refineRouting } from '../src/routing.ts';

async function fixture(count = 6) {
  const source = await parseNewick('(' + Array.from({ length: count }, (_, i) => `T${i}:1`).join(',') + ');');
  const recipe = { ...defaultRecipe(source), globalThreshold: 0 };
  const rooted = orient(source, recipe.root), reduction = reduce(source, rooted, recipe);
  const presentation = structuredClone(DEFAULT_PRESENTATION);
  const layout = generateLayout(rooted, reduction, presentation, 'organic');
  layout.nodes[rooted.rootId] = { x: 45, y: 180 };
  for (const [index, entry] of reduction.frontier.entries()) {
    const point = { x: 8 + index * 74 / (count - 1), y: 30 + index % 2 * 8 };
    layout.nodes[entry.id] = point;
    layout.routes[entry.id] = { segments: [{ c1: { x: 45 + (index % 2 ? -1 : 1) * 8, y: 100 }, c2: { x: point.x, y: point.y + 40 }, end: { ...point } }] };
  }
  const ids = reduction.frontier.map(entry => entry.id);
  const contacts = () => {
    const qa = validateGeometry(source, rooted, recipe, reduction, layout, presentation);
    assert.equal(qa.omittedIssueCount, 0, 'the regression counts every contact rather than a truncated list');
    return qa.issues.filter(issue => issue.type === 'crossing' || issue.type === 'self-intersection').length;
  };
  return { source, recipe, rooted, reduction, presentation, layout, ids, contacts };
}

test('routing never trades additional contact pairs for appearance across widths and line modes', async () => {
  for (const strokeMm of [.25, 1]) for (const straight of [false, true]) {
    const f = await fixture(4); f.presentation.strokeMm = strokeMm;
    if (straight) f.layout.lineStyle = 'straight';
    splitRoute(f.layout, f.rooted, f.ids[0]);
    f.layout.pinnedEdges = [f.ids[1]];
    const original = structuredClone(f.layout), count = f.contacts();
    const inputs = [f.rooted, f.reduction, f.layout, f.presentation, [], new Set(f.ids), DEFAULT_FIT_SETTINGS, {}] as const;
    const result = refineRouting(...inputs);
    assert.ok(f.contacts() <= count);
    assert.deepEqual(f.layout.nodes, original.nodes);
    assert.deepEqual(f.layout.routes[f.ids[1]], original.routes[f.ids[1]]);
    for (const id of f.ids) assert.equal(f.layout.routes[id].segments.length, original.routes[id].segments.length);
    const duplicate = structuredClone(original);
    const repeat = refineRouting(f.rooted, f.reduction, duplicate, f.presentation, [], new Set(f.ids), DEFAULT_FIT_SETTINGS, {});
    assert.deepEqual(duplicate, f.layout);
    assert.deepEqual(repeat, result);
  }
});

test('bounded routing distributes its first trials across dense and sparse routes', async () => {
  const f = await fixture();
  // A sharply bowed early route makes the conflict region substantially more expensive.
  f.layout.routes[f.ids[0]].segments[0].c1 = { x: 85, y: 205 };
  f.layout.routes[f.ids[0]].segments[0].c2 = { x: 1, y: 1 };
  const before = structuredClone(f.layout), count = f.contacts();
  const result = refineRouting(f.rooted, f.reduction, f.layout, f.presentation, [], new Set(f.ids), { ...DEFAULT_FIT_SETTINGS, forkSpread: 0 }, {}, { work: 120000 });
  assert.equal(result.routingLimited, true);
  assert.ok(result.routingDiagnostics.work <= 120000);
  for (const id of f.ids) assert.ok(result.routingDiagnostics.attemptedItems[`route:${id}`] >= 1, `${id} received no trial`);
  assert.ok(f.contacts() <= count);
  assert.deepEqual(f.layout.nodes, before.nodes);
});

test('an interrupted trial restores all junctions and route handles exactly', async () => {
  const f = await fixture(4), before = structuredClone(f.layout);
  const result = refineRouting(f.rooted, f.reduction, f.layout, f.presentation, [], new Set(f.ids), DEFAULT_FIT_SETTINGS, {}, { work: 1 });
  assert.equal(result.routingLimited, true);
  assert.equal(result.refinedRoutes, 0);
  assert.equal(result.routingDiagnostics.accepted, 0);
  assert.ok(result.routingDiagnostics.work <= 1);
  assert.deepEqual(f.layout, before);
});

test('a 1,200-tip fork bounds candidate enumeration even with a one-operation budget', async () => {
  const f = await fixture(1200), before = structuredClone(f.layout);
  const run = () => refineRouting(f.rooted, f.reduction, f.layout, f.presentation, [], new Set(f.ids), DEFAULT_FIT_SETTINGS, {}, { work: 1 });
  const result = run();
  assert.equal(result.routingLimited, true);
  assert.equal(result.routingDiagnostics.work, 1);
  assert.ok(result.routingDiagnostics.candidateVisits <= 1);
  assert.ok(result.routingDiagnostics.candidatePairs <= 1);
  assert.equal(result.routingDiagnostics.evaluations, 0);
  assert.equal(result.refinedRoutes, 0);
  assert.deepEqual(f.layout, before);
  assert.deepEqual(run(), result);
});

test('exact evaluation exhaustion discloses skipped route trials after a completed comparison', async () => {
  const f = await fixture(2);
  const result = refineRouting(f.rooted, f.reduction, f.layout, f.presentation, [], new Set([f.ids[0]]), { ...DEFAULT_FIT_SETTINGS, forkSpread: 0 }, {}, { evaluations: 2 });
  assert.equal(result.routingDiagnostics.evaluations, 2);
  assert.equal(result.routingDiagnostics.attempts, 1, 'only one of forty scheduled route trials ran');
  assert.equal(result.routingLimited, true);
});

test('exact work exhaustion is disclosed and a completed search remains unlimited', async () => {
  const f = await fixture(2), original = structuredClone(f.layout);
  const run = (work?: number) => refineRouting(f.rooted, f.reduction, f.layout, f.presentation, [], new Set([f.ids[0]]), { ...DEFAULT_FIT_SETTINGS, forkSpread: 0 }, {}, { work });
  const complete = run();
  assert.equal(complete.routingLimited, false);
  assert.equal(complete.routingDiagnostics.attempts, 40);
  f.layout = structuredClone(original);
  const exhausted = run(complete.routingDiagnostics.work);
  assert.equal(exhausted.routingDiagnostics.work, complete.routingDiagnostics.work);
  assert.equal(exhausted.routingLimited, true);
});
