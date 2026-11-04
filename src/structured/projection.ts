import type { Source, Rooted, Correction } from '../types.ts';
import type { DisplayGraph, DisplayNode, ProjectionSpec, DisplayEdge } from './types.ts';
import { displayLabel } from '../science.ts';

const exact = (value: object, fields: string[]) => { if (!value || Array.isArray(value) || typeof value !== 'object' || fields.some(key => !Object.hasOwn(value,key)) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid projection fields.'); };
export function validateProjection(spec: ProjectionSpec, source: Source, rooted: Rooted): void {
  exact(spec, ['selection','collapse','expand','reveal','childOrder']);
  if (!spec.selection || !['all','explicit-tips'].includes(spec.selection.kind)) throw new Error('Unknown taxon selection.');
  exact(spec.selection, spec.selection.kind === 'all' ? ['kind'] : ['kind','tipIds']);
  const checkIds = (ids: string[], allowed: Set<string>) => { if (!Array.isArray(ids) || ids.length > source.order.length || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error('Unknown or duplicate source identities in selection/projection.'); };
  if (spec.selection.kind === 'explicit-tips') {
    checkIds(spec.selection.tipIds,new Set(source.tips)); if (!spec.selection.tipIds.length) throw new Error('Select at least one source tip.');
  }
  const nodes = new Set(rooted.order); for (const ids of [spec.collapse,spec.expand,spec.reveal]) checkIds(ids,nodes);
  if (spec.collapse.includes(rooted.rootId)) throw new Error('The declared root cannot be collapsed.');
  for (const id of spec.collapse) if (!rooted.nodes[id].children.length) throw new Error('An individual tip cannot be explicitly collapsed.');
  for (const id of [...spec.expand,...spec.reveal,...spec.collapse]) {
    let p = rooted.nodes[id].parent;
    if ((spec.expand.includes(id) || spec.reveal.includes(id)) && spec.collapse.includes(id)) throw new Error('Collapse would hide a protected/revealed node.');
    while (p) { if (spec.collapse.includes(p)) throw new Error('Collapse would hide another explicit collapse, expansion or highlight.'); p = rooted.nodes[p].parent; }
  }
  if (!spec.childOrder || typeof spec.childOrder !== 'object' || Array.isArray(spec.childOrder)) throw new Error('Invalid child ordering.');
  for (const [id, children] of Object.entries(spec.childOrder)) {
    const original = rooted.nodes[id]?.children;
    if (!original || !Array.isArray(children) || original.length !== children.length || new Set(children).size !== children.length || children.some(c => !original.includes(c))) throw new Error('Only permutations of complete child subtrees are allowed.');
  }
}
/** Explicit selected-tip projection; maximal_frontier_v1 is intentionally not used here. */
export function projectTree(source: Source, rooted: Rooted, spec: ProjectionSpec, corrections: Correction[] = []): DisplayGraph {
  validateProjection(spec,source,rooted);
  const selected = new Set(spec.selection.kind === 'all' ? source.tips : spec.selection.tipIds);
  const members: Record<string,string[]> = {}, relevant = new Set<string>();
  for (const id of [...rooted.order].reverse()) {
    members[id] = rooted.nodes[id].children.length ? rooted.nodes[id].children.flatMap(c => members[c]) : selected.has(id) ? [id] : [];
    if (members[id].length) relevant.add(id);
  }
  const collapsed = new Set(spec.collapse), protectedIds = new Set([...spec.reveal,...spec.expand]);
  for (const id of [...spec.collapse,...protectedIds]) if (!relevant.has(id)) throw new Error(`Explicit node ${id} has no selected descendants; remove its projection rule first.`);
  const nodes: Record<string,DisplayNode> = {}, edges: Record<string,DisplayEdge> = {}, order: string[] = [], endpoints: string[] = [];
  const childrenOf = (id: string) => (spec.childOrder[id] ?? rooted.nodes[id].children).filter(c => relevant.has(c));
  const keep = (id: string) => id === rooted.rootId || collapsed.has(id) || protectedIds.has(id) || childrenOf(id).length !== 1 || !!source.nodes[id]?.label || rooted.nodes[id].annotations.length > 0 || (source.nodes[id]?.annotations.length ?? 0) > 0;
  const visit = (id: string, parent: string | null, path: string[]) => {
    if (!keep(id)) { visit(childrenOf(id)[0],parent,[...path,id]); return; }
    const n = rooted.nodes[id], children = collapsed.has(id) ? [] : childrenOf(id);
    const selectedMembers = members[id], originalMembers = n.members;
    const aggregate = collapsed.has(id) && n.children.length > 0;
    nodes[id] = { id, parent, children: [], selectedMembers: [...selectedMembers], originalMembers: [...originalMembers], omittedMembers: originalMembers.filter(t => !selected.has(t)), aggregate, label: aggregate ? `Source clade ${id} (${selectedMembers.length} selected${originalMembers.length !== selectedMembers.length ? ` / ${originalMembers.length} original` : ''})` : displayLabel(source,id,corrections) };
    order.push(id); if (parent) nodes[parent].children.push(id);
    if (parent) {
      const sourcePath = [...path,id], lengths = sourcePath.map(x => rooted.nodes[x].length);
      const length = lengths.every(v => v !== null && Number.isFinite(v) && v >= 0) ? (lengths as number[]).reduce((a,b) => a+b,0) : null;
      edges[`display-edge-${id}`] = { id: `display-edge-${id}`, parent, child: id, sourcePath: [parent,...sourcePath], sourceEdgeIds: sourcePath.map(x => rooted.nodes[x].sourceEdgeId!), length, annotations: sourcePath.flatMap(x => rooted.nodes[x].annotations.map(a => ({ sourceNodeId: x, ...a }))) };
    }
    if (!children.length) endpoints.push(id); else for (const child of children) visit(child,id,[]);
  };
  visit(rooted.rootId,null,[]);
  const representedTips = endpoints.flatMap(id => nodes[id].selectedMembers), unique = new Set(representedTips);
  if (unique.size !== representedTips.length || unique.size !== selected.size || [...selected].some(id => !unique.has(id))) throw new Error('Selected tips do not form an exact endpoint partition.');
  return { rootId: rooted.rootId, nodes, edges, order, endpoints, representedTips, omittedTips: source.tips.filter(id => !selected.has(id)), sourceSha256: source.sha256 };
}
export function sourceMRCA(rooted: Rooted, tipIds: string[]): string {
  if (!tipIds.length || tipIds.some(id => !rooted.nodes[id])) throw new Error('Select valid source identities for an ancestor query.');
  const ancestors = (id: string) => { const ids: string[] = []; let current: string | null = id; while (current) { ids.push(current); current = rooted.nodes[current].parent; } return ids; };
  const paths = tipIds.map(id => new Set(ancestors(id)));
  return ancestors(tipIds[0]).find(id => paths.every(path => path.has(id)))!;
}
