import type { Source, RootSpec, Rooted, RootedNode, Recipe, Reduction, FrontierEntry, Correction } from './types.ts';
import { quoteLabel } from './newick.ts';

export const HUG_SHA = '9829bbe7c058d7807c10fa63f7e6977087206e4355b60162ece4a45086540c61';
export function defaultRecipe(source: Source): Recipe {
  return {
    algorithm: 'maximal_frontier_v1', sourceSha256: source.sha256,
    root: source.sha256 === HUG_SHA
      ? { kind: 'edge', sourceEdge: ['n000000', 'n000001'], fraction: 0.5, status: 'declared_assumption' }
      : { kind: 'node', sourceNodeId: source.rootId, status: 'serialization_origin_not_biological_root' },
    globalThreshold: .65, thresholdOverrides: [], protectOverridePaths: true,
    comparison: 'strict_less_than', protect: [], collapse: [], expand: [],
  };
}

export function orient(source: Source, root: RootSpec): Rooted {
  type Adj = { to: string; length: number | null; sourceEdgeId: string; annotations: RootedNode['annotations'] };
  const adjacency: Record<string, Adj[]> = Object.fromEntries(source.order.map(id => [id, []]));
  for (const id of source.order) for (const child of source.nodes[id].children) {
    const n = source.nodes[child], edge = { length: n.length, sourceEdgeId: `e-${child}`, annotations: n.annotations };
    adjacency[id].push({ to: child, ...edge }); adjacency[child].push({ to: id, ...edge });
  }
  let rootId: string;
  if (root.kind === 'edge') {
    const [a, b] = root.sourceEdge;
    const edge = adjacency[a]?.find(x => x.to === b);
    if (!edge) throw new Error('The chosen root edge is not in the original source.');
    if (!Number.isFinite(root.fraction) || root.fraction <= 0 || root.fraction >= 1) throw new Error('Root fraction must be strictly between 0 and 1.');
    rootId = 'virtual-root'; adjacency[rootId] = [];
    adjacency[a] = adjacency[a].filter(x => x.to !== b); adjacency[b] = adjacency[b].filter(x => x.to !== a);
    for (const [to, fraction] of [[a, root.fraction], [b, 1 - root.fraction]] as [string, number][]) {
      const length = edge.length === null ? null : edge.length * fraction;
      adjacency[rootId].push({ ...edge, to, length }); adjacency[to].push({ ...edge, to: rootId, length });
    }
    // Keep the original serialized child side first, matching the bundled audit's frontier order.
    if (source.nodes[a].children.includes(b)) adjacency[rootId].reverse();
  } else {
    rootId = root.sourceNodeId;
    if (!adjacency[rootId]) throw new Error('Unknown root node.');
    if (source.tips.includes(rootId) && source.tips.length > 1) throw new Error('Root on the terminal edge, not on a terminal node.');
  }
  const nodes: Record<string, RootedNode> = {}, order: string[] = [];
  const stack = [{ id: rootId, parent: null as string | null, length: null as number | null, sourceEdgeId: null as string | null, annotations: [] as RootedNode['annotations'] }];
  while (stack.length) {
    const entry = stack.pop()!; const children = adjacency[entry.id].filter(x => x.to !== entry.parent);
    nodes[entry.id] = { ...entry, children: children.map(x => x.to), members: [], count: 0, sum: 0, mean: 0 }; order.push(entry.id);
    for (const child of [...children].reverse()) stack.push({ ...child, id: child.to, parent: entry.id });
  }
  for (const id of [...order].reverse()) {
    const n = nodes[id];
    n.members = n.children.length ? n.children.flatMap(c => nodes[c].members) : [id];
    n.count = n.members.length;
    n.sum = n.children.reduce((sum, c) => sum + nodes[c].sum + (nodes[c].length ?? NaN) * nodes[c].count, 0);
    n.mean = n.sum / n.count;
  }
  if (nodes[rootId].count !== source.tips.length) throw new Error('Rooting lost source tip identities.');
  return { rootId, nodes, order, root: structuredClone(root), distanceUsable: source.distanceUsable };
}

export function reduce(source: Source, rooted: Rooted, recipe: Recipe, verifyReplay = false): Reduction {
  if (recipe.algorithm !== 'maximal_frontier_v1' || recipe.comparison !== 'strict_less_than' || recipe.protectOverridePaths !== true) throw new Error('Unsupported reduction policy.');
  if (recipe.sourceSha256 !== source.sha256) throw new Error('The recipe belongs to a different source checksum.');
  const threshold = (v: number) => { if (!Number.isFinite(v) || v < 0) throw new Error('Thresholds must be finite and nonnegative.'); };
  threshold(recipe.globalThreshold);
  const overrides = new Map<string, number>();
  for (const item of recipe.thresholdOverrides) {
    threshold(item.threshold);
    if (overrides.has(item.sourceNodeId)) throw new Error(`Duplicate override for ${item.sourceNodeId}.`);
    overrides.set(item.sourceNodeId, item.threshold);
  }
  const collapse = new Set(recipe.collapse), expand = new Set(recipe.expand), protect = new Set(recipe.protect);
  const needsPath = new Set([...overrides.keys(), ...expand, ...protect, ...collapse]);
  for (const id of needsPath) if (!rooted.nodes[id]) throw new Error(`Unknown source node ${id}.`);
  if (collapse.has(rooted.rootId)) throw new Error('The designated root cannot be collapsed.');
  const blocked = new Set<string>([rooted.rootId, ...expand, ...protect]);
  for (const id of needsPath) {
    let parent = rooted.nodes[id].parent;
    while (parent) { blocked.add(parent); parent = rooted.nodes[parent].parent; }
  }
  for (const id of collapse) if (blocked.has(id)) throw new Error(`Contradictory rules at ${id}: its collapse would hide a protected, expanded, overridden, or explicitly selected descendant. Remove the conflicting rule first.`);
  const frontier: FrontierEntry[] = [], visible: string[] = [];
  const stack = [{ id: rooted.rootId, value: recipe.globalThreshold }];
  while (stack.length) {
    const { id, value } = stack.pop()!, n = rooted.nodes[id]; visible.push(id);
    const effective = overrides.get(id) ?? value;
    const eligible = !blocked.has(id) && rooted.distanceUsable && n.mean < effective;
    if (!n.children.length || collapse.has(id) || eligible) {
      frontier.push({ id, members: [...n.members], mean: Number.isFinite(n.mean) ? n.mean : null, threshold: effective, rule: !n.children.length ? 'source_tip' : collapse.has(id) ? 'explicit_collapse' : 'mean_below_threshold' });
    } else for (const child of [...n.children].reverse()) stack.push({ id: child, value: effective });
  }
  const members = frontier.flatMap(x => x.members), unique = new Set(members);
  if (members.length !== source.tips.length || unique.size !== members.length || source.tips.some(id => !unique.has(id))) throw new Error('The frontier is not an exhaustive partition of original tips.');
  if (verifyReplay && recipe.resolvedFrontierSourceNodeIds && JSON.stringify(frontier.map(x => x.id)) !== JSON.stringify(recipe.resolvedFrontierSourceNodeIds)) throw new Error('Saved frontier does not replay with maximal_frontier_v1. The project was not changed.');
  const counts: Record<string, number> = {};
  for (const entry of frontier) { const domains = [...new Set(entry.members.map(id => labelDomain(source.nodes[id].label)))]; const key = domains.length === 1 ? domains[0] : 'Mixed'; counts[key] = (counts[key] ?? 0) + 1; }
  return { frontier, visible, tipCount: members.length, counts };
}

export function labelDomain(label: string): string {
  if (label.startsWith('Bacteria_')) return 'Bacteria';
  if (label.startsWith('Archaea_')) return 'Archaea';
  if (label.startsWith('Eukaryota_') || label.startsWith('Archaeplastida_')) return 'Eukaryota';
  return 'Unclassified';
}
export function displayLabel(source: Source, id: string, corrections: Correction[] = []): string {
  const node = source.nodes[id]; if (!node) return 'Declared root';
  if (node.children.length) return node.label || `Source clade ${id}`;
  return corrections.find(x => x.source_node_id === id)?.display_taxonomy || node.label;
}
export function reducedNewick(source: Source, rooted: Rooted, reduction: Reduction): string {
  const frontier = new Set(reduction.frontier.map(x => x.id));
  const emit = (id: string): string => {
    const n = rooted.nodes[id];
    const body = frontier.has(id) ? quoteLabel(id) : `(${n.children.map(emit).join(',')})${quoteLabel(id)}`;
    // Comments stay attached to original split provenance, including both root-edge pieces.
    const length = n.parent && n.length !== null && Number.isFinite(n.length) ? `:${n.length}` : '';
    const metadata = n.sourceEdgeId ? `[&source_edge=${n.sourceEdgeId}]${n.annotations.map(a => `[${a.text}]`).join('')}` : '';
    return body + length + metadata;
  };
  return `[&source_sha256=${source.sha256},algorithm=maximal_frontier_v1,endpoints=${reduction.frontier.length}]${emit(rooted.rootId)};\n`;
}
