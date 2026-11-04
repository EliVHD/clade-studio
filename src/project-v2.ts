import type { Project, Source, Rooted, Reduction } from './types.ts';
import type { BuildInfo } from './provenance/identity.ts';
import type { ProjectDocument, WorkingProject, SavedView } from './model/document.ts';
import { validateStructuredView } from './structured/view.ts';
import { validateBuildInfo } from './provenance/identity.ts';
import { loadProject, validateLayout, validatePresentation } from './project.ts';
import { validateDesign } from './design.ts';
import { HUG_SHA, orient, reduce } from './science.ts';
import { defaultScientificBasis, validateScientificBasis } from './model/basis.ts';
import { legacyRootState, validateRootState } from './model/semantics.ts';
import { HUG_REFERENCE } from './provenance/registry.ts';
import { bundledDataset } from './datasets.ts';
import { activeView, contributionClosure, seedCheckpoint, seedBasisMigration, validateProvenance } from './provenance/operations.ts';
import { digestSync, persisted } from './provenance/sync-identity.ts';

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/;
function object(value: unknown, label: string): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}.`); }
function exactKeys(value: unknown, required: string[], optional: string[] = []): void {
  object(value, 'object');
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Unsupported or missing project fields.');
}

export function startAuthoring(legacy: Project, source: Source, build: BuildInfo | null, origin: 'legacy' | 'new' = 'legacy', executedMethods: string[] = []): WorkingProject {
  if (build) validateBuildInfo(build);
  const { authoring: _old, ...plain } = legacy;
  if (JSON.stringify(plain.provenance).length > 2_000_000) throw new Error('Legacy provenance exceeds the 2 MB metadata limit.');
  const known = source.sha256 === HUG_SHA, dataset = bundledDataset(source.sha256), sourceId = `source-${source.sha256}`;
  const references = dataset?.references ?? [];
  const project: WorkingProject = { ...structuredClone(plain), authoring: {
    documentId: crypto.randomUUID(), createdWith: origin === 'new' ? build : null, lastSavedWith: build,
    source: { id: sourceId, role: 'topology', mediaType: 'text/x-newick', sha256: source.sha256, hashBasis: 'legacy-utf8-text', referenceIds: references.map(ref => ref.id), metadataStatus: dataset ? 'curated' : 'incomplete', attribution: structuredClone(plain.provenance) },
    basis: defaultScientificBasis(source.sha256), root: origin === 'new' && dataset?.rootEvidence && legacy.recipe.root.kind === 'node' && legacy.recipe.root.sourceNodeId === source.rootId ? { status: 'rooted', basis: 'source-declared', explanation: dataset.rootEvidence, referenceIds: references.map(ref => ref.id) } : legacyRootState(legacy.recipe.root, source), edgeMeasure: known ? { meaning: 'substitutions-per-site', unit: 'substitutions/site', evidenceReferenceId: HUG_REFERENCE.id } : null,
    structuredViews: {}, activeStructuredViewId: null, activeViewId: 'view-1', viewName: legacy.layout.mode === 'organic' ? 'Artistic arrangement' : 'Legacy normalized inspection', otherViews: {},
    provenance: { references: Object.fromEntries(references.map(ref => [ref.id, structuredClone(ref)])), methods: {}, operations: {}, heads: {}, replayCoverage: 'source-and-final-geometry' },
    compatibility: { originalVersion: origin === 'legacy' ? 1 : 4, migrationVersion: 'structured-views-v4.1', historyStatus: origin === 'legacy' ? 'incomplete' : 'recorded-from-creation', notices: origin === 'legacy' ? ['Authoring operations before import are unknown. Existing recipe and final geometry are retained as evidence, not reconstructed history.'] : [], legacyProvenance: structuredClone(plain.provenance) },
  } };
  seedCheckpoint(project, origin, build, executedMethods); return project;
}

export function documentFromWorking(project: WorkingProject, savingBuild: BuildInfo | null = project.authoring.lastSavedWith): ProjectDocument {
  if (savingBuild) validateBuildInfo(savingBuild);
  const state = project.authoring, provenance = structuredClone(state.provenance);
  provenance.operations = contributionClosure(provenance);
  const methods = new Set(Object.values(provenance.operations).flatMap(op => op.methods.map(method => method.key)));
  provenance.methods = Object.fromEntries(Object.entries(provenance.methods).filter(([key]) => methods.has(key)));
  const references = new Set([...state.source.referenceIds, ...state.root.referenceIds, ...state.basis.referenceIds, ...Object.values(state.structuredViews??{}).flatMap(view=>[...view.input.basis.referenceIds,...view.input.root.referenceIds,...(view.scene.metric?.spec.measure.referenceIds??[]),...(view.artistic?.baseScene.metric?.spec.measure.referenceIds??[]),...(view.scene.classification?.spec.referenceIds??[]),...(view.artistic?.baseScene.classification?.spec.referenceIds??[])]), ...(state.edgeMeasure ? [state.edgeMeasure.evidenceReferenceId] : []), ...Object.values(provenance.operations).flatMap(op => op.referenceUses.map(use => use.referenceId)), ...Object.values(provenance.methods).flatMap(method => method.referenceUses.map(use => use.referenceId))]);
  provenance.references = Object.fromEntries(Object.entries(provenance.references).filter(([id]) => references.has(id)));
  return persisted({
    format: 'phylogenetic-tree-studio', version: 4, documentId: state.documentId, title: project.title,
    createdWith: state.createdWith, lastSavedWith: savingBuild,
    sources: { [state.source.id]: { ...state.source, content: project.sourceText } },
    scientific: { basis: state.basis, primarySourceId: state.source.id, root: state.root, traversal: project.recipe.root, selection: { kind: 'all' }, reduction: project.recipe, corrections: project.corrections, edgeMeasure: state.edgeMeasure },
    views: { ...state.otherViews, [state.activeViewId]: activeView(project) }, activeViewId: state.activeViewId,
    provenance, compatibility: state.compatibility, structuredViews: state.structuredViews ?? {}, ui: { selection: project.selection ?? [], structuredViewId: state.activeStructuredViewId ?? null },
  });
}

export function workingFromDocument(doc: ProjectDocument): WorkingProject {
  const primary = doc.sources[doc.scientific.primarySourceId], view = doc.views[doc.activeViewId];
  if (!primary || !view) throw new Error('Missing primary source or active view.');
  const { content: _content, ...source } = primary;
  return persisted({
    format: 'phylogenetic-tree-studio', version: 1, appVersion: '0.1.0', title: doc.title,
    sourceText: primary.content, sourceSha256: primary.sha256, provenance: primary.attribution,
    recipe: doc.scientific.reduction, corrections: doc.scientific.corrections, layout: view.layout, presentation: view.appearance,
    ...(view.design ? { design: view.design } : {}), selection: doc.ui.selection,
    authoring: { documentId: doc.documentId, createdWith: doc.createdWith, lastSavedWith: doc.lastSavedWith,
      structuredViews: doc.structuredViews ?? {}, activeStructuredViewId: doc.ui.structuredViewId ?? null, source, basis: Object.hasOwn(doc.scientific, 'basis') ? doc.scientific.basis : defaultScientificBasis(primary.sha256), root: doc.scientific.root, edgeMeasure: doc.scientific.edgeMeasure,
      activeViewId: doc.activeViewId, viewName: view.name, otherViews: Object.fromEntries(Object.entries(doc.views).filter(([id]) => id !== doc.activeViewId)),
      provenance: doc.provenance, compatibility: doc.compatibility },
  });
}

export function validateWorking(project: WorkingProject, source: Source): { rooted: Rooted; reduction: Reduction } {
  if (project.sourceSha256 !== source.sha256 || project.sourceText !== source.text || project.authoring.source.sha256 !== source.sha256 || project.authoring.source.id !== `source-${source.sha256}`) throw new Error('Source content/identity cannot change during a command.');
  validateScientificBasis(project.authoring.basis, source.sha256);
  const rooted = orient(source, project.recipe.root), reduction = reduce(source, rooted, project.recipe, true);
  validatePresentation(project.presentation); validateLayout(project.layout, rooted, reduction); validateDesign(project.design, rooted);
  validateRootState(project.authoring.root, project.recipe.root, source);
  const structured = project.authoring.structuredViews ?? {};
  if (Object.keys(structured).length > 16 || (project.authoring.activeStructuredViewId && !structured[project.authoring.activeStructuredViewId])) throw new Error('Invalid/excessive structured views or active view.');
  for (const [id,view] of Object.entries(structured)) { if(id!==view.id || id===project.authoring.activeViewId || project.authoring.otherViews[id]) throw new Error('View identity collision.'); validateStructuredView(view,project,source); }
  for (const view of Object.values(project.authoring.otherViews)) validateView(view, rooted, reduction);
  for (const [id, point] of Object.entries(project.presentation.labelOffsets)) if (!rooted.nodes[id] || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid label offset.');
  for (const c of project.corrections) if (!source.nodes[c.source_node_id] || source.nodes[c.source_node_id].rawLabel !== c.raw_label || (c.display_taxonomy !== null && typeof c.display_taxonomy !== 'string') || (c.evidence_url !== null && !/^https?:\/\//i.test(c.evidence_url))) throw new Error('Invalid source correction.');
  return { rooted, reduction };
}
function validateView(view: SavedView, rooted: Rooted, reduction: Reduction): void {
  exactKeys(view, ['id','name','intent','adapter','layout','appearance'], ['design']);
  if (!idPattern.test(view.id) || typeof view.name !== 'string' || view.adapter !== 'legacy-artistic-v1' || view.intent !== (view.layout.mode === 'organic' ? 'artistic' : 'legacy-inspection')) throw new Error('Unsupported view/intent adapter.');
  validateLayout(view.layout, rooted, reduction); validatePresentation(view.appearance); validateDesign(view.design, rooted);
  for (const [id, point] of Object.entries(view.appearance.labelOffsets)) if (!rooted.nodes[id] || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid stored-view annotation.');
}

export async function loadAnyProject(text: string, build: BuildInfo | null = null): Promise<{ project: WorkingProject; source: Source; rooted: Rooted; reduction: Reduction; migrated: boolean }> {
  if (build) validateBuildInfo(build);
  if (new TextEncoder().encode(text).length > 50_000_000) throw new Error('Project exceeds the 50 MB import limit.');
  const json = JSON.parse(text);
  if (json.format !== 'phylogenetic-tree-studio' || ![1,2,3,4].includes(json.version)) throw new Error('Unsupported project format/version.');
  if (json.version === 1) {
    delete json.authoring; // Never trust hidden session fields from a legacy file.
    const loaded = await loadProject(JSON.stringify(json));
    return { ...loaded, project: startAuthoring(loaded.project, loaded.source, build), migrated: true };
  }
  const doc = json as ProjectDocument, isV2 = json.version === 2, isV4 = json.version === 4;
  exactKeys(doc, ['format','version','documentId','title','createdWith','lastSavedWith','sources','scientific','views','activeViewId','provenance','compatibility','ui', ...(isV4 ? ['structuredViews'] : [])]);
  if (!idPattern.test(doc.documentId) || typeof doc.title !== 'string' || doc.title.length > 10000 || !idPattern.test(doc.activeViewId)) throw new Error('Invalid document identity/title.');
  if (doc.createdWith) validateBuildInfo(doc.createdWith); if (doc.lastSavedWith) validateBuildInfo(doc.lastSavedWith);
  object(doc.sources, 'sources'); object(doc.views, 'views');
  if (Object.keys(doc.sources).length !== 1 || !Object.keys(doc.views).length || Object.keys(doc.views).length > 32) throw new Error('This version requires one primary topology and 1–32 saved views.');
  exactKeys(doc.scientific, ['primarySourceId','root','traversal','selection','reduction','corrections','edgeMeasure', ...(isV2 ? [] : ['basis'])]);
  if (doc.scientific.selection?.kind !== 'all' || Object.keys(doc.scientific.selection).length !== 1) throw new Error('Selected-taxon projection is not implemented in this version.');
  if (digestSync(doc.scientific.traversal) !== digestSync(doc.scientific.reduction.root)) throw new Error('Traversal and reduction root disagree.');
  const sourceAsset = doc.sources[doc.scientific.primarySourceId];
  exactKeys(sourceAsset, ['id','role','mediaType','content','sha256','hashBasis','referenceIds','metadataStatus','attribution']);
  if (sourceAsset.id !== doc.scientific.primarySourceId || sourceAsset.id !== `source-${sourceAsset.sha256}` || sourceAsset.role !== 'topology' || sourceAsset.mediaType !== 'text/x-newick' || sourceAsset.hashBasis !== 'legacy-utf8-text' || !['curated','incomplete'].includes(sourceAsset.metadataStatus) || !Array.isArray(sourceAsset.referenceIds)) throw new Error('Invalid primary source asset.');
  object(sourceAsset.attribution, 'source attribution');
  exactKeys(doc.ui, ['selection', ...(isV4 ? ['structuredViewId'] : [])]);
  if(isV4){object(doc.structuredViews,'structured views');if(doc.ui.structuredViewId!==null && (typeof doc.ui.structuredViewId!=='string'||!doc.structuredViews[doc.ui.structuredViewId]))throw new Error('Unknown active structured view.');}
  if (!Array.isArray(doc.ui.selection) || doc.ui.selection.some(id => typeof id !== 'string')) throw new Error('Invalid selection.');
  exactKeys(doc.compatibility, ['originalVersion','migrationVersion','historyStatus','notices','legacyProvenance']);
  object(doc.compatibility.legacyProvenance, 'legacy provenance');
  if (!(isV2 ? [1,2] : isV4 ? [1,2,3,4] : [1,2,3]).includes(doc.compatibility.originalVersion) || !(isV2 ? ['legacy-to-v2.1'] : isV4 ? ['structured-views-v4.1'] : ['scientific-basis-v3.1']).includes(doc.compatibility.migrationVersion) || !['incomplete','recorded-from-creation'].includes(doc.compatibility.historyStatus) || !Array.isArray(doc.compatibility.notices) || doc.compatibility.notices.some(note => typeof note !== 'string') || JSON.stringify(doc.compatibility.legacyProvenance).length > 2_000_000) throw new Error('Invalid compatibility metadata.');
  const project = workingFromDocument(doc);
  const { authoring: _session, ...legacy } = project;
  const loaded = await loadProject(JSON.stringify(legacy));
  validateWorking(project, loaded.source);
  for (const [id, view] of Object.entries(doc.views)) { if (id !== view.id) throw new Error('View identity mismatch.'); validateView(view, loaded.rooted, loaded.reduction); }
  validateProvenance(project, !isV2);
  for (const id of [...sourceAsset.referenceIds, ...doc.scientific.root.referenceIds]) if (!doc.provenance.references[id]) throw new Error('Source/root references an unknown citation.');
  const dataset = bundledDataset(sourceAsset.sha256);
  if (!dataset && (sourceAsset.referenceIds.includes(HUG_REFERENCE.id) || sourceAsset.metadataStatus === 'curated')) throw new Error('Unrelated source cannot acquire the bundled source attribution/curated status.');
  if (dataset && dataset.references.some(ref => digestSync(doc.provenance.references[ref.id]) !== digestSync(ref) || !sourceAsset.referenceIds.includes(ref.id))) throw new Error('Bundled source citation must retain its verified identity.');
  const measure = doc.scientific.edgeMeasure;
  if (measure !== null && (measure.meaning !== 'substitutions-per-site' || measure.unit !== 'substitutions/site' || !doc.provenance.references[measure.evidenceReferenceId])) throw new Error('Invalid edge-measure evidence.');
  if (isV2) { seedBasisMigration(project, build); validateProvenance(project); }
  if(!isV4){project.authoring.compatibility.migrationVersion='structured-views-v4.1';project.authoring.compatibility.notices.push('Migrated to V4 structured-view envelope; existing artwork and contributions retained.');}
  return { ...loaded, project, migrated: !isV4 };
}

export function treeRevision(document: ProjectDocument): string {
  const { ui: _ui, lastSavedWith: _saved, ...content } = structuredClone(document);
  for (const record of Object.values(content.provenance.operations)) delete (record as Partial<typeof record>).recordedAt;
  for (const view of Object.values(content.views)) if (view.design) {
    delete view.design.fitSettings; delete view.design.activeBorderId; delete (view.design as Partial<typeof view.design>).showBorders;
    if (!view.design.borders.length && !view.design.referenceImage) delete view.design;
  }
  return digestSync({ algorithm: 'tree_revision_v1', content });
}
export function serializeProject(project: WorkingProject, build: BuildInfo | null = project.authoring.lastSavedWith): string {
  validateProvenance(project); const text = JSON.stringify(documentFromWorking(project, build), null, 2);
  if (new TextEncoder().encode(text).length > 50_000_000) throw new Error('Saved project would exceed the 50 MB reopen limit.');
  return text;
}
