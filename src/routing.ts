import type { FitSettings, Layout, Point, Presentation, Reduction, Rooted, Route } from './types.ts';
import { add, sub, distance, lerp, edgeWidth, flattenedEdge, moveNodes } from './geometry.ts';

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
type Path = { points: Point[]; segments: Segment[]; length: number; box: number[] };
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

/** Local, deterministic route search. It measures complete sampled paths, not just chords.
 * Scientific endpoints, pins, waypoint count and topology are invariant. Each accepted
 * step lowers the same local objective: stroke spacing, fork angles, length and flow.
 * A fixed work budget bounds dense layouts; final adaptive geometry QA remains authoritative.
 */
export function refineRouting(rooted: Rooted, reduction: Reduction, layout: Layout, p: Presentation, junctions: string[], eligible: Set<string>, settings: FitSettings, flows: Record<string, Point>): { refinedRoutes: number; routingLimited: boolean } {
  const strength = settings.routing ?? 0;
  if (!strength || !eligible.size) return { refinedRoutes: 0, routingLimited: false };
  const edges = reduction.visible.filter(id => rooted.nodes[id].parent), visible = new Set(edges), original = structuredClone(layout);
  const widths = Object.fromEntries(edges.map(id => [id, edgeWidth(rooted, id, p)]));
  const extra = p.clearanceMm + strength * .8, padding = Math.max(...Object.values(widths)) + extra + .4;
  const cell = Math.max(4, padding * 2, Math.max(p.widthMm, p.heightMm) / 32), cache = new Map<string, Path>(), bins = new Map<string, Set<string>>();
  const tolerance = Math.min(.15, Math.max(.02, (p.clearanceMm + p.strokeMm) / 8));
  const keys = (box: number[]) => {
    const result: string[] = [];
    // Index only the page plus its margin: extreme imported control points must not
    // allocate an unbounded grid. Outside-page geometry is penalized separately.
    for (let x = Math.floor(clamp(box[0] - padding, -padding, p.widthMm + padding) / cell); x <= Math.floor(clamp(box[2] + padding, -padding, p.widthMm + padding) / cell); x++) for (let y = Math.floor(clamp(box[1] - padding, -padding, p.heightMm + padding) / cell); y <= Math.floor(clamp(box[3] + padding, -padding, p.heightMm + padding) / cell); y++) result.push(`${x},${y}`);
    return result;
  };
  const path = (id: string): Path => {
    const points = flattenedEdge(rooted, layout, id, tolerance), segments: Segment[] = points.slice(1).map((b, i) => [points[i], b]);
    return { points, segments, length: segments.reduce((sum, [a, b]) => sum + distance(a, b), 0), box: [Math.min(...points.map(q => q.x)), Math.min(...points.map(q => q.y)), Math.max(...points.map(q => q.x)), Math.max(...points.map(q => q.y))] };
  };
  const update = (id: string) => {
    const old = cache.get(id); if (old) for (const key of keys(old.box)) bins.get(key)?.delete(id);
    const next = path(id); cache.set(id, next);
    for (const key of keys(next.box)) { const bin = bins.get(key) ?? new Set<string>(); bin.add(id); bins.set(key, bin); }
  };
  edges.forEach(update);
  let work = 0, evaluations = 0, limited = false;
  const pairCost = (aId: string, a: Path, bId: string, b: Path): number => {
    const aParent = rooted.nodes[aId].parent!, bParent = rooted.nodes[bId].parent!;
    const shared = [aId, aParent].find(id => id === bId || id === bParent);
    const aa = shared ? outsideDisk(a.segments, layout.nodes[shared], p.junctionMm) : a.segments;
    const bb = shared ? outsideDisk(b.segments, layout.nodes[shared], p.junctionMm) : b.segments;
    const gap = (widths[aId] + widths[bId]) / 2 + extra + tolerance * 2;
    let cost = 0, nearest = Infinity;
    for (const [v, w] of aa) for (const [x, y] of bb) {
      if (++work > 4_000_000) { limited = true; return Infinity; }
      if (Math.max(v.x, w.x) + gap < Math.min(x.x, y.x) || Math.max(x.x, y.x) + gap < Math.min(v.x, w.x) || Math.max(v.y, w.y) + gap < Math.min(x.y, y.y) || Math.max(x.y, y.y) + gap < Math.min(v.y, w.y)) continue;
      const d = segmentDistance(v, w, x, y); nearest = Math.min(nearest, d);
      // Integrated pressure favors short, divergent approaches over long parallel lanes.
      cost += 4 * Math.max(0, gap - d) ** 2 * Math.min(distance(v, w), distance(x, y), 5) / gap ** 2;
    }
    cost += 60 * Math.max(0, gap - nearest) ** 2 / gap ** 2;
    if (aParent === bParent && (settings.forkSpread ?? 0) > 0) {
      const tangent = (id: string, line: Path) => unit(sub(layout.lineStyle === 'straight' ? line.points[1] : layout.routes[id].segments[0].c1, layout.nodes[aParent]));
      const angle = Math.acos(clamp(dot(tangent(aId, a), tangent(bId, b)), -1, 1));
      cost += 80 * Math.max(0, (settings.forkSpread ?? 0) * .85 - angle) ** 2;
    }
    return cost;
  };
  const score = (affected: string[], node?: string): number => {
    if (++evaluations > 30_000) { limited = true; return Infinity; }
    const candidates = new Map(affected.map(id => [id, path(id)])), pairs = new Set<string>();
    let cost = node ? distance(layout.nodes[node], original.nodes[node]) ** 2 * .015 : 0;
    for (const [id, line] of candidates) {
      cost += line.length * .035;
      for (const q of line.points) cost += 30 * (Math.max(0, widths[id] / 2 - q.x, q.x - p.widthMm + widths[id] / 2) ** 2 + Math.max(0, widths[id] / 2 - q.y, q.y - p.heightMm + widths[id] / 2) ** 2);
      const flow = flows[id];
      if (flow) for (const [a, b] of line.segments) cost += 20 * Math.min(0, dot(sub(b, a), unit(flow))) ** 2 * Math.hypot(flow.x, flow.y);
      // Penalize loops and fold-backs within an edge, outside adjacent sampled spans.
      for (let i = 0; i < line.segments.length; i++) for (let j = i + 2; j < line.segments.length; j++) {
        if (++work > 4_000_000) { limited = true; return Infinity; }
        const [a, b] = line.segments[i], [c, d] = line.segments[j];
        if (distance(b, c) > widths[id] * 2 && segmentDistance(a, b, c, d) < widths[id]) cost += 250;
      }
      const neighbors = new Set(affected);
      for (const key of keys(line.box)) for (const other of bins.get(key) ?? []) neighbors.add(other);
      for (const other of neighbors) if (other !== id) pairs.add([id, other].sort().join('|'));
    }
    for (const pair of pairs) {
      const [a, b] = pair.split('|'); cost += pairCost(a, candidates.get(a) ?? cache.get(a)!, b, candidates.get(b) ?? cache.get(b)!);
      if (limited) return Infinity;
    }
    return cost;
  };
  const directions = Array.from({ length: 8 }, (_, i) => ({ x: Math.cos(i * Math.PI / 4), y: Math.sin(i * Math.PI / 4) }));
  for (const factor of [1, .5, .25, .125]) {
    const step = Math.max(2, settings.junctionSpacingMm, padding * 2) * strength * factor;
    for (const node of junctions) {
      if (limited) break;
      const incident = Object.keys(layout.routes).filter(id => id === node || rooted.nodes[id].parent === node);
      const affected = incident.filter(id => visible.has(id));
      const start = { ...layout.nodes[node] }, routes = Object.fromEntries(incident.map(id => [id, structuredClone(layout.routes[id])]));
      let best = score(affected, node), winner = start, bestRoutes = routes;
      for (const direction of directions) {
        if (limited) break;
        layout.nodes[node] = { ...start }; for (const id of incident) layout.routes[id] = structuredClone(routes[id]);
        const next = add(start, scale(direction, step));
        if (next.x < p.strokeMm || next.y < p.strokeMm || next.x > p.widthMm - p.strokeMm || next.y > p.heightMm - p.strokeMm) continue;
        moveNodes(layout, rooted, [node], sub(next, start));
        const value = score(affected, node);
        if (value < best - 1e-7) { best = value; winner = { ...layout.nodes[node] }; bestRoutes = Object.fromEntries(incident.map(id => [id, structuredClone(layout.routes[id])])); }
      }
      layout.nodes[node] = winner; for (const id of incident) layout.routes[id] = bestRoutes[id]; affected.forEach(update);
    }
    if (layout.lineStyle !== 'straight') for (const id of eligible) {
      if (limited) break;
      const originalRoute = structuredClone(layout.routes[id]); let winner: Route = originalRoute, best = score([id]);
      // Search both sides, then individual handles. No extra biological or routing nodes.
      for (const mode of ['both', 'start', 'end', 'turn-start', 'turn-end'] as const) for (const sign of [-1, 1]) {
        if (limited) break;
        layout.routes[id] = structuredClone(originalRoute); let start = layout.nodes[rooted.nodes[id].parent!];
        for (const s of layout.routes[id].segments) {
          const v = sub(s.end, start), normal = unit({ x: -v.y, y: v.x }), shift = scale(normal, sign * Math.min(step * 2, distance(start, s.end) * .3));
          if (mode === 'turn-start' || mode === 'turn-end') {
            const turn = (handle: Point, origin: Point) => {
              const v = sub(handle, origin), angle = sign * Math.PI / 6 * strength * Math.sqrt(factor);
              return add(origin, { x: v.x * Math.cos(angle) - v.y * Math.sin(angle), y: v.x * Math.sin(angle) + v.y * Math.cos(angle) });
            };
            if (mode === 'turn-start') s.c1 = turn(s.c1, start); else s.c2 = turn(s.c2, s.end);
          } else {
            if (mode !== 'end') s.c1 = add(s.c1, shift);
            if (mode !== 'start') s.c2 = add(s.c2, shift);
          }
          start = s.end;
        }
        const value = score([id]); if (value < best - 1e-7) { best = value; winner = structuredClone(layout.routes[id]); }
      }
      layout.routes[id] = winner; update(id);
    }
    if (limited) break;
  }
  return { refinedRoutes: edges.filter(id => JSON.stringify(original.routes[id]) !== JSON.stringify(layout.routes[id])).length, routingLimited: limited };
}
