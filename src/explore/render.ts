import { LABEL_BUDGET, sourcePath } from './index.ts';
import type { Box, DetailFrame, ExploreIndex } from './index.ts';
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const f = (n: number) => Number(n.toFixed(3));
/** Render in CSS pixels, so strokes, hits and labels do not change size on zoom. */
export function renderExplore(index: ExploreIndex, frame: DetailFrame, camera: Box, width: number, height: number, selected: number | undefined, label: (i: number) => string, measure: (text: string) => number): { svg: string; labels: number; paths: number } {
  const scale = width / camera.w, sx = (x: number) => f((x - camera.x) * scale), sy = (y: number) => f((y - camera.y) * scale);
  const pt = (i: number) => `${sx(index.x[i])},${sy(index.y[i])}`;
  const polar = (r: number, a: number) => `${sx(r * Math.cos(a))},${sy(r * Math.sin(a))}`;
  const arc = (r: number, a: number, b: number) => {
    if (!r || Math.abs(b - a) < 1e-12) return `L${polar(r, b)}`;
    // Split into <= pi arcs, including wraparound and a complete circle.
    const parts = Math.max(1, Math.ceil(Math.abs(b - a) / Math.PI)), radius = f(r * scale);
    return Array.from({ length: parts }, (_, k) => `A${radius},${radius} 0 0 ${b > a ? 1 : 0} ${polar(r, a + (b - a) * (k + 1) / parts)}`).join('');
  };
  const stem = (i: number) => {
    const p = index.parent[i]; if (p < 0) return '';
    return index.mode === 'rectangular' ? `M${sx(index.x[p])},${sy(index.y[i])}L${pt(i)}` : `M${polar(index.radius[p], index.angle[i])}L${pt(i)}`;
  };
  const connector = (i: number) => {
    const lo = index.offsets[i], hi = index.offsets[i + 1]; if (lo === hi) return '';
    const a = index.children[lo], b = index.children[hi - 1];
    return index.mode === 'rectangular' ? `M${sx(index.x[i])},${sy(index.y[a])}L${sx(index.x[i])},${sy(index.y[b])}` : `M${polar(index.radius[i], index.angle[a])}${arc(index.radius[i], index.angle[a], index.angle[b])}`;
  };
  const summary = (i: number) => {
    const a = index.start[i] / index.tips, b = index.end[i] / index.tips;
    if (index.mode === 'rectangular') return `M${pt(i)}L${sx(1000)},${sy(a * 1000)}L${sx(1000)},${sy(b * 1000)}Z`;
    const t0 = index.angleStart + index.angleSpan * a, t1 = index.angleStart + index.angleSpan * b, r = index.radius[i];
    return `M${polar(r, t0)}L${polar(1000, t0)}${arc(1000, t0, t1)}L${polar(r, t1)}${arc(r, t1, t0)}Z`;
  };
  const lines: string[] = [], groups: string[] = [], marks: string[] = [], texts: string[] = [];
  for (const i of frame.nodes) {
    const d = stem(i) + (frame.expanded.has(i) ? connector(i) : '');
    if (d) lines.push(`<path d="${d}"/>`);
    if (frame.summaries.has(i)) groups.push(`<path class="explore-summary" data-explore-node="${i}" d="${summary(i)}"><title>Temporary display group · ${index.count[i].toLocaleString()} source tips · ${esc(index.ids[i])} · ${frame.summaries.get(i)} limit. Double-click to focus.</title></path>`);
    const x = sx(index.x[i]), y = sy(index.y[i]);
    if (x < -6 || y < -6 || x > width + 6 || y > height + 6) continue;
    marks.push(`<circle class="explore-node" data-explore-node="${i}" cx="${x}" cy="${y}" r="${index.count[i] === 1 ? 2.5 : 2}"><title>${esc(label(i))} · ${esc(index.ids[i])}</title></circle>`);
  }
  const occupied = new Map<string, Box[]>();
  const place = (text: string, i: number, summaryLabel: boolean, priority = false) => {
    let x = sx(index.x[i]) + 8, y = sy(index.y[i]) - 7;
    // Summary labels describe a region; clamp them into the visible portion of that region.
    if (summaryLabel) {
      const mid = (index.start[i] + index.end[i]) / (2 * index.tips);
      x = index.mode === 'rectangular' ? sx((index.x[i] + 1000) / 2) : sx((index.radius[i] + 1000) / 2 * Math.cos(index.angle[i]));
      y = index.mode === 'rectangular' ? sy(mid * 1000) : sy((index.radius[i] + 1000) / 2 * Math.sin(index.angle[i]));
      x = Math.max(8, Math.min(width - 130, x)); y = Math.max(18, Math.min(height - 8, y));
    }
    const clipped = text.length > 46 ? text.slice(0, 43) + '…' : text, w = measure(clipped) + 10;
    if (!summaryLabel && (x < 0 || y < 14 || y > height - 4 || x > width - 20)) return;
    x = Math.max(5, Math.min(x, width - w - 5));
    const box = { x, y: y - 13, w, h: 18 }, cells: string[] = [];
    for (let cx = Math.floor(x / 100); cx <= Math.floor((x + w) / 100); cx++) for (let cy = Math.floor(box.y / 20); cy <= Math.floor((box.y + box.h) / 20); cy++) cells.push(`${cx}:${cy}`);
    if (!priority && cells.some(key => (occupied.get(key) ?? []).some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y))) return;
    for (const key of cells) occupied.set(key, [...(occupied.get(key) ?? []), box]);
    texts.push(`<g class="explore-label${priority ? ' selected' : ''}" data-explore-node="${i}"><title>${esc(text)} · ${esc(index.ids[i])}</title><rect x="${f(x - 3)}" y="${f(y - 13)}" width="${f(w)}" height="18" rx="3"/><text x="${f(x)}" y="${f(y)}">${esc(clipped)}</text></g>`);
  };
  let path = '';
  if (selected !== undefined) {
    for (const i of sourcePath(index, selected)) {
      const p = index.parent[i]; if (p < 0) continue;
      path += stem(i) + (index.mode === 'rectangular' ? `M${pt(p)}L${sx(index.x[p])},${sy(index.y[i])}` : `M${pt(p)}${arc(index.radius[p], index.angle[p], index.angle[i])}`);
    }
    const x = sx(index.x[selected]), y = sy(index.y[selected]);
    marks.push(`<circle class="explore-selected" data-explore-node="${selected}" cx="${x}" cy="${y}" r="5"/>`);
    place(label(selected), selected, false, true);
  }
  // Selected label first, then exact group counts, then source tips and meaningful internal labels.
  for (const i of frame.summaries.keys()) if (texts.length < LABEL_BUDGET) place(`${index.count[i].toLocaleString()} tips · group`, i, true);
  for (const i of frame.nodes) {
    if (texts.length >= LABEL_BUDGET) break;
    if (i !== selected && !frame.summaries.has(i) && (index.count[i] === 1 || !/^Source (node|group)|^Virtual traversal/.test(label(i)))) place(label(i), i, false);
  }
  return { svg: `<g class="explore-branches">${lines.join('')}</g><g>${groups.join('')}</g><path class="explore-path" d="${path}"/><g>${marks.join('')}</g><g>${texts.join('')}</g>`, labels: texts.length, paths: lines.length + groups.length + (path ? 1 : 0) };
}
