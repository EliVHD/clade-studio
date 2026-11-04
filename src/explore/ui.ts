import type { Correction, RootSpec, Source } from '../types.ts';
import type { RootState, ScientificBasis } from '../model/document.ts';
import { searchSource } from '../search.ts';
import { fitBox, focusBox, selectDetail, sourcePath, NODE_BUDGET, LABEL_BUDGET } from './index.ts';
import type { Box, ExploreIndex, ExploreMode } from './index.ts';
import { renderExplore } from './render.ts';

type Input = { source: Source; root: RootSpec; childOrder: Record<string, string[]>; corrections: Correction[]; basis: ScientificBasis; rootState: RootState; title: string };
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** Owns only ephemeral viewing state. No project mutation, QA, export or history callbacks. */
export class ExploreController {
  active = false;
  private input?: Input;
  private index?: ExploreIndex;
  private worker?: Worker;
  private sequence = 0;
  private mode: ExploreMode = 'rectangular';
  private camera: Box = { x: 0, y: 0, w: 1000, h: 1000 };
  private expanded = new Set<number>();
  private selectedId?: string;
  private lookup = new Map<string, number>();
  private corrections = new Map<string, string>();
  private raf = 0;
  private offset = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private drag?: { x: number; y: number; camera: Box; moved: boolean };
  private width = 1;
  private height = 1;
  private indexMs = 0;
  private context = document.createElement('canvas').getContext('2d')!;

  constructor() {
    $('explore-back').onclick = () => this.close();
    $('explore-home').onclick = () => this.home();
    $('explore-in').onclick = () => this.zoom(.65);
    $('explore-out').onclick = () => this.zoom(1 / .65);
    $('explore-focus').onclick = () => { if (this.selectedId) this.focus(this.selectedId); };
    $('explore-layout').onchange = () => { this.mode = $<HTMLSelectElement>('explore-layout').value as ExploreMode; this.build(); };
    $('explore-search').oninput = () => { clearTimeout(this.searchTimer); this.offset = 0; this.searchTimer = setTimeout(() => this.search(), 140); };
    $('explore-results').onclick = event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-explore-id],[data-explore-page]');
      if (target?.dataset.exploreId) this.focus(target.dataset.exploreId);
      else if (target?.dataset.explorePage) { this.offset = Number(target.dataset.explorePage); this.search(); }
    };
    $('explore-inspector').onclick = event => {
      const target = (event.target as Element).closest<HTMLElement>('[data-explore-id]'); if (target?.dataset.exploreId) this.focus(target.dataset.exploreId);
    };
    const stage = $('explore-stage');
    stage.addEventListener('wheel', event => { event.preventDefault(); const rect = stage.getBoundingClientRect(); this.zoom(Math.exp(Math.max(-.35, Math.min(.35, event.deltaY * .0015))), event.clientX - rect.left, event.clientY - rect.top); }, { passive: false });
    stage.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      stage.focus(); this.drag = { x: event.clientX, y: event.clientY, camera: { ...this.camera }, moved: false }; stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointermove', event => {
      if (!this.drag) return;
      const dx = event.clientX - this.drag.x, dy = event.clientY - this.drag.y;
      if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
      if (!this.drag.moved) return;
      this.camera = { ...this.drag.camera, x: this.drag.camera.x - dx * this.drag.camera.w / this.width, y: this.drag.camera.y - dy * this.drag.camera.h / this.height }; this.schedule();
    });
    stage.addEventListener('pointerup', event => {
      const moved = this.drag?.moved; this.drag = undefined;
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      if (!moved) {
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-explore-node]');
        if (hit && this.index) { this.selectedId = this.index.ids[Number(hit.dataset.exploreNode)]; this.inspect(); this.schedule(); }
      }
    });
    stage.addEventListener('pointercancel', () => { this.drag = undefined; });
    stage.addEventListener('dblclick', event => {
      const hit = (event.target as Element).closest<HTMLElement>('[data-explore-node]');
      if (hit && this.index) this.focus(this.index.ids[Number(hit.dataset.exploreNode)]); else this.zoom(.5);
    });
    stage.addEventListener('keydown', event => {
      if (event.key === 'Home') this.home();
      else if (['+', '='].includes(event.key)) this.zoom(.65);
      else if (event.key === '-') this.zoom(1 / .65);
      else if (event.key === 'Enter' && this.selectedId) this.focus(this.selectedId);
      else if (event.key.startsWith('Arrow')) {
        this.camera.x += (event.key === 'ArrowLeft' ? -.15 : event.key === 'ArrowRight' ? .15 : 0) * this.camera.w;
        this.camera.y += (event.key === 'ArrowUp' ? -.15 : event.key === 'ArrowDown' ? .15 : 0) * this.camera.h; this.schedule();
      } else return;
      event.preventDefault();
    });
    new ResizeObserver(() => {
      if (!this.active) return;
      const old = this.camera, size = stage.getBoundingClientRect();
      this.width = Math.max(1, size.width); this.height = Math.max(1, size.height);
      this.camera = fitBox(old, this.width, this.height, 1); this.schedule();
    }).observe(stage);
    document.fonts?.addEventListener('loadingdone', () => this.schedule());
  }
  open(input: Input): void {
    this.input = input; this.active = true; this.selectedId = undefined;
    this.corrections = new Map(input.corrections.filter(c => c.display_taxonomy).map(c => [c.source_node_id, c.display_taxonomy!]));
    document.querySelector<HTMLElement>('.workspace')!.hidden = true; $('explore-view').hidden = false;
    // Artwork exports remain in the editor, where the accepted view is visible.
    for (const id of ['save-btn', 'export-btn']) $(id).hidden = true;
    $('explore-title').textContent = input.title;
    const relation = input.basis.relationshipKind;
    $('explore-meaning').textContent = relation === 'classification'
      ? 'Classification · supplied parent links. Groups express membership, not evolutionary ancestry.'
      : input.rootState.status === 'rooted' && relation === 'phylogeny'
        ? `Rooted source topology · ${input.rootState.explanation}`
        : 'Source traversal only · no biological root or ancestry claim. Full unrooted expansion is not supported.';
    $('explore-meaning').textContent += ' Nonmetric spacing; source lengths and internal labels are not interpreted. Shaded groups are temporary viewing summaries.';
    $<HTMLInputElement>('explore-search').value = ''; this.offset = 0; this.search();
    const size = $('explore-stage').getBoundingClientRect(); this.width = Math.max(1, size.width); this.height = Math.max(1, size.height);
    this.build(); $('explore-back').focus();
  }
  close(): void {
    this.active = false; this.sequence++; this.worker?.terminate(); this.worker = undefined; cancelAnimationFrame(this.raf); this.raf = 0; clearTimeout(this.searchTimer); this.drag = undefined;
    $('explore-view').hidden = true; document.querySelector<HTMLElement>('.workspace')!.hidden = false;
    for (const id of ['save-btn', 'export-btn']) $(id).hidden = false;
    $('explore-view-btn').focus();
  }
  private build(): void {
    if (!this.input || !this.active) return;
    this.worker?.terminate(); this.index = undefined; this.lookup.clear(); this.expanded.clear();
    for (const key of Object.keys($('explore-canvas').dataset)) delete $('explore-canvas').dataset[key];
    $('explore-canvas').innerHTML = ''; $('explore-status').textContent = 'Preparing full source in a cancellable background worker…';
    $('explore-inspector').textContent = 'Preparing source identities…';
    const sequence = ++this.sequence, input = this.input, mode = this.mode;
    const worker = new Worker(new URL('./worker.ts', import.meta.url).href.replace(/\.ts$/, '.js'), { type: 'module' }); this.worker = worker;
    worker.onmessage = ({ data }) => {
      if (!this.active || sequence !== this.sequence || this.worker !== worker) return;
      worker.terminate(); this.worker = undefined;
      if (data.error) { $('explore-status').textContent = `Explore unavailable: ${data.error}`; return; }
      if (data.sourceSha !== input.source.sha256 || data.mode !== mode) return;
      this.index = data.index; this.indexMs = data.indexMs; this.lookup = new Map(this.index!.ids.map((id, i) => [id, i]));
      this.home(); this.inspect();
      if (this.selectedId) this.focus(this.selectedId);
    };
    worker.onerror = event => { if (sequence === this.sequence) $('explore-status').textContent = `Explore unavailable: ${event.message}`; worker.terminate(); };
    // Classification always keeps its supplied parent orientation, regardless of an artistic recipe traversal.
    const root: RootSpec = input.basis.relationshipKind === 'classification' ? { kind: 'node', sourceNodeId: input.source.rootId, status: 'classification_parent_links' } : input.root;
    worker.postMessage({ sequence, sourceSha: input.source.sha256, sourceText: input.source.text, root, childOrder: input.childOrder, mode });
  }
  private label(i: number): string {
    const id = this.index!.ids[i], node = this.input!.source.nodes[id];
    if (!node) return 'Virtual traversal junction';
    if (!node.children.length) return this.corrections.get(id) ?? node.label;
    // Numeric labels are visible verbatim in the inspector, never treated as taxon names/support.
    return node.label && !/^[\d.eE+\-/\s]+$/.test(node.label) ? node.label : `Source node ${id}`;
  }
  private home(): void { if (this.index) { this.camera = fitBox(this.index.extent, this.width, this.height, 1.24); this.schedule(); } }
  private focus(id: string): void {
    this.selectedId = id;
    const i = this.lookup.get(id); if (i === undefined || !this.index) return;
    this.camera = focusBox(this.index, i, this.width, this.height); this.inspect(); this.schedule();
  }
  private zoom(factor: number, px = this.width / 2, py = this.height / 2): void {
    if (!this.index) return;
    const next = this.camera.h * factor;
    if (next < .002 || next > 20000) return;
    const x = this.camera.x + px / this.width * this.camera.w, y = this.camera.y + py / this.height * this.camera.h;
    this.camera = { x: x + (this.camera.x - x) * factor, y: y + (this.camera.y - y) * factor, w: this.camera.w * factor, h: next }; this.schedule();
  }
  private schedule(): void { if (this.active && !this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }
  private draw(): void {
    if (!this.index || !this.active) return;
    const began = performance.now(), frame = selectDetail(this.index, this.camera, this.width / this.camera.w, this.expanded);
    this.expanded = frame.expanded; this.context.font = '12px system-ui';
    const render = renderExplore(this.index, frame, this.camera, this.width, this.height, this.selectedId ? this.lookup.get(this.selectedId) : undefined, i => this.label(i), text => this.context.measureText(text).width);
    const canvas = $('explore-canvas'); canvas.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`); canvas.innerHTML = render.svg;
    const ms = performance.now() - began, outside = this.index.tips - frame.coveredTips, budget = [...frame.summaries.values()].filter(v => v === 'budget').length;
    $('explore-status').textContent = `${this.index.tips.toLocaleString()} source tips · ${frame.nodes.length.toLocaleString()} drawn nodes/groups · ${frame.summaries.size} summaries · ${outside.toLocaleString()} tips outside displayed groups${budget ? ` · ${budget} budget-limited groups; zoom or search for detail` : ''}`;
    $('explore-performance').textContent = `Index ${this.indexMs.toFixed(0)} ms · last SVG update ${ms.toFixed(1)} ms · ${render.labels} labels · limits ${NODE_BUDGET} nodes / ${LABEL_BUDGET} labels`;
    // Ephemeral diagnostics support local verification; never enter the saved project.
    canvas.dataset.nodes = String(frame.nodes.length); canvas.dataset.summaries = String(frame.summaries.size); canvas.dataset.updateMs = ms.toFixed(2); canvas.dataset.sourceSha = this.index.sourceSha; canvas.dataset.selectedId = this.selectedId ?? ''; canvas.dataset.camera = JSON.stringify(this.camera);
  }
  private search(): void {
    if (!this.input) return;
    const query = $<HTMLInputElement>('explore-search').value;
    if (!query.trim()) { $('explore-results').innerHTML = '<p class="help">Search all supplied labels or an exact source ID. Duplicate names stay separate.</p>'; return; }
    const page = searchSource(this.input.source, query, this.input.corrections, { offset: this.offset, limit: 25 }); this.offset = page.offset;
    $('explore-results').innerHTML = `<p class="help">${page.total ? `${page.offset + 1}–${page.offset + page.results.length} of ${page.total}` : 'No'} matches in the full input</p>` + page.results.map(r => `<button class="search-result" data-explore-id="${esc(r.id)}">${esc(r.label)}<span>${esc(r.id)} · ${r.kind}</span></button>`).join('') + (page.total > 25 ? `<div class="button-row"><button class="button" data-explore-page="${Math.max(0, page.offset - 25)}" ${page.offset === 0 ? 'disabled' : ''}>Previous</button><button class="button" data-explore-page="${page.offset + 25}" ${page.offset + 25 >= page.total ? 'disabled' : ''}>Next</button></div>` : '');
  }
  private inspect(): void {
    const i = this.selectedId ? this.lookup.get(this.selectedId) : undefined;
    if (!this.index || i === undefined) { $('explore-inspector').innerHTML = '<h2>Inspect the complete source</h2><p>Click a junction or shaded group. Double-click to focus. Scroll to zoom; drag to pan.</p><p>Shaded groups have exact source-tip counts. Detail and labels appear as space permits. Search can reach every source identity.</p><p>Keyboard: arrows pan, + / − zoom, Home fits, Enter focuses selection.</p>'; return; }
    const node = this.input!.source.nodes[this.selectedId!], parent = this.index.parent[i], path = sourcePath(this.index, i);
    const sourceParent = node ? this.input!.source.order.find(id => this.input!.source.nodes[id].children.includes(node.id)) : undefined;
    $('explore-inspector').innerHTML = `<p class="eyebrow">SOURCE IDENTITY</p><h2>${esc(this.label(i))}</h2><code>${esc(this.selectedId!)}</code><p><strong>${this.index.count[i].toLocaleString()}</strong> source tips in this oriented group.</p><p>Selection stays attached to this identity at every zoom. Its original path is highlighted where visible.</p>${parent >= 0 ? `<button class="button" data-explore-id="${esc(this.index.ids[parent])}">Inspect parent junction</button>` : ''}<p>${path.length} junctions on the traversal path.</p>${node ? `<details open><summary>Original source fields</summary><p>Label (verbatim; internal meaning unspecified):</p><pre>${esc(node.rawLabel || '(unnamed)')}</pre><p>Serialized parent: <code>${esc(sourceParent ?? '(top of input)')}</code></p><p>Incoming source length token: <code>${esc(node.lengthToken ?? '(missing)')}</code></p><p>Source annotations (uninterpreted):</p><pre>${esc(JSON.stringify(node.annotations, null, 2))}</pre></details>` : '<p>Temporary junction on the declared traversal edge; not a new source taxon. The original edge and its annotations remain unchanged.</p>'}`;
  }
}
