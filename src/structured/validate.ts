import type { Point } from '../types.ts';
import type { DisplayGraph, RenderScene, SceneQA, SceneIssue, Primitive } from './types.ts';
import { primitivePoints, sceneRevision } from './layout.ts';
import { digestSync } from '../provenance/sync-identity.ts';

type Box = { minX: number; minY: number; maxX: number; maxY: number };
type Segment = { a: Point; b: Point; box: Box; shape: number; index: number; from: number; to: number };
type Shape = { id: string; nodeIds: string[]; points: Point[]; segments: Segment[]; ports: Map<string, Point[]> };
type Part = { a: Point; b: Point; inside: boolean; box: Box };
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const interpolate = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const bounds = (points: Point[], pad = 0): Box => points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x - pad), minY: Math.min(b.minY, p.y - pad), maxX: Math.max(b.maxX, p.x + pad), maxY: Math.max(b.maxY, p.y + pad) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const overlaps = (a: Box, b: Box) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
function closest(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return interpolate(a, b, t);
}
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): { distance: number; p: Point; q: Point } {
  const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y, denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) > 1e-12 * Math.hypot(dx, dy) * Math.hypot(ex, ey)) {
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / denominator;
    const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / denominator;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      const p = interpolate(a, b, t);
      return { distance: 0, p, q: p };
    }
  }
  const pairs: [Point, Point][] = [[a, closest(a, c, d)], [b, closest(b, c, d)], [closest(c, a, b), c], [closest(d, a, b), d]];
  let result = { distance: Infinity, p: a, q: c };
  for (const [p, q] of pairs) { const distance = dist(p, q); if (distance < result.distance) result = { distance, p, q }; }
  return result;
}
export function polygonsOverlap(a: Point[], b: Point[]): boolean {
  for (const polygon of [a, b]) for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i], q = polygon[(i + 1) % polygon.length], axis = { x: q.y - p.y, y: p.x - q.x };
    const project = (points: Point[]) => points.map(v => v.x * axis.x + v.y * axis.y);
    const aa = project(a), bb = project(b);
    if (Math.max(...aa) < Math.min(...bb) - 1e-8 || Math.max(...bb) < Math.min(...aa) - 1e-8) return false;
  }
  return true;
}

/** Split a line at the union of its permitted junction disks. Only the resulting
 * inside/inside pairs are exempt: a permitted closest point never exempts a whole line. */
function diskParts(a: Point, b: Point, centers: Point[], radius: number, spend?: () => boolean): Part[] {
  const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
  if (!length2) return [{ a, b, inside: centers.some(center => dist(a, center) <= radius), box: bounds([a, b]) }];
  const intervals: [number, number][] = [];
  for (const center of centers) {
    if (spend && !spend()) return [];
    const qx = a.x - center.x, qy = a.y - center.y, projection = -(qx * dx + qy * dy) / length2;
    const perpendicular2 = qx * qx + qy * qy - projection * projection * length2;
    const remaining = radius * radius - perpendicular2;
    if (remaining < 0) continue;
    const half = Math.sqrt(Math.max(0, remaining) / length2), lo = Math.max(0, projection - half), hi = Math.min(1, projection + half);
    if (lo <= hi) intervals.push([lo, hi]);
  }
  intervals.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const merged: [number, number][] = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1] + 1e-12) last[1] = Math.max(last[1], interval[1]); else merged.push([...interval]);
  }
  const parts: Part[] = [], append = (lo: number, hi: number, inside: boolean) => {
    if (hi - lo <= 1e-12) return;
    const start = interpolate(a, b, lo), end = interpolate(a, b, hi);
    parts.push({ a: start, b: end, inside, box: bounds([start, end]) });
  };
  let previous = 0;
  for (const [lo, hi] of merged) { append(previous, lo, false); append(lo, hi, true); previous = hi; }
  append(previous, 1, false);
  return parts;
}

/** Spatial bins index short, exact line pieces, including long straight stems.
 * Grid traversal and candidate tests share the same bounded work accounting. */
class SegmentIndex {
  private cells = new Map<string, number[]>();
  private size: number;
  private spend: () => boolean;
  constructor(size: number, spend: () => boolean) { this.size = size; this.spend = spend; }
  private keys(box: Box): string[] {
    const result: string[] = [];
    for (let x = Math.floor(box.minX / this.size); x <= Math.floor(box.maxX / this.size); x++) {
      for (let y = Math.floor(box.minY / this.size); y <= Math.floor(box.maxY / this.size); y++) {
        if (!this.spend()) return result;
        result.push(`${x},${y}`);
      }
    }
    return result;
  }
  insert(id: number, box: Box): void {
    for (const key of this.keys(box)) { const list = this.cells.get(key) ?? []; list.push(id); this.cells.set(key, list); }
  }
  query(box: Box): number[] {
    const result = new Set<number>();
    for (const key of this.keys(box)) for (const id of this.cells.get(key) ?? []) {
      if (!this.spend()) return [...result];
      result.add(id);
    }
    return [...result].sort((a, b) => a - b);
  }
}

export function validateScene(graph: DisplayGraph, scene: RenderScene, limits: { work?: number } = {}): SceneQA {
  const workLimit = limits.work ?? 500000;
  if (!Number.isSafeInteger(workLimit) || workLimit < 1 || workLimit > 500000) throw new Error('Validation work limit must be a positive safe integer up to 500,000.');
  const issues: SceneIssue[] = [];
  const issueCounts: Record<SceneIssue['type'], number> = { incidence: 0, contact: 0, clearance: 0, labels: 0, bounds: 0, font: 0, legibility: 0 };
  let omittedIssueCount = 0, checkedPairs = 0, limited = false, work = 0;
  const spend = () => { if (work >= workLimit) { limited = true; return false; } work++; return true; };
  const add = (type: SceneIssue['type'], ids: string[], detail: string) => {
    issueCounts[type]++;
    if (issues.length < 200) issues.push({ type, ids, detail }); else omittedIssueCount++;
  };
  const s = scene.settings, tolerance = s.toleranceMm, epsilon = 1e-7;
  const represented = new Set(graph.representedTips), omitted = new Set(graph.omittedTips), original = graph.nodes[graph.rootId].originalMembers;
  const coveragePassed = original.length === represented.size + omitted.size && original.every(id => represented.has(id) || omitted.has(id))
    && represented.size === graph.representedTips.length && omitted.size === graph.omittedTips.length && !graph.omittedTips.some(id => represented.has(id))
    && digestSync(graph.endpoints.flatMap(id => graph.nodes[id].selectedMembers)) === digestSync(graph.representedTips);
  let incidencePassed = true;
  const incidence = (ids: string[], detail: string) => { incidencePassed = false; add('incidence', ids, detail); };
  if (scene.revision !== sceneRevision(scene) || scene.graphRevision !== digestSync(graph)) incidence([], 'Scene identity does not match its graph or geometry.');
  const glyphs = new Map(scene.junctionGlyphs.map(g => [g.nodeId, g])), ports = new Map(scene.ports.map(p => [p.id, p]));
  if (glyphs.size !== graph.order.length || scene.junctionGlyphs.length !== glyphs.size || scene.edgeStems.length !== Object.keys(graph.edges).length || ports.size !== scene.edgeStems.length * 2 || scene.ports.length !== ports.size) incidence([], 'Junction/stem/port inventory does not match the display graph.');
  const pointCache = new Map<Primitive, Point[]>();
  const pointsFor = (primitive: Primitive) => {
    if (limited) return [];
    let points = pointCache.get(primitive);
    if (!points) {
      points = primitivePoints(primitive, tolerance); pointCache.set(primitive, points);
      for (let i = 0; i < points.length; i++) if (!spend()) break;
    }
    return points;
  };
  const incidenceIndexes = new Map<Primitive, { index: SegmentIndex; lines: [Point, Point][] }>();
  const onPrimitive = (point: Point, primitive: Primitive): boolean | null => {
    if (!spend()) return null;
    if (primitive.kind === 'arc') {
      const radius = dist(point, primitive.center);
      if (primitive.radius === 0) return radius <= tolerance + epsilon;
      if (Math.abs(radius - primitive.radius) > tolerance + epsilon) return false;
      const angle = Math.atan2(point.y - primitive.center.y, point.x - primitive.center.x) * 180 / Math.PI;
      const relative = ((angle - primitive.startDeg) % 360 + 360) % 360;
      if (relative <= primitive.endDeg - primitive.startDeg + 1e-10) return true;
      const endpoint = (degree: number) => ({ x: primitive.center.x + primitive.radius * Math.cos(degree * Math.PI / 180), y: primitive.center.y + primitive.radius * Math.sin(degree * Math.PI / 180) });
      return dist(point, endpoint(primitive.startDeg)) <= tolerance + epsilon || dist(point, endpoint(primitive.endDeg)) <= tolerance + epsilon;
    }
    const points = pointsFor(primitive);
    if (limited) return null;
    if (points.length === 1) return dist(point, points[0]) <= tolerance + epsilon;
    if (points.length === 2) return dist(point, closest(point, points[0], points[1])) <= tolerance + epsilon;
    let cached = incidenceIndexes.get(primitive);
    if (!cached) {
      const index = new SegmentIndex(Math.max(8, Math.min(s.widthMm, s.heightMm) / 32), spend);
      const lines = points.slice(1).map((point, i) => [points[i], point] as [Point, Point]);
      for (const [id, line] of lines.entries()) { if (limited) break; index.insert(id, bounds(line, tolerance + epsilon)); }
      cached = { index, lines }; incidenceIndexes.set(primitive, cached);
    }
    for (const id of cached.index.query(bounds([point], tolerance + epsilon))) {
      if (!spend()) return null;
      const [a, b] = cached.lines[id];
      if (dist(point, closest(point, a, b)) <= tolerance + epsilon) return true;
    }
    if (limited) return null;
    return false;
  };
  for (const glyph of scene.junctionGlyphs) {
    if (limited) break;
    if (!graph.nodes[glyph.nodeId] || onPrimitive(glyph.anchor, glyph.geometry) === false) incidence([glyph.id], 'Junction anchor is outside its owned connector.');
    if (glyph.geometry.kind === 'arc' && (glyph.geometry.endDeg - glyph.geometry.startDeg >= 360 - epsilon || glyph.geometry.endDeg < glyph.geometry.startDeg)) incidence([glyph.id], 'A junction connector must be an open ordered arc, never a ring.');
  }
  for (const stem of scene.edgeStems) {
    const edge = graph.edges[stem.edgeId], a = ports.get(stem.parentPortId), b = ports.get(stem.childPortId), points = pointsFor(stem.geometry);
    if (limited) break;
    if (!edge || !a || !b || a.edgeId !== edge.id || b.edgeId !== edge.id || a.end !== 'parent' || b.end !== 'child' || a.nodeId !== edge.parent || b.nodeId !== edge.child
      || dist(a.point, points[0]) > epsilon || dist(b.point, points.at(-1)!) > epsilon || !glyphs.has(edge.parent) || !glyphs.has(edge.child)
      || onPrimitive(a.point, glyphs.get(edge.parent)!.geometry) === false || onPrimitive(b.point, glyphs.get(edge.child)!.geometry) === false) incidence([stem.id], 'Stem port does not attach to its correct parent/child junction.');
  }
  // Later stroke/label exhaustion must not invalidate a completed incidence pass.
  const incidenceComplete = !limited;
  incidencePassed &&= incidenceComplete;
  const nodePorts = new Map<string, Point[]>();
  for (const port of scene.ports) { const list = nodePorts.get(port.nodeId) ?? []; list.push(port.point); nodePorts.set(port.nodeId, list); }
  const shapes: Shape[] = [
    ...scene.junctionGlyphs.map(g => ({ id: g.id, nodeIds: [g.nodeId], points: pointsFor(g.geometry), segments: [], ports: new Map([[g.nodeId, nodePorts.get(g.nodeId) ?? []]]) })),
    ...scene.edgeStems.map(e => {
      const a = ports.get(e.parentPortId), b = ports.get(e.childPortId), grouped = new Map<string, Point[]>();
      for (const port of [a, b]) if (port) { const list = grouped.get(port.nodeId) ?? []; list.push(port.point); grouped.set(port.nodeId, list); }
      return { id: e.id, nodeIds: [...grouped.keys()], points: pointsFor(e.geometry), segments: [], ports: grouped };
    }),
  ];
  const gap = s.strokeMm + s.clearanceMm + 2 * tolerance, contactGap = s.strokeMm + 2 * tolerance;
  const cellSize = Math.max(8, gap * 2, Math.min(s.widthMm, s.heightMm) / 32), pad = gap / 2;
  const allSegments: Segment[] = [];
  for (const [shapeId, shape] of shapes.entries()) {
    let along = 0;
    const append = (a: Point, b: Point) => {
      if (!spend()) return;
      const length = dist(a, b), count = Math.max(1, Math.ceil(length / cellSize));
      for (let part = 0; part < count && !limited; part++) {
        if (!spend()) break;
        const from = interpolate(a, b, part / count), to = interpolate(a, b, (part + 1) / count);
        const segment = { a: from, b: to, box: bounds([from, to], pad), shape: shapeId, index: shape.segments.length, from: along + length * part / count, to: along + length * (part + 1) / count };
        shape.segments.push(segment); allSegments.push(segment);
      }
      along += length;
    };
    if (shape.points.length === 1) append(shape.points[0], shape.points[0]);
    else for (let i = 1; i < shape.points.length && !limited; i++) append(shape.points[i - 1], shape.points[i]);
    if (limited) break;
  }
  const index = new SegmentIndex(cellSize, spend), pairStates = new Map<string, { a: number; b: number; contact: boolean; clearance: boolean }>(), selfHits = new Set<number>();
  const junctionRadius = s.junctionMm + s.strokeMm / 2;
  const partCache = new Map<Segment, Map<string, Part[]>>();
  const partsFor = (segment: Segment, nodeId: string): Part[] => {
    let cached = partCache.get(segment); if (!cached) { cached = new Map(); partCache.set(segment, cached); }
    let parts = cached.get(nodeId);
    if (!parts) { parts = diskParts(segment.a, segment.b, shapes[segment.shape].ports.get(nodeId) ?? [], junctionRadius, spend); cached.set(nodeId, parts); }
    return parts;
  };
  const distanceOutsideJunction = (a: Segment, b: Segment, common: string[]): number => {
    if (!common.length) return segmentDistance(a.a, a.b, b.a, b.b).distance;
    // Tree shapes share at most one biological junction. Multiple shared owners
    // indicate a malformed/duplicate edge, so never grant a wider exemption.
    if (common.length !== 1) return segmentDistance(a.a, a.b, b.a, b.b).distance;
    let nearest = Infinity;
    for (const aa of partsFor(a, common[0])) for (const bb of partsFor(b, common[0])) {
      if (aa.inside && bb.inside) continue;
      if (!spend()) return nearest;
      if (!overlaps(bounds([aa.a, aa.b], gap), bb.box)) continue;
      nearest = Math.min(nearest, segmentDistance(aa.a, aa.b, bb.a, bb.b).distance);
    }
    return nearest;
  };
  for (const [segmentId, segment] of allSegments.entries()) {
    if (limited) break;
    for (const otherId of index.query(segment.box)) {
      if (!spend()) break;
      const other = allSegments[otherId];
      if (!overlaps(segment.box, other.box)) continue;
      if (segment.shape === other.shape) {
        if (selfHits.has(segment.shape)) continue;
        const earlier = segment.index < other.index ? segment : other, later = earlier === segment ? other : segment;
        let distance: number;
        if (later.index === earlier.index + 1 || later.from - earlier.to < contactGap) {
          // Trim only the local continuous join, not the whole adjacent segments:
          // a reversed line can overlap itself far away from that join.
          const aa = diskParts(earlier.a, earlier.b, [earlier.b], contactGap, spend).filter(p => !p.inside);
          const bb = diskParts(later.a, later.b, [later.a], contactGap, spend).filter(p => !p.inside);
          distance = Infinity;
          for (const a of aa) for (const b of bb) distance = Math.min(distance, segmentDistance(a.a, a.b, b.a, b.b).distance);
        } else {
          distance = segmentDistance(segment.a, segment.b, other.a, other.b).distance;
        }
        if (distance <= contactGap) selfHits.add(segment.shape);
      } else {
        const a = Math.min(segment.shape, other.shape), b = Math.max(segment.shape, other.shape), key = `${a}|${b}`;
        let pair = pairStates.get(key);
        if (!pair) { pair = { a, b, contact: false, clearance: false }; pairStates.set(key, pair); checkedPairs++; }
        if (pair.contact) continue;
        const common = shapes[a].nodeIds.filter(id => shapes[b].nodeIds.includes(id));
        const distance = distanceOutsideJunction(segment, other, common);
        if (distance <= contactGap) pair.contact = true; else if (distance <= gap) pair.clearance = true;
      }
    }
    if (!limited) index.insert(segmentId, segment.box);
  }
  const strokesComplete = !limited;
  for (const shapeId of [...selfHits].sort((a, b) => a - b)) add('contact', [shapes[shapeId].id], 'Nonlocal portions of this stroke cross, touch or return into one another.');
  for (const pair of [...pairStates.values()].sort((a, b) => a.a - b.a || a.b - b.b)) {
    if (pair.contact) add('contact', [shapes[pair.a].id, shapes[pair.b].id], 'Unrelated strokes touch, or incident strokes overlap beyond their declared junction neighbourhood.');
    else if (pair.clearance) add('clearance', [shapes[pair.a].id, shapes[pair.b].id], 'Stroke clearance is below the requested physical spacing.');
  }
  let labelCollisions = 0;
  const labels = scene.labels.map(label => ({ ...label, box: bounds(label.corners) })).sort((a, b) => a.box.minX - b.box.minX || a.id.localeCompare(b.id));
  for (let i = 0; i < labels.length && !limited; i++) for (let j = i + 1; j < labels.length && labels[j].box.minX <= labels[i].box.maxX; j++) {
    if (!spend()) break;
    if (overlaps(labels[i].box, labels[j].box) && polygonsOverlap(labels[i].corners, labels[j].corners)) { labelCollisions++; add('labels', [labels[i].id, labels[j].id], 'Measured label boxes overlap, including across the circular seam.'); }
  }
  for (const label of labels) {
    if (limited) break;
    const boundary = label.corners.map((p, i) => [p, label.corners[(i + 1) % label.corners.length]] as [Point, Point]);
    const labelGap = s.strokeMm / 2 + tolerance;
    for (const segmentId of index.query(bounds(label.corners, labelGap))) {
      if (!spend()) break;
      const segment = allSegments[segmentId];
      if (!overlaps(bounds(label.corners, labelGap), segment.box)) continue;
      if (polygonsOverlap(label.corners, [segment.a, segment.b, segment.b, segment.a]) || boundary.some(([a, b]) => segmentDistance(segment.a, segment.b, a, b).distance <= labelGap)) {
        labelCollisions++; add('labels', [label.id, shapes[segment.shape].id], 'A measured label box intersects a tree stroke.'); break;
      }
    }
  }
  const labelsComplete = !limited;
  const b = scene.bounds, inside = b.minX - s.strokeMm / 2 >= 0 && b.minY - s.strokeMm / 2 >= 0 && b.maxX + s.strokeMm / 2 <= s.widthMm && b.maxY + s.strokeMm / 2 <= s.heightMm;
  if (!inside) add('bounds', [], 'Tree or labels extend beyond the page. Enlarge the page, reduce displayed taxa or change label placement; text was not shrunk.');
  if (scene.measurements.fontStatus !== 'available') add('font', [], scene.measurements.fontStatus === 'estimated' ? 'Text metrics are estimates. Browser-measured fonts are required for a checked authoring output.' : 'The requested font is unavailable; saved coordinates remain unchanged. Review the substituted labels.');
  if (limited) {
    const incomplete = [!incidenceComplete && 'incidence', !strokesComplete && 'stroke', !labelsComplete && 'label'].filter(Boolean).join(', ');
    add('legibility', [], `Validation reached its ${workLimit.toLocaleString('en-US')}-operation work limit; ${incomplete} checks are incomplete. No all-clear is asserted.`);
  }
  const crossingPassed = incidencePassed && strokesComplete && issueCounts.contact === 0;
  const clearancePassed = crossingPassed && issueCounts.clearance === 0;
  return {
    status: coveragePassed && incidencePassed && crossingPassed && clearancePassed && !labelCollisions && inside && !limited && scene.measurements.fontStatus === 'available' ? 'checked' : 'draft',
    coveragePassed, incidencePassed, crossingPassed, clearancePassed, labelCollisions, issues, omittedIssueCount, checkedPairs, limited,
    issueCounts, completeness: { incidence: incidenceComplete, strokes: strokesComplete, labels: labelsComplete }, work,
    limitations: ['Nonmetric cladogram: depth and connector length do not encode time, evolutionary distance or confidence.', 'Stroke contacts use tolerance-bounded arc subdivision, finite-width envelopes and clipped local junction neighbourhoods; nonlocal self-contact is checked.', 'Issue totals are complete only for completed categories; bounded examples do not limit totals. Label totals count label pairs plus once per label that meets any stroke.', 'Computational checks do not establish biological support or usability for authors.'],
  };
}
