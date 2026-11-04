import type { FitSettings, Layout, Point, Presentation, Reduction, Rooted } from './types.ts';
import { add, sub, distance, lerp, edgeWidth, flattenedEdge } from './geometry.ts';

const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const scale = (a: Point, n: number): Point => ({ x: a.x * n, y: a.y * n });
const unit = (a: Point) => scale(a, 1 / (Math.hypot(a.x, a.y) || 1));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function pointDistance(p: Point, a: Point, b: Point): number {
  const v = sub(b, a);
  return distance(p, lerp(a, b, clamp(dot(sub(p, a), v) / (dot(v, v) || 1), 0, 1)));
}
function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}
type Segment = [Point, Point];
type SegmentTree = { box: number[]; entries?: { segment: Segment; index: number }[]; left?: SegmentTree; right?: SegmentTree };
type Path = { points: Point[]; segments: Segment[]; length: number; box: number[]; clips: Map<string, { segments: Segment[]; tree: SegmentTree }> };
const segmentBox = ([a, b]: Segment, pad = 0): number[] => [Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.max(a.x, b.x) + pad, Math.max(a.y, b.y) + pad];
const boxesOverlap = (a: number[], b: number[]): boolean => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
function segmentTree(entries: { segment: Segment; index: number }[]): SegmentTree {
  const box = entries.reduce((box, entry) => {
    const b = segmentBox(entry.segment);
    return [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
  if (entries.length <= 4) return { box, entries };
  const axis = box[2] - box[0] > box[3] - box[1] ? 'x' : 'y';
  entries.sort((a, b) => a.segment[0][axis] + a.segment[1][axis] - b.segment[0][axis] - b.segment[1][axis] || a.index - b.index);
  const middle = Math.floor(entries.length / 2);
  return { box, left: segmentTree(entries.slice(0, middle)), right: segmentTree(entries.slice(middle)) };
}
function outsideDisk(segments: Segment[], center: Point, radius: number): Segment[] {
  return segments.flatMap(([a, b]) => {
    const v = sub(b, a), q = sub(a, center), aa = dot(v, v), bb = 2 * dot(q, v), cc = dot(q, q) - radius ** 2;
    const disc = bb * bb - 4 * aa * cc, cuts = [0, 1];
    if (aa && disc >= 0) for (const t of [(-bb - Math.sqrt(disc)) / (2 * aa), (-bb + Math.sqrt(disc)) / (2 * aa)]) if (t > 0 && t < 1) cuts.push(t);
    cuts.sort((x, y) => x - y);
    return cuts.slice(1).flatMap((t, i): Segment[] => distance(lerp(a, b, (cuts[i] + t) / 2), center) > radius ? [[lerp(a, b, cuts[i]), lerp(a, b, t)]] : []);
  });
}

/** Open forks in the order of their actual child positions, without imposing parallel
 * tangents. The common direction remains the center of the fan, not every twig's angle. */
export function spreadForks(rooted: Rooted, reduction: Reduction, layout: Layout, eligible: Set<string>, amount: number, flows: Record<string, Point>): void {
  if (!amount || layout.lineStyle === 'straight') return;
  const visible = new Set(reduction.visible), wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  for (const parent of reduction.visible) {
    const children = rooted.nodes[parent].children.filter(id => visible.has(id));
    if (children.length < 2) continue;
    const origin = layout.nodes[parent], flow = flows[parent], directed = flow && Math.hypot(flow.x, flow.y) > 1e-6;
    const center = directed ? flow : children.reduce((sum, id) => add(sum, unit(sub(layout.nodes[id], origin))), { x: 0, y: 0 });
    const axis = Math.atan2(center.y, center.x);
    const angles = children.map(id => {
      const route = layout.routes[id], chord = sub(route.segments[0].end, origin), handle = sub(route.segments[0].c1, origin);
      const current = wrap(Math.atan2(handle.y, handle.x) - axis), natural = wrap(Math.atan2(chord.y, chord.x) - axis);
      return { id, angle: current + wrap(natural - current) * amount };
    }).sort((a, b) => a.angle - b.angle || a.id.localeCompare(b.id));
    const minimum = Math.min(amount * .85, 2.6 / (children.length - 1)), before = angles.reduce((sum, a) => sum + a.angle, 0) / angles.length;
    for (let i = 1; i < angles.length; i++) angles[i].angle = Math.max(angles[i].angle, angles[i - 1].angle + minimum);
    const shift = angles.reduce((sum, a) => sum + a.angle, 0) / angles.length - before;
    for (const item of angles) {
      if (!eligible.has(item.id)) continue;
      const s = layout.routes[item.id].segments[0], angle = axis + (directed ? clamp(item.angle - shift, -1.35, 1.35) : item.angle - shift);
      const length = Math.min(distance(origin, s.end) / 3, Math.max(distance(origin, s.c1), distance(origin, s.end) * .2));
      s.c1 = add(origin, { x: Math.cos(angle) * length, y: Math.sin(angle) * length });
    }
  }
}

export type RoutingDiagnostics = {
  work: number;
  candidateVisits: number;
  candidatePairs: number;
  evaluations: number;
  attempts: number;
  accepted: number;
  attemptedItems: Record<string, number>;
};
export type RoutingResult = { refinedRoutes: number; routingLimited: boolean; routingDiagnostics: RoutingDiagnostics };
export type RoutingLimits = { work?: number; evaluations?: number };
type Quality = { bounds: number; contacts: number; clearance: number; cost: number };
type PairQuality = { contacts: number; clearance: number; cost: number };
const emptyQuality = (): Quality => ({ bounds: 0, contacts: 0, clearance: 0, cost: 0 });
const better = (candidate: Quality, baseline: Quality): boolean => {
  // Hard non-regression guards also apply when another category improves.
  if (candidate.bounds > baseline.bounds || candidate.contacts > baseline.contacts) return false;
  for (const key of ['bounds', 'contacts', 'clearance', 'cost'] as const) {
    if (Math.abs(candidate[key] - baseline[key]) > 1e-7) return candidate[key] < baseline[key];
  }
  return false;
};

/** Deterministic, conflict-prioritized coordinate search with round-robin trials.
 * Every trial compares complete local QA at the final geometry tolerance. No trial
 * may add a contact or an out-of-page stroke to obtain a cosmetic improvement.
 * Per-trial slices prevent one dense region from spending all remaining work.
 */
export function refineRouting(rooted: Rooted, reduction: Reduction, layout: Layout, p: Presentation, junctions: string[], eligible: Set<string>, settings: FitSettings, flows: Record<string, Point>, limits: RoutingLimits = {}): RoutingResult {
  const diagnostics: RoutingDiagnostics = { work: 0, candidateVisits: 0, candidatePairs: 0, evaluations: 0, attempts: 0, accepted: 0, attemptedItems: {} };
  const strength = settings.routing ?? 0, forkSpread = settings.forkSpread ?? 0;
  const result = (refinedRoutes: number, routingLimited: boolean): RoutingResult => ({ refinedRoutes, routingLimited, routingDiagnostics: diagnostics });
  if ((!strength && !forkSpread) || !eligible.size) return result(0, false);
  for (const limit of [limits.work, limits.evaluations]) if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Routing work limits must be positive safe integers.');
  const workLimit = Math.min(4_000_000, limits.work ?? 4_000_000);
  const evaluationLimit = Math.min(30_000, limits.evaluations ?? 30_000);
  const edges = reduction.visible.filter(id => rooted.nodes[id].parent), visible = new Set(edges);
  const pinned = new Set(layout.pinnedEdges), locked = new Set([rooted.rootId, ...layout.pinnedNodes]);
  for (const id of pinned) { locked.add(id); if (rooted.nodes[id]?.parent) locked.add(rooted.nodes[id].parent!); }
  const routes = [...eligible].filter(id => visible.has(id) && !pinned.has(id)).sort();
  if (!routes.length) return result(0, false);
  const originalRoutes = new Map(edges.map(id => [id, JSON.stringify(layout.routes[id])]));
  const originalNodes = Object.fromEntries(junctions.map(id => [id, { ...layout.nodes[id] }]));
  const widths = Object.fromEntries(edges.map(id => [id, edgeWidth(rooted, id, p)]));
  const extra = p.clearanceMm + strength * .8;
  const padding = Math.max(...Object.values(widths)) + extra + .4;
  const cell = Math.max(4, padding * 2, Math.max(p.widthMm, p.heightMm) / 32);
  const cache = new Map<string, Path>(), bins = new Map<string, Set<string>>();
  const tolerance = p.toleranceMm / 2;
  const incident = new Map<string, string[]>();
  for (const id of Object.keys(layout.routes)) for (const node of [id, rooted.nodes[id]?.parent]) if (node) {
    const list = incident.get(node) ?? []; list.push(id); incident.set(node, list);
  }
  const keys = (box: number[]) => {
    const result: string[] = [];
    for (let x = Math.floor(clamp(box[0] - padding, -padding, p.widthMm + padding) / cell); x <= Math.floor(clamp(box[2] + padding, -padding, p.widthMm + padding) / cell); x++) {
      for (let y = Math.floor(clamp(box[1] - padding, -padding, p.heightMm + padding) / cell); y <= Math.floor(clamp(box[3] + padding, -padding, p.heightMm + padding) / cell); y++) result.push(`${x},${y}`);
    }
    return result;
  };
  const path = (id: string): Path => {
    const points = flattenedEdge(rooted, layout, id, tolerance);
    const segments: Segment[] = points.slice(1).map((b, i) => [points[i], b]);
    return { points, segments, clips: new Map(), length: segments.reduce((sum, [a, b]) => sum + distance(a, b), 0), box: [Math.min(...points.map(q => q.x)), Math.min(...points.map(q => q.y)), Math.max(...points.map(q => q.x)), Math.max(...points.map(q => q.y))] };
  };
  const update = (id: string, next: Path) => {
    const old = cache.get(id); if (old) for (const key of keys(old.box)) bins.get(key)?.delete(id);
    cache.set(id, next);
    for (const key of keys(next.box)) { const bin = bins.get(key) ?? new Set<string>(); bin.add(id); bins.set(key, bin); }
  };
  for (const id of edges) update(id, path(id));
  let limited = false, sliceEnd = workLimit;
  const limitReached = (): boolean => {
    if (diagnostics.work < workLimit && diagnostics.evaluations < evaluationLimit) return false;
    limited = true; return true;
  };
  const spend = (): boolean => {
    if (diagnostics.work >= workLimit || diagnostics.work >= sliceEnd) return false;
    diagnostics.work++; return true;
  };
  const visit = (tree: SegmentTree, box: number[], action: (segment: Segment, index: number) => boolean): boolean => {
    if (!spend()) return false;
    if (!boxesOverlap(tree.box, box)) return true;
    if (tree.entries) {
      for (const entry of tree.entries) if (boxesOverlap(segmentBox(entry.segment), box)) {
        if (!spend() || !action(entry.segment, entry.index)) return false;
      }
      return true;
    }
    return visit(tree.left!, box, action) && visit(tree.right!, box, action);
  };
  const clipped = (line: Path, center: Point | null) => {
    const key = center ? `${center.x},${center.y}` : '';
    let clip = line.clips.get(key);
    if (!clip) {
      const segments = center ? outsideDisk(line.segments, center, p.junctionMm) : line.segments;
      clip = { segments, tree: segmentTree(segments.map((segment, index) => ({ segment, index }))) };
      line.clips.set(key, clip);
    }
    return clip;
  };
  const pairQuality = (aId: string, a: Path, bId: string, b: Path, nodeOverride?: { id: string; point: Point }): PairQuality | null => {
    const aParent = rooted.nodes[aId].parent!, bParent = rooted.nodes[bId].parent!;
    const shared = [aId, aParent].find(id => id === bId || id === bParent);
    const center = shared ? shared === nodeOverride?.id ? nodeOverride.point : layout.nodes[shared] : null;
    const aa = clipped(a, center), bb = clipped(b, center);
    const halfWidths = (widths[aId] + widths[bId]) / 2;
    const gap = halfWidths + extra + p.toleranceMm;
    let cost = 0, nearest = Infinity;
    for (const segment of aa.segments) {
      const [v, w] = segment;
      if (!visit(bb.tree, segmentBox(segment, gap), ([x, y]) => {
        const d = segmentDistance(v, w, x, y); nearest = Math.min(nearest, d);
        cost += 4 * Math.max(0, gap - d) ** 2 * Math.min(distance(v, w), distance(x, y), 5) / gap ** 2;
        return true;
      })) return null;
    }
    cost += 60 * Math.max(0, gap - nearest) ** 2 / gap ** 2;
    if (aParent === bParent && forkSpread > 0) {
      // The sampled first span follows the actual curve, independent of mutable handles.
      const tangent = (line: Path) => unit(sub(line.points[1], line.points[0]));
      const angle = Math.acos(clamp(dot(tangent(a), tangent(b)), -1, 1));
      cost += 80 * Math.max(0, forkSpread * .85 - angle) ** 2;
    }
    return { contacts: Number(nearest - halfWidths <= p.toleranceMm), clearance: Number(nearest - halfWidths - p.toleranceMm < p.clearanceMm), cost };
  };
  const pairCache = new Map<string, PairQuality>();
  const unaryCache = new Map<string, Quality>();
  const unaryQuality = (id: string, line: Path): Quality | null => {
    const value = emptyQuality(), half = widths[id] / 2 + p.toleranceMm;
    value.bounds = Number(line.points.some(q => q.x < half || q.y < half || q.x > p.widthMm - half || q.y > p.heightMm - half));
    value.cost = line.length * .035;
    const flow = flows[id];
    for (const q of line.points) value.cost += 30 * (Math.max(0, half - q.x, q.x - p.widthMm + half) ** 2 + Math.max(0, half - q.y, q.y - p.heightMm + half) ** 2);
    if (flow) for (const [a, b] of line.segments) value.cost += 20 * Math.min(0, dot(sub(b, a), unit(flow))) ** 2 * Math.hypot(flow.x, flow.y);
    const along = [0];
    for (const [a, b] of line.segments) along.push(along.at(-1)! + distance(a, b));
    const tree = clipped(line, null).tree;
    for (let i = 0; i < line.segments.length && !value.contacts; i++) {
      const segment = line.segments[i], [a, b] = segment;
      if (!visit(tree, segmentBox(segment, widths[id] + p.toleranceMm), ([c, d], j) => {
        if (j > i + 1 && along[j] - along[i + 1] >= widths[id] + 2 * p.toleranceMm && segmentDistance(a, b, c, d) <= widths[id] + p.toleranceMm) value.contacts = 1;
        return true;
      })) return null;
    }
    value.cost += value.contacts * 250;
    return value;
  };
  // Stream pairs in stable input/bin order. Charge every visit before deduplication:
  // a large fork or a densely populated bin must not bypass the work limit.
  function* pairsFor(affected: string[], candidates: Map<string, Path>): Generator<string | null> {
    const pairs = new Set<string>();
    const pairFor = (id: string, other: string): string | undefined | null => {
      if (!spend()) return null;
      diagnostics.candidateVisits++;
      if (id === other) return undefined;
      const key = id < other ? `${id}|${other}` : `${other}|${id}`;
      if (pairs.has(key)) return undefined;
      pairs.add(key); diagnostics.candidatePairs++; return key;
    };
    for (const id of affected) {
      for (const other of affected) {
        const key = pairFor(id, other);
        if (key === null) { yield null; return; }
        if (key !== undefined) yield key;
      }
      // Use the union of old and candidate neighbors for an equivalent comparison.
      for (const line of [cache.get(id)!, candidates.get(id)!]) for (const cellKey of keys(line.box)) {
        if (!spend()) { yield null; return; }
        for (const other of bins.get(cellKey) ?? []) {
          const key = pairFor(id, other);
          if (key === null) { yield null; return; }
          if (key !== undefined) yield key;
        }
      }
    }
  }
  const evaluate = (affected: string[], candidates: Map<string, Path>, pairs: string[], baseline: boolean, node?: { id: string; point: Point }): Quality | null => {
    if (diagnostics.evaluations >= evaluationLimit) return null;
    diagnostics.evaluations++;
    const value = emptyQuality();
    if (node) value.cost += distance(node.point, originalNodes[node.id]) ** 2 * .015;
    for (const id of affected) {
      let unary = baseline ? unaryCache.get(id) : undefined;
      if (!unary) { unary = unaryQuality(id, candidates.get(id)!) ?? undefined; if (!unary) return null; if (baseline) unaryCache.set(id, unary); }
      value.bounds += unary.bounds; value.contacts += unary.contacts; value.clearance += unary.clearance; value.cost += unary.cost;
    }
    for (const key of pairs) {
      const [a, b] = key.split('|');
      let pair = baseline ? pairCache.get(key) : undefined;
      if (!pair) {
        pair = pairQuality(a, candidates.get(a) ?? cache.get(a)!, b, candidates.get(b) ?? cache.get(b)!, baseline ? node : undefined) ?? undefined;
        if (!pair) return null;
        if (baseline) pairCache.set(key, pair);
      }
      value.contacts += pair.contacts; value.clearance += pair.clearance; value.cost += pair.cost;
    }
    return value;
  };
  const directions = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i * Math.PI / 4), y: Math.sin(i * Math.PI / 4) }));
  type Job = { key: string; node?: string; route?: string; fork?: string; incident: string[]; affected: string[]; modes: number; pressure: number };
  const routeSet = new Set(routes);
  const forks = forkSpread && layout.lineStyle !== 'straight' ? reduction.visible.filter(id => rooted.nodes[id].children.filter(child => visible.has(child)).length > 1).map(id => ({ id, affected: rooted.nodes[id].children.filter(child => routeSet.has(child)) })).filter(fork => fork.affected.length) : [];
  const jobs: Job[] = [
    ...junctions.filter(id => strength > 0 && !locked.has(id)).map(id => ({ key: `node:${id}`, node: id, incident: incident.get(id) ?? [], affected: (incident.get(id) ?? []).filter(edge => visible.has(edge)), modes: 8, pressure: 0 })),
    ...forks.map(fork => ({ key: `fork:${fork.id}`, fork: fork.id, incident: fork.affected, affected: fork.affected, modes: 1, pressure: 0 })),
    ...(layout.lineStyle === 'straight' || !strength ? [] : routes.map(id => ({ key: `route:${id}`, route: id, incident: [id], affected: [id], modes: 10, pressure: 0 }))),
  ];
  if (!jobs.length) return result(0, false);
  // A bounded sampled conflict pass prioritizes the queue; every item still gets a
  // first trial before another item receives a second trial at the same scale.
  sliceEnd = Math.min(workLimit, Math.floor(workLimit * .1));
  const pressure = new Map<string, number>(), seen = new Set<string>();
  pressurePass: for (const job of jobs) {
    const current = new Map(job.affected.map(id => [id, cache.get(id)!]));
    for (const key of pairsFor(job.affected, current)) {
      if (key === null) break pressurePass;
      if (seen.has(key)) continue; seen.add(key);
      const [a, b] = key.split('|'), pair = pairQuality(a, cache.get(a)!, b, cache.get(b)!);
      if (!pair) break pressurePass;
      pairCache.set(key, pair);
      const weight = pair.contacts * 100000 + pair.clearance * 1000 + pair.cost;
      pressure.set(a, (pressure.get(a) ?? 0) + weight); pressure.set(b, (pressure.get(b) ?? 0) + weight);
    }
    job.pressure = job.affected.reduce((sum, id) => sum + (pressure.get(id) ?? 0), 0);
  }
  if (limitReached()) return result(0, true);
  for (const job of jobs) job.pressure = job.affected.reduce((sum, id) => sum + (pressure.get(id) ?? 0), 0);
  jobs.sort((a, b) => b.pressure - a.pressure || a.key.localeCompare(b.key));
  const forkRoutes = forkSpread && layout.lineStyle !== 'straight' ? { ...layout, nodes: { ...layout.nodes }, routes: { ...layout.routes, ...Object.fromEntries(routes.map(id => [id, structuredClone(layout.routes[id])])) } } : null;
  if (forkRoutes) spreadForks(rooted, reduction, forkRoutes, new Set(routes), forkSpread, flows);
  const invalidate = (affected: string[]) => {
    const changed = new Set(affected);
    for (const id of affected) unaryCache.delete(id);
    for (const key of pairCache.keys()) if (key.split('|').some(id => changed.has(id))) pairCache.delete(key);
  };
  for (const factor of [1, .5, .25, .125]) {
    const nodeOrigins = Object.fromEntries(jobs.filter(job => job.node).map(job => [job.node!, { ...layout.nodes[job.node!] }]));
    const step = Math.max(2, settings.junctionSpacingMm, padding * 2) * strength * factor;
    for (let mode = 0; mode < 11; mode++) {
      const round = jobs.filter(job => mode < job.modes);
      for (let index = 0; index < round.length; index++) {
        if (limitReached()) break;
        const job = round[index];
        // Enumeration and QA share this item's fair slice, including duplicates.
        sliceEnd = Math.min(workLimit, diagnostics.work + Math.max(1, Math.floor((workLimit - diagnostics.work) / (round.length - index))));
        diagnostics.attempts++; diagnostics.attemptedItems[job.key] = (diagnostics.attemptedItems[job.key] ?? 0) + 1;
        const saved = new Map(job.incident.map(id => [id, layout.routes[id]]));
        const start = job.node ? layout.nodes[job.node] : undefined;
        for (const id of job.incident) layout.routes[id] = structuredClone(layout.routes[id]);
        if (job.node) {
          const next = add(nodeOrigins[job.node], scale(directions[mode], step));
          layout.nodes[job.node] = next;
          for (const id of job.incident) {
            const route = layout.routes[id];
            if (rooted.nodes[id].parent === job.node) route.segments[0].c1 = add(route.segments[0].c1, sub(next, start!));
            if (id === job.node) { route.segments.at(-1)!.c2 = add(route.segments.at(-1)!.c2, sub(next, start!)); route.segments.at(-1)!.end = { ...next }; }
          }
        } else if (job.fork) {
          const delta = sub(layout.nodes[job.fork], forkRoutes!.nodes[job.fork]);
          for (const id of job.affected) layout.routes[id].segments[0].c1 = add(forkRoutes!.routes[id].segments[0].c1, delta);
        } else {
          const id = job.route!;
          {
            const trial = mode, sign = trial % 2 ? 1 : -1;
            const kind = ['both', 'start', 'end', 'turn-start', 'turn-end'][Math.floor(trial / 2)];
            let from = layout.nodes[rooted.nodes[id].parent!];
            for (const segment of layout.routes[id].segments) {
              const chord = sub(segment.end, from), normal = unit({ x: -chord.y, y: chord.x });
              const shift = scale(normal, sign * Math.min(step * 2, distance(from, segment.end) * .3));
              const turn = (handle: Point, origin: Point) => {
                const v = sub(handle, origin), angle = sign * Math.PI / 6 * strength * Math.sqrt(factor);
                return add(origin, { x: v.x * Math.cos(angle) - v.y * Math.sin(angle), y: v.x * Math.sin(angle) + v.y * Math.cos(angle) });
              };
              if (kind === 'turn-start') segment.c1 = turn(segment.c1, from);
              else if (kind === 'turn-end') segment.c2 = turn(segment.c2, segment.end);
              else { if (kind !== 'end') segment.c1 = add(segment.c1, shift); if (kind !== 'start') segment.c2 = add(segment.c2, shift); }
              from = segment.end;
            }
          }
        }
        const candidates = new Map(job.affected.map(id => [id, path(id)]));
        const pairs: string[] = [];
        let pairsComplete = true;
        for (const key of pairsFor(job.affected, candidates)) {
          if (key === null) { pairsComplete = false; break; }
          pairs.push(key);
        }
        const oldPaths = new Map(job.affected.map(id => [id, cache.get(id)!]));
        const baseline = pairsComplete ? evaluate(job.affected, oldPaths, pairs, true, job.node ? { id: job.node, point: start! } : undefined) : null;
        const candidate = baseline ? evaluate(job.affected, candidates, pairs, false, job.node ? { id: job.node, point: layout.nodes[job.node] } : undefined) : null;
        if (baseline && candidate && better(candidate, baseline)) {
          diagnostics.accepted++; invalidate(job.affected);
          for (const [id, line] of candidates) update(id, line);
        } else {
          if (!baseline || !candidate) limited = true;
          if (job.node) layout.nodes[job.node] = start!;
          for (const [id, route] of saved) layout.routes[id] = route;
        }
      }
      if (limitReached()) break;
    }
    if (limitReached()) break;
  }
  return result(edges.filter(id => originalRoutes.get(id) !== JSON.stringify(layout.routes[id])).length, limited);
}
