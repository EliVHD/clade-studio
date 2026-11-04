import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNewick } from '../src/newick.ts';
import { defaultRecipe, orient } from '../src/science.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED, estimatedMeasurements, labelCorners, layoutCluster, sceneRevision } from '../src/structured/layout.ts';
import { replayArtistic } from '../src/structured/artistic.ts';
import { polygonsOverlap, segmentDistance, validateScene } from '../src/structured/validate.ts';
import { validateScene as validateHistoricalScene } from '../src/structured/validate-v1.ts';
import { validateScene as validateV2 } from '../src/structured/validate-v2.ts';
import { sceneChecksComplete, sceneIncidenceSummary } from '../src/structured/qa-summary.ts';
import type { ArtisticEdit, StructuredSettings } from '../src/structured/types.ts';

const projection = { selection: { kind: 'all' as const }, collapse: [], expand: [], reveal: [], childOrder: {} };
async function fixture(text: string, changes: Partial<StructuredSettings> = {}) {
  const source = await parseNewick(text), rooted = orient(source, defaultRecipe(source).root);
  const graph = projectTree(source, rooted, projection), settings = { ...DEFAULT_STRUCTURED, ...changes };
  const metrics = estimatedMeasurements(graph, settings); metrics.fontStatus = 'available';
  return { graph, scene: layoutCluster(graph, settings, metrics) };
}
const star = (count: number) => '(' + Array.from({ length: count }, (_, i) => `T${i}:1`).join(',') + ');';

async function incidentBranches(degrees: number) {
  const f = await fixture('(A:1,B:1);', { kind: 'circular', innerRadiusMm: 0, outerRadiusMm: 100, widthMm: 400, heightMm: 400 });
  const edits: ArtisticEdit[] = [];
  let scene = f.scene;
  for (const [index, id] of f.graph.endpoints.entries()) {
    const angle = index * degrees * Math.PI / 180, target = { x: 200 + 100 * Math.cos(angle), y: 200 + 100 * Math.sin(angle) };
    const from = scene.junctionGlyphs.find(g => g.nodeId === id)!.anchor;
    edits.push({ kind: 'move-junction', nodeIds: [id], delta: { x: target.x - from.x, y: target.y - from.y } });
    edits.push({ kind: 'move-label', nodeId: id, delta: { x: 20, y: index ? 20 : -20 } });
    scene = replayArtistic(f.graph, f.scene, edits);
  }
  return { graph: f.graph, scene };
}

test('current QA catches long incident overlap while historical replay remains exact', async () => {
  const f = await incidentBranches(.6), qa = validateScene(f.graph, f.scene);
  assert.equal(validateHistoricalScene(f.graph, f.scene).status, 'checked');
  assert.equal(qa.incidencePassed, true);
  assert.equal(qa.crossingPassed, false);
  assert.equal(qa.clearancePassed, false);
  assert.equal(qa.issueCounts!.contact, 1);
  assert.equal(qa.status, 'draft');
  assert.deepEqual(qa.completeness, { incidence: true, strokes: true, labels: true });
  assert.deepEqual(qa.issues.find(issue => issue.type === 'contact')!.ids.sort(), f.scene.edgeStems.map(stem => stem.id).sort());
  const legal = await incidentBranches(60), legalQA = validateScene(legal.graph, legal.scene);
  assert.equal(legalQA.crossingPassed, true);
  assert.equal(legalQA.clearancePassed, true);
});

test('current QA detects self-crossing and adjacent backtracking without rejecting continuous waypoints', async () => {
  const f = await fixture('(A:1);'), edgeId = f.scene.edgeStems[0].edgeId;
  const crossing = replayArtistic(f.graph, f.scene, [{ kind: 'stem-waypoints', edgeId, points: [{ x: 60, y: 30 }, { x: 100, y: 70 }, { x: 60, y: 70 }, { x: 100, y: 30 }] }]);
  assert.equal(validateHistoricalScene(f.graph, crossing).status, 'checked');
  const qa = validateScene(f.graph, crossing);
  assert.equal(qa.crossingPassed, false);
  assert.equal(qa.issueCounts!.contact, 1);
  assert.deepEqual(qa.issues.find(issue => issue.type === 'contact')!.ids, [f.scene.edgeStems[0].id]);
  const returning = replayArtistic(f.graph, f.scene, [{ kind: 'stem-waypoints', edgeId, points: [{ x: 70, y: 70 }, { x: 140, y: 70 }, { x: 90, y: 70 }] }]);
  assert.equal(validateScene(f.graph, returning).crossingPassed, false);
  const tightHairpin = replayArtistic(f.graph, f.scene, [{ kind: 'stem-waypoints', edgeId, points: [{ x: 70, y: 70 }, { x: 75, y: 70 }, { x: 75, y: 70.1 }, { x: 70, y: 70.1 }] }]);
  assert.equal(validateScene(f.graph, tightHairpin).crossingPassed, false);
  const y = f.scene.ports[0].point.y;
  const continuous = replayArtistic(f.graph, f.scene, [{ kind: 'stem-waypoints', edgeId, points: [{ x: 60, y }, { x: 60, y }, { x: 100, y }, { x: 200, y }] }]);
  assert.equal(validateScene(f.graph, continuous).status, 'checked');
});

test('legal compound connectors stay attached across arcs, polylines, rotations and the circular seam', async () => {
  for (const kind of ['rectangular', 'circular', 'fan'] as const) for (const curves of [true, false]) for (const orientationDeg of [0, 90, 359]) {
    const f = await fixture('((A:1,B:1):1,(C:1,D:1,E:1):1);', {
      kind, curves, orientationDeg, startAngleDeg: 350, sweepDeg: kind === 'fan' ? 270 : 360,
      innerRadiusMm: 30, outerRadiusMm: 100, widthMm: 400, heightMm: 400,
      strokeMm: .1, clearanceMm: .1, toleranceMm: .001,
    });
    const qa = validateScene(f.graph, f.scene);
    assert.equal(qa.incidencePassed, true, `${kind}/${curves}/${orientationDeg}: incidence`);
    assert.equal(qa.crossingPassed, true, `${kind}/${curves}/${orientationDeg}: contacts ${JSON.stringify(qa.issues)}`);
    assert.equal(qa.clearancePassed, true, `${kind}/${curves}/${orientationDeg}: clearance`);
    assert.deepEqual(qa.completeness, { incidence: true, strokes: true, labels: true });
  }
});

test('relative intersection tolerance does not mistake collinear continuations for crossings', () => {
  const a = { x: 312.6798754587849, y: 363.8283370280351 }, b = { x: 334.37224631926025, y: 389.1318778159115 };
  const c = { x: 334.6000154505694, y: 389.3975660071832 }, d = { x: 356.2923863110447, y: 414.70110679505954 };
  const expected = Math.hypot(c.x - b.x, c.y - b.y);
  assert.ok(Math.abs(segmentDistance(a, b, c, d).distance - expected) < 1e-10);
  assert.ok(Math.abs(segmentDistance(d, c, b, a).distance - expected) < 1e-10);
  assert.equal(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }).distance, 0);
  assert.equal(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 8, y: 0 }, { x: 3, y: 0 }).distance, 0);
});

test('spacious 600-tip circles complete all checks under the unchanged work limit', async () => {
  for (const curves of [true, false]) {
    const f = await fixture(star(600), { kind: 'circular', curves, innerRadiusMm: 300, outerRadiusMm: 500, widthMm: 1200, heightMm: 1200 });
    const qa = validateScene(f.graph, f.scene);
    assert.equal(qa.status, 'checked', JSON.stringify(qa.issues));
    assert.deepEqual(qa.completeness, { incidence: true, strokes: true, labels: true });
    assert.equal(qa.limited, false);
    assert.ok(qa.work! < 500000);
    assert.deepEqual(qa, validateScene(f.graph, f.scene));
  }
});

test('bounded issue examples retain complete category totals beyond 200 findings', async () => {
  const f = await fixture(star(80), { kind: 'circular', innerRadiusMm: 0, outerRadiusMm: 7, widthMm: 400, heightMm: 400, strokeMm: .8, junctionMm: .1, clearanceMm: .1 });
  const qa = validateScene(f.graph, f.scene);
  assert.equal(qa.limited, false);
  assert.equal(qa.issues.length, 200);
  assert.ok(qa.issueCounts!.contact > 200);
  assert.equal(qa.issueCounts!.labels, qa.labelCollisions);
  assert.ok(qa.labelCollisions > 0);
  assert.equal(Object.values(qa.issueCounts!).reduce((a, b) => a + b, 0), qa.issues.length + qa.omittedIssueCount);
});

test('exhausted validation explicitly marks incomplete checks and never asserts a stroke all-clear', async () => {
  const f = await fixture(star(600), { kind: 'circular', innerRadiusMm: 0, outerRadiusMm: 7, widthMm: 400, heightMm: 400, strokeMm: .8, junctionMm: .1, clearanceMm: .1 });
  const qa = validateScene(f.graph, f.scene);
  assert.equal(qa.limited, true);
  assert.equal(qa.work, 500000);
  assert.equal(qa.status, 'draft');
  assert.deepEqual(qa.completeness, { incidence: true, strokes: false, labels: false });
  assert.equal(qa.crossingPassed, false);
  assert.equal(qa.clearancePassed, false);
  assert.equal(qa.issueCounts!.legibility, 1);
  assert.equal(qa.incidencePassed, true, 'later exhaustion does not erase completed incidence checks');
  assert.equal(sceneIncidenceSummary(qa), 'pass');
});

test('truncated incidence is incomplete rather than a pass or a fabricated detached junction', async () => {
  for (const kind of ['rectangular', 'circular'] as const) {
    const f = await fixture('(A:1,B:1,C:1);', { kind });
    for (const work of [1, 2, 3]) {
      const qa = validateScene(f.graph, f.scene, { work });
      assert.equal(qa.work, work);
      assert.equal(qa.incidencePassed, false);
      assert.equal(qa.completeness!.incidence, false);
      assert.equal(qa.issueCounts!.incidence, 0, 'unchecked attachments are not detected failures');
      assert.equal(sceneIncidenceSummary(qa), 'incomplete');
      assert.equal(sceneChecksComplete(qa), false);
      assert.match(qa.issues.find(i => i.type === 'legibility')!.detail, /incidence.*incomplete/);
    }
  }
});

test('a 5,000-tip late detached stem cannot receive a truncated incidence pass', async () => {
  const f = await fixture(star(5000), { kind: 'circular', curves: false, widthMm: 2000, heightMm: 2000, innerRadiusMm: 50, toleranceMm: .001 });
  const stem = f.scene.edgeStems.at(-1)!, port = f.scene.ports.find(p => p.id === stem.childPortId)!;
  assert.equal(stem.geometry.kind, 'polyline');
  if (stem.geometry.kind !== 'polyline') return;
  port.point = { x: port.point.x + 20, y: port.point.y + 20 };
  stem.geometry.points[stem.geometry.points.length - 1] = { ...port.point };
  f.scene.revision = sceneRevision(f.scene);
  const historical = validateV2(f.graph, f.scene), qa = validateScene(f.graph, f.scene);
  assert.equal(historical.incidencePassed, true, 'reproduces the saved v2 false pass');
  assert.equal(qa.work, 500000);
  assert.equal(qa.limited, true);
  assert.equal(qa.status, 'draft');
  assert.deepEqual(qa.completeness, { incidence: false, strokes: false, labels: false });
  assert.equal(qa.incidencePassed, false);
  assert.equal(qa.issueCounts!.incidence, 0, 'the detached late stem was not reached');
  assert.equal(sceneIncidenceSummary(qa), 'incomplete');
  f.scene.junctionGlyphs[0].anchor.x += 100;
  f.scene.revision = sceneRevision(f.scene);
  const knownFailure = validateScene(f.graph, f.scene);
  assert.equal(knownFailure.completeness!.incidence, false);
  assert.ok(knownFailure.issueCounts!.incidence > 0, 'confirmed failures survive truncation');
});

test('completed incidence distinguishes a confirmed detached attachment from incompleteness', async () => {
  const f = await fixture('(A:1,B:1);');
  const glyph = f.scene.junctionGlyphs.at(-1)!;
  glyph.anchor = { ...glyph.anchor, x: glyph.anchor.x + 10 };
  f.scene.revision = sceneRevision(f.scene);
  const qa = validateScene(f.graph, f.scene);
  assert.equal(qa.completeness!.incidence, true);
  assert.equal(qa.incidencePassed, false);
  assert.ok(qa.issueCounts!.incidence > 0);
  assert.equal(sceneIncidenceSummary(qa), 'review');
});

test('indexed rotated-label candidates agree with exhaustive polygon pairs', async () => {
  const f = await fixture(star(24), { kind: 'circular', innerRadiusMm: 40, outerRadiusMm: 100, widthMm: 400, heightMm: 400 });
  for (const [index, label] of f.scene.labels.entries()) {
    label.position = { x: 20 + (index % 6) * 3.2, y: 20 + Math.floor(index / 6) * 2.3 };
    label.rotationDeg = index * 37;
    label.corners = labelCorners(label.position, label.rotationDeg, label.anchor, f.scene.measurements.metrics[label.nodeId]);
  }
  f.scene.revision = sceneRevision(f.scene);
  let exhaustive = 0;
  for (let i = 0; i < f.scene.labels.length; i++) for (let j = i + 1; j < f.scene.labels.length; j++) if (polygonsOverlap(f.scene.labels[i].corners, f.scene.labels[j].corners)) exhaustive++;
  const qa = validateScene(f.graph, f.scene);
  assert.equal(qa.limited, false);
  assert.equal(qa.labelCollisions, exhaustive);
  assert.equal(qa.issueCounts!.labels, exhaustive);
});
