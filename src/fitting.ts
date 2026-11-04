import type { Design, FitResult, FitSettings, Layout, Point, Presentation, Reduction, Rooted } from './types.ts';
import { add, sub, distance, lerp, edgeWidth } from './geometry.ts';
import { borderTargets, validateDesign } from './design.ts';
import { validateFitSettings, directionVector } from './fit-settings.ts';
import { refineRouting, spreadForks } from './routing.ts';

const times = (p: Point, k: number): Point => ({ x: p.x * k, y: p.y * k });
const unit = (p: Point): Point => times(p, 1 / (Math.hypot(p.x, p.y) || 1));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
function onSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const v = sub(b, a), d = v.x * v.x + v.y * v.y;
  const t = d ? clamp(((p.x - a.x) * v.x + (p.y - a.y) * v.y) / d, 0, 1) : .5;
  return { point: lerp(a, b, t), t };
}
/** Stable separation direction for coincident junctions; no random or clock-dependent state. */
function direction(a: number, b: number): Point {
  const angle = ((Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663)) >>> 0) / 0xffffffff * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

export function fittingTargets(design: Design, rooted: Rooted, reduction: Reduction, layout: Layout, settings: FitSettings) {
  validateFitSettings(settings); validateDesign(design, rooted);
  const borders = settings.borderScope === 'active' ? design.borders.filter(b => b.id === design.activeBorderId) : design.borders;
  if (!borders.length) throw new Error('Draw and assign an endpoint border in Shape first.');
  const targets = new Map<string, Point>(), directions = new Map<string, Point>(); let hidden = 0, pinned = 0;
  for (const border of borders) for (const t of borderTargets(border, rooted, reduction, layout)) {
    if (t.hidden) { hidden++; continue; }
    const flow = directionVector(border.direction === undefined ? settings.direction : border.direction);
    const previous = targets.get(t.id);
    if (previous && distance(directions.get(t.id)!, flow) > 1e-6) throw new Error(`Borders give ${t.id} different directions. Reassign the endpoint to one border in Shape.`);
    if (previous && distance(previous, t.point) > 1e-6) throw new Error(`Borders give ${t.id} different targets. Choose Active border or reassign overlapping borders in Shape.`);
    if (!previous && t.pinned) pinned++;
    targets.set(t.id, t.point); directions.set(t.id, flow);
  }
  if (!targets.size) throw new Error('These borders have no visible assigned endpoints. Assign endpoints in Shape to reassign them.');
  return { targets, directions, hidden, pinned };
}

type Stats = { count: number; assigned: number; height: number; oldCenter: Point; newCenter: Point; flow: Point };
/**
 * Fit junctions to nested clade envelopes, then relax crowding. Endpoints and scientific
 * topology are separate: no operation here creates, removes, or reparents source nodes.
 * Only junctions whose entire visible descendant frontier is assigned may move. The root,
 * pin boundaries and partially assigned ancestors act as anchors for independent regions.
 */
export function fitSilhouette(rooted: Rooted, reduction: Reduction, base: Layout, p: Presentation, design: Design, settings: FitSettings): Omit<FitResult, 'beforeQA' | 'afterQA'> {
  const { targets, directions, hidden, pinned } = fittingTargets(design, rooted, reduction, base, settings);
  // Full-source artwork is retained; the interactive solver has an explicit bounded workload.
  if (reduction.visible.length > 5000) throw new Error('Automatic fitting supports up to 5,000 visible nodes. Reduce more clades before fitting.');
  const visible = new Set(reduction.visible), order = rooted.order.filter(id => visible.has(id));
  const frontier = new Set(reduction.frontier.map(e => e.id)), locked = new Set([rooted.rootId, ...base.pinnedNodes]);
  for (const edge of base.pinnedEdges) { locked.add(edge); if (rooted.nodes[edge].parent) locked.add(rooted.nodes[edge].parent!); }
  const children = (id: string) => rooted.nodes[id].children.filter(c => visible.has(c));
  const weights: Record<string, number> = {};
  for (const id of order) { const parent = rooted.nodes[id].parent; weights[id] = parent ? Math.sqrt(Math.max(.5, distance(base.nodes[parent], base.nodes[id]))) : 0; }
  const stats: Record<string, Stats> = {};
  for (const id of [...order].reverse()) {
    if (frontier.has(id)) stats[id] = { count: 1, assigned: Number(targets.has(id)), height: 0, flow: directions.get(id) ?? { x: 0, y: 0 }, oldCenter: base.nodes[id], newCenter: locked.has(id) ? base.nodes[id] : targets.get(id) ?? base.nodes[id] };
    else {
      const cc = children(id), count = cc.reduce((n, c) => n + stats[c].count, 0);
      stats[id] = { count, assigned: cc.reduce((n, c) => n + stats[c].assigned, 0), height: Math.max(...cc.map(c => weights[c] + stats[c].height)),
        flow: times(cc.reduce((s, c) => add(s, times(stats[c].flow, stats[c].count)), { x: 0, y: 0 }), 1 / count),
        oldCenter: times(cc.reduce((s, c) => add(s, times(stats[c].oldCenter, stats[c].count)), { x: 0, y: 0 }), 1 / count),
        newCenter: times(cc.reduce((s, c) => add(s, times(stats[c].newCenter, stats[c].count)), { x: 0, y: 0 }), 1 / count) };
    }
  }
  const mobile = new Set(order.filter(id => !locked.has(id) && stats[id].assigned === stats[id].count));
  const junctions = order.filter(id => mobile.has(id) && !frontier.has(id));
  const goals: Record<string, Point> = {}, positions = structuredClone(base.nodes);
  const anchors: Record<string, string> = {}, depths: Record<string, number> = {};
  const margin = Math.min(Math.min(p.widthMm, p.heightMm) / 10, Math.max(p.strokeMm * 2, .5));
  const inside = (point: Point): Point => ({ x: clamp(point.x, margin, p.widthMm - margin), y: clamp(point.y, margin, p.heightMm - margin) });
  for (const id of order) {
    if (!mobile.has(id)) continue;
    if (frontier.has(id)) { positions[id] = { ...targets.get(id)! }; continue; }
    const parent = rooted.nodes[id].parent!;
    anchors[id] = mobile.has(parent) ? anchors[parent] : parent;
    depths[id] = (mobile.has(parent) ? depths[parent] : 0) + weights[id];
    const anchor = base.nodes[anchors[id]], t = depths[id] / (depths[id] + stats[id].height);
    // Depth is an artistic dial: early forks stay nearer the anchor, late forks nearer the envelope.
    const reach = Math.pow(t, Math.pow(2.5, 1 - 2 * settings.junctionDepth));
    const oldAxis = sub(stats[id].oldCenter, anchor), newAxis = sub(stats[id].newCenter, anchor);
    const angle = Math.atan2(newAxis.y, newAxis.x) - Math.atan2(oldAxis.y, oldAxis.x);
    const residual = sub(base.nodes[id], lerp(anchor, stats[id].oldCenter, t));
    const scale = clamp(Math.hypot(newAxis.x, newAxis.y) / Math.max(1, Math.hypot(oldAxis.x, oldAxis.y)), .35, 2.5);
    const flow = times({ x: residual.x * Math.cos(angle) - residual.y * Math.sin(angle), y: residual.x * Math.sin(angle) + residual.y * Math.cos(angle) }, settings.preserveFlow * scale);
    const natural = add(lerp(anchor, stats[id].newCenter, reach), flow);
    const influence = Math.min(1, Math.hypot(stats[id].flow.x, stats[id].flow.y));
    const directed = sub(stats[id].newCenter, times(unit(stats[id].flow), Math.max(settings.junctionSpacingMm, distance(anchor, stats[id].newCenter)) * (1 - reach)));
    goals[id] = inside(lerp(natural, directed, influence)); positions[id] = { ...goals[id] };
  }
  // Positions are simultaneous, so one junction cannot silently move another junction's anchor.
  // Springs preserve clade depth; spatial repulsion creates breathing room around scientific forks.
  const edges = order.filter(id => rooted.nodes[id].parent), index = new Map(order.map((id, i) => [id, i]));
  const rest = Object.fromEntries(edges.map(id => [id, Math.max(settings.junctionSpacingMm, distance(positions[id], positions[rooted.nodes[id].parent!]))]));
  const cellSize = Math.max(1, settings.junctionSpacingMm), radius = settings.junctionSpacingMm;
  for (let iteration = 0; iteration < 110 && junctions.length && settings.strength > 0; iteration++) {
    const forces: Record<string, Point> = Object.fromEntries(junctions.map(id => [id, times(sub(goals[id], positions[id]), .12)]));
    const bins = new Map<string, string[]>();
    for (const id of order) { const q = positions[id], key = `${Math.floor(q.x / cellSize)},${Math.floor(q.y / cellSize)}`; const bin = bins.get(key) ?? []; bin.push(id); bins.set(key, bin); }
    for (const id of junctions) {
      const q = positions[id], bx = Math.floor(q.x / cellSize), by = Math.floor(q.y / cellSize);
      for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) for (const other of bins.get(`${x},${y}`) ?? []) {
        if (other === id) continue;
        const v = sub(q, positions[other]), d = Math.hypot(v.x, v.y);
        if (d < radius) {
          let away = d > 1e-7 ? times(v, 1 / d) : direction(Math.min(index.get(id)!, index.get(other)!), Math.max(index.get(id)!, index.get(other)!));
          if (d <= 1e-7 && index.get(id)! < index.get(other)!) away = times(away, -1);
          forces[id] = add(forces[id], times(away, (radius - d) * .8));
        }
      }
    }
    for (const id of edges) {
      const parent = rooted.nodes[id].parent!, v = sub(positions[id], positions[parent]), d = Math.hypot(v.x, v.y);
      const force = times(d > 1e-7 ? times(v, 1 / d) : direction(index.get(id)!, index.get(parent)!), (d - rest[id]) * .07);
      if (forces[id]) forces[id] = sub(forces[id], force);
      if (forces[parent]) forces[parent] = add(forces[parent], force);
      if (stats[id].assigned === stats[id].count) {
        const flow = stats[id].flow, influence = Math.hypot(flow.x, flow.y), heading = unit(flow);
        const advance = v.x * heading.x + v.y * heading.y, minimum = Math.min(radius, rest[id] * .35);
        if (influence > 1e-6 && advance < minimum) {
          const correction = times(heading, (minimum - advance) * influence * .65 / (forces[id] && forces[parent] ? 2 : 1));
          if (forces[id]) forces[id] = add(forces[id], correction);
          if (forces[parent]) forces[parent] = sub(forces[parent], correction);
        }
      }
    }
    // Repel junctions from unrelated branch chords. This is a soft objective; the exact
    // Bézier/stroke checks are run on the proposal before it can be accepted in the UI.
    for (const id of junctions) for (const edge of edges) {
      const parent = rooted.nodes[edge].parent!;
      if (id === edge || id === parent) continue;
      const a = positions[parent], b = positions[edge], q = positions[id];
      const gap = p.clearanceMm + edgeWidth(rooted, edge, p) / 2 + Math.min(radius * .35, 1.5);
      if (q.x < Math.min(a.x, b.x) - gap || q.x > Math.max(a.x, b.x) + gap || q.y < Math.min(a.y, b.y) - gap || q.y > Math.max(a.y, b.y) + gap) continue;
      const projection = onSegment(q, a, b), v = sub(q, projection.point), d = Math.hypot(v.x, v.y);
      if (d >= gap) continue;
      const away = d > 1e-7 ? times(v, 1 / d) : unit({ x: -(b.y - a.y), y: b.x - a.x });
      const force = times(away, (gap - d) * .3);
      forces[id] = add(forces[id], force);
      if (forces[parent]) forces[parent] = sub(forces[parent], times(force, (1 - projection.t) * .5));
      if (forces[edge]) forces[edge] = sub(forces[edge], times(force, projection.t * .5));
    }
    let movement = 0;
    for (const id of junctions) {
      const force = forces[id], magnitude = Math.hypot(force.x, force.y), step = times(force, Math.min(.65, 1.2 / Math.max(1e-9, magnitude)));
      const next = inside(add(positions[id], step)); movement = Math.max(movement, distance(positions[id], next)); positions[id] = next;
    }
    if (movement < .003) break;
  }
  const flows = Object.fromEntries(order.filter(id => stats[id].assigned === stats[id].count).map(id => [id, stats[id].flow]));
  // Solve at full strength once, then interpolate the complete proposal. A 50% preview
  // is exactly halfway to the same solution, rather than running a different search.
  const full = settings.strength ? warpLayout(rooted, reduction, base, positions, mobile, { ...settings, strength: 1 }, flows) : structuredClone(base);
  const eligible = new Set(edges.filter(id => !base.pinnedEdges.includes(id) && stats[id].assigned === stats[id].count && (mobile.has(id) || mobile.has(rooted.nodes[id].parent!))));
  let routing = { refinedRoutes: 0, routingLimited: false };
  if (settings.strength) {
    spreadForks(rooted, reduction, full, eligible, settings.forkSpread ?? 0, flows);
    routing = refineRouting(rooted, reduction, full, p, junctions, eligible, settings, flows);
  }
  const layout = full;
  if (settings.strength > 0 && settings.strength < 1) {
    for (const id of Object.keys(layout.nodes)) layout.nodes[id] = lerp(base.nodes[id], full.nodes[id], settings.strength);
    for (const [id, route] of Object.entries(layout.routes)) route.segments.forEach((s, i) => {
      const old = base.routes[id].segments[i];
      s.c1 = lerp(old.c1, s.c1, settings.strength); s.c2 = lerp(old.c2, s.c2, settings.strength); s.end = lerp(old.end, s.end, settings.strength);
    });
  }
  const directed = edges.filter(id => flows[id] && Math.hypot(flows[id].x, flows[id].y) > 1e-6);
  const directionConflicts = directed.filter(id => {
    const heading = unit(flows[id]); let start = layout.nodes[rooted.nodes[id].parent!];
    return layout.routes[id].segments.some(s => {
      const projection = (v: Point) => v.x * heading.x + v.y * heading.y;
      if (layout.lineStyle === 'straight') { const reverse = projection(sub(s.end, start)) < -.01; start = s.end; return reverse; }
      const a = projection(sub(s.c1, start)), b = projection(sub(s.c2, s.c1)), c = projection(sub(s.end, s.c2));
      start = s.end;
      const denominator = a - 2 * b + c, t = denominator ? (a - b) / denominator : -1;
      const minimum = Math.min(a, c, t > 0 && t < 1 ? a * (1 - t) ** 2 + 2 * b * t * (1 - t) + c * t ** 2 : Infinity);
      return minimum < -.01;
    });
  }).length;
  const movedJunctions = junctions.filter(id => distance(base.nodes[id], layout.nodes[id]) > 1e-6).map(id => ({ id, from: { ...base.nodes[id] }, to: { ...layout.nodes[id] } }));
  const error = (l: Layout) => [...targets].reduce((sum, [id, target]) => sum + distance(l.nodes[id], target), 0) / targets.size;
  let crowdedJunctionPairs = 0; const junctionSet = new Set(junctions);
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    if (!junctionSet.has(order[i]) && !junctionSet.has(order[j])) continue;
    if (distance(layout.nodes[order[i]], layout.nodes[order[j]]) + .01 < radius) crowdedJunctionPairs++;
  }
  return { layout, movedJunctions, movedEndpoints: [...targets.keys()].filter(id => distance(base.nodes[id], layout.nodes[id]) > 1e-6).length,
    assignedEndpoints: targets.size, pinnedEndpoints: pinned, hiddenAssignments: hidden,
    fixedJunctions: order.filter(id => !frontier.has(id) && !mobile.has(id)).length,
    errorBeforeMm: error(base), errorAfterMm: error(layout), crowdedJunctionPairs, directedEdges: directed.length, directionConflicts, ...routing };
}

/** Move every shared junction once; warp all incident routes, including hidden descendants. */
function warpLayout(rooted: Rooted, reduction: Reduction, base: Layout, fitted: Record<string, Point>, mobile: Set<string>, settings: FitSettings, flows: Record<string, Point>): Layout {
  const layout = structuredClone(base);
  if (settings.strength === 0) return layout;
  for (const id of mobile) layout.nodes[id] = settings.strength === 1 ? { ...fitted[id] } : lerp(base.nodes[id], fitted[id], settings.strength);
  const visible = new Set(reduction.visible), pinned = new Set(base.pinnedEdges);
  const blend = settings.smoothing * settings.strength;
  for (const [id, route] of Object.entries(layout.routes)) {
    const parent = rooted.nodes[id].parent!;
    const flow = flows[id], directed = flow && Math.hypot(flow.x, flow.y) > 1e-6;
    if (pinned.has(id) || (!mobile.has(id) && !mobile.has(parent) && !directed)) continue;
    const da = sub(layout.nodes[parent], base.nodes[parent]), db = sub(layout.nodes[id], base.nodes[id]);
    const n = route.segments.length;
    for (let i = 0; i < n; i++) {
      const s = route.segments[i]; s.c1 = add(s.c1, lerp(da, db, (i + 1 / 3) / n)); s.c2 = add(s.c2, lerp(da, db, (i + 2 / 3) / n)); s.end = add(s.end, lerp(da, db, (i + 1) / n));
    }
    route.segments.at(-1)!.end = { ...layout.nodes[id] };
    if (!visible.has(id) || layout.lineStyle === 'straight') continue;
    const a = layout.nodes[parent], b = layout.nodes[id], grand = rooted.nodes[parent].parent;
    const firstEnd = n > 1 ? route.segments[0].end : b, lastStart = n > 1 ? route.segments[n - 2].end : a;
    const chord = unit(sub(firstEnd, a)), incoming = grand ? unit(sub(a, layout.nodes[grand])) : chord;
    const startDirection = unit(add(times(chord, .8), times(incoming, .2)));
    const cc = rooted.nodes[id].children.filter(c => visible.has(c));
    const center = cc.length ? times(cc.reduce((sum, c) => add(sum, layout.nodes[c]), { x: 0, y: 0 }), 1 / cc.length) : b;
    const endChord = unit(sub(b, lastStart)), onward = cc.length ? unit(sub(center, lastStart)) : endChord;
    const endDirection = unit(add(times(endChord, .75), times(onward, .25)));
    route.segments[0].c1 = lerp(route.segments[0].c1, add(a, times(startDirection, distance(a, firstEnd) / 3)), blend);
    route.segments.at(-1)!.c2 = lerp(route.segments.at(-1)!.c2, sub(b, times(endDirection, distance(lastStart, b) / 3)), blend);
    if (directed) {
      // Align incident tangents independently of smoothing. Direction varies continuously
      // through mixed clades; opposite groups cancel at their shared ancestor.
      const parentFlow = flows[parent], fromFlow = parentFlow && Math.hypot(parentFlow.x, parentFlow.y) > 1e-6 ? parentFlow : flow;
      let start = a;
      for (let i = 0; i < n; i++) {
        const s = route.segments[i], chord = sub(s.end, start), length = distance(start, s.end);
        const align = (handle: Point, origin: Point, vector: Point, sign: number) => {
          const influence = Math.min(1, Math.hypot(vector.x, vector.y)) * settings.strength, heading = unit(vector);
          const advance = chord.x * heading.x + chord.y * heading.y;
          const handleLength = advance > .01 ? Math.min(length / 3, advance * .45) : length / 3;
          return lerp(handle, add(origin, times(heading, sign * handleLength)), influence);
        };
        s.c1 = align(s.c1, start, lerp(fromFlow, flow, i / n), 1);
        s.c2 = align(s.c2, s.end, lerp(fromFlow, flow, (i + 1) / n), -1);
        start = s.end;
      }
    }
  }
  return layout;
}
