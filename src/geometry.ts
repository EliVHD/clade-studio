import type { Point, Layout, Rooted, Reduction, Presentation, QA, Issue, Source, Recipe } from './types.ts';
import { reduce } from './science.ts';

export const DEFAULT_PRESENTATION: Presentation = {
  widthMm: 90, heightMm: 220, strokeMm: .25, taper: .8, clearanceMm: .6,
  toleranceMm: .025, junctionMm: 1, sourceUnitMm: 30, labels: false, labelOffsets: {},
};
export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
export const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const finitePoint = (p: Point | undefined) => p && Number.isFinite(p.x) && Number.isFinite(p.y);
const rounded = (v: number): string => Number(v.toFixed(6)).toString();
export function orderedChildren(rooted: Rooted, layout: Layout, id: string): string[] {
  const children = rooted.nodes[id].children, custom = layout.childOrder[id];
  return custom && custom.length === children.length && new Set(custom).size === children.length && custom.every(x => children.includes(x)) ? custom : children;
}

export function generateLayout(rooted: Rooted, reduction: Reduction, p: Presentation, mode: Layout['mode'], previous?: Layout): Layout {
  const out: Layout = { nodes: {}, routes: {}, pinnedNodes: [], pinnedEdges: [], childOrder: previous?.childOrder ?? {}, mode };
  if (previous?.lineStyle) out.lineStyle = previous.lineStyle;
  const frontier = new Set(reduction.frontier.map(x => x.id));
  const spans: Record<string, [number, number]> = {}, heights: Record<string, number> = {};
  let index = 0;
  const measure = (id: string): void => {
    if (frontier.has(id)) { spans[id] = [index, index++]; heights[id] = 0; return; }
    const children = orderedChildren(rooted, out, id); children.forEach(measure);
    spans[id] = [spans[children[0]][0], spans[children.at(-1)!][1]];
    heights[id] = Math.max(...children.map(c => heights[c] + Math.max(.25, Math.pow(Math.max(0, rooted.nodes[c].length ?? .1), .35))));
  };
  measure(rooted.rootId);
  const total = Math.max(1, reduction.frontier.length - 1), maxHeight = Math.max(.01, heights[rooted.rootId]);
  const radius: Record<string, number> = {}, angle: Record<string, number> = {};
  for (const id of reduction.visible) {
    const center = (spans[id][0] + spans[id][1]) / 2 / total;
    radius[id] = 1 - Math.pow(heights[id] / maxHeight, .72);
    // A continuous ordered sweep reserves the last 15% for real downward descendants.
    angle[id] = (-172 + center * 226) * Math.PI / 180;
    if (mode === 'scientific') {
      out.nodes[id] = { x: p.widthMm * (.08 + .8 * radius[id]), y: p.heightMm * (.055 + .88 * center) };
    }
  }
  if (mode === 'organic') {
    // Ordered sectors preserve clade neighborhoods. Cumulative source-edge depth
    // gives unequal terminal reach, avoiding a ring of uniformly long end twigs.
    const rootTips = reduction.frontier.length >= 12 ? Math.max(2, Math.round(reduction.frontier.length * .08)) : 0;
    const crownTips = reduction.frontier.length - rootTips;
    const depths: Record<string, number> = {};
    for (const id of reduction.visible) {
      const n = rooted.nodes[id];
      depths[id] = n.parent ? depths[n.parent] + .35 + Math.sqrt(Math.max(0, n.length ?? .1)) : 0;
    }
    const side: Record<string, string> = {}, sideDepths: Record<string, number[]> = {};
    for (const id of reduction.visible) {
      const parent = rooted.nodes[id].parent;
      side[id] = parent === rooted.rootId ? id : parent ? side[parent] : id;
      if (frontier.has(id)) (sideDepths[side[id]] ??= []).push(depths[id]);
    }
    const scales = Object.fromEntries(Object.entries(sideDepths).map(([id, values]) => {
      values.sort((a, b) => a - b); return [id, values[Math.floor((values.length - 1) * .94)] || 1];
    }));
    const origin = { x: p.widthMm * .48, y: p.heightMm * .61 };
    for (const id of reduction.visible) {
      const i = (spans[id][0] + spans[id][1]) / 2;
      let envelope: Point;
      if (i < crownTips) {
        const a = (-198 + i / Math.max(1, crownTips - 1) * 216) * Math.PI / 180;
        const irregularity = .96 + .035 * Math.sin(a * 5);
        envelope = { x: p.widthMm * (.5 + Math.cos(a) * .42 * irregularity), y: p.heightMm * (.41 + Math.sin(a) * .34 * irregularity) };
      } else {
        const t = (i - crownTips) / Math.max(1, rootTips - 1);
        envelope = { x: p.widthMm * (.73 - .46 * t), y: p.heightMm * (.86 + .045 * Math.sin(t * Math.PI)) };
      }
      let reach = Math.min(1.04, Math.pow(depths[id] / (scales[side[id]] || 1), .8));
      if (i >= crownTips) reach = .75 + .25 * Math.min(1, reach);
      if (id === rooted.rootId) reach = 0;
      out.nodes[id] = lerp(origin, envelope, reach);
    }
  }

  for (const id of reduction.visible) {
    const parent = rooted.nodes[id].parent; if (!parent) continue;
    const a = out.nodes[parent], b = out.nodes[id];
    let c1 = lerp(a, b, 1 / 3), c2 = lerp(a, b, 2 / 3);
    if (mode === 'scientific') { c1 = { x: (a.x + b.x) / 2, y: a.y }; c2 = { x: (a.x + b.x) / 2, y: b.y }; }
    else {
      // Modest bend, bounded relative to each edge. Every path still joins its scientific nodes.
      const bend = Math.min(1.3, distance(a, b) * .075) * Math.sin(angle[id] - angle[parent]);
      c1 = add(c1, { x: -bend, y: bend * .35 }); c2 = add(c2, { x: -bend, y: bend * .35 });
    }
    out.routes[id] = { segments: [{ c1, c2, end: { ...b } }] };
  }
  return out;
}

/** Preserve all existing artwork, including hidden descendants, when the frontier changes. */
export function reconcileLayout(rooted: Rooted, reduction: Reduction, p: Presentation, old: Layout): Layout {
  const fresh = generateLayout(rooted, reduction, p, old.mode, old), result = structuredClone(old);
  const visible = new Set(reduction.visible);
  for (const id of reduction.visible) {
    if (result.nodes[id]) continue;
    let anchor = rooted.nodes[id].parent;
    while (anchor && !old.nodes[anchor]) anchor = rooted.nodes[anchor].parent;
    const shift = anchor ? sub(old.nodes[anchor], fresh.nodes[anchor]) : { x: 0, y: 0 };
    result.nodes[id] = add(fresh.nodes[id], shift);
  }
  for (const id of reduction.visible) {
    const parent = rooted.nodes[id].parent;
    if (!parent || result.routes[id]) continue;
    const a = result.nodes[parent], b = result.nodes[id];
    result.routes[id] = { segments: [{ c1: lerp(a, b, .33), c2: lerp(a, b, .67), end: { ...b } }] };
  }
  // Final endpoints are authoritative shared junctions, never independent biological vertices.
  for (const id of Object.keys(result.routes)) if (visible.has(id)) result.routes[id].segments.at(-1)!.end = { ...result.nodes[id] };
  return result;
}

export function edgeWidth(rooted: Rooted, id: string, p: Presentation): number {
  const count = rooted.nodes[id].count, total = rooted.nodes[rooted.rootId].count;
  return p.strokeMm * (1 + p.taper * Math.sqrt(count / total) * 2);
}
export function pathData(rooted: Rooted, layout: Layout, id: string): string {
  const parent = rooted.nodes[id].parent; if (!parent) return '';
  const start = layout.nodes[parent], route = layout.routes[id];
  return `M${rounded(start.x)},${rounded(start.y)} ` + route.segments.map((s, i) => {
    const end = i === route.segments.length - 1 ? layout.nodes[id] : s.end;
    if (layout.lineStyle === 'straight') return `L${rounded(end.x)},${rounded(end.y)}`;
    return `C${rounded(s.c1.x)},${rounded(s.c1.y)} ${rounded(s.c2.x)},${rounded(s.c2.y)} ${rounded(end.x)},${rounded(end.y)}`;
  }).join(' ');
}
export function subtreeIds(rooted: Rooted, id: string): string[] {
  const result: string[] = [], queue = [id];
  while (queue.length) { const x = queue.pop()!; result.push(x); queue.push(...rooted.nodes[x].children); }
  return result;
}
export function moveNodes(layout: Layout, rooted: Rooted, ids: string[], delta: Point): void {
  const locked = new Set(layout.pinnedNodes);
  for (const edge of layout.pinnedEdges) { locked.add(edge); const parent = rooted.nodes[edge]?.parent; if (parent) locked.add(parent); }
  const moving = new Set(ids.filter(id => layout.nodes[id] && !locked.has(id)));
  for (const id of moving) layout.nodes[id] = add(layout.nodes[id], delta);
  for (const [id, route] of Object.entries(layout.routes)) {
    if (layout.pinnedEdges.includes(id)) continue;
    const parent = rooted.nodes[id]?.parent; if (!parent) continue;
    const first = route.segments[0], last = route.segments.at(-1)!;
    if (moving.has(parent) && moving.has(id)) for (const s of route.segments) { s.c1 = add(s.c1, delta); s.c2 = add(s.c2, delta); s.end = add(s.end, delta); }
    else { if (moving.has(parent)) first.c1 = add(first.c1, delta); if (moving.has(id)) last.c2 = add(last.c2, delta); }
    last.end = { ...layout.nodes[id] };
  }
}
export function transformSubtree(layout: Layout, rooted: Rooted, id: string, rotation: number, scale: number): void {
  const ids = subtreeIds(rooted, id), set = new Set(ids), anchor = layout.nodes[id];
  if (ids.some(x => layout.pinnedNodes.includes(x) || layout.pinnedEdges.includes(x))) throw new Error('This subtree contains pinned geometry. Unpin it before rotating or scaling.');
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(rotation)) throw new Error('Enter a positive scale and a finite angle.');
  const r = rotation * Math.PI / 180;
  const tx = (p: Point): Point => ({ x: anchor.x + scale * ((p.x - anchor.x) * Math.cos(r) - (p.y - anchor.y) * Math.sin(r)), y: anchor.y + scale * ((p.x - anchor.x) * Math.sin(r) + (p.y - anchor.y) * Math.cos(r)) });
  for (const x of ids) if (layout.nodes[x]) layout.nodes[x] = tx(layout.nodes[x]);
  for (const [x, route] of Object.entries(layout.routes)) if (set.has(x) && x !== id) for (const s of route.segments) { s.c1 = tx(s.c1); s.c2 = tx(s.c2); s.end = tx(s.end); }
}
export function splitRoute(layout: Layout, rooted: Rooted, id: string): void {
  if (layout.pinnedEdges.includes(id)) throw new Error('Unpin this edge before editing its route.');
  const route = layout.routes[id]; if (!route) throw new Error('Select an edge below the root.');
  if (route.segments.length >= 24) throw new Error('This edge already has 24 curve segments.');
  const i = route.segments.length - 1, s = route.segments[i];
  const a = i ? route.segments[i - 1].end : layout.nodes[rooted.nodes[id].parent!], b = layout.nodes[id];
  if (layout.lineStyle === 'straight') {
    const mid = lerp(a, b, .5);
    route.segments.splice(i, 1, { c1: lerp(a, mid, 1 / 3), c2: lerp(a, mid, 2 / 3), end: mid }, { c1: lerp(mid, b, 1 / 3), c2: lerp(mid, b, 2 / 3), end: { ...b } });
    return;
  }
  const p = lerp(a, s.c1, .5), q = lerp(s.c1, s.c2, .5), r = lerp(s.c2, b, .5), u = lerp(p, q, .5), v = lerp(q, r, .5), mid = lerp(u, v, .5);
  route.segments.splice(i, 1, { c1: p, c2: u, end: mid }, { c1: v, c2: r, end: { ...b } });
}

function pointSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, d = dx * dx + dy * dy;
  return distance(p, lerp(a, b, d ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / d)) : 0));
}
function cross(a: Point, b: Point, c: Point): number { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const x = cross(a, b, c), y = cross(a, b, d), z = cross(c, d, a), w = cross(c, d, b);
  if (x * y < 0 && z * w < 0) return true;
  return Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b)) < 1e-9;
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  return intersects(a, b, c, d) ? 0 : Math.min(pointSegment(a, c, d), pointSegment(b, c, d), pointSegment(c, a, b), pointSegment(d, a, b));
}

/** Adaptive de Casteljau subdivision; control-polygon excess catches collinear backtracking. */
export function flatten(a: Point, c1: Point, c2: Point, b: Point, tolerance: number, depth = 0): Point[] {
  const excess = distance(a, c1) + distance(c1, c2) + distance(c2, b) - distance(a, b);
  if (depth >= 18 || (Math.max(pointSegment(c1, a, b), pointSegment(c2, a, b)) <= tolerance && excess <= tolerance)) return [a, b];
  const p = lerp(a, c1, .5), q = lerp(c1, c2, .5), r = lerp(c2, b, .5), u = lerp(p, q, .5), v = lerp(q, r, .5), m = lerp(u, v, .5);
  return [...flatten(a, p, u, m, tolerance, depth + 1).slice(0, -1), ...flatten(m, v, r, b, tolerance, depth + 1)];
}
export function flattenedEdge(rooted: Rooted, layout: Layout, id: string, tolerance: number): Point[] {
  let a = layout.nodes[rooted.nodes[id].parent!]; const points: Point[] = [a];
  layout.routes[id].segments.forEach((s, i, arr) => {
    const end = i === arr.length - 1 ? layout.nodes[id] : s.end;
    points.push(...(layout.lineStyle === 'straight' ? [end] : flatten(a, s.c1, s.c2, end, tolerance).slice(1))); a = end;
  });
  return points;
}
export function validateGeometry(source: Source, rooted: Rooted, recipe: Recipe, reduction: Reduction, layout: Layout, p: Presentation): QA {
  const issues: Issue[] = []; let omittedIssueCount = 0;
  const issue = (v: Issue) => { if (issues.length < 2000) issues.push(v); else omittedIssueCount++; };
  const replay = reduce(source, rooted, recipe, true);
  const coveragePassed = JSON.stringify(replay.frontier.map(x => x.id)) === JSON.stringify(reduction.frontier.map(x => x.id));
  const edges = reduction.visible.filter(id => rooted.nodes[id].parent);
  let incidencePassed = true;
  for (const id of reduction.visible) if (!finitePoint(layout.nodes[id])) { incidencePassed = false; issue({ type: 'junction', edges: [id], detail: 'Missing or nonfinite shared junction.' }); }
  for (const id of edges) {
    const route = layout.routes[id];
    if (!route?.segments.length || route.segments.some(s => !finitePoint(s.c1) || !finitePoint(s.c2) || !finitePoint(s.end)) || distance(route.segments.at(-1)!.end, layout.nodes[id]) > 1e-8) {
      incidencePassed = false; issue({ type: 'junction', edges: [id], detail: 'A route is missing, invalid, or detached from its shared junction.' });
    }
  }
  let crossingPassed = incidencePassed, clearancePassed = incidencePassed, checkedEdgePairs = 0, minClearance = Infinity;
  const ratios: number[] = []; let undefinedEdges = 0, annotationCollisions = 0;
  if (incidencePassed) {
    const flat: Record<string, Point[]> = {}, lengths: Record<string, number> = {};
    const boxes: Record<string, [number, number, number, number]> = {};
    for (const id of edges) {
      const points = flattenedEdge(rooted, layout, id, p.toleranceMm / 2); flat[id] = points;
      lengths[id] = points.slice(1).reduce((sum, b, i) => sum + distance(points[i], b), 0);
      const length = rooted.nodes[id].length;
      if (length !== null && Number.isFinite(length) && length > 0) ratios.push(lengths[id] / (length * p.sourceUnitMm)); else undefinedEdges++;
      boxes[id] = [Math.min(...points.map(v => v.x)), Math.min(...points.map(v => v.y)), Math.max(...points.map(v => v.x)), Math.max(...points.map(v => v.y))];
      const half = edgeWidth(rooted, id, p) / 2 + p.toleranceMm;
      const outside = points.find(v => v.x < half || v.y < half || v.x > p.widthMm - half || v.y > p.heightMm - half);
      if (outside) { clearancePassed = false; issue({ type: 'bounds', edges: [id], point: outside, detail: 'Visible stroke leaves the physical page.' }); }
      let arc = 0; const along = [0];
      for (let i = 1; i < points.length; i++) { arc += distance(points[i - 1], points[i]); along.push(arc); }
      let selfHit = false;
      for (let i = 0; i < points.length - 1 && !selfHit; i++) for (let j = i + 2; j < points.length - 1; j++) {
        // Immediate curve neighborhoods form one continuous stroke. Nonlocal returning portions do not.
        if (along[j] - along[i + 1] < edgeWidth(rooted, id, p) + 2 * p.toleranceMm) continue;
        const d = segmentDistance(points[i], points[i + 1], points[j], points[j + 1]);
        if (d <= edgeWidth(rooted, id, p) + p.toleranceMm) { crossingPassed = false; clearancePassed = false; selfHit = true; issue({ type: 'self-intersection', edges: [id], point: points[j], detail: 'Nonadjacent portions of this edge touch or overlap within tolerance.' }); break; }
      }
    }
    // Uniform spatial bins are a bounding-box broad phase; only candidate edge pairs are tested.
    const cells = new Map<string, string[]>(), candidates = new Set<string>(), cellSize = Math.max(3, p.clearanceMm * 3);
    for (const id of edges) {
      const b = boxes[id], pad = edgeWidth(rooted, id, p) / 2 + p.clearanceMm + p.toleranceMm;
      const minX = Math.floor((b[0] - pad) / cellSize), maxX = Math.floor((b[2] + pad) / cellSize), minY = Math.floor((b[1] - pad) / cellSize), maxY = Math.floor((b[3] + pad) / cellSize);
      if ((maxX - minX + 1) * (maxY - minY + 1) > 100_000) throw new Error('Geometry is too large for validation. Fit the artwork to the page first.');
      for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
        const key = `${x},${y}`, occupants = cells.get(key) ?? [];
        for (const other of occupants) candidates.add([id, other].sort().join('|'));
        occupants.push(id); cells.set(key, occupants);
      }
    }
    for (const pair of candidates) {
      const [aId, bId] = pair.split('|'), a = flat[aId], b = flat[bId]; checkedEdgePairs++;
      const aEnds = [aId, rooted.nodes[aId].parent!], bEnds = [bId, rooted.nodes[bId].parent!];
      const shared = aEnds.find(x => bEnds.includes(x)), junction = shared ? layout.nodes[shared] : null;
      let closest = Infinity, at = a[0];
      for (let i = 0; i < a.length - 1; i++) for (let j = 0; j < b.length - 1; j++) {
        // Clip both segments to the outside of the declared junction disk, rather than
        // exempting the entire incident edges or an arbitrarily long endpoint segment.
        const clip = (v: Point, w: Point): [Point, Point][] => {
          if (!junction) return [[v, w]];
          const dx = w.x - v.x, dy = w.y - v.y, qx = v.x - junction.x, qy = v.y - junction.y;
          const aa = dx * dx + dy * dy, bb = 2 * (qx * dx + qy * dy), cc = qx * qx + qy * qy - p.junctionMm ** 2;
          const disc = bb * bb - 4 * aa * cc;
          if (!aa) return distance(v, junction) > p.junctionMm ? [[v, w]] : [];
          const cuts = [0, 1]; if (disc >= 0) for (const t of [(-bb - Math.sqrt(disc)) / (2 * aa), (-bb + Math.sqrt(disc)) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
          cuts.sort((x, y) => x - y); const parts: [Point, Point][] = [];
          for (let k = 1; k < cuts.length; k++) if (distance(lerp(v, w, (cuts[k - 1] + cuts[k]) / 2), junction) > p.junctionMm) parts.push([lerp(v, w, cuts[k - 1]), lerp(v, w, cuts[k])]);
          return parts;
        };
        for (const [v, w] of clip(a[i], a[i + 1])) for (const [x, y] of clip(b[j], b[j + 1])) {
          const d = segmentDistance(v, w, x, y); if (d < closest) { closest = d; at = lerp(v, w, .5); }
        }
      }
      const gap = closest - (edgeWidth(rooted, aId, p) + edgeWidth(rooted, bId, p)) / 2;
      minClearance = Math.min(minClearance, gap);
      if (gap <= p.toleranceMm) { crossingPassed = false; clearancePassed = false; issue({ type: 'crossing', edges: [aId, bId], point: at, detail: 'Stroke envelopes touch, cross, or are unresolved within tolerance outside a shared junction.' }); }
      else if (gap - p.toleranceMm < p.clearanceMm) { clearancePassed = false; issue({ type: 'clearance', edges: [aId, bId], point: at, detail: `Conservative clearance ${(gap - p.toleranceMm).toFixed(3)} mm is below ${p.clearanceMm} mm.` }); }
    }
    const labelBoxes = reduction.frontier.map((entry, i) => {
      const pos = labelPosition(layout, p, entry.id); return { id: entry.id, x: pos.x, y: pos.y - 1.6, w: String(i + 1).length * 1.1, h: 2 };
    });
    for (let i = 0; i < labelBoxes.length; i++) {
      const b = labelBoxes[i]; let collision = b.x < 0 || b.y < 0 || b.x + b.w > p.widthMm || b.y + b.h > p.heightMm;
      for (let j = 0; j < i && !collision; j++) { const c = labelBoxes[j]; collision = b.x < c.x + c.w && b.x + b.w > c.x && b.y < c.y + c.h && b.y + b.h > c.y; }
      for (const id of edges) {
        if (collision) break;
        const points = flat[id], center = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
        for (let j = 1; j < points.length; j++) if (pointSegment(center, points[j - 1], points[j]) < Math.hypot(b.w, b.h) / 2 + edgeWidth(rooted, id, p) / 2) { collision = true; break; }
      }
      if (collision) { annotationCollisions++; issue({ type: 'labels', edges: [b.id], point: layout.nodes[b.id], detail: 'A numbered label may touch artwork, another label, or the page boundary (conservative font bounds).' }); }
    }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), sourceSha256: source.sha256, endpoints: reduction.frontier.length, sourceTips: source.tips.length,
    coveragePassed, incidencePassed, crossingPassed, clearancePassed, status: coveragePassed && incidencePassed && crossingPassed && clearancePassed && !annotationCollisions ? 'checked' : 'draft',
    issues, root: rooted.root, toleranceMm: p.toleranceMm, clearanceMm: p.clearanceMm, junctionMm: p.junctionMm, checkedEdgePairs,
    minClearanceMm: Number.isFinite(minClearance) ? minClearance : null, annotationCollisions, omittedIssueCount,
    limitations: ['Adaptive curve approximation, round stroke envelopes, and conservative numerical tolerances; not an exact proof.', 'Incident edge contact is exempt only inside the stated shared-junction radius.', 'Annotation bounds are conservative estimates; inspect exported labels in an SVG editor.', 'Candidate-pair minimum clearance is reported; it is not a global minimum over all distant pairs.', 'Artistic lengths are not time or proportional evolutionary distances. Artist review has not been performed.'],
    distortion: { sourceUnitMm: p.sourceUnitMm, minRatio: ratios.length ? Math.min(...ratios) : null, maxRatio: ratios.length ? Math.max(...ratios) : null, undefinedEdges },
  };
}
export function labelPosition(layout: Layout, p: Presentation, id: string): Point { return add(layout.nodes[id], p.labelOffsets[id] ?? { x: 1.2, y: -.7 }); }
