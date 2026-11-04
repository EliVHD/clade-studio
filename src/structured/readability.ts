import type { DisplayGraph, RenderScene, SceneQA, StructuredSettings, TextMeasurements } from './types.ts';
import { layoutCluster } from './layout.ts';
import { validateScene } from './validate.ts';
import { sceneChecksComplete, sceneIssueCount } from './qa-summary.ts';

export type ReadabilityPolicy = 'keep-page' | 'grow-page';
export type ReadabilityResult = {
  scene: RenderScene; qa: SceneQA;
  readability: { policy: ReadabilityPolicy; candidates: number; improved: boolean; before: ReturnType<typeof summarizeReadability>; after: ReturnType<typeof summarizeReadability>; };
};
function summarizeReadability(scene: RenderScene, qa: SceneQA) {
  return { widthMm: scene.settings.widthMm, heightMm: scene.settings.heightMm, outerRadiusMm: scene.settings.outerRadiusMm,
    labelCollisions: qa.labelCollisions, contacts: sceneIssueCount(qa, 'contact'),
    clearanceIssues: sceneIssueCount(qa, 'clearance'), limited: !sceneChecksComplete(qa),
    labelsComplete: qa.completeness?.labels ?? !qa.limited, status: qa.status };
}
function rankReadabilityScene(scene: RenderScene, qa: SceneQA): number[] {
  const s = scene.settings, b = scene.bounds;
  const overflow = Math.max(0, s.marginMm - b.minX + s.strokeMm / 2) + Math.max(0, s.marginMm - b.minY + s.strokeMm / 2)
    + Math.max(0, b.maxX + s.strokeMm / 2 - s.widthMm + s.marginMm) + Math.max(0, b.maxY + s.strokeMm / 2 - s.heightMm + s.marginMm);
  return [Number(!qa.coveragePassed || !qa.incidencePassed), Number(!sceneChecksComplete(qa)), Number(!qa.crossingPassed),
    sceneIssueCount(qa, 'contact'), qa.labelCollisions, Number(!qa.clearancePassed),
    sceneIssueCount(qa, 'clearance'), overflow, s.widthMm * s.heightMm, s.outerRadiusMm];
}
function isBetterReadabilityScore(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-7) return a[i] < b[i];
  return false;
}
function fitsReadabilityMargins(scene: RenderScene): boolean {
  const s = scene.settings, b = scene.bounds, epsilon = 1e-7;
  return b.minX >= s.marginMm - epsilon && b.minY >= s.marginMm - epsilon
    && b.maxX <= s.widthMm - s.marginMm + epsilon && b.maxY <= s.heightMm - s.marginMm + epsilon;
}
function fitReadabilityPage(graph: DisplayGraph, settings: StructuredSettings, metrics: TextMeasurements, nodes: RenderScene['nodeOffsets'], labels: RenderScene['labelOffsets']): RenderScene {
  let scene = layoutCluster(graph, settings, metrics, nodes, labels);
  // Enlarging a circular page translates its centre; remeasure actual rotated boxes.
  // Rectangular orientation can couple both dimensions, so stop after four passes.
  for (let pass = 0; pass < 4; pass++) {
    const s = scene.settings, b = scene.bounds, margin = s.marginMm + s.strokeMm / 2 + .1;
    // Existing rectangular anchors sit on the declared margin. Growing the page
    // cannot change that left edge, and previously added a millimetre every pass.
    if (fitsReadabilityMargins(scene)) break;
    const widthMm = Math.min(2000, Math.ceil(Math.max(s.widthMm, 2 * Math.max(s.widthMm / 2 - b.minX, b.maxX - s.widthMm / 2) + 2 * margin)));
    const heightMm = Math.min(2000, Math.ceil(Math.max(s.heightMm, 2 * Math.max(s.heightMm / 2 - b.minY, b.maxY - s.heightMm / 2) + 2 * margin)));
    if (widthMm === s.widthMm && heightMm === s.heightMm) break;
    scene = layoutCluster(graph, { ...s, widthMm, heightMm }, metrics, nodes, labels);
  }
  return scene;
}
/** Original bounded search of spacing/page parameters. Does not change topology, text, font size or offsets. */
export function improveReadability(graph: DisplayGraph, settings: StructuredSettings, metrics: TextMeasurements,
  policy: ReadabilityPolicy, nodes: RenderScene['nodeOffsets'] = {}, labels: RenderScene['labelOffsets'] = {}): ReadabilityResult {
  if (!['keep-page', 'grow-page'].includes(policy)) throw new Error('Unknown readability page policy.');
  const baseline = layoutCluster(graph, settings, metrics, nodes, labels), beforeQA = validateScene(graph, baseline);
  let scene = baseline, qa = beforeQA, best = rankReadabilityScene(scene, qa), candidates = 1;
  const initialOverflow = best[7];
  if (best.slice(0, 7).every(v => v === 0) && sceneIssueCount(qa, 'bounds') === 0 && fitsReadabilityMargins(scene)) return { scene, qa, readability: { policy, candidates, improved: false, before: summarizeReadability(baseline, beforeQA), after: summarizeReadability(scene, qa) } };
  const seen = new Set([JSON.stringify(baseline.settings)]);
  // Include a smaller radius for fixed pages with labels outside the page, and
  // larger radii for crowding. At most eight distinct, fully validated candidates.
  const requiredRadius = graph.endpoints.reduce((sum, id) => {
    const m = metrics.metrics[id], height = m.ascentMm + m.descentMm;
    // Conservative horizontal/tangential tangents; actual rotated boxes still decide.
    return sum + (settings.labelPlacement === 'radial' ? height : Math.hypot(m.widthMm, height)) + settings.terminalGapMm;
  }, 0) / (settings.sweepDeg * Math.PI / 180);
  const requiredFactor = requiredRadius / settings.outerRadiusMm;
  const factors = policy === 'keep-page' ? [.65, .8, 1, 1.2, 1.5, 2, 3] : [1, 1.25, 1.6, 2.1, 2.8, Math.max(3.8, requiredFactor), Math.max(5, requiredFactor * 1.25)];
  for (const factor of factors) {
    const s = { ...settings };
    if (s.kind !== 'rectangular') {
      s.outerRadiusMm = Math.min(950, settings.outerRadiusMm * factor);
      s.innerRadiusMm = Math.min(s.outerRadiusMm - .001, settings.innerRadiusMm * factor);
    } else if (policy === 'grow-page') {
      const minimumHeight = 2 * s.marginMm + graph.endpoints.reduce((sum, id) => sum + metrics.metrics[id].ascentMm + metrics.metrics[id].descentMm + s.terminalGapMm, 0);
      s.heightMm = Math.min(2000, Math.max(s.heightMm, Math.ceil(minimumHeight)));
      s.widthMm = Math.min(2000, settings.widthMm * factor);
    } else continue;
    const candidate = policy === 'grow-page' ? fitReadabilityPage(graph, s, metrics, nodes, labels) : layoutCluster(graph, s, metrics, nodes, labels);
    const key = JSON.stringify(candidate.settings); if (seen.has(key)) continue; seen.add(key); candidates++;
    const checked = validateScene(graph, candidate), rank = rankReadabilityScene(candidate, checked);
    // Partial totals are lower bounds, not comparable quality measurements. Keep
    // the original unless a candidate completes all checks on its actual geometry.
    if (!sceneChecksComplete(checked)) continue;
    if (policy === 'keep-page' && rank[7] > initialOverflow + 1e-7) continue;
    if (isBetterReadabilityScore(rank, best)) { scene = candidate; qa = checked; best = rank; }
    if (best.slice(0, 8).every(v => v === 0)) break;
  }
  return { scene, qa, readability: { policy, candidates, improved: scene.revision !== baseline.revision, before: summarizeReadability(baseline, beforeQA), after: summarizeReadability(scene, qa) } };
}

/** Translate issue identities to selectable biological owners and physical focus bounds. */
export function locateIssue(scene: RenderScene, ids: string[]): { nodeIds: string[]; bounds: RenderScene['bounds'] } {
  const nodeIds = new Set<string>(), points: { x: number; y: number }[] = [];
  for (const id of ids) {
    if(scene.metric&&id.startsWith('metric-scale-'))points.push(scene.metric.scaleBar.from,scene.metric.scaleBar.to,...scene.metric.scaleBar.corners);
    const label = scene.labels.find(l => l.id === id), glyph = scene.junctionGlyphs.find(g => g.id === id), stem = scene.edgeStems.find(e => e.id === id);
    if (label) { nodeIds.add(label.nodeId); points.push(...label.corners); }
    if (glyph) { nodeIds.add(glyph.nodeId); points.push(glyph.anchor, ...scene.ports.filter(p => p.nodeId === glyph.nodeId).map(p => p.point)); }
    if (stem) for (const port of scene.ports.filter(p => p.id === stem.parentPortId || p.id === stem.childPortId)) { nodeIds.add(port.nodeId); points.push(port.point); }
  }
  return { nodeIds: [...nodeIds], bounds: points.length ? {
    minX: Math.min(...points.map(p => p.x)), minY: Math.min(...points.map(p => p.y)), maxX: Math.max(...points.map(p => p.x)), maxY: Math.max(...points.map(p => p.y)),
  } : scene.bounds };
}
