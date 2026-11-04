import type { Source } from './types.ts';
import type { WorkingProject, ReferenceRecord, ScientificBasis } from './model/document.ts';
import type { BuildInfo } from './provenance/identity.ts';
import type { CommandEvidence } from './provenance/operations.ts';
import { recordAccepted, validateProvenance } from './provenance/operations.ts';
import { effectiveViewId, checkStructuredPins } from './structured/view.ts';
import { semanticCapabilities } from './model/semantics.ts';
import { validateReference } from './provenance/registry.ts';
import { validateWorking, documentFromWorking, treeRevision } from './project-v2.ts';
import { persisted } from './provenance/sync-identity.ts';
import { digestSync } from './provenance/sync-identity.ts';

/** One synchronous commit after a proposal: validation failure leaves before unchanged. */
export function acceptCommand(before: WorkingProject, proposal: WorkingProject, source: Source, evidence: CommandEvidence = {}, build: BuildInfo | null = null, newReferences: ReferenceRecord[] = []): WorkingProject {
  if (before.authoring.documentId !== proposal.authoring.documentId || before.sourceSha256 !== proposal.sourceSha256 || before.sourceText !== proposal.sourceText) throw new Error('A command cannot replace its document/source.');
  const candidate = persisted(proposal);
  candidate.authoring.provenance = structuredClone(before.authoring.provenance);
  for (const ref of newReferences) {
    validateReference(ref);
    const { id, ...content } = ref;
    if (ref.verification !== 'unverified' || id !== `user-reference-${digestSync(content)}`) throw new Error('User-supplied citations must be unverified and content-addressed.');
    if (candidate.authoring.provenance.references[id] && digestSync(candidate.authoring.provenance.references[id]) !== digestSync(ref)) throw new Error('A citation cannot overwrite an existing identity.');
    candidate.authoring.provenance.references[id] = structuredClone(ref);
  }
  if (before.authoring.basis.id !== candidate.authoring.basis.id) throw new Error('The basis identity cannot change during a metadata edit.');
  const capabilities = semanticCapabilities(candidate.authoring.root, candidate.layout.mode === 'organic' ? 'artistic' : 'legacy-inspection', candidate.authoring.edgeMeasure, candidate.authoring.basis);
  if (digestSync(before.layout) !== digestSync(candidate.layout) && !capabilities.canEditGeometry && candidate.layout.mode === 'organic') throw new Error('This relationship adapter is not available for editing.');
  if (candidate.authoring.root.status === 'rooted' && digestSync(before.authoring.root) !== digestSync(candidate.authoring.root) && !capabilities.canClaimAncestry) throw new Error('Declaring biological ancestry requires a phylogenetic basis and a stated entity type.');
  if (before.layout.mode === 'scientific' && candidate.layout.mode === 'scientific' && digestSync(before.layout) !== digestSync(candidate.layout)) throw new Error('Legacy inspection coordinates are read-only. Use Arrange → Make artistic to edit them.');
  for(const [id,view] of Object.entries(before.authoring.structuredViews??{})) { const next=candidate.authoring.structuredViews?.[id]; if(next)checkStructuredPins(view,next); }
  validateWorking(candidate, source);
  const committed = recordAccepted(before, candidate, evidence, build);
  validateProvenance(committed);
  if(new TextEncoder().encode(JSON.stringify(documentFromWorking(committed))).length>50_000_000)throw new Error('This edit would exceed the 50 MB project limit. Keep fewer saved views or fewer displayed taxa.');
  return committed;
}

/** Basis edits describe the existing immutable input and never construct a new topology. */
export function acceptBasisEdit(before: WorkingProject, basis: ScientificBasis, source: Source, build: BuildInfo | null = null, references: ReferenceRecord[] = []): WorkingProject {
  const proposal = structuredClone(before); proposal.authoring.basis = structuredClone(basis);
  return acceptCommand(before, proposal, source, { kind: 'scientific', replace: true, parameters: { basisId: basis.id }, notes: 'Edited scientific-basis description; source topology and artwork unchanged. User-supplied evidence and rights are not independently verified.' }, build, references);
}
export function userReference(content: Omit<ReferenceRecord, 'id' | 'verification' | 'type'>): ReferenceRecord {
  const record = { ...content, type: 'source' as const, verification: 'unverified' as const };
  return { id: `user-reference-${digestSync(record)}`, ...record };
}
export function isCurrentResult(project: WorkingProject, baseRevision: string, viewId: string): boolean {
  return effectiveViewId(project) === viewId && treeRevision(documentFromWorking(project)) === baseRevision;
}
