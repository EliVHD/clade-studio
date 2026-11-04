import type { ScientificBasis } from './document.ts';
import { HUG_SHA } from '../science.ts';
import { HUG_REFERENCE } from '../provenance/registry.ts';
import { bundledDataset } from '../datasets.ts';

/** Curated only by exact source identity. Generic Newick conveys no relationship meaning. */
export function defaultScientificBasis(sha256: string): ScientificBasis {
  const dataset = bundledDataset(sha256);
  if (dataset && sha256 !== HUG_SHA) return {
    id: 'basis-1', name: dataset.name, question: 'Relationships among the taxa sampled in this source dataset.',
    relationshipKind: 'phylogeny', entityKind: dataset.entityKind,
    edgeMeaning: 'Inferred evolutionary relationships from the source authors; drawing depth is nonmetric unless separately declared with evidence.',
    evidenceBasis: dataset.evidence, sourceIds: [`source-${sha256}`], referenceIds: dataset.references.map(ref => ref.id),
    provider: dataset.sourceUrl, release: dataset.release, retrievedAt: '2026-10-28', epistemicStatus: 'published-hypothesis',
    limitations: dataset.limitations, rightsRecordIds: [dataset.rightsId],
  };
  const known = sha256 === HUG_SHA;
  return {
    id: 'basis-1', name: known ? 'Hug et al. 2016 ribosomal-protein phylogeny' : 'Unspecified imported tree',
    question: known ? 'Relationships among the sampled organisms in the supplied ribosomal-protein study.' : '',
    relationshipKind: known ? 'phylogeny' : 'unspecified', entityKind: known ? 'taxon-concepts' : 'unspecified',
    edgeMeaning: known ? 'Inferred evolutionary relationships from the supplied study; root assumptions are recorded separately.' : '',
    evidenceBasis: known ? 'Ribosomal-protein sequence evidence reported by Hug et al. (2016); Supplementary Dataset 2 supplies the topology. Inference was performed by the source authors.' : '',
    sourceIds: [`source-${sha256}`], referenceIds: known ? [HUG_REFERENCE.id] : [],
    provider: null, release: known ? '2016 Supplementary Dataset 2' : null, retrievedAt: null,
    epistemicStatus: known ? 'published-hypothesis' : 'unspecified',
    limitations: known ? 'One published hypothesis with its original sampling and evidence. Gene histories and organism histories need not coincide; this is not a unique or definitive tree of life.' : 'Scientific meaning, evidence and redistribution rights have not been supplied.',
    rightsRecordIds: known ? ['hug-2016-source'] : [],
  };
}
export function validateScientificBasis(basis: ScientificBasis, sha256: string): void {
  const fields = ['id','name','question','relationshipKind','entityKind','edgeMeaning','evidenceBasis','sourceIds','referenceIds','provider','release','retrievedAt','epistemicStatus','limitations','rightsRecordIds'];
  if (!basis || typeof basis !== 'object' || Array.isArray(basis) || fields.some(key => !Object.hasOwn(basis,key)) || Object.keys(basis).some(key => !fields.includes(key))) throw new Error('Invalid scientific basis fields.');
  if (typeof basis.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(basis.id) || typeof basis.name !== 'string' || !basis.name.trim() || basis.name.length > 500) throw new Error('A scientific basis needs a stable ID and a name (up to 500 characters).');
  for (const key of ['question','edgeMeaning','evidenceBasis','limitations'] as const) if (typeof basis[key] !== 'string' || basis[key].length > 10000) throw new Error('Basis descriptions must be text of at most 10,000 characters.');
  if (!['phylogeny','classification','similarity','ecological-interaction','unspecified'].includes(basis.relationshipKind) || !['taxon-concepts','specimens','populations','genes-sequences','unspecified'].includes(basis.entityKind) || !['published-hypothesis','classification-release','historical-model','teaching-example','unspecified'].includes(basis.epistemicStatus)) throw new Error('Invalid scientific relationship, entity or evidence status.');
  if (basis.relationshipKind === 'phylogeny' && (!basis.edgeMeaning.trim() || !basis.evidenceBasis.trim())) throw new Error('Describe the edge meaning and evidence before declaring a phylogeny.');
  for (const key of ['sourceIds','referenceIds','rightsRecordIds'] as const) if (!Array.isArray(basis[key]) || basis[key].length > 100 || basis[key].some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(id)) || new Set(basis[key]).size !== basis[key].length) throw new Error('Invalid scientific basis links.');
  if (basis.sourceIds.length !== 1 || basis.sourceIds[0] !== `source-${sha256}`) throw new Error('The scientific basis must identify this exact immutable source. Import another topology as a separate project.');
  const dataset = bundledDataset(sha256), expectedRights = dataset ? [dataset.rightsId] : [];
  if (JSON.stringify(basis.rightsRecordIds) !== JSON.stringify(expectedRights)) throw new Error('Basis labels cannot grant redistribution rights or remove bundled data obligations.');
  if (dataset && dataset.references.some(ref => !basis.referenceIds.includes(ref.id))) throw new Error('The bundled data citations must remain attached to its scientific basis.');
  for (const key of ['provider','release','retrievedAt'] as const) if (basis[key] !== null && (typeof basis[key] !== 'string' || !basis[key]!.trim() || basis[key]!.length > 500)) throw new Error('Provider, release and retrieval details must be text or unknown (null).');
  if (basis.retrievedAt !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(basis.retrievedAt) || !Number.isFinite(Date.parse(basis.retrievedAt)) || new Date(basis.retrievedAt).toISOString().slice(0,10) !== basis.retrievedAt)) throw new Error('Retrieval date must be a valid YYYY-MM-DD date or unknown.');
}
export function basisCaption(basis: ScientificBasis): string {
  const sentence = (value: string) => /[.!?]$/.test(value.trim()) ? value.trim() : value.trim() + '.';
  return [
    `Scientific basis: ${basis.name}`, `Relationship: ${basis.relationshipKind}; entities: ${basis.entityKind}`,
    `Question: ${basis.question || 'not supplied'}`, `Edges: ${basis.edgeMeaning || 'unspecified'}`,
    `Evidence: ${basis.evidenceBasis || 'not supplied'}`,
    `Source/framework: ${basis.provider ?? 'not supplied'}; release: ${basis.release ?? 'not supplied'}; retrieved: ${basis.retrievedAt ?? 'unknown'}`,
    `Status: ${basis.epistemicStatus==='teaching-example'?'hypothetical-example':basis.epistemicStatus}`, `Limitations: ${basis.limitations || 'not supplied'}`,
  ].map(sentence).join(' ');
}
