import type { RootSpec, Source } from '../types.ts';
import type { RootState, ViewIntent, ScientificBasis } from './document.ts';

export function legacyRootState(root: RootSpec, source: Source): RootState {
  const plausible = root.kind !== 'node' || source.tips.length === 1 || !source.tips.includes(root.sourceNodeId);
  return root.status === 'declared_assumption' && plausible
    ? { status: 'rooted', basis: 'user-assumption', explanation: 'Explicit rooting assumption retained from the reduction recipe; not independently established biological evidence.', referenceIds: [] }
    : { status: 'unspecified', explanation: `Legacy traversal preserved (${root.status}); it does not by itself establish a biological root.`, referenceIds: [] };
}
export function validateRootState(root: RootState, traversal: RootSpec, source: Source): void {
  if (!root || !['rooted', 'unrooted', 'unspecified'].includes(root.status) || typeof root.explanation !== 'string' || !root.explanation.trim() || !Array.isArray(root.referenceIds) || root.referenceIds.some(id => typeof id !== 'string')) throw new Error('Invalid biological root metadata.');
  if (Object.keys(root).some(key => !['status','explanation','referenceIds', ...(root.status === 'rooted' ? ['basis'] : [])].includes(key))) throw new Error('Unsupported biological root fields.');
  if (root.status === 'rooted') {
    if (!['source-declared', 'curated', 'user-assumption', 'hypothetical'].includes(root.basis)) throw new Error('A biological root needs a declared basis.');
    if (traversal.kind === 'node' && source.tips.length > 1 && source.tips.includes(traversal.sourceNodeId)) throw new Error('A source tip cannot be the biological root of a multi-tip tree; use its adjacent edge.');
  }
}
export function semanticCapabilities(root: RootState, intent: ViewIntent, measure: unknown = null, basis?: ScientificBasis): { canClaimAncestry: boolean; canEditGeometry: boolean; quantitative: boolean; available: boolean; reasons: string[] } {
  const relationshipSupported = !basis || ['phylogeny','unspecified'].includes(basis.relationshipKind);
  const ancestry = basis?.relationshipKind === 'phylogeny' && basis.entityKind !== 'unspecified';
  const m=measure as {meaning?:string;unit?:string;evidence?:string;evidenceReferenceId?:string}|null;const typedMetric=!!m&&['substitutions-per-site','expected-changes','other-distance'].includes(m.meaning??'')&&typeof m.unit==='string'&&!!m.unit.trim()&&!!(m.evidence?.trim()||m.evidenceReferenceId);
  const classification=intent==='taxonomy'&&basis?.relationshipKind==='classification'&&basis.entityKind==='taxon-concepts'&&!!basis.provider?.trim()&&!!basis.release?.trim()&&!!basis.edgeMeaning.trim()&&!!basis.evidenceBasis.trim();
  const unrooted=intent==='unrooted'&&!!ancestry;
  const supported = unrooted || classification || ((intent === 'artistic' || intent === 'legacy-inspection') && relationshipSupported) || (['cladogram','phylogram'].includes(intent) && !!ancestry && root.status === 'rooted' && (intent!=='phylogram'||typedMetric));
  const reasons: string[] = [];
  if (!ancestry&&!classification) reasons.push('Ancestry claims require a phylogenetic basis with a stated entity type; a classification parent or similarity does not establish descent.');
  if (!relationshipSupported&&!classification) reasons.push('This relationship adapter is not implemented. Its metadata and saved artwork can be inspected; geometry editing and scientific interpretations are unavailable.');
  if (basis?.entityKind === 'genes-sequences') reasons.push('Ancestry refers to the supplied genes/sequences; it does not establish species ancestry.');
  if (root.status !== 'rooted'&&!classification&&!unrooted) reasons.push('A biological root has not been declared; MRCA/ancestor claims are unavailable.');
  if (!supported) reasons.push(intent==='taxonomy'?'Classification requires taxon concepts, a named framework/release and parent-link evidence.':intent==='phylogram'?'A rooted phylogenetic basis, typed units/evidence and valid displayed path lengths are required for a phylogram.':'This structured/quantitative view is not implemented yet.');
  if (intent === 'phylogram' && !measure) reasons.push('Branch-length meaning and units must be supplied.');
  if(unrooted)reasons.push('Unrooted topology has no biological root or MRCA. Display origin and equal display spacing carry no ancestry or distance meaning.');
  if(classification)reasons.push('Classification membership does not establish evolutionary ancestry. The supplied top node is not a biological root; MRCA is unavailable.');
  if (intent === 'legacy-inspection') reasons.push('Legacy normalized depth is not an evolutionary-distance or time scale.');
  return { canClaimAncestry: !!ancestry && root.status === 'rooted' && intent !== 'unrooted' && intent !== 'taxonomy' && supported, canEditGeometry: intent === 'artistic' && relationshipSupported, quantitative: intent==='phylogram'&&supported, available: supported, reasons };
}
