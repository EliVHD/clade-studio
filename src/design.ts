import type { Design, EndpointBorder, Layout, Point, Presentation, Reduction, ReferenceImage, Rooted } from './types.ts';
import { add, sub, distance, lerp, moveNodes, subtreeIds } from './geometry.ts';
import { validateFitSettings, validateBranchDirection } from './fit-settings.ts';

export const MAX_IMAGE_BYTES = 8_000_000;
const finite = (v: number, min: number, max: number) => Number.isFinite(v) && v >= min && v <= max;
const validPoint = (p: Point) => p && finite(p.x, -9999, 9999) && finite(p.y, -9999, 9999);

/** Iterative Ramer–Douglas–Peucker: preserve the drawn silhouette without hundreds of handles. */
export function simplifyStroke(raw: Point[], tolerance = .45): Point[] {
  const points = raw.filter((p, i) => !i || distance(p, raw[i - 1]) > .01);
  if (points.length < 2) return points;
  const keep = new Set([0, points.length - 1]), stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!; let farthest = tolerance, index = -1;
    for (let i = start + 1; i < end; i++) {
      const d = distance(points[i], projectToSegment(points[i], points[start], points[end]).point);
      if (d > farthest) { farthest = d; index = i; }
    }
    if (index >= 0) { keep.add(index); stack.push([start, index], [index, end]); }
  }
  const result = [...keep].sort((a, b) => a - b).map(i => ({ ...points[i] }));
  // Inputs from a long tablet stroke remain bounded without recursion or silently dropping its end.
  return result.length <= 512 ? result : simplifyStroke(points, tolerance * 1.5);
}
function projectToSegment(p: Point, a: Point, b: Point): { point: Point; fraction: number } {
  const v = sub(b, a), square = v.x * v.x + v.y * v.y;
  const fraction = square ? Math.max(0, Math.min(1, ((p.x - a.x) * v.x + (p.y - a.y) * v.y) / square)) : 0;
  return { point: lerp(a, b, fraction), fraction };
}
function segments(border: Pick<EndpointBorder, 'points' | 'closed'>) {
  const result: { a: Point; b: Point; length: number; start: number }[] = []; let length = 0;
  const count = border.points.length - (border.closed ? 0 : 1);
  for (let i = 0; i < count; i++) {
    const a = border.points[i], b = border.points[(i + 1) % border.points.length], d = distance(a, b);
    if (d > 1e-9) { result.push({ a, b, length: d, start: length }); length += d; }
  }
  if (length < .1) throw new Error('Draw a border at least 0.1 mm long.');
  return { segments: result, length };
}
export function pointOnBorder(border: Pick<EndpointBorder, 'points' | 'closed'>, fraction: number): { point: Point; normal: Point } {
  const metric = segments(border), position = Math.max(0, Math.min(1, fraction)) * metric.length;
  const s = metric.segments.find(s => s.start + s.length >= position) ?? metric.segments.at(-1)!;
  return { point: lerp(s.a, s.b, (position - s.start) / s.length), normal: { x: -(s.b.y - s.a.y) / s.length, y: (s.b.x - s.a.x) / s.length } };
}
export function nearestBorderFraction(border: EndpointBorder, point: Point): number {
  const metric = segments(border); let best = Infinity, fraction = 0;
  for (const s of metric.segments) {
    const projected = projectToSegment(point, s.a, s.b), d = distance(point, projected.point);
    if (d < best) { best = d; fraction = (s.start + projected.fraction * s.length) / metric.length; }
  }
  return fraction;
}
export function scopedEndpoints(rooted: Rooted, reduction: Reduction, selection?: string[], includeDescendants = true): string[] {
  const included = selection ? new Set(includeDescendants ? selection.flatMap(id => subtreeIds(rooted, id)) : selection) : null;
  return reduction.frontier.filter(e => rooted.nodes[e.id].parent && (!included || included.has(e.id))).map(e => e.id);
}
/** Save assignments by source ID. Reducing or selecting another clade cannot retarget them. */
export function bindBorder(border: EndpointBorder, ids: string[], rooted: Rooted, layout: Layout): void {
  if (!ids.length) throw new Error('No visible endpoints in this scope. Select a visible clade or choose all endpoints.');
  const ordered = ids.map(id => ({ id, fraction: nearestBorderFraction(border, layout.nodes[id]) })).sort((a, b) => a.fraction - b.fraction);
  const area = border.points.reduce((sum, p, i, points) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0);
  border.assignments = ordered.map((entry, i) => {
    const fraction = border.placement === 'nearest' ? entry.fraction : border.closed ? i / ordered.length : ordered.length === 1 ? .5 : i / (ordered.length - 1);
    const { point, normal } = pointOnBorder(border, fraction), parent = layout.nodes[rooted.nodes[entry.id].parent!];
    const towardParent = sub(parent, point);
    const normalSign = border.closed ? (area >= 0 ? 1 : -1) : (towardParent.x * normal.x + towardParent.y * normal.y >= 0 ? 1 : -1);
    return { sourceNodeId: entry.id, fraction, normalSign };
  });
}
/** Explicit assignment transfers ownership while leaving every unrelated target untouched. */
export function assignBorder(design: Design, borderId: string, ids: string[], rooted: Rooted, layout: Layout): { assigned: number; transferred: number } {
  const border = design.borders.find(b => b.id === borderId);
  if (!border) throw new Error('Choose a saved border first.');
  const unique = new Set(ids), next = structuredClone(border);
  // Resolve the replacement before touching other borders, including on an empty selection.
  bindBorder(next, [...unique], rooted, layout);
  const transferred = new Set<string>();
  for (const other of design.borders) if (other !== border) {
    other.assignments = other.assignments.filter(a => {
      if (!unique.has(a.sourceNodeId)) return true;
      transferred.add(a.sourceNodeId); return false;
    });
  }
  border.assignments = next.assignments;
  return { assigned: unique.size, transferred: transferred.size };
}
/** Fixed per-ID noise, independent of iteration order and previous applications. */
function noise(id: string, seed: number): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b); h = (h ^ (h >>> 16)) >>> 0;
  return h / 0xffffffff * 2 - 1;
}
export function borderTargets(border: EndpointBorder, rooted: Rooted, reduction: Reduction, layout: Layout) {
  const visible = new Set(reduction.frontier.map(e => e.id));
  const locked = new Set([...layout.pinnedNodes, ...layout.pinnedEdges.flatMap(id => [id, rooted.nodes[id].parent!])]);
  return border.assignments.map(a => {
    const { point, normal } = pointOnBorder(border, a.fraction), offset = (border.insetMm + border.variationMm * noise(a.sourceNodeId, border.seed)) * a.normalSign;
    return { id: a.sourceNodeId, point: add(point, { x: normal.x * offset, y: normal.y * offset }), hidden: !visible.has(a.sourceNodeId), pinned: locked.has(a.sourceNodeId) };
  });
}
export function applyBorder(border: EndpointBorder, rooted: Rooted, reduction: Reduction, layout: Layout) {
  const targets = borderTargets(border, rooted, reduction, layout); let moved = 0;
  for (const t of targets) if (!t.hidden && !t.pinned) {
    moveNodes(layout, rooted, [t.id], sub(t.point, layout.nodes[t.id]));
    // Store the absolute target to avoid floating-point drift from adding a delta twice.
    layout.nodes[t.id] = { ...t.point }; layout.routes[t.id].segments.at(-1)!.end = { ...t.point }; moved++;
  }
  return { moved, pinned: targets.filter(t => t.pinned && !t.hidden).length, hidden: targets.filter(t => t.hidden).length };
}
export function fitReference(image: ReferenceImage, page: Presentation): void {
  const scale = Math.min(page.widthMm * .9 / image.pixelWidth, page.heightMm * .9 / image.pixelHeight);
  image.widthMm = image.pixelWidth * scale; image.heightMm = image.pixelHeight * scale;
  image.x = (page.widthMm - image.widthMm) / 2; image.y = (page.heightMm - image.heightMm) / 2; image.rotationDeg = 0;
}
export function validateImageData(dataUrl: string): void {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 50) throw new Error('Reference image exceeds the 8 MB limit.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[2].length % 4) throw new Error('Use an embedded PNG, JPEG or WebP reference image.');
  const header = atob(match[2].slice(0, 24));
  const valid = match[1] === 'png' ? header.startsWith('\x89PNG\r\n\x1a\n') : match[1] === 'jpeg' ? header.startsWith('\xff\xd8\xff') : header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP';
  if (!valid) throw new Error('Reference image content does not match its file type.');
}
export function validateDesign(design: Design | undefined, rooted: Rooted): void {
  if (design === undefined) return; // Existing version-1 projects remain compatible.
  if (!design || !Array.isArray(design.borders) || design.borders.length > 20 || typeof design.showBorders !== 'boolean') throw new Error('Invalid design guides.');
  if (design.fitSettings !== undefined) validateFitSettings(design.fitSettings);
  const ids = new Set<string>();
  for (const b of design.borders) {
    if (!b || typeof b.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(b.id) || ids.has(b.id) || typeof b.name !== 'string' || b.name.length > 100) throw new Error('Invalid border identity.');
    ids.add(b.id);
    if (b.direction !== undefined && b.direction !== null) validateBranchDirection(b.direction);
    if (!Array.isArray(b.points) || b.points.length < 2 || b.points.length > 512 || b.points.some(p => !validPoint(p)) || typeof b.closed !== 'boolean' || (b.closed && b.points.length < 3)) throw new Error('Invalid border points.');
    segments(b);
    if (!['nearest', 'spread'].includes(b.placement) || !finite(b.insetMm, -50, 50) || !finite(b.variationMm, 0, 50) || !Number.isInteger(b.seed) || !finite(b.seed, 0, 0xffffffff)) throw new Error('Invalid border offsets.');
    if (!Array.isArray(b.assignments) || b.assignments.length > rooted.order.length || new Set(b.assignments.map(a => a.sourceNodeId)).size !== b.assignments.length || b.assignments.some(a => !a || !Object.hasOwn(rooted.nodes, a.sourceNodeId) || a.sourceNodeId === rooted.rootId || !finite(a.fraction, 0, 1) || ![1, -1].includes(a.normalSign))) throw new Error('Invalid border endpoint assignments.');
  }
  if (design.activeBorderId !== undefined && !ids.has(design.activeBorderId)) throw new Error('Unknown active border.');
  const r = design.referenceImage;
  if (r !== undefined) {
    if (!r || typeof r.name !== 'string' || r.name.length > 200 || !Number.isInteger(r.pixelWidth) || !Number.isInteger(r.pixelHeight) || !finite(r.pixelWidth, 1, 40000) || !finite(r.pixelHeight, 1, 40000) || r.pixelWidth * r.pixelHeight > 40_000_000) throw new Error('Reference image must contain at most 40 megapixels.');
    validateImageData(r.dataUrl);
    if (!validPoint(r) || !finite(r.widthMm, .1, 9999) || !finite(r.heightMm, .1, 9999) || !finite(r.rotationDeg, -360, 360) || !finite(r.opacity, 0, 1) || typeof r.visible !== 'boolean' || !['behind', 'above'].includes(r.layer)) throw new Error('Invalid reference image placement.');
  }
}
