import { ExploreController } from './explore/ui.ts';
import { prepareLocalImport, prepareBundledDataset } from './import.ts';
import type { PreparedImport } from './import.ts';
import { BUNDLED_DATASETS, bundledDataset, sourceHeading } from './datasets.ts';
import { searchSource } from './search.ts';
import type { Project, Source, Rooted, Reduction, Recipe, Layout, QA, Point, Presentation, Design, EndpointBorder, ReferenceImage, FitSettings, FitResult, BranchDirection } from './types.ts';
import { parseNewick } from './newick.ts';
import { HUG_SHA, defaultRecipe, orient, reduce, displayLabel } from './science.ts';
import { DEFAULT_PRESENTATION, generateLayout, reconcileLayout, pathData, edgeWidth, subtreeIds, moveNodes, transformSubtree, splitRoute, labelPosition, add, sub } from './geometry.ts';
import { History, validatePresentation, validateLayout } from './project.ts';
import { startAuthoring, serializeProject, documentFromWorking, treeRevision } from './project-v2.ts';
import { acceptCommand, acceptBasisEdit, userReference, isCurrentResult } from './commands.ts';
import { hasAuthoring, viewPrefix } from './provenance/operations.ts';
import type { CommandEvidence } from './provenance/operations.ts';
import { legacyRootState, semanticCapabilities } from './model/semantics.ts';
import { classificationSample, sampleTree } from './structured/example.ts';
import { StructuredController } from './structured/ui.ts';
import { effectiveViewId } from './structured/view.ts';
import { exportStructuredFiles } from './structured/export.ts';
import type { ScientificBasis } from './model/document.ts';
import { provenanceReport, addArtifactManifest } from './export-provenance.ts';
import { escapeXML as esc, exportFiles, zipFiles } from './export.ts';
import { DEFAULT_FIT_SETTINGS, validateFitSettings, validateBranchDirection, directionVector, directionAngle } from './fit-settings.ts';
import { routingDemo } from './demo.ts';
import { verifyBuildIdentity } from './provenance/identity.ts';
import type { BuildInfo, BuildManifest } from './provenance/identity.ts';
import { applyBorder, assignBorder, bindBorder, borderTargets, fitReference, MAX_IMAGE_BYTES, scopedEndpoints, simplifyStroke, validateDesign, validateImageData } from './design.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => $<HTMLInputElement>(id);
const on = (id: string, action: () => unknown) => $(id).addEventListener('click', () => guard(action));
const num = (id: string): number => Number(input(id).value);
let source: Source, rooted: Rooted, reduction: Reduction, project: Project;
let exportingBuild: BuildInfo;
let exportingBuildManifest: BuildManifest;
let qa: QA | null = null, selected = new Set<string>(), view: 'organic' | 'scientific' = 'organic';
let scientificLayout: Layout | null = null, showNodes = true, showIssues = true, spaceDown = false;
let scienceVersion = 0, editVersion = 0, ready = false, pendingReduction = false;
let desiredRecipe: Recipe | null = null;
let fitPreview: FitResult | null = null, pendingFit = false, compareOriginal = false, fitVersion = 0;
let requestSequence = 0;
const workers = new Map<string, { worker: Worker; reject: (error: Error) => void }>();
const history = new History<Project>();
let viewBox = { x: -9, y: -8, w: 108, h: 236 };
let toastTimeout: ReturnType<typeof setTimeout>, sliderTimeout: ReturnType<typeof setTimeout>;
let unsaved = false, importing = false;
let sourceSearchOffset=0,sourceSearchSha='';
const explorer = new ExploreController();
const teacher = new StructuredController({
  project:()=>{if(!hasAuthoring(project))throw new Error('Missing authoring state.');return project;},source:()=>source,rooted:()=>rooted,selected:()=>[...selected],
  commit:(proposal,evidence)=>{const before=structuredClone(project);project=proposal;accepted(before,evidence);invalidate();render();},
  render:()=>render(),fit:()=>fit(),focus:bounds=>{const pad=8,w=Math.max(15,bounds.maxX-bounds.minX),h=Math.max(15,bounds.maxY-bounds.minY);viewBox={x:(bounds.minX+bounds.maxX-w)/2-pad,y:(bounds.minY+bounds.maxY-h)/2-pad,w:w+2*pad,h:h+2*pad};setViewBox();$('zoom-label').textContent='Focused drawing';},calculate:payload=>workerTask('structured',payload),
  cancel:()=>{const task=workers.get('structured');if(task){task.worker.terminate();task.reject(new Error('superseded'));workers.delete('structured');}},
  toast:message=>toast(message),canWork:()=>ready&&!pendingReduction&&!pendingFit&&!fitPreview,
});


function toast(message: string, error = false): void {
  const box = $('toast'); box.textContent = message; box.classList.toggle('error', error); box.hidden = false;
  clearTimeout(toastTimeout); toastTimeout = setTimeout(() => { box.hidden = true; }, error ? 9000 : 5000);
}
async function guard(action: () => unknown): Promise<void> { try { await action(); } catch (error) { if (error instanceof Error && error.message === 'superseded') return; toast(error instanceof Error ? error.message : String(error), true); } }
function workingLayout(): Layout { return view === 'scientific' ? scientificLayout! : fitPreview && !compareOriginal ? fitPreview.layout : project.layout; }
function invalidate(): void { clearFit(); editVersion++; qa = null; unsaved = true; renderQA(); }
function accepted(before: Project, evidence: CommandEvidence = {}): void {
  if (!hasAuthoring(before) || !hasAuthoring(project)) throw new Error('Missing authoring state.');
  try { project = acceptCommand(before, project, source, evidence, exportingBuild); }
  catch (error) { project = before; rooted = orient(source, project.recipe.root); reduction = reduce(source, rooted, project.recipe, true); throw error; }
  history.push(before);
}
function currentRevision(): string { if (!hasAuthoring(project)) throw new Error('Missing document.'); return treeRevision(documentFromWorking(project)); }
function regenerationEvidence(target = rooted.rootId): CommandEvidence {
  const prefix = viewPrefix(project.authoring!.activeViewId);
  const inputs = ['source', 'scientific', `${prefix}appearance`, `${prefix}pins`, `${prefix}nodes/${target}`,
    ...Object.keys(project.layout.childOrder).map(id => `${prefix}order/${id}`),
    ...project.layout.pinnedNodes.map(id => `${prefix}nodes/${id}`),
    ...project.layout.pinnedEdges.flatMap(id => [`${prefix}routes/${id}`, `${prefix}nodes/${id}`, `${prefix}nodes/${rooted.nodes[id].parent}`])];
  return { kind: 'layout', methods: ['organic-initializer'], inputs, parameters: { target, pins: { nodes: project.layout.pinnedNodes, edges: project.layout.pinnedEdges }, presentation: project.presentation }, notes: 'Regenerated with the target anchor and pins retained; dependencies include those retained positions.' };
}
function mutate(action: () => void, affectsGeometry = true, evidence: CommandEvidence = {}): void {
  if (teacher.enabled) throw new Error('Use the Layout controls for constrained structured changes, or return to Organic for artistic editing.');
  if (fitPreview) throw new Error('Keep or discard the fit preview before editing.');
  clearFit(); commitOpacity();
  if (!semanticCapabilities(project.authoring!.root, 'artistic', project.authoring!.edgeMeasure, project.authoring!.basis).canEditGeometry) throw new Error('This relationship adapter is not implemented. Edit the basis metadata or inspect the saved artwork.');
  if (view === 'scientific') throw new Error('Switch to Organic to edit geometry. The scientific view is for inspection.');
  if (pendingReduction) throw new Error('Wait for the pending reduction to finish before editing.');
  const before = structuredClone(project);
  try { action(); accepted(before, evidence); } catch (error) { project = before; render(); throw error; }
  if (affectsGeometry) invalidate(); else unsaved = true;
  render();
}
function savedRecipe(): Recipe { return { ...project.recipe, resolvedFrontierSourceNodeIds: reduction.frontier.map(x => x.id) }; }
function syncRecipe(): void { project.recipe.resolvedFrontierSourceNodeIds = reduction.frontier.map(x => x.id); }
function workerTask<T>(kind: 'reduce' | 'validate' | 'fit' | 'structured', payload: Record<string, unknown>): Promise<T> {
  const old = workers.get(kind); if (old) { old.worker.terminate(); old.reject(new Error('superseded')); }
  const id = ++requestSequence, worker = new Worker(new URL('./worker.ts', import.meta.url).href.replace(/\.ts$/, '.js'), { type: 'module' });
  const baseRevision = currentRevision(), viewId = effectiveViewId(project as import('./model/document.ts').WorkingProject);
  return new Promise((resolve, reject) => {
    workers.set(kind, { worker, reject });
    const end = () => { worker.terminate(); if (workers.get(kind)?.worker === worker) workers.delete(kind); };
    worker.onmessage = event => { if (event.data.id !== id) return; end(); if (event.data.baseRevision !== baseRevision || event.data.viewId !== viewId || !hasAuthoring(project) || !isCurrentResult(project, baseRevision, viewId)) reject(new Error('superseded')); else if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.value as T); };
    worker.onerror = event => { end(); reject(new Error(event.message || 'The calculation worker failed.')); };
    worker.postMessage({ id, baseRevision, viewId, kind, ...payload });
  });
}
async function applyRecipe(next: Recipe, message?: string): Promise<void> {
  if (explorer.active) explorer.close();
  endDrag(true); commitOpacity(); clearFit();
  const version = ++scienceVersion; desiredRecipe = next; pendingReduction = true; updateButtons();
  const before = structuredClone(project); delete next.resolvedFrontierSourceNodeIds;
  try {
    const result = await workerTask<Reduction>('reduce', { sourceText: source.text, recipe: next });
    if (version !== scienceVersion) return;
    project.recipe = next; rooted = orient(source, next.root); reduction = result;
    project.layout = reconcileLayout(rooted, reduction, project.presentation, project.layout); syncRecipe();
    accepted(before, { kind: 'scientific', methods: ['maximal-frontier', 'organic-initializer'], parameters: { recipe: project.recipe }, notes: 'Accepted reduction; existing and hidden geometry retained by reconciliation.' });
    scientificLayout = generateLayout(rooted, reduction, project.presentation, 'scientific'); invalidate();
    if (message) toast(message);
  } finally { if (version === scienceVersion) { pendingReduction = false; desiredRecipe = null; render(); } }
}
function currentId(): string {
  const id = [...selected].at(-1); if (!id) throw new Error('Select a source clade or an edge first.'); return id;
}
function changeRule(kind: 'collapse' | 'expand' | 'protect' | 'clear'): void {
  const id = currentId(), recipe = structuredClone(desiredRecipe ?? project.recipe);
  if (kind === 'clear') { for (const key of ['collapse', 'expand', 'protect'] as const) recipe[key] = recipe[key].filter(x => x !== id); recipe.thresholdOverrides = recipe.thresholdOverrides.filter(x => x.sourceNodeId !== id); }
  else { recipe[kind] = [...new Set([...recipe[kind], id])]; if (kind === 'expand') recipe.collapse = recipe.collapse.filter(x => x !== id); if (kind === 'collapse') recipe.expand = recipe.expand.filter(x => x !== id); }
  void guard(() => applyRecipe(recipe));
}
function select(id: string, extend = false): void {
  if (!rooted.nodes[id]) return;
  if (!extend) selected.clear();
  if (extend && selected.has(id)) selected.delete(id); else selected.add(id);
  renderCanvas(); renderInspector(); renderDesignControls(); renderFitControls();
}
function fit(): void {
  const p = teacher.enabled ? teacher.dimensions : project.presentation; viewBox = { x: -p.widthMm * .12, y: -p.heightMm * .045, w: p.widthMm * 1.24, h: p.heightMm * 1.09 };
  setViewBox(); $('zoom-label').textContent = 'Fit to view';
}
function setViewBox(): void { $('canvas').setAttribute('viewBox', `${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`); }
function focusSelection(): void {
  const id = currentId(), point = workingLayout().nodes[id]; if (!point) { toast('This node is hidden. Use Reveal to expose its source path.'); return; }
  viewBox.x = point.x - viewBox.w / 2; viewBox.y = point.y - viewBox.h / 2; setViewBox();
}
function updateButtons(): void {
  $('legacy-inspection-note').hidden = project.layout.mode !== 'scientific';
  ($('undo-btn') as HTMLButtonElement).disabled = (!history.past.length && !fitPreview && !pendingFit) || pendingReduction;
  ($('redo-btn') as HTMLButtonElement).disabled = !history.future.length || pendingReduction || pendingFit || !!fitPreview;
  for (const id of ['export-btn', 'save-btn', 'validate-btn']) ($<HTMLButtonElement>(id)).disabled = !ready || pendingReduction || pendingFit || !!fitPreview;
  $<HTMLFieldSetElement>('shape-fields').disabled = pendingReduction || view === 'scientific' || pendingFit || !!fitPreview;
  for (const id of ['artwork-style', 'fit-artwork-style']) $<HTMLFieldSetElement>(id).disabled = view !== 'organic' || pendingReduction || pendingFit || !!fitPreview;
  $('structured-view').classList.toggle('active',teacher.enabled);$('structured-view').textContent=teacher.view?.intent==='artistic'?'Artistic copy':teacher.view?.intent==='phylogram'?'Phylogram':teacher.view?.intent==='taxonomy'?'Classification':teacher.view?.intent==='unrooted'?'Unrooted':teacher.view?.intent==='cladogram'?'Cladogram':'Layouts';
  if(teacher.enabled){$('organic-view').classList.remove('active');$('scientific-view').classList.remove('active');}
  $('import-btn').toggleAttribute('disabled',!ready||importing||pendingReduction||pendingFit||!!fitPreview||teacher.pending);$('import-btn').textContent=importing?'Checking file…':'Open file';
  $('datasets-btn').toggleAttribute('disabled',!ready||importing||pendingReduction||pendingFit||!!fitPreview||teacher.pending);
  $('open-dataset').toggleAttribute('disabled',importing);
  $('save-btn').toggleAttribute('disabled',!ready||pendingReduction||pendingFit||!!fitPreview||teacher.pending);
  $('export-btn').title=!teacher.enabled&&view==='scientific'?'Return to Organic or an accepted Layout view to export a design.':'';
  if(teacher.enabled)$('export-btn').toggleAttribute('disabled',!teacher.exportable);else if(view==='scientific')$('export-btn').setAttribute('disabled','');
  $('canvas-context').textContent = teacher.enabled ? teacher.busy?'Building structured view…':teacher.preview?teacher.dragging?'Moving artistic geometry':'Structured preview · original retained':teacher.view?.intent==='artistic'?'Artistic copy · source connectivity retained':teacher.view?.intent==='taxonomy'?'Classification · supplied parent links':teacher.view?.intent==='unrooted'?'Unrooted · display origin only':teacher.view?.intent==='phylogram'?'Phylogram · source distances':'Nonmetric structured cladogram' : pendingFit ? 'Fitting junctions…' : fitPreview ? compareOriginal ? 'Comparing original arrangement' : 'Preview · artwork unchanged' : pendingReduction ? 'Recalculating reduction…' : view === 'scientific' ? 'Topology inspection · normalized depth' : 'Editable arrangement';
}
function render(): void {
  if (!ready) return;
  $('endpoint-count').textContent = reduction.frontier.length.toLocaleString(); $('tip-count').textContent = source.tips.length.toLocaleString();
  if(teacher.enabled&&teacher.view)$('endpoint-count').textContent=String(teacher.view.graph.endpoints.length);
  $('coverage-text').textContent = teacher.enabled&&teacher.view ? `${teacher.view.graph.representedTips.length} represented · ${teacher.view.graph.omittedTips.length} omitted source tips` : `All ${source.tips.length.toLocaleString()} source tips accounted for`;
  renderSourceSearch();
  $('project-title').textContent = project.title;
  $('basis-info-btn').textContent = `Scientific basis: ${project.authoring!.basis.name} · Edit`;
  $('canvas').setAttribute('aria-label', `${project.authoring!.basis.name} — ${project.authoring!.basis.relationshipKind}`);
  const heading=sourceHeading(source.sha256,project.provenance,project.authoring?.basis.name);
  $('source-name').textContent=heading.title;
  $('source-subtitle').textContent=heading.subtitle;
  $('threshold-unit').textContent=project.authoring?.edgeMeasure?.unit??'raw source units (unverified)';
  $('reset-example').toggleAttribute('disabled',source.sha256!==HUG_SHA);
  input('global-threshold').max = String(Math.max(1.5, project.recipe.globalThreshold)); input('global-threshold').value = String(project.recipe.globalThreshold); input('global-value').value = String(project.recipe.globalThreshold);
  input('global-threshold').disabled = !source.distanceUsable; input('global-value').disabled = !source.distanceUsable;
  $('override-count').textContent = String(project.recipe.thresholdOverrides.length);
  $('override-list').innerHTML = project.recipe.thresholdOverrides.map(x => {
    const name = source.sha256 === HUG_SHA ? ({ n000001: 'Bacteria', n000000: 'Nonbacterial side', n005375: 'Eukaryota' } as Record<string, string>)[x.sourceNodeId] : '';
    return `<div class="override-card"><div class="card-top"><span class="dot"></span><button class="card-label" data-select="${x.sourceNodeId}">${esc(name || x.sourceNodeId)}</button><button class="icon-button" data-remove-override="${x.sourceNodeId}" aria-label="Remove override for ${esc(name || x.sourceNodeId)}">×</button></div><div class="source-id">${x.sourceNodeId} · ${rooted.nodes[x.sourceNodeId].count.toLocaleString()} source tips</div><div class="slider-row"><input type="range" min="0" max="1.5" step=".01" value="${x.threshold}" data-override="${x.sourceNodeId}" aria-label="${esc(name || x.sourceNodeId)} threshold"><input class="number-input" type="number" min="0" step=".01" value="${x.threshold}" data-override="${x.sourceNodeId}" aria-label="${esc(name || x.sourceNodeId)} exact threshold"></div></div>`;
  }).join('') || '<p class="help">No overrides. Select a clade to give it its own threshold.</p>';
  const p = project.presentation;
  for (const [id, key] of Object.entries({ 'page-width': 'widthMm', 'page-height': 'heightMm', stroke: 'strokeMm', 'fit-stroke': 'strokeMm', taper: 'taper', 'fit-taper': 'taper', clearance: 'clearanceMm', tolerance: 'toleranceMm', 'junction-radius': 'junctionMm', 'length-scale': 'sourceUnitMm' })) input(id).value = String(p[key as keyof Presentation]);
  input('show-labels').checked = p.labels;
  input('stroke-slider').max = String(Math.max(2, p.strokeMm)); input('stroke-slider').value = String(p.strokeMm);
  for (const id of ['allow-curves', 'fit-allow-curves']) input(id).checked = project.layout.lineStyle !== 'straight';
  const widths = reduction.visible.filter(id => rooted.nodes[id].parent).map(id => edgeWidth(rooted, id, p));
  $('line-style-status').textContent = `${project.layout.lineStyle === 'straight' ? 'Straight segments' : 'Curved lines'} · ${widths.length ? `${Math.min(...widths).toFixed(2)}–${Math.max(...widths).toFixed(2)}` : p.strokeMm.toFixed(2)} mm visible strokes`;
  const page=teacher.enabled?teacher.dimensions:p;$('page-size').textContent = `${page.widthMm} × ${page.heightMm} mm`;
  teacher.render();
  renderNotes(); renderCanvas(); renderInspector(); renderQA(); renderDesignControls(); renderFitControls(); updateButtons();
}
function renderNotes(): void {
  const notes = [
    { title: `Scientific basis · ${project.authoring!.basis.relationshipKind}`, body: semanticCapabilities(project.authoring!.root, 'artistic', project.authoring!.edgeMeasure, project.authoring!.basis).reasons.join(' ') || 'Phylogenetic interpretation uses the stated evidence and entity type; root assumptions are recorded separately.' },
    { title: project.authoring!.root.status==='rooted' ? project.authoring!.root.basis==='source-declared' ? 'Rooting supplied by source authors' : 'Rooting is a declared assumption' : 'Biological root not established', body: project.authoring!.root.explanation + (project.recipe.root.kind === 'edge' ? ` Root on ${project.recipe.root.sourceEdge.join(' — ')}; fraction ${project.recipe.root.fraction} is a length-split convention.` : '') + ' Moving the drawn origin does not reroot the tree.' },
    ...(source.sha256 === HUG_SHA ? [{ title: '2 label conflicts · 1 placement review', body: 'Tribolium and Serpula display-taxonomy corrections are recorded separately. Blastocystis placement remains under review. Original labels and connections are retained.' }, { title: 'Historical collapse count unresolved', body: 'The documented 0.65 rule gives 224 endpoints, not the paper’s reported groups. This editor does not claim exact Figure 2 reproduction.' }] : []),
    ...source.warnings.map(s => ({ title: s.split('.')[0], body: s })),
  ];
  $('warning-count').textContent = String(notes.length);
  $('source-notes').innerHTML = notes.map(x => `<details><summary>${esc(x.title)}</summary><p>${esc(x.body)}</p></details>`).join('');
}
function renderCanvas(): void {
  if (!ready) return;
  if(teacher.enabled){const size=teacher.dimensions;$('canvas').innerHTML=`<rect x="0" y="0" width="${size.widthMm}" height="${size.heightMm}" fill="#fffefa" stroke="#d7dfd2" stroke-width=".2"/>${teacher.canvas()}`;$('canvas').classList.add('structured-mode');setViewBox();return;}
  $('canvas').classList.remove('structured-mode');
  const svg = $('canvas'), layout = workingLayout(), p = project.presentation;
  const selectedEdges = new Set([...selected].flatMap(id => subtreeIds(rooted, id)));
  const paths: string[] = [], hits: string[] = [];
  for (const id of reduction.visible) {
    if (!rooted.nodes[id].parent) continue;
    const d = pathData(rooted, layout, id), width = edgeWidth(rooted, id, p), active = selectedEdges.has(id);
    paths.push(`<path d="${d}" fill="none" stroke="${active ? '#608358' : '#26372c'}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`);
    hits.push(`<path class="tree-hit" d="${d}" data-edge="${id}" stroke-width="${Math.max(1.7, width + 1)}"><title>${id} · original edge ${rooted.nodes[id].sourceEdgeId}</title></path>`);
  }
  const nodes = reduction.visible.map(id => {
    const pos = layout.nodes[id], isSelected = selected.has(id), pin = layout.pinnedNodes.includes(id);
    return `<circle class="node-hit" data-node="${id}" cx="${pos.x}" cy="${pos.y}" r="${isSelected ? 1.15 : id === rooted.rootId ? .85 : .55}" fill="${isSelected ? '#5d8056' : pin ? '#c09255' : '#fff'}" stroke="${isSelected ? '#fff' : '#709266'}" stroke-width=".18" opacity="${showNodes || isSelected ? 1 : 0}"><title>${id}${pin ? ' · pinned' : ''} · ${rooted.nodes[id].count} tips</title></circle>`;
  }).join('');
  const labels = p.labels ? reduction.frontier.map((e, i) => { const pos = labelPosition(layout, p, e.id); return `<text class="tree-label" data-label="${e.id}" x="${pos.x}" y="${pos.y}" font-size="2" font-family="Arial,sans-serif" fill="#758369">${i + 1}</text>`; }).join('') : '';
  const displayQA = displayedQA();
  const issueMarks = displayQA && showIssues && view === 'organic' ? displayQA.issues.slice(0, 500).filter(x => x.point).map(x => `<circle cx="${x.point!.x}" cy="${x.point!.y}" r="1.2" fill="none" stroke="${x.type === 'crossing' || x.type === 'self-intersection' ? '#bd6654' : '#c99e61'}" stroke-width=".22" pointer-events="none"/>`).join('') : '';
  let handles = '';
  if (selected.size === 1 && view === 'organic') {
    const id = currentId(), route = layout.routes[id], parent = rooted.nodes[id].parent;
    if (route && parent && reduction.visible.includes(id)) {
      route.segments.forEach((s, i) => {
        const start = i ? route.segments[i - 1].end : layout.nodes[parent], end = i === route.segments.length - 1 ? layout.nodes[id] : s.end;
        if (layout.lineStyle !== 'straight') handles += `<path d="M${start.x},${start.y}L${s.c1.x},${s.c1.y}M${end.x},${end.y}L${s.c2.x},${s.c2.y}" fill="none" stroke="#a3b79b" stroke-width=".17" stroke-dasharray=".6 .5" pointer-events="none"/>`;
        if (layout.lineStyle !== 'straight') for (const key of ['c1', 'c2'] as const) handles += `<circle class="handle" data-handle="${id}:${i}:${key}" cx="${s[key].x}" cy="${s[key].y}" r=".78" fill="#fff" stroke="#608958" stroke-width=".25"/>`;
        if (i < route.segments.length - 1) handles += `<rect class="waypoint" data-waypoint="${id}:${i}" x="${end.x - .65}" y="${end.y - .65}" width="1.3" height="1.3" fill="#e6efe1" stroke="#66855a" stroke-width=".22"/>`;
      });
    }
  }
  svg.innerHTML = `<defs><filter id="paper-shadow" x="-20%" y="-10%" width="140%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1.8" flood-color="#35432a" flood-opacity=".07"/></filter></defs><rect x="0" y="0" width="${p.widthMm}" height="${p.heightMm}" fill="#fffefa" stroke="#e1e6d9" stroke-width=".18" filter="url(#paper-shadow)"/>${project.design?.referenceImage?.layer !== 'above' ? referenceMarkup() : ''}<g id="preview-artwork">${paths.join('')}</g>${project.design?.referenceImage?.layer === 'above' ? referenceMarkup() : ''}<g>${hits.join('')}</g><g>${nodes}</g><g>${labels}</g><g>${handles}</g><g>${issueMarks}</g>${designMarkup()}${directionMarkup()}${fitPreviewMarkup()}<g id="selection-overlay"></g>`;
  svg.classList.toggle('fit-preview-active', !!fitPreview); svg.classList.toggle('scientific-readonly', view === 'scientific'); setViewBox();
}
function renderInspector(): void {
  if(teacher.enabled){$('selection-count').textContent=String(teacher.selected.size);$('inspector-content').innerHTML=teacher.inspector();return;}
  $('selection-count').textContent = String(selected.size);
  const host = $('inspector-content');
  if (!selected.size) { host.innerHTML = '<div class="empty-state"><span class="empty-icon">⌁</span><h2>Every line has a lineage.</h2><p>Select a branch or junction to inspect its source, adjust its detail, or shape its curve.</p></div>'; return; }
  const id = currentId(), node = rooted.nodes[id], pos = workingLayout().nodes[id], visible = reduction.visible.includes(id);
  const entry = reduction.frontier.find(x => x.id === id), correction = project.corrections.find(x => x.source_node_id === id);
  const label = displayLabel(source, id, project.corrections), isRoot = id === rooted.rootId;
  host.innerHTML = `<div class="selection-type">${selected.size > 1 ? `${selected.size} SELECTED JUNCTIONS` : isRoot ? 'DRAWING ORIGIN' : entry ? entry.members.length === 1 ? 'SOURCE TIP' : 'COLLAPSED CLADE' : 'SCIENTIFIC JUNCTION'}</div><div class="selection-title"><h2>${isRoot ? 'Declared root' : `Clade ${id.slice(1)}`}</h2><button id="focus-selection" class="icon-button" aria-label="Center selection">⊙</button></div><div class="selection-id">${id}${visible ? '' : ' · hidden by reduction'}</div><p class="selection-label">${esc(label)}</p>${correction ? `<p class="help note">${esc(correction.status)}. ${correction.evidence_url ? `<a href="${esc(correction.evidence_url)}" target="_blank" rel="noopener">Evidence ↗</a>` : 'Placement requires review.'} Original label retained.</p>` : ''}<div class="metric-list"><span>Original descendant tips</span><strong>${node.count.toLocaleString()}</strong><span>Mean distance</span><strong>${Number.isFinite(node.mean) ? node.mean.toFixed(6) : 'Unavailable'}</strong><span>Source edge length</span><strong>${node.length === null ? '—' : Number.isFinite(node.length) ? node.length.toFixed(6) : 'Invalid'}</strong><span>Original split</span><strong>${node.sourceEdgeId ?? 'Virtual root'}</strong><span>Source annotations</span><strong>${node.annotations.map(x => esc(x.text)).join(', ') || '—'}</strong></div><div class="button-row">${node.parent ? '<button id="select-parent" class="button">↑ Parent</button>' : ''}<button id="reveal-node" class="button">${visible ? 'Expand' : 'Reveal'}</button></div><h2>Clade reduction</h2><div class="button-row"><button id="collapse-node" class="button" ${isRoot ? 'disabled' : ''}>Collapse</button><button id="protect-node" class="button">Protect</button><button id="clear-rule" class="button">Clear rules</button></div><div class="slider-row"><input id="selected-threshold" class="full-input" type="number" min="0" step=".01" value="${project.recipe.thresholdOverrides.find(x => x.sourceNodeId === id)?.threshold ?? project.recipe.globalThreshold}" aria-label="Selected clade threshold"><button id="set-threshold" class="button">Set override</button></div><p class="help note">${project.recipe.collapse.includes(id) ? 'Explicit collapse. ' : ''}${project.recipe.expand.includes(id) ? 'Explicit expansion. ' : ''}${project.recipe.protect.includes(id) ? 'Protected from collapse. ' : ''}Rules affect original descendants.</p><div class="small-divider"></div>${pos && visible ? `<h2>Junction position</h2><div class="field-grid"><label>X, mm<input id="node-x" type="number" step=".1" value="${pos.x.toFixed(3)}"></label><label>Y, mm<input id="node-y" type="number" step=".1" value="${pos.y.toFixed(3)}"></label></div><div class="button-row"><button id="move-node" class="button">Move selection</button><button id="pin-node" class="button">${project.layout.pinnedNodes.includes(id) ? 'Unpin' : 'Pin'} junction</button></div><p class="pin-indicator">${project.layout.pinnedNodes.includes(id) ? '● Junction is pinned' : ''}${project.layout.pinnedEdges.includes(id) ? ' ● Edge is pinned' : ''}</p><h2>Route & subtree</h2><div class="button-row"><button id="add-waypoint" class="button" ${isRoot ? 'disabled' : ''}>Add waypoint</button><button id="simplify-edge" class="button" ${isRoot ? 'disabled' : ''}>Simplify route</button></div><div class="button-row"><button id="pin-edge" class="button" ${isRoot ? 'disabled' : ''}>${project.layout.pinnedEdges.includes(id) ? 'Unpin' : 'Pin'} edge</button><button id="pin-subtree" class="button">${subtreeIds(rooted, id).every(x => project.layout.pinnedNodes.includes(x)) ? 'Unpin' : 'Pin'} subtree</button></div><div class="field-grid"><label>Rotate, degrees<input id="rotation" type="number" value="15" step="5"></label><label>Length multiplier<input id="subtree-scale" type="number" value="1.1" step=".1" min=".1"></label></div><div class="button-row"><button id="rotate-subtree" class="button">Rotate subtree</button><button id="scale-subtree" class="button">Scale subtree</button></div><div class="button-row"><button id="reverse-children" class="button">Reverse child order</button><button id="regenerate-subtree" class="button">Regenerate clade</button></div><p class="help">${project.layout.lineStyle === 'straight' ? 'Drag a junction or a square waypoint. Enable curves in Arrange to edit curve handles.' : 'Drag a junction, a round Bézier handle, or a square waypoint.'} Pinned edges also lock their incident junctions.</p>${project.presentation.labels && entry ? '<h2>Number placement</h2><p class="help">Drag this endpoint’s number to reposition its annotation without moving the branch.</p>' : ''}` : '<p class="help">Reveal this clade to edit its geometry.</p>'}`;
  on('focus-selection', focusSelection); if (node.parent) on('select-parent', () => select(node.parent!));
  on('reveal-node', () => changeRule('expand')); on('collapse-node', () => changeRule('collapse')); on('protect-node', () => changeRule('protect')); on('clear-rule', () => changeRule('clear'));
  on('set-threshold', () => { const next = structuredClone(desiredRecipe ?? project.recipe); next.thresholdOverrides = next.thresholdOverrides.filter(x => x.sourceNodeId !== id); next.thresholdOverrides.push({ sourceNodeId: id, threshold: num('selected-threshold') }); return applyRecipe(next); });
  if (!pos || !visible) return;
  on('move-node', () => mutate(() => { const x = num('node-x'), y = num('node-y'); if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Enter finite coordinates.'); moveNodes(project.layout, rooted, [...selected], sub({ x, y }, project.layout.nodes[id])); }));
  on('pin-node', () => mutate(() => { const pin = !project.layout.pinnedNodes.includes(id); project.layout.pinnedNodes = pin ? [...new Set([...project.layout.pinnedNodes, ...selected])] : project.layout.pinnedNodes.filter(x => !selected.has(x)); }));
  on('pin-edge', () => mutate(() => { project.layout.pinnedEdges = project.layout.pinnedEdges.includes(id) ? project.layout.pinnedEdges.filter(x => x !== id) : [...project.layout.pinnedEdges, id]; }));
  on('pin-subtree', () => mutate(() => { const ids = subtreeIds(rooted, id), allPinned = ids.every(x => project.layout.pinnedNodes.includes(x)); project.layout.pinnedNodes = allPinned ? project.layout.pinnedNodes.filter(x => !ids.includes(x)) : [...new Set([...project.layout.pinnedNodes, ...ids])]; project.layout.pinnedEdges = allPinned ? project.layout.pinnedEdges.filter(x => !ids.includes(x)) : [...new Set([...project.layout.pinnedEdges, ...ids.filter(x => rooted.nodes[x].parent)])]; }));
  on('add-waypoint', () => mutate(() => splitRoute(project.layout, rooted, id)));
  on('simplify-edge', () => mutate(() => { if (project.layout.pinnedEdges.includes(id)) throw new Error('Unpin the edge before editing.'); const route = project.layout.routes[id]; route.segments = [{ c1: route.segments[0].c1, c2: route.segments.at(-1)!.c2, end: { ...project.layout.nodes[id] } }]; }));
  on('rotate-subtree', () => mutate(() => transformSubtree(project.layout, rooted, id, num('rotation'), 1)));
  on('scale-subtree', () => mutate(() => transformSubtree(project.layout, rooted, id, 0, num('subtree-scale'))));
  on('reverse-children', () => mutate(() => { project.layout.childOrder[id] = [...(project.layout.childOrder[id] ?? rooted.nodes[id].children)].reverse(); regenerate(id); }, true, { ...regenerationEvidence(id), notes: 'Reversed the complete child order and regenerated the selected subtree with anchors retained.' }));
  on('regenerate-subtree', () => mutate(() => regenerate(id), true, regenerationEvidence(id)));
}

function regenerate(target = rooted.rootId): void {
  const old = project.layout, fresh = generateLayout(rooted, reduction, project.presentation, 'organic', old);
  const ids = new Set(subtreeIds(rooted, target)), shift = sub(old.nodes[target], fresh.nodes[target]);
  const locked = new Set(old.pinnedNodes);
  for (const id of old.pinnedEdges) { locked.add(id); if (rooted.nodes[id].parent) locked.add(rooted.nodes[id].parent!); }
  locked.add(target);
  for (const id of reduction.visible) if (ids.has(id) && !locked.has(id)) old.nodes[id] = add(fresh.nodes[id], shift);
  for (const id of reduction.visible) {
    const parent = rooted.nodes[id].parent; if (!parent || !ids.has(id) || id === target || old.pinnedEdges.includes(id)) continue;
    const route = structuredClone(fresh.routes[id]);
    route.segments[0].c1 = add(route.segments[0].c1, sub(old.nodes[parent], fresh.nodes[parent]));
    route.segments.at(-1)!.c2 = add(route.segments.at(-1)!.c2, sub(old.nodes[id], fresh.nodes[id])); route.segments.at(-1)!.end = { ...old.nodes[id] };
    old.routes[id] = route;
  }
}
function displayedQA(): QA | null { return fitPreview ? compareOriginal ? fitPreview.beforeQA : fitPreview.afterQA : qa; }
function renderQA(): void {
  if (!ready) return;
  if(teacher.enabled){const v=teacher.view;$('draft-status').textContent=teacher.dragging?'MOVING · geometry unchecked':v?`${teacher.dragging?'MOVING · checks pending':teacher.preview?'PREVIEW · ':''}${teacher.dragging?'':v.qa.status.toUpperCase()} · ${v.qa.crossingPassed?'No detected contacts':'Refinement needed'}`:'No structured view';$('qa-summary').innerHTML=v?teacher.summary(v):'<p>Preview a structured view.</p>';$('issue-list').innerHTML='';return;}
  const qa = displayedQA();
  $('draft-status').textContent = qa ? `${fitPreview ? compareOriginal ? 'ORIGINAL · ' : 'PREVIEW · ' : ''}${qa.status.toUpperCase()} · ${qa.crossingPassed ? 'No detected contacts' : 'Refinement needed'}` : 'DRAFT · Geometry unchecked';
  if (!qa) { $('qa-summary').innerHTML = '<p>No current geometry check. Changes invalidate earlier results.</p>'; $('issue-list').innerHTML = ''; return; }
  const row = (label: string, pass: boolean, text = pass ? 'Pass' : 'Review') => `<div class="result-row"><span>${label}</span><strong class="${pass ? 'pass' : 'fail'}">${text}</strong></div>`;
  $('qa-summary').innerHTML = row('Source coverage', qa.coveragePassed) + row('Shared junctions', qa.incidencePassed) + row('Stroke contacts', qa.crossingPassed) + row('Clearance', qa.clearancePassed) + row('Numbered annotations', !qa.annotationCollisions, String(qa.annotationCollisions) + ' flagged') + `<p>${qa.checkedEdgePairs.toLocaleString()} candidate pairs · ${qa.toleranceMm} mm tolerance.<br>Artist review: not performed.</p>`;
  $('issue-list').innerHTML = qa.issues.slice(0, 120).map((issue, i) => `<button class="issue-item" data-issue="${i}"><strong>${esc(issue.type)}</strong> · ${issue.edges.join(' / ')}<br>${esc(issue.detail)}</button>`).join('') + (qa.issues.length > 120 ? '<p>Showing the first 120 issues. The export report includes all recorded issues.</p>' : '');
}
async function runValidation(): Promise<QA | null> {
  if (pendingReduction) throw new Error('Wait for the reduction to finish.');
  const version = editVersion; $('qa-summary').textContent = 'Checking stroke envelopes and clearances…';
  const result = await workerTask<QA>('validate', { sourceText: source.text, recipe: savedRecipe(), layout: workingLayout(), presentation: project.presentation });
  if (version !== editVersion) { toast('Artwork changed during validation. Run the check again.'); return null; }
  qa = result; renderQA(); renderCanvas(); return result;
}
function download(name: string, data: string | Uint8Array, type: string): void {
  const content = typeof data === 'string' ? data : new Uint8Array(data).buffer;
  const url = URL.createObjectURL(new Blob([content], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function snapshot(): Project { commitOpacity(); validateDesign(project.design, rooted); return { ...structuredClone(project), recipe: savedRecipe(), selection: [...selected] }; }
async function exportPackage(): Promise<void> {
  if(!teacher.enabled&&view==='scientific')throw new Error('Scientific is a normalized inspection. Return to Organic or an accepted Layout view to export that design.');
  if(teacher.enabled){if(!teacher.exportable)throw new Error('Accept a current structured layout before exporting.');const state=snapshot();if(!hasAuthoring(state))throw new Error('Missing document.');const files=exportStructuredFiles(source,state,exportingBuild);files['build-manifest.json']=JSON.stringify(exportingBuildManifest,null,2);addArtifactManifest(files,state);download(`clade-studio-${teacher.view!.intent}-${teacher.view!.qa.status}.zip`,zipFiles(files),'application/zip');toast('Structured package exported with source paths, represented/omitted memberships, exact scene and Sources & Methods.');return;}
  toast('Checking the artwork and assembling the export package…');
  const result = qa ?? await runValidation(); if (!result) return;
  const state = snapshot(), files = exportFiles(source, rooted, reduction, state, result, exportingBuild);
  files['build-manifest.json'] = JSON.stringify(exportingBuildManifest, null, 2);
  if (hasAuthoring(state)) addArtifactManifest(files, state);
  download(`clade-studio-${result.status}-${reduction.frontier.length}.zip`, zipFiles(files), 'application/zip');
  toast(`${result.status === 'checked' ? 'Checked' : 'Draft'} package exported: paired SVGs, source, recipe, mappings, legend, project, and QA report.`);
}
async function importFile(file: File): Promise<void> {
  if(importing)throw new Error('Another file is still being checked.');
  const checkIdle=()=>{if(!ready||pendingReduction||pendingFit||fitPreview||teacher.pending)throw new Error('Finish or discard the current calculation/preview before opening another file.');};
  checkIdle();const baseRevision=currentRevision(),baseViewId=effectiveViewId(project as import('./model/document.ts').WorkingProject);importing=true;updateButtons();
  try {
    if(file.size>50_000_000)throw new Error('File exceeds the 50 MB limit.');
    const bytes=await file.arrayBuffer(),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
    const prepared=await prepareLocalImport(text,file.name,exportingBuild,{source,recipe:project.recipe});
    checkIdle();if(!hasAuthoring(project)||!isCurrentResult(project,baseRevision,baseViewId))throw new Error('The current project changed while the file was being checked. Open the file again when ready.');
    if(prepared.kind==='recipe'){await applyRecipe(prepared.recipe,'Reduction recipe replayed successfully.');return;}
    installPrepared(prepared);
    toast(prepared.kind==='newick'?'Newick imported. Search this file in Reduce or Layout; describe its relationships through Scientific basis.':prepared.migrated?'Legacy project migrated without changing geometry. Save writes version 4 with preserved artwork and history.':'Version-4 project restored with verified geometry and provenance.');
  } finally {importing=false;updateButtons();}
}
function installPrepared(prepared:Exclude<PreparedImport,{kind:'recipe'}>):void {
    if (explorer.active) explorer.close();
    endDrag(true);commitOpacity();
    if(unsaved){const state=snapshot();if(!hasAuthoring(state))throw new Error('Missing document.');download('before-import.treeproject.json',serializeProject(state,exportingBuild),'application/json');}
    clearTimeout(sliderTimeout);teacher.discard();clearFit();for(const task of workers.values()){task.worker.terminate();task.reject(new Error('superseded'));}workers.clear();
    scienceVersion++;editVersion++;source=prepared.source;rooted=prepared.rooted;reduction=prepared.reduction;project=prepared.project;scientificLayout=prepared.scientificLayout;
    history.clear();selected=new Set(project.selection??[]);qa=null;pendingReduction=false;desiredRecipe=null;unsaved=prepared.kind==='newick';view='organic';teacher.sync();
    if(teacher.enabled)activateTeacherPanel();else setView('organic');render();fit();
}
function setView(next: 'organic' | 'scientific'): void {
  if(next!==view){qa=null;editVersion++;}
  teacher.close();
  endDrag(true); commitOpacity(); clearFit(); designTool = 'edit'; drawingPoints = [];
  view = next; $('organic-view').classList.toggle('active', view === 'organic'); $('scientific-view').classList.toggle('active', view === 'scientific');
  if (next === 'scientific') scientificLayout = generateLayout(rooted, reduction, project.presentation, 'scientific');
  render();
}
function restoreHistory(direction: 'undo' | 'redo'): void {
  if(teacher.pending){teacher.discard();render();return;}
  if (pendingFit || fitPreview) { clearFit(); render(); return; }
  endDrag(true); commitOpacity(); designTool = 'edit';
  if (pendingReduction) return;
  const restored = history[direction](project); if (!restored) return;
  project = restored; rooted = orient(source, project.recipe.root); reduction = reduce(source, rooted, project.recipe, true);
  scienceVersion++; scientificLayout = generateLayout(rooted, reduction, project.presentation, 'scientific'); teacher.sync(); if(teacher.enabled)activateTeacherPanel(); invalidate(); render();fit();
}

// Event delegation keeps controls stable across science and selection updates.
document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(tab => tab.addEventListener('click', () => {
  if(tab.dataset.panel==='structured'){endDrag(true);clearFit();teacher.open();}else if(teacher.enabled)setView('organic');
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => { const active = button === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); $(`panel-${button.dataset.panel}`).hidden = !active; });
}));
function activateTeacherPanel():void{document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button=>{const active=button.dataset.panel==='structured';button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));$(`panel-${button.dataset.panel}`).hidden=!active;});}
on('teacher-example',async()=>{
  if(pendingReduction||pendingFit||fitPreview||teacher.pending)throw new Error('Finish or discard the pending proposal before opening another project.');
  if(unsaved){const state=snapshot();if(!hasAuthoring(state))throw new Error('Missing document.');download('before-sample-tree.treeproject.json',serializeProject(state,exportingBuild),'application/json');}
  const example=await sampleTree(exportingBuild);source=example.source;rooted=example.rooted;reduction=example.reduction;project=example.project;history.clear();selected.clear();qa=null;scienceVersion++;editVersion++;unsaved=false;desiredRecipe=null;
  scientificLayout=generateLayout(rooted,reduction,project.presentation,'scientific');teacher.sync();teacher.open();activateTeacherPanel();render();fit();toast('New synthetic A–E sample opened. Its topology does not describe real organisms.');
});
on('teacher-class-example',async()=>{
  if(pendingReduction||pendingFit||fitPreview||teacher.pending)throw new Error('Finish or discard the pending proposal before opening another project.');
  if(unsaved){const state=snapshot();if(!hasAuthoring(state))throw new Error('Missing document.');download('before-classification-sample.treeproject.json',serializeProject(state,exportingBuild),'application/json');}
  const example=await classificationSample(exportingBuild);source=example.source;rooted=example.rooted;reduction=example.reduction;project=example.project;history.clear();selected.clear();qa=null;scienceVersion++;editVersion++;unsaved=false;desiredRecipe=null;
  scientificLayout=generateLayout(rooted,reduction,project.presentation,'scientific');teacher.sync();teacher.open();teacher.setClassificationSpec(example.spec);activateTeacherPanel();render();fit();toast('Synthetic classification opened. Groups and ranks are invented; parent links do not assert ancestry.');
});
on('structured-view',()=>{endDrag(true);clearFit();teacher.open();activateTeacherPanel();});
on('organic-view', () => setView('organic')); on('scientific-view', () => setView('scientific'));
on('make-artistic', () => { setView('organic'); mutate(() => { project.layout.mode = 'organic'; project.authoring!.viewName = 'Artistic arrangement'; }, false, { notes: 'Explicitly adopted legacy inspection coordinates as an artistic arrangement; no coordinates changed.' }); });
on('fit-btn', fit); on('undo-btn', () => restoreHistory('undo')); on('redo-btn', () => restoreHistory('redo'));
on('import-btn', () => input('file-input').click());
input('file-input').addEventListener('change', () => { const file = input('file-input').files?.[0]; if (file) void guard(() => importFile(file)); input('file-input').value = ''; });
on('save-btn', () => { commitOpacity(); validateDesign(project.design, rooted); validateLayout(project.layout, rooted, reduction); const state = snapshot(); if (!hasAuthoring(state)) throw new Error('Missing document.'); download('tree.treeproject.json', serializeProject(state, exportingBuild), 'application/json'); unsaved = false; toast('Version-4 project saved with exact geometry, source and accepted-operation provenance.'); });
on('export-btn', exportPackage); on('validate-btn', runValidation);
on('regenerate-btn', () => mutate(() => regenerate(), true, regenerationEvidence()));
on('routing-demo-btn', () => {
  if (pendingReduction) throw new Error('Wait for the reduction to finish.');
  const before = structuredClone(project), demo = routingDemo(source); Object.assign(project, demo);
  rooted = orient(source, project.recipe.root); reduction = reduce(source, rooted, project.recipe, true);
  project.authoring!.root = legacyRootState(project.recipe.root, source);
  accepted(before, { kind: 'layout', methods: ['routing-demo', 'maximal-frontier'], replace: true, parameters: { recipe: project.recipe }, notes: 'Applied the exact source-derived routing demonstration.' });
  scienceVersion++; selected.clear(); invalidate(); setView('organic'); render(); fit();
  toast('Six-endpoint routing demonstration loaded. Every branch is from the original source; Undo restores your previous artwork.');
});
on('reset-example', async () => {
  if (source.sha256 !== HUG_SHA) throw new Error('The example preset belongs to the bundled Hug source. Choose Hug et al. in Datasets to restore that source.');
  if (JSON.stringify(project.recipe.root) !== JSON.stringify(defaultRecipe(source).root)) throw new Error('Restore the bundled root edge before using its example preset.');
  const fixture = await (await fetch('/data/example_reduction_recipe.json')).json();
  const recipe = { ...defaultRecipe(source), ...fixture }; reduce(source, rooted, recipe, true); await applyRecipe(recipe, 'Example restored: 150 endpoints covering all 3,083 source tips.');
});
function setGlobal(value: number): void { const next = structuredClone(desiredRecipe ?? project.recipe); next.globalThreshold = value; void guard(() => applyRecipe(next)); }
input('global-threshold').addEventListener('input', () => { input('global-value').value = input('global-threshold').value; clearTimeout(sliderTimeout); sliderTimeout = setTimeout(() => setGlobal(num('global-threshold')), 180); });
input('global-value').addEventListener('change', () => setGlobal(num('global-value')));
$('override-list').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('[data-select],[data-remove-override]'); if (!target) return;
  if (target.dataset.select) select(target.dataset.select);
  else { const next = structuredClone(desiredRecipe ?? project.recipe); next.thresholdOverrides = next.thresholdOverrides.filter(x => x.sourceNodeId !== target.dataset.removeOverride); void guard(() => applyRecipe(next)); }
});
$('override-list').addEventListener('change', event => {
  const target = event.target as HTMLInputElement, id = target.dataset.override; if (!id) return;
  const next = structuredClone(desiredRecipe ?? project.recipe); next.thresholdOverrides.find(x => x.sourceNodeId === id)!.threshold = Number(target.value); void guard(() => applyRecipe(next));
});
$('override-list').addEventListener('input', event => {
  const target = event.target as HTMLInputElement, id = target.dataset.override;
  if (!id) return;
  if (target.type === 'range') (target.nextElementSibling as HTMLInputElement).value = target.value;
  const value = Number(target.value); if (!target.value || !Number.isFinite(value) || value < 0) return;
  clearTimeout(sliderTimeout);
  sliderTimeout = setTimeout(() => { const next = structuredClone(desiredRecipe ?? project.recipe); const item = next.thresholdOverrides.find(x => x.sourceNodeId === id); if (item && item.threshold !== value) { item.threshold = value; void guard(() => applyRecipe(next)); } }, 250);
});
function renderSourceSearch():void {
  if(sourceSearchSha!==source.sha256){sourceSearchSha=source.sha256;sourceSearchOffset=0;input('search').value='';}
  const query=input('search').value;if(!query.trim()){$('search-results').innerHTML='';return;}
  const page=searchSource(source,query,project.corrections,{offset:sourceSearchOffset,limit:35});sourceSearchOffset=page.offset;
  $('search-results').innerHTML=page.total?`<p class="help" role="status">${page.offset+1}–${page.offset+page.results.length} of ${page.total} matches in this file</p>`+page.results.map(item=>`<button class="search-result" data-search-id="${item.id}">${esc(item.label)}<span>${item.id} · ${item.kind==='tip'?'organism / endpoint':'source group'} · ${rooted.nodes[item.id].count.toLocaleString()} tips</span></button>`).join('')+(page.total>page.limit?`<div class="button-row"><button class="button" data-search-page="${Math.max(0,page.offset-page.limit)}" ${page.offset===0?'disabled':''}>Previous</button><button class="button" data-search-page="${page.offset+page.limit}" ${page.offset+page.limit>=page.total?'disabled':''}>Next</button></div>`:''):'<p class="help" role="status">No matching organisms or groups in this file. Search its labels or source IDs; no online lookup is performed.</p>';
}
input('search').addEventListener('input',()=>{sourceSearchOffset=0;renderSourceSearch();});
$('search-results').addEventListener('click',event=>{const target=(event.target as HTMLElement).closest<HTMLElement>('[data-search-id],[data-search-page]');if(!target)return;if(target.dataset.searchPage!==undefined){sourceSearchOffset=Number(target.dataset.searchPage);renderSourceSearch();}else select(target.dataset.searchId!);});
$('issue-list').addEventListener('click', event => { const target = (event.target as HTMLElement).closest<HTMLElement>('[data-issue]'); const shown = displayedQA(); if (target && shown) { const issue = shown.issues[Number(target.dataset.issue)]; selected = new Set(issue.edges); if (issue.point) { viewBox.x = issue.point.x - viewBox.w / 2; viewBox.y = issue.point.y - viewBox.h / 2; } renderCanvas(); renderInspector(); } });
input('show-nodes').addEventListener('change', () => { showNodes = input('show-nodes').checked; renderCanvas(); });
input('show-issues').addEventListener('change', () => { showIssues = input('show-issues').checked; renderCanvas(); });
input('show-labels').addEventListener('change', () => guard(() => mutate(() => { project.presentation.labels = input('show-labels').checked; })));
for (const [id, key] of Object.entries({ 'page-width': 'widthMm', 'page-height': 'heightMm', stroke: 'strokeMm', 'fit-stroke': 'strokeMm', taper: 'taper', 'fit-taper': 'taper', clearance: 'clearanceMm', tolerance: 'toleranceMm', 'junction-radius': 'junctionMm', 'length-scale': 'sourceUnitMm' })) {
  input(id).addEventListener('change', () => guard(() => {
    const next = { ...project.presentation, [key]: num(id) }; validatePresentation(next);
    mutate(() => {
    if (key === 'widthMm' || key === 'heightMm') {
      const sx = next.widthMm / project.presentation.widthMm, sy = next.heightMm / project.presentation.heightMm;
      const scale = (p: Point) => { p.x *= sx; p.y *= sy; };
      for (const p of Object.values(project.layout.nodes)) scale(p);
      for (const r of Object.values(project.layout.routes)) for (const s of r.segments) { scale(s.c1); scale(s.c2); scale(s.end); }
      for (const p of Object.values(next.labelOffsets)) scale(p);
      // Guides follow the canvas. Images retain their aspect ratio and physical dimensions;
      // their centre follows the resized page, so an imported design is never stretched.
      for (const b of project.design?.borders ?? []) for (const p of b.points) scale(p);
      const r = project.design?.referenceImage;
      if (r) { r.x = (r.x + r.widthMm / 2) * sx - r.widthMm / 2; r.y = (r.y + r.heightMm / 2) * sy - r.heightMm / 2; }
    }
    project.presentation = next; validateLayout(project.layout, rooted, reduction); validateDesign(project.design, rooted);
    });
    scientificLayout = generateLayout(rooted, reduction, next, 'scientific'); if (key === 'widthMm' || key === 'heightMm') fit();
  }));
}
for (const id of ['allow-curves', 'fit-allow-curves']) input(id).addEventListener('change', () => guard(() => mutate(() => {
  project.layout.lineStyle = input(id).checked ? 'curved' : 'straight';
})));
input('stroke-slider').addEventListener('input', () => { input('stroke').value = input('stroke-slider').value; });
input('stroke-slider').addEventListener('change', () => guard(() => {
  const next = { ...project.presentation, strokeMm: num('stroke-slider') }; validatePresentation(next);
  mutate(() => { project.presentation = next; });
}));
function sourceAttributionMarkup():string {
  const d=bundledDataset(source.sha256);
  return d?`${esc(d.name)} · ${esc(d.release)}<br>${d.references.map(ref=>`${esc(ref.authors.join(', '))}. <a href="${esc(ref.url??d.sourceUrl)}" target="_blank" rel="noopener">${esc(ref.title)}</a> (${ref.year??'n.d.'})`).join('<br>')}<br><a href="${esc(d.licenseUrl)}" target="_blank" rel="noopener">${esc(d.license)}</a>. ${esc(d.changes)}<br>${esc(d.limitations)}`:'User-imported source. See Scientific basis and Sources &amp; Methods for supplied citations and rights statements; these remain unverified.';
}
function datasetDetails():void {
  const d=BUNDLED_DATASETS.find(d=>d.id===input('dataset-choice').value)!;
  $('dataset-detail').innerHTML=`<p><strong>${esc(d.shortCitation)}</strong> · ${d.tipCount.toLocaleString()} terminal identities · ${esc(d.license)}</p><p>${esc(d.evidence)}</p><p>${esc(d.limitations)}</p><p><a href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">Scientific source ↗</a> · <a href="${esc(d.licenseUrl)}" target="_blank" rel="noopener">Reuse terms ↗</a></p>`;
}
on('datasets-btn',()=>{
  $('dataset-choice').innerHTML=BUNDLED_DATASETS.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');
  input('dataset-choice').value=bundledDataset(source.sha256)?.id??BUNDLED_DATASETS[0].id;
  datasetDetails();$<HTMLDialogElement>('datasets-dialog').showModal();
});
$('dataset-choice').addEventListener('change',datasetDetails);
on('close-datasets',()=>$<HTMLDialogElement>('datasets-dialog').close());
on('open-dataset',async()=>{
  if(importing||!ready||pendingReduction||pendingFit||fitPreview||teacher.pending)throw new Error('Finish or discard the current calculation/preview first.');
  const d=BUNDLED_DATASETS.find(d=>d.id===input('dataset-choice').value)!;
  const revision=currentRevision(),viewId=effectiveViewId(project as import('./model/document.ts').WorkingProject);importing=true;updateButtons();
  try {
    const response=await fetch(`/data/${d.file}`);if(!response.ok)throw new Error('Could not read the bundled local dataset.');
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await response.arrayBuffer());
    const prepared=await prepareBundledDataset(d.id,text,exportingBuild);
    if(!hasAuthoring(project)||!isCurrentResult(project,revision,viewId)||pendingReduction||pendingFit||fitPreview||teacher.pending)throw new Error('The current project changed while loading. Open the dataset again when ready.');
    installPrepared(prepared);$<HTMLDialogElement>('datasets-dialog').close();
    toast(`${d.shortCitation} opened: ${source.tips.length.toLocaleString()} source tips, ${reduction.frontier.length} overview endpoints. Search all source names in Reduce or Layout.`);
  } finally {importing=false;updateButtons();}
});
on('source-info-btn', () => {
  const count = Object.values(source.nodes).reduce((sum, x) => sum + x.annotations.length, 0);
  $('source-detail').innerHTML = `<p>${source.tips.length.toLocaleString()} terminal identities · ${source.order.length.toLocaleString()} original nodes · ${count.toLocaleString()} preserved bracket annotations.</p><p><strong>Source SHA256</strong><br><code>${source.sha256}</code></p><p>${sourceAttributionMarkup()}</p><p><strong>${teacher.view?.scene.unrooted||teacher.view?.artistic?.baseScene.unrooted?'Stored traversal (unused by unrooted view)':project.authoring!.basis.relationshipKind==='classification'?'Legacy traversal (not classification parent orientation)':'Root assumption'}</strong><br>${esc(JSON.stringify(project.authoring!.root))}<br>Traversal: ${esc(JSON.stringify(project.recipe.root))}</p><details><summary>Full provenance metadata</summary><pre>${esc(JSON.stringify(project.provenance, null, 2))}</pre></details><section id="biological-root-controls"><h2>Change the biological root</h2><p>This separate scientific operation clears reduction rules and geometry. Dragging the drawn origin does not do this. The old state remains available through Undo.</p><div class="field-grid"><label>Source edge endpoint A<input id="root-a" value="${source.rootId}"></label><label>Source edge endpoint B<input id="root-b" value="${source.nodes[source.rootId].children[0] ?? ''}"></label></div><div class="field-grid"><label>Edge fraction<input id="root-fraction" type="number" min=".001" max=".999" step=".1" value=".5"></label></div><button id="apply-root" class="button">Declare root and reset arrangement</button></section>`;
  on('apply-root', () => {
    if (pendingReduction) throw new Error('Wait for the reduction to finish.');
    if (!semanticCapabilities({ status: 'rooted', basis: 'user-assumption', explanation: 'Proposed assumption', referenceIds: [] }, 'artistic', project.authoring!.edgeMeasure, project.authoring!.basis).canClaimAncestry) throw new Error('Describe a phylogenetic basis and entity type before declaring a biological root.');
    const next = defaultRecipe(source); next.root = { kind: 'edge', sourceEdge: [input('root-a').value.trim(), input('root-b').value.trim()], fraction: num('root-fraction'), status: 'declared_assumption' };
    const before = structuredClone(project), tree = orient(source, next.root), result = reduce(source, tree, next); scienceVersion++;
    project.recipe = next; rooted = tree; reduction = result; project.layout = generateLayout(rooted, reduction, project.presentation, 'organic'); syncRecipe();
    project.authoring!.root = legacyRootState(project.recipe.root, source);
    for (const b of project.design?.borders ?? []) b.assignments = [];
    accepted(before, { kind: 'scientific', methods: ['root-orientation', 'maximal-frontier', 'organic-initializer'], replace: true, parameters: { root: next.root, recipe: project.recipe }, notes: 'Explicit rooting assumption and fresh arrangement.' });
    designTool = 'edit'; selected.clear(); scientificLayout = generateLayout(rooted, reduction, project.presentation, 'scientific'); invalidate(); render(); $<HTMLDialogElement>('source-dialog').close(); toast('Biological root changed explicitly. Source splits and original edge identities are retained.');
  });
  $('biological-root-controls').hidden=project.authoring!.basis.relationshipKind==='classification'||!!teacher.view?.scene.unrooted||!!teacher.view?.artistic?.baseScene.unrooted;
  $<HTMLButtonElement>('apply-root').disabled = project.authoring!.basis.relationshipKind !== 'phylogeny' || project.authoring!.basis.entityKind === 'unspecified';
  if (hasAuthoring(project)) $('source-detail').insertAdjacentHTML('beforeend', provenanceReport(project));
  $<HTMLDialogElement>('source-dialog').showModal();
});
on('close-source', () => $<HTMLDialogElement>('source-dialog').close());

const basisFields = { name: 'basis-name', question: 'basis-question', relationshipKind: 'basis-relationship', entityKind: 'basis-entity', edgeMeaning: 'basis-edges', evidenceBasis: 'basis-evidence', provider: 'basis-provider', release: 'basis-release', retrievedAt: 'basis-retrieved', epistemicStatus: 'basis-status', limitations: 'basis-limitations' } as const;
on('basis-info-btn', () => {
  endDrag(true); commitOpacity();
  const basis = project.authoring!.basis;
  for (const [key,id] of Object.entries(basisFields)) input(id).value = basis[key as keyof typeof basisFields] ?? '';
  for (const id of ['title','authors','year','doi','url','license']) input(`basis-ref-${id}`).value = '';
  input('basis-replace-ref').checked = false;
  $('basis-identity').textContent = `Immutable source: ${project.sourceSha256}. Rights records: ${basis.rightsRecordIds.join(', ') || 'none supplied'}. Citations: ${basis.referenceIds.map(id => project.authoring!.provenance.references[id]?.title ?? id).join('; ') || 'none supplied'}.`;
  $('basis-capabilities').textContent = semanticCapabilities(project.authoring!.root, basis.relationshipKind==='classification'?'taxonomy':'artistic', project.authoring!.edgeMeasure, basis).reasons.join(' ') || 'Phylogenetic interpretation uses the stated entities and root assumptions.';
  $('basis-error').hidden = true;
  $<HTMLDialogElement>('basis-dialog').showModal();
});
on('close-basis', () => $<HTMLDialogElement>('basis-dialog').close());
$('basis-form').addEventListener('submit', event => {
  event.preventDefault();
  void guard(() => {
    try {
      if (!hasAuthoring(project)) throw new Error('Missing authoring state.');
      if (pendingReduction || pendingFit || fitPreview || teacher.pending) throw new Error('Finish or discard the pending calculation/preview before editing the scientific basis.');
      const basis: ScientificBasis = structuredClone(project.authoring.basis);
      for (const [key,id] of Object.entries(basisFields)) {
        const value = input(id).value.trim();
        Object.assign(basis, { [key]: ['provider','release','retrievedAt'].includes(key) ? value || null : value });
      }
      const title = input('basis-ref-title').value.trim();
      const references = title ? [userReference({ title, authors: input('basis-ref-authors').value.split(';').map(s => s.trim()).filter(Boolean), year: input('basis-ref-year').value ? num('basis-ref-year') : null, doi: input('basis-ref-doi').value.trim() || null, url: input('basis-ref-url').value.trim() || null, license: input('basis-ref-license').value.trim() || null })] : [];
      if (!title && input('basis-replace-ref').checked) throw new Error('Supply a replacement citation title or leave replacement unchecked.');
      if (input('basis-replace-ref').checked) basis.referenceIds = basis.referenceIds.filter(id => !id.startsWith('user-reference-') || project.authoring!.source.referenceIds.includes(id));
      basis.referenceIds = [...new Set([...basis.referenceIds, ...references.map(ref => ref.id)])];
      const before = structuredClone(project);
      project = acceptBasisEdit(project, basis, source, exportingBuild, references);
      if (currentRevision() !== treeRevision(documentFromWorking(before))) { history.push(before); invalidate(); }
      render(); $<HTMLDialogElement>('basis-dialog').close();
      toast('Scientific basis saved with this project. Topology and artwork retained.');
    } catch (error) {
      $('basis-error').textContent = error instanceof Error ? error.message : String(error); $('basis-error').hidden = false;
    }
  });
});


// Design layers are saved with the project, but never passed to artworkGroup/SVG export.
type DesignTool = 'edit' | 'select-endpoints' | 'draw-direction' | 'draw-border' | 'edit-border' | 'move-reference';
let directionScope = '';
let designTool: DesignTool = 'edit', drawingPoints: Point[] = [], drawingIds: string[] = [];
let opacityBefore: Project | null = null, imageRequest = 0;
function design(): Design { return project.design ??= { borders: [], showBorders: true }; }
function activeBorder(): EndpointBorder | undefined { return project.design?.borders.find(b => b.id === project.design?.activeBorderId); }
function borderScope(): string[] {
  const scope = input('border-scope').value;
  return scopedEndpoints(rooted, reduction, scope === 'all' ? undefined : [...selected], scope !== 'endpoints');
}
function commitOpacity(): void {
  if (!opacityBefore) return;
  if (opacityBefore.design?.referenceImage?.opacity !== project.design?.referenceImage?.opacity) accepted(opacityBefore);
  opacityBefore = null; updateButtons();
}
function setDesignTool(tool: DesignTool): void {
  endDrag(true); commitOpacity(); designTool = tool; drawingPoints = [];
  if (tool === 'select-endpoints') { input('border-scope').value = 'endpoints'; selected = new Set(scopedEndpoints(rooted, reduction, [...selected])); renderInspector(); }
  if (tool === 'draw-border' && !borderScope().length) { designTool = 'edit'; renderDesignControls(); renderCanvas(); throw new Error('Select endpoints on the canvas first, or change Endpoints to shape.'); }
  if (tool === 'edit-border') design().showBorders = true;
  renderDesignControls(); renderCanvas(); updateButtons();
}
function renderDesignControls(): void {
  if (!ready) return;
  const d = project.design, b = activeBorder(), r = d?.referenceImage;
  $<HTMLFieldSetElement>('shape-fields').disabled = pendingReduction || view === 'scientific' || pendingFit || !!fitPreview;
  $('shape-readonly').hidden = view === 'organic';
  $('border-scope-count').textContent = `${borderScope().length} endpoints in current scope`;
  $('border-list').innerHTML = d?.borders.length ? d.borders.map(b => `<option value="${b.id}">${esc(b.name)} · ${b.assignments.length} endpoints</option>`).join('') : '<option value="">No borders yet</option>';
  input('border-list').value = b?.id ?? '';
  input('show-borders').checked = d?.showBorders ?? true;
  for (const id of ['edit-border', 'apply-border', 'delete-border', 'border-rebind', 'border-select-assigned', 'border-randomize']) $<HTMLButtonElement>(id).disabled = !b;
  $<HTMLButtonElement>('border-rebind').disabled = !b || !borderScope().length;
  $('border-rebind').textContent = input('border-scope').value === 'all' ? 'Assign all endpoints' : input('border-scope').value === 'selected' ? 'Assign selected clades' : 'Assign selected endpoints';
  if (b) {
    input('border-closed').checked = b.closed; input('border-placement').value = b.placement;
    input('border-inset').value = String(b.insetMm); input('border-variation').value = String(b.variationMm);
    const targets = borderTargets(b, rooted, reduction, project.layout);
    const hidden = targets.filter(t => t.hidden).length, pinned = targets.filter(t => t.pinned && !t.hidden).length;
    $('border-status').textContent = `${targets.length - hidden} assigned endpoints visible · ${pinned} pinned${hidden ? ` · ${hidden} hidden` : ''}. Dots preview targets; Apply moves them.`;
  } else $('border-status').textContent = 'Select endpoints, then draw a border on the canvas.';
  $('reference-controls').hidden = !r;
  if (r) {
    $('reference-name').textContent = `${r.name} · ${r.pixelWidth} × ${r.pixelHeight} px`;
    input('reference-opacity').value = String(Math.round(r.opacity * 100)); $('reference-opacity-value').textContent = `${Math.round(r.opacity * 100)}%`;
    input('reference-visible').checked = r.visible; input('reference-above').checked = r.layer === 'above';
    for (const [id, value] of [['reference-x', r.x], ['reference-y', r.y], ['reference-width', r.widthMm], ['reference-rotation', r.rotationDeg]] as const) input(id).value = String(Number(value.toFixed(3)));
    $<HTMLButtonElement>('move-reference').disabled = !r.visible;
  }
  for (const [id, tool] of [['select-endpoints', 'select-endpoints'], ['draw-border', 'draw-border'], ['edit-border', 'edit-border'], ['move-reference', 'move-reference']] as const) $(id).setAttribute('aria-pressed', String(designTool === tool));
  const hint = designTool === 'draw-direction' ? 'Drag an arrow from where branches come from toward where they should point. Release to save its angle; Esc cancels.' : designTool === 'select-endpoints' ? 'Click endpoints or drag a box. Shift adds/removes endpoints or adds a box. Then draw a border or assign to a saved border.' : designTool === 'draw-border' ? 'Drag to draw a border. Release to preview. Esc cancels.' : designTool === 'edit-border' ? 'Drag a border point or its line. Apply to update endpoints. Esc returns to branches.' : designTool === 'move-reference' ? 'Drag the image to align it. Esc locks it for branch editing.' : '';
  $('design-mode-hint').textContent = hint; $('design-mode-hint').hidden = !hint || view === 'scientific';
  $('stage').dataset.tool = designTool;
}
function referenceMarkup(): string {
  const r = project.design?.referenceImage;
  if (view !== 'organic' || !r?.visible) return '';
  return `<image id="reference-image" href="${esc(r.dataUrl)}" x="${r.x}" y="${r.y}" width="${r.widthMm}" height="${r.heightMm}" opacity="${r.opacity}" transform="rotate(${r.rotationDeg} ${r.x + r.widthMm / 2} ${r.y + r.heightMm / 2})" preserveAspectRatio="none" pointer-events="none"/>`;
}
function designMarkup(): string {
  if (view !== 'organic') return '';
  const d = project.design, markup: string[] = [];
  if (d?.showBorders) for (const b of d.borders) {
    const active = b.id === d.activeBorderId, path = `M${b.points.map(p => `${p.x},${p.y}`).join('L')}${b.closed ? 'Z' : ''}`;
    markup.push(`<path d="${path}" fill="none" stroke="${active ? '#ab7a3e' : '#b2a180'}" stroke-width=".35" stroke-dasharray="1.2 .8" pointer-events="none" opacity="${active ? 1 : .55}"/>`);
    if (active || (fitPreview && fitSettings().borderScope === 'all')) {
      // A degenerate guide can occur transiently while dragging a handle. Validate on release.
      try { for (const t of borderTargets(b, rooted, reduction, project.layout)) if (!t.hidden) markup.push(`<circle data-target-border="${b.id}" data-border-target="${t.id}" cx="${t.point.x}" cy="${t.point.y}" r=".65" fill="${t.pinned ? '#999' : '#b48a49'}" opacity=".65" pointer-events="none"/>`); } catch { /* transient preview */ }
    }
    if (designTool === 'edit-border') {
      markup.push(`<path class="border-hit" d="${path}" data-border-move="${b.id}" stroke-width="2.5"/>`);
      if (active) b.points.forEach((p, i) => markup.push(`<circle class="border-point" data-border-point="${b.id}:${i}" cx="${p.x}" cy="${p.y}" r=".85" fill="#fff9ed" stroke="#a57a3e" stroke-width=".25"/>`));
    }
  }
  if (drawingPoints.length) markup.push(`<path d="M${drawingPoints.map(p => `${p.x},${p.y}`).join('L')}" fill="none" stroke="#b18242" stroke-width=".45" pointer-events="none"/>`);
  const r = d?.referenceImage;
  if (r?.visible && designTool === 'move-reference') markup.push(`<rect class="reference-move" data-reference-move="true" x="${r.x}" y="${r.y}" width="${r.widthMm}" height="${r.heightMm}" transform="rotate(${r.rotationDeg} ${r.x + r.widthMm / 2} ${r.y + r.heightMm / 2})"/>`);
  return `<g id="design-guides">${markup.join('')}</g>`;
}
function borderSettings(b: EndpointBorder): void {
  b.closed = input('border-closed').checked; b.placement = input('border-placement').value as EndpointBorder['placement'];
  b.insetMm = num('border-inset'); b.variationMm = num('border-variation');
}
function finishBorder(): void {
  let number = 1; while (project.design?.borders.some(b => b.name === `Border ${number}`)) number++;
  const b: EndpointBorder = { id: `border-${crypto.randomUUID()}`, name: `Border ${number}`, points: simplifyStroke(drawingPoints), closed: false, placement: 'spread', insetMm: 2, variationMm: 1, seed: 1, assignments: [] };
  borderSettings(b);
  // Closed strokes often finish on their start; the closing segment already supplies that point.
  if (b.closed && b.points.length > 3 && Math.hypot(b.points[0].x - b.points.at(-1)!.x, b.points[0].y - b.points.at(-1)!.y) < .5) b.points.pop();
  const next = structuredClone(project.design ?? { borders: [], showBorders: true }); next.borders.push(b); next.activeBorderId = b.id; next.showBorders = true;
  validateDesign(next, rooted); const assignment = assignBorder(next, b.id, drawingIds, rooted, project.layout); validateDesign(next, rooted);
  const before = structuredClone(project); project.design = next; accepted(before); unsaved = true; designTool = 'edit-border';
  toast(`${b.name} saved with ${assignment.assigned} endpoints${assignment.transferred ? ` · ${assignment.transferred} transferred from other borders` : ''}. Select endpoints again to create another group, or open Fit to fit all borders.`);
}
async function importReference(file: Blob, name: string): Promise<void> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('Reference image exceeds the 8 MB limit.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.');
  const request = ++imageRequest, originalSource = source;
  const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the reference image.')); reader.readAsDataURL(file); });
  validateImageData(dataUrl);
  const image = new Image(); image.src = dataUrl; await image.decode();
  if (request !== imageRequest || source !== originalSource) return;
  const reference: ReferenceImage = { name: name.slice(0, 200), dataUrl, pixelWidth: image.naturalWidth, pixelHeight: image.naturalHeight, x: 0, y: 0, widthMm: 1, heightMm: 1, rotationDeg: 0, opacity: .3, visible: true, layer: 'behind' };
  fitReference(reference, project.presentation);
  mutate(() => { design().referenceImage = reference; validateDesign(project.design, rooted); }, false);
  toast('Reference image embedded in this project. Use opacity and Move image to align it.');
}

// A fit stays outside the project until explicitly accepted. Cancellation terminates its worker.
function clearFit(): void {
  fitVersion++;
  const running = workers.get('fit'); if (running) { running.worker.terminate(); running.reject(new Error('superseded')); workers.delete('fit'); }
  fitPreview = null; pendingFit = false; compareOriginal = false;
}
function fitSettings(): FitSettings { const settings = project.design?.fitSettings ?? DEFAULT_FIT_SETTINGS; return { ...settings, routing: settings.routing ?? 0, forkSpread: settings.forkSpread ?? 0 }; }
function selectedJunctions(): string[] {
  const tips = new Set(reduction.frontier.map(e => e.id));
  return [...selected].filter(id => id !== rooted.rootId && reduction.visible.includes(id) && !tips.has(id));
}
function renderFitControls(): void {
  if (!ready) return;
  const settings = fitSettings(), readonly = view !== 'organic' || pendingReduction;
  $<HTMLFieldSetElement>('auto-fit-settings').disabled = readonly;
  $('fit-readonly').hidden = view === 'organic';
  input('fit-border-scope').value = settings.borderScope;
  for (const [id, key] of [['fit-depth', 'junctionDepth'], ['fit-flow', 'preserveFlow'], ['fit-strength', 'strength'], ['fit-smoothing', 'smoothing'], ['fit-routing', 'routing'], ['fit-fork-spread', 'forkSpread']] as const) {
    input(id).value = String(Math.round((settings[key] ?? 0) * 100)); $(`${id}-value`).textContent = `${Math.round((settings[key] ?? 0) * 100)}%`;
  }
  input('fit-spacing').value = String(settings.junctionSpacingMm);
  input('fit-smoothing').disabled = project.layout.lineStyle === 'straight';
  renderDirectionControls();
  const pinned = project.layout.pinnedNodes.filter(id => reduction.visible.includes(id) && !reduction.frontier.some(e => e.id === id)).length;
  $('fit-anchor-status').textContent = `${selectedJunctions().length} internal junctions selected · ${pinned} junctions pinned · origin fixed`;
  for (const id of ['fit-pin-selected', 'fit-unpin-selected']) $<HTMLButtonElement>(id).disabled = pendingFit || !!fitPreview || !selectedJunctions().length;
  $<HTMLButtonElement>('preview-fit').disabled = readonly || pendingFit || !project.design?.borders.length;
  $('preview-fit').textContent = pendingFit ? 'Fitting junctions and checking curves…' : fitPreview ? 'Recalculate preview' : 'Preview automatic fit';
  $('cancel-fit').hidden = !pendingFit;
  $('fit-compare-row').hidden = !fitPreview; input('fit-compare').checked = compareOriginal;
  $('fit-preview-banner').hidden = !fitPreview;
  $('fit-preview-caption').textContent = compareOriginal ? 'Original arrangement · comparison only' : 'Fit preview · blue marks show moved junctions';
  $('inspector-content').inert = pendingFit || !!fitPreview;
  $('fit-summary').innerHTML = pendingFit ? '<p class="help">Calculating in a background worker. Cancel keeps your current artwork.</p>' : '<p class="help">Your artwork changes only when you keep the preview.</p>';
  if (!fitPreview) return;
  const r = fitPreview, counts = (q: QA, kinds: QA['issues'][number]['type'][]) => `${q.issues.filter(i => kinds.includes(i.type)).length}${q.omittedIssueCount ? '+' : ''}`;
  $('accept-fit').textContent = r.afterQA.status === 'checked' ? 'Use fit' : 'Use draft fit';
  const row = (label: string, value: string) => `<div class="result-row"><span>${label}</span><strong>${value}</strong></div>`;
  $('fit-summary').innerHTML = row('Junctions repositioned', String(r.movedJunctions.length)) + row('Endpoints moved', `${r.movedEndpoints} / ${r.assignedEndpoints}`) +
    row('Fixed junctions / boundaries', String(r.fixedJunctions)) + row('Pinned endpoints / hidden', `${r.pinnedEndpoints} / ${r.hiddenAssignments}`) +
    row('Mean distance to targets', `${r.errorBeforeMm.toFixed(2)} → ${r.errorAfterMm.toFixed(2)} mm`) +
    row('Contacts · before → after', `${counts(r.beforeQA, ['crossing', 'self-intersection'])} → ${counts(r.afterQA, ['crossing', 'self-intersection'])}`) +
    row('Clearance / bounds issues', `${counts(r.afterQA, ['clearance'])} / ${counts(r.afterQA, ['bounds'])}`) +
    row('Routes refined for spacing', String(r.refinedRoutes)) +
    (r.routingLimited ? '<p class="fit-warning">Routing reached its work limit. The best changes so far are shown; geometry checks below still cover the whole result.</p>' : '') +
    row('Junction spacing conflicts', String(r.crowdedJunctionPairs)) +
    row('Branches against direction', `${r.directionConflicts} / ${r.directedEdges}`) +
    (r.directionConflicts ? '<p class="fit-warning">Some curves still run against the requested direction. Fixed boundaries, pins, waypoints or target positions can prevent consistent forward flow.</p>' : '') +
    `<p class="${r.afterQA.status === 'checked' ? 'fit-good' : 'fit-warning'}">${r.afterQA.status === 'checked' ? 'Geometry checks passed at the current physical dimensions.' : 'Draft fit. Geometry or numbered-label checks still need attention.'} ${r.afterQA.annotationCollisions} numbered-label conflicts. Source coverage and connections preserved.</p>`;
}
async function previewAutomaticFit(): Promise<void> {
  if (view !== 'organic') throw new Error('Switch to Organic before fitting.');
  if (pendingReduction) throw new Error('Wait for the reduction to finish.');
  endDrag(true); commitOpacity(); clearFit(); designTool = 'edit';
  const settings = structuredClone(fitSettings()); validateFitSettings(settings);
  const version = ++fitVersion, edit = editVersion, originalSource = source;
  pendingFit = true; render();
  try {
    const result = await workerTask<FitResult>('fit', { sourceText: source.text, recipe: savedRecipe(), layout: project.layout, presentation: project.presentation, design: project.design, settings });
    if (version !== fitVersion || edit !== editVersion || source !== originalSource) return;
    validateLayout(result.layout, rooted, reduction);
    if (!result.afterQA.coveragePassed || !result.afterQA.incidencePassed) throw new Error('Fit did not preserve source coverage and junction incidence. Original artwork retained.');
    fitPreview = result;
    toast(`${result.movedJunctions.length} junctions repositioned in preview. Compare the original, then keep or discard the proposal.`);
  } finally { if (version === fitVersion) { pendingFit = false; render(); } }
}
function fitPreviewMarkup(): string {
  if (!fitPreview || compareOriginal || view !== 'organic') return '';
  return `<g id="fit-junction-preview" pointer-events="none">${fitPreview.movedJunctions.map(j => `<path d="M${j.from.x},${j.from.y}L${j.to.x},${j.to.y}" stroke="#729bb1" stroke-width=".16" stroke-dasharray=".7 .5" opacity=".6"/><circle cx="${j.from.x}" cy="${j.from.y}" r=".5" fill="none" stroke="#8ca4b1" stroke-width=".15"/><circle data-fit-junction="${j.id}" cx="${j.to.x}" cy="${j.to.y}" r=".8" fill="#4282a4" stroke="#fff" stroke-width=".2"/>`).join('')}</g>`;
}
function directionBorder(id = directionScope): EndpointBorder | undefined { return project.design?.borders.find(b => b.id === id); }
function renderDirectionControls(): void {
  if (directionScope && !directionBorder()) directionScope = '';
  $('fit-direction-scope').innerHTML = '<option value="">Whole fit</option>' + (project.design?.borders ?? []).map(b => `<option value="${b.id}">${esc(b.name)} · ${b.assignments.length} endpoints</option>`).join('');
  input('fit-direction-scope').value = directionScope;
  const b = directionBorder(), own = b ? b.direction : fitSettings().direction;
  $('fit-direction-mode').innerHTML = (b ? '<option value="inherit">Use whole-fit direction</option>' : '') + '<option value="off">Automatic · no direction</option><option value="custom">Set direction</option>';
  const mode = b && own === undefined ? 'inherit' : own ? 'custom' : 'off';
  input('fit-direction-mode').value = mode;
  const value = own ?? (b && own === undefined ? fitSettings().direction : undefined) ?? { angleDeg: 270, strength: .8 };
  input('fit-direction-angle').value = String(Number(value.angleDeg.toFixed(2)));
  input('fit-direction-strength').value = String(Math.round(value.strength * 100));
  $('fit-direction-strength-value').textContent = `${Math.round(value.strength * 100)}%`;
  const angle = (value.angleDeg + 360) % 360;
  input('fit-direction-preset').value = [0, 90, 180, 270].includes(angle) ? String(angle) : '';
  $<HTMLFieldSetElement>('fit-direction-fields').disabled = mode !== 'custom';
  $('draw-direction').setAttribute('aria-pressed', String(designTool === 'draw-direction'));
  $('fit-direction-status').textContent = `${b ? b.name : 'Whole fit'}: ${mode === 'inherit' ? 'inherits the whole-fit direction' : mode === 'off' ? 'automatic direction' : `${Number(value.angleDeg.toFixed(2))}° at ${Math.round(value.strength * 100)}%`}. Right 0° · down 90° · left 180° · up 270°. Pins and endpoint targets stay fixed during directional relaxation.`;
}
function saveDirection(value: BranchDirection | null | undefined, scope = directionScope): void {
  if (value) validateBranchDirection(value);
  clearFit();
  mutate(() => {
    if (scope) { const b = directionBorder(scope); if (!b) throw new Error('Choose an existing border.'); if (value === undefined) delete b.direction; else b.direction = value; }
    else { const settings = structuredClone(fitSettings()); if (value) settings.direction = value; else delete settings.direction; design().fitSettings = settings; }
    validateDesign(project.design, rooted);
  }, false);
}
function directionMarkup(): string {
  if (view !== 'organic' || (fitPreview && compareOriginal)) return '';
  const borders = project.design?.borders ?? [], arrows: string[] = [];
  const arrow = (key: string, center: Point, d: BranchDirection, label: string) => {
    if (!d.strength) return;
    const v = directionVector({ ...d, strength: 1 }), a = sub(center, { x: v.x * 6, y: v.y * 6 }), b = add(center, { x: v.x * 6, y: v.y * 6 });
    arrows.push(`<g data-direction-border="${esc(key)}"><title>${esc(label)} · ${d.angleDeg}° · ${Math.round(d.strength * 100)}%</title><path d="M${a.x},${a.y}L${b.x},${b.y}" stroke="#3e7b9b" stroke-width=".65" marker-end="url(#flow-arrow-head)"/></g>`);
  };
  for (const b of borders) {
    if (fitSettings().borderScope === 'active' && b.id !== project.design?.activeBorderId) continue;
    const d = b.direction === undefined ? fitSettings().direction : b.direction;
    if (d && b.assignments.length) { const c = b.points.reduce((s, p) => add(s, p), { x: 0, y: 0 }); arrow(b.id, { x: c.x / b.points.length, y: c.y / b.points.length }, d, b.name); }
  }
  if (!borders.length && fitSettings().direction) arrow('whole-fit', { x: project.presentation.widthMm / 2, y: project.presentation.heightMm / 2 }, fitSettings().direction!, 'Whole fit');
  return `<g id="direction-guides" pointer-events="none"><defs><marker id="flow-arrow-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#3e7b9b"/></marker></defs>${arrows.join('')}</g>`;
}
input('fit-direction-scope').addEventListener('change', () => { setDesignTool('edit'); directionScope = input('fit-direction-scope').value; renderDirectionControls(); });
input('fit-direction-mode').addEventListener('change', () => guard(() => {
  const mode = input('fit-direction-mode').value;
  saveDirection(mode === 'inherit' ? undefined : mode === 'off' ? null : { angleDeg: num('fit-direction-angle'), strength: num('fit-direction-strength') / 100 });
}));
for (const id of ['fit-direction-angle', 'fit-direction-strength', 'fit-direction-preset']) input(id).addEventListener('change', () => guard(() => {
  if (id === 'fit-direction-preset') { if (!input(id).value) return; input('fit-direction-angle').value = input(id).value; }
  try { saveDirection({ angleDeg: num('fit-direction-angle'), strength: num('fit-direction-strength') / 100 }); } catch (error) { renderDirectionControls(); throw error; }
}));
input('fit-direction-strength').addEventListener('input', () => { $('fit-direction-strength-value').textContent = `${num('fit-direction-strength')}%`; });
on('draw-direction', () => { clearFit(); setDesignTool(designTool === 'draw-direction' ? 'edit' : 'draw-direction'); render(); });
on('preview-fit', previewAutomaticFit);
on('cancel-fit', () => { clearFit(); render(); toast('Calculation canceled. Artwork unchanged.'); });
on('discard-fit', () => { clearFit(); render(); toast('Fit discarded. Artwork unchanged.'); });
on('accept-fit', () => {
  const result = fitPreview; if (!result) return;
  const settings = structuredClone(fitSettings()), constraints = structuredClone(project.design ?? { borders: [], showBorders: true });
  const evidence: CommandEvidence = { kind: 'layout', methods: ['junction-fit', ...((settings.routing ?? 0) > 0 ? ['route-search'] : [])], inputs: Object.keys(project.authoring!.provenance.heads).filter(key => key === 'source' || key === 'scientific' || key.startsWith(viewPrefix(project.authoring!.activeViewId))), parameters: { settings, borders: constraints.borders, activeBorderId: constraints.activeBorderId ?? null, pinnedNodes: project.layout.pinnedNodes, pinnedEdges: project.layout.pinnedEdges, presentation: project.presentation, lineStyle: project.layout.lineStyle ?? 'curved' }, result: { accepted: true, routingLimited: result.routingLimited, refinedRoutes: result.refinedRoutes, movedEndpoints: result.movedEndpoints, errorAfterMm: result.errorAfterMm, qaStatus: result.afterQA.status, directionConflicts: result.directionConflicts }, notes: 'Accepted fit; sampled-path objectives and transported bends consume existing geometry. Residual issues remain disclosed.' };
  clearFit(); mutate(() => { project.layout = result.layout; design().fitSettings = settings; }, true, evidence); qa = result.afterQA; render();
  toast(`${result.afterQA.status === 'checked' ? 'Fit' : 'Draft fit'} applied. ${result.movedJunctions.length} junctions moved. Undo restores the previous arrangement.`);
});
input('fit-compare').addEventListener('change', () => { compareOriginal = input('fit-compare').checked; renderCanvas(); renderInspector(); renderQA(); renderFitControls(); updateButtons(); });
for (const [id, key] of [['fit-depth', 'junctionDepth'], ['fit-flow', 'preserveFlow'], ['fit-strength', 'strength'], ['fit-smoothing', 'smoothing'], ['fit-routing', 'routing'], ['fit-fork-spread', 'forkSpread'], ['fit-spacing', 'junctionSpacingMm'], ['fit-border-scope', 'borderScope']] as const) {
  if (id !== 'fit-spacing' && id !== 'fit-border-scope') input(id).addEventListener('input', () => { $(`${id}-value`).textContent = `${num(id)}%`; });
  input(id).addEventListener('change', () => guard(() => {
    const next = { ...fitSettings(), [key]: key === 'borderScope' ? input(id).value : num(id) / (key === 'junctionSpacingMm' ? 1 : 100) } as FitSettings;
    try { validateFitSettings(next); } catch (error) { renderFitControls(); throw error; }
    clearFit(); mutate(() => { design().fitSettings = next; }, false);
  }));
}
for (const [button, pin] of [['fit-pin-selected', true], ['fit-unpin-selected', false]] as const) on(button, () => {
  const ids = selectedJunctions(); if (!ids.length) throw new Error('Select an internal junction to anchor.');
  mutate(() => { const pins = new Set(project.layout.pinnedNodes); for (const id of ids) { if (pin) pins.add(id); else pins.delete(id); } project.layout.pinnedNodes = [...pins]; });
  toast(`${ids.length} junctions ${pin ? 'pinned as fit anchors' : 'unpinned'}. Pinned edges continue to lock their endpoints.`);
});

on('select-endpoints', () => setDesignTool(designTool === 'select-endpoints' ? 'edit' : 'select-endpoints'));
on('draw-border', () => setDesignTool(designTool === 'draw-border' ? 'edit' : 'draw-border'));
on('edit-border', () => setDesignTool(designTool === 'edit-border' ? 'edit' : 'edit-border'));
on('finish-design', () => setDesignTool('edit'));
input('border-scope').addEventListener('change', renderDesignControls);
input('border-list').addEventListener('change', () => { design().activeBorderId = input('border-list').value; unsaved = true; renderDesignControls(); renderCanvas(); });
for (const id of ['border-closed', 'border-placement', 'border-inset', 'border-variation']) input(id).addEventListener('change', () => guard(() => {
  const b = activeBorder(); if (!b) return;
  mutate(() => {
    borderSettings(b); validateDesign(project.design, rooted);
    // Spacing/closure changes reproject the same saved IDs, never a newly selected clade.
    if (b.assignments.length && (id === 'border-closed' || id === 'border-placement')) bindBorder(b, b.assignments.map(a => a.sourceNodeId), rooted, project.layout);
  }, false);
}));
on('border-rebind', () => {
  let result!: ReturnType<typeof assignBorder>;
  mutate(() => { result = assignBorder(design(), activeBorder()!.id, borderScope(), rooted, project.layout); }, false);
  toast(`${result.assigned} endpoints assigned to ${activeBorder()!.name} · ${result.transferred} transferred from other borders. Other targets are unchanged.`);
});
on('border-select-assigned', () => {
  const b = activeBorder(); if (!b) return;
  setDesignTool('select-endpoints');
  selected = new Set(scopedEndpoints(rooted, reduction, b.assignments.map(a => a.sourceNodeId), false));
  renderInspector(); renderDesignControls(); renderFitControls(); renderCanvas();
});
on('border-randomize', () => mutate(() => { const b = activeBorder()!; b.seed = (b.seed + 1) >>> 0; }, false));
on('apply-border', () => {
  let result!: ReturnType<typeof applyBorder>;
  const border = structuredClone(activeBorder()!);
  mutate(() => { result = applyBorder(border, rooted, reduction, project.layout); validateLayout(project.layout, rooted, reduction); }, true, { kind: 'layout', methods: ['endpoint-border'], inputs: Object.keys(project.authoring!.provenance.heads).filter(key => key === 'source' || key === 'scientific' || key.startsWith(viewPrefix(project.authoring!.activeViewId))), parameters: { border }, notes: 'Applied assigned endpoints to the saved border with pins and variation retained.' });
  toast(`${result.moved} endpoints placed · ${result.pinned} pinned · ${result.hidden} hidden. Run geometry checks after shaping.`);
});
on('delete-border', () => { setDesignTool('edit'); mutate(() => { const d = design(); d.borders = d.borders.filter(b => b.id !== d.activeBorderId); d.activeBorderId = d.borders.at(-1)?.id; }, false); });
input('show-borders').addEventListener('change', () => guard(() => { const show = input('show-borders').checked; if (!show) setDesignTool('edit'); mutate(() => { design().showBorders = show; }, false); }));
on('choose-reference', () => input('reference-file').click());
input('reference-file').addEventListener('change', () => { const file = input('reference-file').files?.[0]; if (file) void guard(() => importReference(file, file.name)); input('reference-file').value = ''; });
on('move-reference', () => setDesignTool(designTool === 'move-reference' ? 'edit' : 'move-reference'));
on('fit-reference', () => mutate(() => { fitReference(design().referenceImage!, project.presentation); }, false));
on('remove-reference', () => { setDesignTool('edit'); imageRequest++; mutate(() => { delete design().referenceImage; }, false); });
input('reference-opacity').addEventListener('input', () => {
  const r = project.design?.referenceImage; if (!r || pendingReduction || view !== 'organic') return;
  opacityBefore ??= structuredClone(project); r.opacity = num('reference-opacity') / 100; unsaved = true;
  $('reference-opacity-value').textContent = `${Math.round(r.opacity * 100)}%`; renderCanvas();
});
input('reference-opacity').addEventListener('change', commitOpacity); input('reference-opacity').addEventListener('blur', commitOpacity);
for (const id of ['reference-visible', 'reference-above', 'reference-x', 'reference-y', 'reference-width', 'reference-rotation']) input(id).addEventListener('change', () => guard(() => {
  mutate(() => {
    const r = design().referenceImage!;
    if (id === 'reference-visible') { r.visible = input(id).checked; if (!r.visible) designTool = 'edit'; }
    else if (id === 'reference-above') r.layer = input(id).checked ? 'above' : 'behind';
    else if (id === 'reference-width') { r.widthMm = num(id); r.heightMm = r.widthMm * r.pixelHeight / r.pixelWidth; }
    else if (id === 'reference-x') r.x = num(id);
    else if (id === 'reference-y') r.y = num(id);
    else r.rotationDeg = num(id);
    validateDesign(project.design, rooted);
  }, false);
}));

// Pointer editing uses shared junctions; handles and waypoints never alter scientific incidence.
type Drag = { kind: 'pan' | 'nodes' | 'handle' | 'waypoint' | 'area' | 'endpoint-area' | 'label' | 'draw-direction' | 'draw-border' | 'border-point' | 'border-move' | 'reference'; start: Point; last: Point; ids: string[]; target: string; before: Project | null; moved: boolean; view: typeof viewBox };
let drag: Drag | null = null;
function canvasPoint(event: PointerEvent | WheelEvent): Point {
  const svg = $('canvas') as unknown as SVGSVGElement, matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()); return { x: point.x, y: point.y };
}
$('stage').addEventListener('pointerdown', event => {
  if(teacher.enabled&&!spaceDown&&event.button!==1){
    if(event.button!==0)return;const element=event.target as Element,target=element.closest<HTMLElement>('[data-structured-node]'),waypoint=element.closest<HTMLElement>('[data-artistic-waypoint]');
    try{if(target||waypoint){const [node,index]=(waypoint?.dataset.artisticWaypoint??target!.dataset.structuredNode!).split(':');const kind=waypoint?'waypoint':target!.tagName.toLowerCase()==='text'?'label':'node';
      if(teacher.beginArtisticPointer(node,kind,canvasPoint(event),event.shiftKey,Number(index??0)))$('stage').setPointerCapture(event.pointerId);else teacher.select(node,event.shiftKey);event.preventDefault();}}
    catch(error){toast(error instanceof Error?error.message:String(error),true);}return;
  }
  if (!ready || event.button > 1 || (event.target as Element).closest('#fit-preview-banner')) return;
  const target = event.target as HTMLElement, node = target.dataset.node, edge = target.dataset.edge, handle = target.dataset.handle, waypoint = target.dataset.waypoint, label = target.dataset.label;
  const borderPoint = target.dataset.borderPoint, borderMove = target.dataset.borderMove;
  const start = canvasPoint(event); let kind: Drag['kind'] = 'pan', ids: string[] = [];
  if (spaceDown || event.button === 1) kind = 'pan';
  else if (designTool === 'draw-direction') kind = 'draw-direction';
  else if (designTool === 'select-endpoints') {
    if (node && reduction.frontier.some(e => e.id === node)) { select(node, event.shiftKey); event.preventDefault(); return; }
    kind = 'endpoint-area'; ids = event.shiftKey ? [...selected] : [];
  } else if (designTool === 'draw-border') {
    kind = 'draw-border'; drawingPoints = [start]; drawingIds = borderScope();
  } else if (designTool === 'edit-border') {
    if (borderPoint || borderMove) {
      kind = borderPoint ? 'border-point' : 'border-move'; design().activeBorderId = (borderPoint || borderMove)!.split(':')[0];
      renderDesignControls(); renderCanvas();
    }
  } else if (designTool === 'move-reference') { if (target.dataset.referenceMove) kind = 'reference'; }
  else if (event.altKey) kind = 'area';
  else if (handle || waypoint || label) { kind = handle ? 'handle' : waypoint ? 'waypoint' : 'label'; ids = [(handle || waypoint || label)!.split(':')[0]]; }
  else if (node || edge) {
    const id = (node || edge)!;
    if (!selected.has(id) || event.shiftKey) select(id, event.shiftKey);
    ids = input('move-subtree').checked ? [...new Set([...selected].flatMap(x => subtreeIds(rooted, x)))] : [...selected];
    kind = node ? 'nodes' : 'pan';
  } else { if (!event.shiftKey) { selected.clear(); renderInspector(); renderCanvas(); } }
  if (view === 'scientific' && kind !== 'pan' && kind !== 'area') return;
  if ((pendingFit || fitPreview) && !['pan', 'area'].includes(kind)) { toast('Keep or discard the fit preview before editing.'); return; }
  if (pendingReduction && !['pan', 'area'].includes(kind)) { toast('Wait for the reduction to finish.'); return; }
  if ((kind === 'handle' || kind === 'waypoint') && project.layout.pinnedEdges.includes(ids[0])) { toast('Unpin this edge before editing its route.'); return; }
  drag = { kind, start, last: start, ids, target: kind === 'draw-direction' ? directionScope : borderPoint || borderMove || handle || waypoint || label || '', before: ['pan', 'area', 'endpoint-area', 'draw-direction', 'draw-border'].includes(kind) ? null : structuredClone(project), moved: false, view: { ...viewBox } };
  $('stage').setPointerCapture(event.pointerId); event.preventDefault();
});
$('stage').addEventListener('pointermove', event => {
  if(teacher.dragging){try{teacher.moveArtisticPointer(canvasPoint(event));}catch(error){teacher.endArtisticPointer(true);toast(error instanceof Error?error.message:String(error),true);}return;}
  if (!drag) return; const point = canvasPoint(event), delta = sub(point, drag.last);
  if (!drag.moved && Math.hypot(point.x - drag.start.x, point.y - drag.start.y) < .08) return;
  drag.moved = true;
  if (drag.kind === 'pan') { viewBox.x -= point.x - drag.start.x; viewBox.y -= point.y - drag.start.y; setViewBox(); return; }
  if (drag.kind === 'area' || drag.kind === 'endpoint-area') { const a = drag.start; $('selection-overlay').innerHTML = `<rect x="${Math.min(a.x, point.x)}" y="${Math.min(a.y, point.y)}" width="${Math.abs(point.x - a.x)}" height="${Math.abs(point.y - a.y)}" fill="#73926922" stroke="#779568" stroke-width=".2"/>`; drag.last = point; return; }
  if (drag.kind === 'draw-direction') {
    const a = drag.start; $('selection-overlay').innerHTML = `<path d="M${a.x},${a.y}L${point.x},${point.y}" stroke="#3e7b9b" stroke-width=".8" marker-end="url(#flow-arrow-head)" pointer-events="none"/>`; drag.last = point; return;
  }
  if (drag.kind === 'draw-border') {
    const samples = event.getCoalescedEvents?.() ?? [];
    for (const sample of samples.length ? samples : [event]) {
      const p = canvasPoint(sample), last = drawingPoints.at(-1)!;
      if (Math.hypot(p.x - last.x, p.y - last.y) >= .3) drawingPoints.push(p);
    }
    if (drawingPoints.length > 4096) drawingPoints = simplifyStroke(drawingPoints, .2);
    drag.last = point; renderCanvas(); return;
  }
  if (drag.kind === 'border-point' || drag.kind === 'border-move' || drag.kind === 'reference') {
    if (drag.kind === 'reference') { const r = design().referenceImage!; r.x += delta.x; r.y += delta.y; }
    else {
      const [id, index] = drag.target.split(':'), b = design().borders.find(b => b.id === id)!;
      if (drag.kind === 'border-point') b.points[Number(index)] = point;
      else b.points = b.points.map(p => add(p, delta));
    }
    drag.last = point; renderCanvas(); return;
  }
  if (drag.kind === 'nodes') {
    let movement = delta;
    if (input('snap-grid').checked) { const anchor = project.layout.nodes[drag.ids[0]]; const desired = add(anchor, delta); movement = { x: Math.round(desired.x) - anchor.x, y: Math.round(desired.y) - anchor.y }; }
    moveNodes(project.layout, rooted, drag.ids, movement);
  } else if (drag.kind === 'label') {
    const id = drag.ids[0]; project.presentation.labelOffsets[id] = add(project.presentation.labelOffsets[id] ?? { x: 1.2, y: -.7 }, delta);
  } else {
    const [id, index, key] = drag.target.split(':'), segment = project.layout.routes[id].segments[Number(index)];
    if (drag.kind === 'handle') segment[key as 'c1' | 'c2'] = point;
    else { segment.end = point; segment.c2 = add(segment.c2, delta); const next = project.layout.routes[id].segments[Number(index) + 1]; if (next) next.c1 = add(next.c1, delta); }
  }
  drag.last = point; editVersion++; qa = null; renderCanvas();
});
function endDrag(cancel = false): void {
  if(teacher.dragging){try{teacher.endArtisticPointer(cancel);}catch(error){toast(error instanceof Error?error.message:String(error),true);}}
  if (!drag) return;
  const current = drag; drag = null;
  if (cancel) { if (current.before) project = current.before; }
  else if (current.kind === 'draw-direction') {
    designTool = 'edit';
    try { const angleDeg = directionAngle(current.start, current.last); saveDirection({ angleDeg, strength: num('fit-direction-strength') / 100 }, current.target); toast(`Direction set to ${angleDeg.toFixed(1)}°. Preview the fit to apply it.`); }
    catch (error) { toast(error instanceof Error ? error.message : String(error), true); }
  } else if (current.moved && current.kind === 'draw-border') {
    try { drawingPoints.push(current.last); finishBorder(); } catch (error) { toast(error instanceof Error ? error.message : String(error), true); }
  } else if (current.moved && current.before) {
    if (['border-point', 'border-move', 'reference'].includes(current.kind)) {
      try { validateDesign(project.design, rooted); accepted(current.before); unsaved = true; }
      catch (error) { project = current.before; toast(error instanceof Error ? error.message : String(error), true); }
    } else { try { accepted(current.before, { kind: current.kind === 'label' ? 'annotation' : 'manual', notes: 'One accepted drag; intermediate pointer samples were not recorded.' }); invalidate(); } catch (error) { project = current.before; toast(error instanceof Error ? error.message : String(error), true); } }
  } else if (current.kind === 'endpoint-area') {
    const a = current.start, b = current.last;
    const enclosed = current.moved ? reduction.frontier.filter(e => {
      const p = workingLayout().nodes[e.id];
      return e.id !== rooted.rootId && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
    }).map(e => e.id) : [];
    selected = new Set([...current.ids, ...enclosed]);
  } else if (current.moved && current.kind === 'area') {
    const a = current.start, b = current.last; selected = new Set(reduction.visible.filter(id => { const p = workingLayout().nodes[id]; return p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y); }));
  }
  drawingPoints = []; renderCanvas(); renderInspector(); renderQA(); renderDesignControls(); renderFitControls(); updateButtons();
}
$('stage').addEventListener('pointerup', () => endDrag()); $('stage').addEventListener('pointercancel', () => endDrag(true));
$('stage').addEventListener('wheel', event => {
  if (!ready || (event.target as Element).closest('#fit-preview-banner')) return; event.preventDefault(); const point = canvasPoint(event), factor = Math.exp(Math.max(-.25, Math.min(.25, event.deltaY * .0015)));
  if (viewBox.h * factor < 5 || viewBox.h * factor > (teacher.enabled?teacher.dimensions.heightMm:project.presentation.heightMm) * 8) return;
  viewBox = { x: point.x + (viewBox.x - point.x) * factor, y: point.y + (viewBox.y - point.y) * factor, w: viewBox.w * factor, h: viewBox.h * factor };
  setViewBox(); $('zoom-label').textContent = `${Math.round(project.presentation.heightMm / viewBox.h * 100)}%`;
}, { passive: false });
window.addEventListener('keydown', event => {
  if (explorer.active) return;
  const target = event.target as HTMLElement; if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable || !ready) return;
  if (event.code === 'Space') { spaceDown = true; event.preventDefault(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); restoreHistory(event.shiftKey ? 'redo' : 'undo'); }
  if (event.key === 'Escape') { teacher.discard(); clearFit(); setDesignTool('edit'); render(); }
  if (!teacher.enabled && selected.size && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && view === 'organic' && designTool === 'edit') {
    event.preventDefault(); const d = event.shiftKey ? 1 : .1; void guard(() => mutate(() => moveNodes(project.layout, rooted, [...selected], { x: event.key === 'ArrowLeft' ? -d : event.key === 'ArrowRight' ? d : 0, y: event.key === 'ArrowUp' ? -d : event.key === 'ArrowDown' ? d : 0 })));
  }
});
window.addEventListener('keyup', event => { if (event.code === 'Space') spaceDown = false; });
window.addEventListener('blur', () => { spaceDown = false; endDrag(true); });
window.addEventListener('beforeunload', event => { if (unsaved) { event.preventDefault(); event.returnValue = ''; } });

on('explore-view-btn', () => {
  if (!ready || importing || pendingReduction || pendingFit || fitPreview || teacher.pending || teacher.preview) throw new Error('Finish or discard the current preview before exploring the source.');
  explorer.open({source, root: project.recipe.root, childOrder: project.layout.childOrder, corrections: project.corrections, basis: project.authoring!.basis, rootState: project.authoring!.root, title: sourceHeading(source.sha256, project.provenance, project.authoring?.basis.name).title});
});

async function initialize(): Promise<void> {
  const responses = await Promise.all(['/data/source_tree.nwk', '/data/source_manifest.json', '/data/example_reduction_recipe.json', '/data/annotation_review.json', '/build-info.json', '/build-manifest.json'].map(async url => { const response = await fetch(url); if (!response.ok) throw new Error(`Could not load ${url}.`); return response; }));
  const [text, provenance, fixture, corrections] = await Promise.all([responses[0].text(), responses[1].json(), responses[2].json(), responses[3].json()]);
  const [info, manifest] = await Promise.all([responses[4].json(), responses[5].json()]);
  await verifyBuildIdentity(info, manifest); exportingBuild = info; exportingBuildManifest = manifest;
  source = await parseNewick(text); if (source.sha256 !== HUG_SHA) throw new Error('Bundled source checksum does not match the pinned Hug dataset.');
  const recipe: Recipe = { ...defaultRecipe(source), ...fixture }; rooted = orient(source, recipe.root); reduction = reduce(source, rooted, recipe, true);
  project = { format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: 'The tree of life', sourceText: source.text, sourceSha256: source.sha256, provenance, corrections, recipe, layout: generateLayout(rooted, reduction, DEFAULT_PRESENTATION, 'organic'), presentation: structuredClone(DEFAULT_PRESENTATION) };
  syncRecipe(); project = startAuthoring(project, source, exportingBuild, 'new', ['newick-parser', 'maximal-frontier', 'organic-initializer']);
  syncRecipe(); scientificLayout = generateLayout(rooted, reduction, project.presentation, 'scientific'); ready = true; $('loading').hidden = true; render(); fit();
}
void initialize().catch(error => { $('loading').textContent = `Could not start: ${error.message}`; toast(error.message, true); });
