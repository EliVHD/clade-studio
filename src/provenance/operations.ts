import type { Project } from '../types.ts';
import type { BuildInfo } from './identity.ts';
import type { Head, OperationRecord, ProvenanceState, SavedView, WorkingProject } from '../model/document.ts';
import { digestSync, persisted } from './sync-identity.ts';
import { validateScientificBasis } from '../model/basis.ts';
import { METHOD_REGISTRY, METHOD_REFERENCES, methodKey, validateMethod, validateReference } from './registry.ts';

export type CommandEvidence = { kind?: OperationRecord['kind']; methods?: string[]; parameters?: Record<string, unknown>; result?: Record<string, unknown>; notes?: string; inputs?: string[]; replace?: boolean };
export const viewPrefix = (id: string) => `view/${id}/`;
function viewComponents(view: SavedView): Record<string, unknown> {
  const prefix = viewPrefix(view.id), result: Record<string, unknown> = {};
  for (const [kind, entries] of Object.entries({ nodes: view.layout.nodes, routes: view.layout.routes, order: view.layout.childOrder, labels: view.appearance.labelOffsets })) for (const [id, value] of Object.entries(entries)) result[`${prefix}${kind}/${id}`] = value;
  const { labelOffsets: _offsets, ...appearance } = view.appearance;
  result[`${prefix}appearance`] = { ...appearance, lineStyle: view.layout.lineStyle ?? 'curved' };
  result[`${prefix}pins`] = { nodes: view.layout.pinnedNodes, edges: view.layout.pinnedEdges };
  result[`${prefix}intent`] = view.intent; result[`${prefix}name`] = view.name;
  if (view.design) {
    const { fitSettings: _controls, activeBorderId: _active, showBorders: _show, ...context } = view.design;
    if (context.borders.length || context.referenceImage) result[`${prefix}context`] = context;
  }
  return result;
}
export function activeView(project: WorkingProject): SavedView {
  return persisted({ id: project.authoring.activeViewId, name: project.authoring.viewName, intent: project.layout.mode === 'organic' ? 'artistic' : 'legacy-inspection', adapter: 'legacy-artistic-v1', layout: project.layout, appearance: project.presentation, ...(project.design ? { design: project.design } : {}) });
}
export function componentValues(project: WorkingProject, includeBasis = true): Record<string, unknown> {
  const state = project.authoring;
  return persisted({
    source: { sourceId: state.source.id, sha256: project.sourceSha256 },
    'document/title': project.title,
    ...(Object.keys(state.structuredViews ?? {}).length ? { 'structured-scientific': { root: state.root, traversal: project.recipe.root, corrections: project.corrections } } : {}),
    ...Object.fromEntries(Object.values(state.structuredViews ?? {}).map(view => [`structured/${view.id}`,view])),
    ...(includeBasis ? { basis: state.basis } : {}),
    scientific: { root: state.root, recipe: project.recipe, corrections: project.corrections, edgeMeasure: state.edgeMeasure },
    ...Object.assign({}, ...Object.values(state.otherViews).map(viewComponents)),
    ...viewComponents(activeView(project)),
  });
}
export function componentRevisions(project: WorkingProject, includeBasis = true): Record<string, string> { return Object.fromEntries(Object.entries(componentValues(project, includeBasis)).map(([key, value]) => [key, digestSync(value)])); }
export function operationId(record: Omit<OperationRecord, 'id'> | OperationRecord): string {
  const { recordedAt: _time, id: _id, ...content } = record as OperationRecord;
  return `operation-${digestSync(content)}`;
}
export function contributionClosure(provenance: ProvenanceState, componentNames = Object.keys(provenance.heads)): Record<string, OperationRecord> {
  const collected: Record<string, OperationRecord> = {}, active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) throw new Error('Cyclic operation history.');
    if (collected[id]) return;
    const record = provenance.operations[id]; if (!record) throw new Error(`Missing operation ${id}.`);
    active.add(id);
    for (const input of Object.values(record.inputs)) visit(input.operationId);
    active.delete(id); collected[id] = record;
  };
  for (const name of componentNames) if (provenance.heads[name]) visit(provenance.heads[name].operationId);
  return collected;
}
export function seedCheckpoint(project: WorkingProject, history: 'legacy' | 'new', build: BuildInfo | null, executedMethods: string[] = []): void {
  const state = project.authoring, outputs = componentRevisions(project), allKeys = history === 'new' ? executedMethods.map(methodKey) : [];
  for (const key of allKeys) { if (!METHOD_REGISTRY[key]) throw new Error(`Unknown creation method ${key}.`); state.provenance.methods[key] = structuredClone(METHOD_REGISTRY[key]); }
  const geometry = (key: string) => key.startsWith('structured/') || /\/(nodes|routes|order)\//.test(key);
  const groups = [['source'], ['scientific', 'basis'], Object.keys(outputs).filter(key => key !== 'source' && key !== 'scientific' && key !== 'basis' && !geometry(key)), Object.keys(outputs).filter(geometry)];
  for (let group = 0; group < groups.length; group++) {
    const names = groups[group]; if (!names.length) continue;
    const methods = allKeys.filter(key => group === 0 ? METHOD_REGISTRY[key].category === 'import' : group === 1 ? METHOD_REGISTRY[key].category === 'scientific' : group === 3 ? METHOD_REGISTRY[key].category === 'layout' : false);
    const inputs = group === 0 ? {} : Object.fromEntries(Object.entries(state.provenance.heads).filter(([key]) => key === 'source' || (group === 3 && (key === 'scientific' || key === 'basis' || key.endsWith('/appearance') || key.endsWith('/pins')))));
    const record: OperationRecord = {
      id: '', kind: history === 'legacy' ? 'migration' : group === 1 ? 'scientific' : group === 3 ? 'layout' : 'context', methods: methods.map(key => ({ key, buildId: build?.buildId ?? null })),
      scope: { sourceId: state.source.id, viewId: names.find(key=>key.startsWith('structured/'))?.slice(11) ?? state.activeViewId, components: names.sort(), sourceNodeIds: [] }, inputs,
      outputs: Object.fromEntries(names.map(key => [key, outputs[key]])), parameters: history === 'legacy' ? { authoringHistory: 'unknown', ...(group === 1 ? { existingReductionRecipe: project.recipe } : {}) } : group === 1 ? { recipe: project.recipe } : group === 3 ? { presentation: project.presentation, childOrder: project.layout.childOrder, lineStyle: project.layout.lineStyle ?? 'curved', pinnedNodes: project.layout.pinnedNodes, pinnedEdges: project.layout.pinnedEdges } : { sourceSha256: project.sourceSha256 },
      referenceUses: group === 0 ? state.source.referenceIds.map(referenceId => ({ referenceId, role: 'input-tree', relationship: 'uses-data' })) : [],
      result: { sourceAndFinalGeometryPreserved: true, importerBuildId: build?.buildId ?? null }, recordedAt: new Date().toISOString(),
      notes: history === 'legacy' ? 'Validated legacy import. Stored controls do not establish which layout/fit methods were previously applied.' : 'New document baseline. Source inference was not performed by this application.',
    };
    record.id = operationId(record); state.provenance.operations[record.id] = record;
    for (const key of names) state.provenance.heads[key] = { revision: outputs[key], operationId: record.id };
  }
}

/** Candidate has already passed scientific/geometry validation; original state is not mutated. */
export function recordAccepted(before: WorkingProject, candidate: WorkingProject, evidence: CommandEvidence, build: BuildInfo | null): WorkingProject {
  const next = { ...candidate, authoring: structuredClone(candidate.authoring) }, state = next.authoring;
  const old = componentRevisions(before), revised = componentRevisions(next);
  const changed = Object.keys(revised).filter(key => old[key] !== revised[key]);
  const removed = Object.keys(old).filter(key => !(key in revised));
  if (!changed.length && !removed.length) return next;
  const keys = (evidence.methods ?? []).map(methodKey);
  for (const key of keys) {
    const definition = METHOD_REGISTRY[key];
    if (!definition || definition.status !== 'implemented') throw new Error(`Method is not available for execution: ${key}`);
    state.provenance.methods[key] = structuredClone(definition);
    for (const use of definition.referenceUses) { const ref=METHOD_REFERENCES[use.referenceId]; if(ref)state.provenance.references[ref.id]=structuredClone(ref); }
  }
  const geometry = (key: string) => key.startsWith('structured/') || /\/(nodes|routes|order)\//.test(key);
  const groups = [changed.filter(key => key === 'scientific' || key === 'basis' || key === 'structured-scientific'), changed.filter(key => key !== 'scientific' && key !== 'basis' && key !== 'structured-scientific' && !geometry(key)), changed.filter(geometry)];
  for (let group = 0; group < groups.length; group++) {
    const names = groups[group]; if (!names.length) continue;
    const methodKeys = keys.filter(key => group === 0 ? METHOD_REGISTRY[key].category === 'scientific' : group === 2 ? (names.some(name=>name.startsWith('structured/')) || METHOD_REGISTRY[key].category === 'layout') : false);
    const defaultInputs = evidence.replace ? ['source', 'scientific'] : names;
    const structuredOnly = names.every(name=>name.startsWith('structured/'));
    const consumed = group === 0 ? names.includes('structured-scientific') ? ['source','basis',...(state.provenance.heads['structured-scientific']?['structured-scientific']:[])] : ['source', ...(names.includes('scientific') ? ['basis', ...(evidence.replace ? [] : ['scientific'])] : ['scientific'])] : group === 1 ? names : structuredOnly ? [...(evidence.inputs??(evidence.replace?[]:names)), 'source','basis','structured-scientific'] : [...(evidence.inputs ?? defaultInputs), 'source', 'scientific', 'basis', `${viewPrefix(state.activeViewId)}appearance`, `${viewPrefix(state.activeViewId)}pins`];
    const inputs: Record<string, Head> = {};
    for (const key of [...new Set(consumed)].sort()) if (state.provenance.heads[key]) inputs[key] = structuredClone(state.provenance.heads[key]);
    const kind = group === 0 ? 'scientific' : group === 2 ? (methodKeys.length ? 'layout' : 'manual') : names.some(key => key.endsWith('/appearance')) ? 'appearance' : names.some(key => key.includes('/labels/')) ? 'annotation' : 'context';
    const record: OperationRecord = persisted({
      id: '', kind, methods: methodKeys.map(key => ({ key, buildId: build?.buildId ?? null })),
      scope: { sourceId: state.source.id, viewId: names.find(key=>key.startsWith('structured/'))?.slice(11) ?? state.activeViewId, components: names.sort(), sourceNodeIds: [...new Set(names.filter(key => /\/(nodes|routes|order|labels)\//.test(key)).map(key => key.split('/').at(-1)!))].sort() },
      inputs, outputs: Object.fromEntries(names.map(key => [key, revised[key]])), parameters: evidence.parameters ?? {},
      referenceUses: [...methodKeys.flatMap(key => state.provenance.methods[key].referenceUses), ...(names.includes('basis') ? state.basis.referenceIds.map(referenceId => ({ referenceId, role: 'input-tree' as const, relationship: 'uses-data' as const })) : [])], result: evidence.result ?? { accepted: true },
      recordedAt: new Date().toISOString(), notes: evidence.notes ?? (kind === 'context' ? 'Editing context changed; this does not assert that an image was traced or a fit applied.' : 'Accepted edit.'),
    });
    record.id = operationId(record); state.provenance.operations[record.id] = record;
    for (const key of names) state.provenance.heads[key] = { revision: revised[key], operationId: record.id };
  }
  for (const key of removed) delete state.provenance.heads[key];
  state.provenance.operations = contributionClosure(state.provenance);
  const usedMethods = new Set(Object.values(state.provenance.operations).flatMap(op => op.methods.map(method => method.key)));
  state.provenance.methods = Object.fromEntries(Object.entries(state.provenance.methods).filter(([key]) => usedMethods.has(key)));
  return next;
}

export function validateProvenance(project: WorkingProject, includeBasis = true): void {
  if (includeBasis) validateScientificBasis(project.authoring.basis, project.sourceSha256);
  const provenance = project.authoring.provenance;
  if (!provenance || provenance.replayCoverage !== 'source-and-final-geometry' || !provenance.references || !provenance.methods || !provenance.operations || !provenance.heads || Object.keys(provenance.operations).length > 20000) throw new Error('Invalid or excessive provenance history.');
  for (const [id, ref] of Object.entries(provenance.references)) { validateReference(ref); if(METHOD_REFERENCES[id]&&digestSync(ref)!==digestSync(METHOD_REFERENCES[id]))throw new Error('Known method citation identity changed.'); if (id !== ref.id) throw new Error('Reference identity mismatch.'); }
  for (const [key, method] of Object.entries(provenance.methods)) validateMethod(key, method);
  const knownRefs = new Set(Object.keys(provenance.references));
  const state = project.authoring;
  for (const id of [...state.source.referenceIds, ...state.root.referenceIds, ...(includeBasis ? state.basis.referenceIds : []), ...Object.values(state.structuredViews??{}).flatMap(view=>[...view.input.basis.referenceIds,...view.input.root.referenceIds]), ...(state.edgeMeasure ? [state.edgeMeasure.evidenceReferenceId] : [])]) if (!knownRefs.has(id)) throw new Error('Source/root references an unknown citation.');
  for (const method of Object.values(provenance.methods)) for (const use of method.referenceUses) if (!knownRefs.has(use.referenceId) || !['input-tree','algorithm','implementation','background'].includes(use.role) || !['uses-data','implements','adapts','inspired-by','background'].includes(use.relationship)) throw new Error('Invalid method reference use.');
  const revisions = componentRevisions(project, includeBasis);
  if (Object.keys(provenance.heads).length !== Object.keys(revisions).length) throw new Error('Provenance component inventory does not match document.');
  for (const [key, revision] of Object.entries(revisions)) {
    const head = provenance.heads[key], record = head && provenance.operations[head.operationId];
    if (!head || head.revision !== revision || !record || record.outputs[key] !== revision) throw new Error(`Provenance does not match saved content: ${key}`);
  }
  for (const [id, record] of Object.entries(provenance.operations)) {
    if (id !== record.id || id !== operationId(record) || !['migration','scientific','layout','manual','appearance','annotation','context'].includes(record.kind) || typeof record.recordedAt !== 'string' || !Number.isFinite(Date.parse(record.recordedAt)) || typeof record.notes !== 'string' || record.scope.sourceId !== project.authoring.source.id || !Array.isArray(record.scope.components) || !Array.isArray(record.scope.sourceNodeIds) || !Array.isArray(record.methods) || !Array.isArray(record.referenceUses)) throw new Error('Invalid operation record.');
    if (JSON.stringify([...record.scope.components].sort()) !== JSON.stringify(Object.keys(record.outputs).sort())) throw new Error('Operation scope/output mismatch.');
    for (const value of [record.inputs, record.outputs, record.parameters, record.result]) if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operation payload.');
    for (const method of record.methods) if (!provenance.methods[method.key] || provenance.methods[method.key].status !== 'implemented' || (method.buildId !== null && !/^[0-9a-f]{64}$/.test(method.buildId))) throw new Error('Unknown/planned method or build in applied history.');
    for (const use of record.referenceUses) if (!knownRefs.has(use.referenceId) || !['input-tree','algorithm','implementation','background'].includes(use.role) || !['uses-data','implements','adapts','inspired-by','background'].includes(use.relationship)) throw new Error('Invalid reference use.');
    for (const [key, input] of Object.entries(record.inputs)) if (provenance.operations[input.operationId]?.outputs[key] !== input.revision) throw new Error('Broken operation dependency.');
    for (const revision of Object.values(record.outputs)) if (!/^[0-9a-f]{64}$/.test(revision)) throw new Error('Invalid component revision.');
  }
  contributionClosure(provenance);
}
export function hasAuthoring(project: Project): project is WorkingProject { return !!project.authoring; }

/** Add only the newly introduced component after validating every V2 checkpoint unchanged. */
export function seedBasisMigration(project: WorkingProject, build: BuildInfo | null): void {
  const state = project.authoring;
  const record: OperationRecord = {
    id: '', kind: 'migration', methods: [],
    scope: { sourceId: state.source.id, viewId: state.activeViewId, components: ['basis'], sourceNodeIds: [] },
    inputs: Object.fromEntries(['source','scientific'].map(key => [key, structuredClone(state.provenance.heads[key])])),
    outputs: { basis: digestSync(state.basis) }, parameters: { migration: 'scientific-basis-v3.1', buildId: build?.buildId ?? null },
    referenceUses: state.basis.referenceIds.map(referenceId => ({ referenceId, role: 'input-tree', relationship: 'uses-data' })),
    result: { geometryAndExistingHistoryPreserved: true }, recordedAt: new Date().toISOString(),
    notes: 'V2 basis metadata added by exact source identity; generic input meaning remains unspecified. Existing authoring history retained.',
  };
  record.id = operationId(record); state.provenance.operations[record.id] = record;
  state.provenance.heads.basis = { revision: record.outputs.basis, operationId: record.id };
  state.compatibility.migrationVersion = 'scientific-basis-v3.1';
  state.compatibility.notices.push('Version 2 migrated to version 3 with scientific-basis metadata; source, geometry and existing operations preserved.');
}
