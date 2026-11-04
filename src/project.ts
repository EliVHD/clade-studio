import type { Source, Project, Rooted, Reduction, Layout, Presentation } from './types.ts';
import { parseNewick } from './newick.ts';
import { orient, reduce } from './science.ts';
import { validateDesign } from './design.ts';

export function validatePresentation(p: Presentation): void {
  for (const [key, low, high] of [
    ['widthMm', 20, 2000], ['heightMm', 20, 2000], ['strokeMm', .01, 10], ['taper', 0, 5],
    ['clearanceMm', 0, 20], ['toleranceMm', .001, .5], ['junctionMm', .05, 10], ['sourceUnitMm', .001, 10000],
  ] as const) if (!Number.isFinite(p[key]) || p[key] < low || p[key] > high) throw new Error(`${key} must be between ${low} and ${high}.`);
  if (typeof p.labels !== 'boolean' || !p.labelOffsets || typeof p.labelOffsets !== 'object') throw new Error('Invalid annotation settings.');
}
export function validateLayout(layout: Layout, rooted: Rooted, reduction: Reduction): void {
  if (!layout || !layout.nodes || !layout.routes || !['organic', 'scientific'].includes(layout.mode)) throw new Error('Invalid project geometry.');
  if (layout.lineStyle !== undefined && !['curved', 'straight'].includes(layout.lineStyle)) throw new Error('Invalid line style.');
  const point = (p: { x: number; y: number }) => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 10000 && Math.abs(p.y) < 10000;
  for (const [id, p] of Object.entries(layout.nodes)) if (!rooted.nodes[id] || !point(p)) throw new Error(`Invalid junction ${id}.`);
  for (const [id, r] of Object.entries(layout.routes)) {
    if (!rooted.nodes[id]?.parent || !Array.isArray(r.segments) || !r.segments.length || r.segments.length > 24 || r.segments.some(s => !point(s.c1) || !point(s.c2) || !point(s.end))) throw new Error(`Invalid route ${id}.`);
    const end = r.segments.at(-1)!.end, node = layout.nodes[id];
    if (!node || Math.hypot(end.x - node.x, end.y - node.y) > 1e-8) throw new Error(`Detached endpoint at ${id}.`);
  }
  for (const id of reduction.visible) if (!layout.nodes[id] || (rooted.nodes[id].parent && !layout.routes[id])) throw new Error(`Missing visible geometry at ${id}.`);
  for (const ids of [layout.pinnedNodes, layout.pinnedEdges]) if (!Array.isArray(ids) || ids.some(id => !rooted.nodes[id])) throw new Error('Unknown pin identity.');
  for (const [id, children] of Object.entries(layout.childOrder ?? {})) {
    const expected = rooted.nodes[id]?.children;
    if (!expected || !Array.isArray(children) || children.length !== expected.length || new Set(children).size !== children.length || children.some(c => !expected.includes(c))) throw new Error(`Child rotation at ${id} changes topology.`);
  }
}
export async function loadProject(text: string): Promise<{ project: Project; source: Source; rooted: Rooted; reduction: Reduction }> {
  if (text.length > 50_000_000) throw new Error('Project exceeds the 50 MB import limit.');
  const project = JSON.parse(text) as Project;
  if (project.format !== 'phylogenetic-tree-studio' || project.version !== 1) throw new Error('Unsupported project format/version.');
  if (typeof project.title !== 'string') throw new Error('Invalid project title.');
  if (typeof project.sourceText !== 'string' || !project.recipe || !Array.isArray(project.corrections)) throw new Error('Project is missing scientific data.');
  const source = await parseNewick(project.sourceText);
  if (source.sha256 !== project.sourceSha256) throw new Error('Embedded source checksum does not match the project.');
  if (!project.recipe.resolvedFrontierSourceNodeIds) throw new Error('Project is missing its resolved reduction frontier.');
  const rooted = orient(source, project.recipe.root), reduction = reduce(source, rooted, project.recipe, true);
  validatePresentation(project.presentation); validateLayout(project.layout, rooted, reduction);
  validateDesign(project.design, rooted);
  for (const [id, p] of Object.entries(project.presentation.labelOffsets)) if (!rooted.nodes[id] || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error('Invalid label offset.');
  for (const c of project.corrections) {
    if (!source.nodes[c.source_node_id] || source.nodes[c.source_node_id].rawLabel !== c.raw_label) throw new Error('A correction no longer matches its original source label.');
    if (c.display_taxonomy !== null && typeof c.display_taxonomy !== 'string') throw new Error('Invalid display taxonomy.');
    if (c.evidence_url !== null && (typeof c.evidence_url !== 'string' || !/^https?:\/\//i.test(c.evidence_url))) throw new Error('Correction evidence must use an HTTP or HTTPS URL.');
  }
  if (project.selection && (!Array.isArray(project.selection) || project.selection.some(id => !rooted.nodes[id]))) throw new Error('Selection contains unknown source IDs.');
  return { project, source, rooted, reduction };
}
export class History<T> {
  past: T[] = []; future: T[] = [];
  push(value: T): void { this.past.push(structuredClone(value)); if (this.past.length > 40) this.past.shift(); this.future = []; }
  undo(current: T): T | null { const previous = this.past.pop(); if (!previous) return null; this.future.push(structuredClone(current)); return previous; }
  redo(current: T): T | null { const next = this.future.pop(); if (!next) return null; this.past.push(structuredClone(current)); return next; }
  clear(): void { this.past = []; this.future = []; }
}
