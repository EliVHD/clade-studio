import type { Correction, Design, Layout, Presentation, Recipe, RootSpec, Project } from '../types.ts';
import type { StructuredView } from '../structured/types.ts';
import type { BuildInfo } from '../provenance/identity.ts';

export type RootState = { status: 'rooted'; basis: 'source-declared' | 'curated' | 'user-assumption' | 'hypothetical'; explanation: string; referenceIds: string[] }
  | { status: 'unrooted' | 'unspecified'; explanation: string; referenceIds: string[] };
export type ViewIntent = 'artistic' | 'legacy-inspection' | 'cladogram' | 'phylogram' | 'chronogram' | 'taxonomy' | 'unrooted';
export type SourceAsset = { id: string; role: 'topology'; mediaType: 'text/x-newick'; content: string; sha256: string; hashBasis: 'legacy-utf8-text'; referenceIds: string[]; metadataStatus: 'curated' | 'incomplete'; attribution: Record<string, unknown> };
export type ReferenceRecord = { id: string; type: 'article' | 'application-method' | 'source'; title: string; authors: string[]; year: number | null; doi: string | null; url: string | null; license: string | null; verification: 'verified-source' | 'application-defined' | 'unverified' };
export type ReferenceUse = { referenceId: string; role: 'input-tree' | 'algorithm' | 'implementation' | 'background'; relationship: 'uses-data' | 'implements' | 'adapts' | 'inspired-by' | 'background' };
export type MethodDefinition = { id: string; version: string; category: string; status: 'implemented' | 'planned'; specification: string; specificationSha256: string; parameterSchema: { type: 'object'; additionalProperties: true }; defaults: Record<string, unknown>; limitations: string[]; referenceUses: ReferenceUse[] };
export type Head = { revision: string; operationId: string };
export type OperationRecord = {
  id: string; kind: 'migration' | 'scientific' | 'layout' | 'manual' | 'appearance' | 'annotation' | 'context';
  methods: { key: string; buildId: string | null }[];
  scope: { sourceId: string; viewId: string; components: string[]; sourceNodeIds: string[] };
  inputs: Record<string, Head>; outputs: Record<string, string>; parameters: Record<string, unknown>;
  referenceUses: ReferenceUse[]; result: Record<string, unknown>; recordedAt: string; notes: string;
};
export type ProvenanceState = { references: Record<string, ReferenceRecord>; methods: Record<string, MethodDefinition>; operations: Record<string, OperationRecord>; heads: Record<string, Head>; replayCoverage: 'source-and-final-geometry' };
export type SavedView = { id: string; name: string; intent: 'artistic' | 'legacy-inspection'; adapter: 'legacy-artistic-v1'; layout: Layout; appearance: Presentation; design?: Design };
export type ScientificBasis = {
  id: string; name: string; question: string;
  relationshipKind: 'phylogeny' | 'classification' | 'similarity' | 'ecological-interaction' | 'unspecified';
  entityKind: 'taxon-concepts' | 'specimens' | 'populations' | 'genes-sequences' | 'unspecified';
  edgeMeaning: string; evidenceBasis: string; sourceIds: string[]; referenceIds: string[];
  provider: string | null; release: string | null; retrievedAt: string | null;
  epistemicStatus: 'published-hypothesis' | 'classification-release' | 'historical-model' | 'teaching-example' | 'unspecified';
  limitations: string; rightsRecordIds: string[];
};
export type Compatibility = { originalVersion: 1 | 2 | 3 | 4; migrationVersion: 'legacy-to-v2.1' | 'scientific-basis-v3.1' | 'structured-views-v4.1'; historyStatus: 'incomplete' | 'recorded-from-creation'; notices: string[]; legacyProvenance: Record<string, unknown> };
export type ProjectDocument = {
  format: 'phylogenetic-tree-studio'; version: 4; documentId: string; title: string;
  createdWith: BuildInfo | null; lastSavedWith: BuildInfo | null;
  sources: Record<string, SourceAsset>;
  scientific: { basis: ScientificBasis; primarySourceId: string; root: RootState; traversal: RootSpec; selection: { kind: 'all' }; reduction: Recipe; corrections: Correction[]; edgeMeasure: { meaning: 'substitutions-per-site'; unit: 'substitutions/site'; evidenceReferenceId: string } | null };
  views: Record<string, SavedView>; activeViewId: string; provenance: ProvenanceState; compatibility: Compatibility;
  structuredViews: Record<string, StructuredView>; ui: { selection: string[]; structuredViewId: string | null };
};
/** Session-only metadata. Geometry/source remain in the legacy editor's working fields. */
export type AuthoringState = {
  documentId: string; createdWith: BuildInfo | null; lastSavedWith: BuildInfo | null;
  source: Omit<SourceAsset, 'content'>; basis: ScientificBasis; root: RootState; edgeMeasure: ProjectDocument['scientific']['edgeMeasure'];
  structuredViews?: Record<string, StructuredView>; activeStructuredViewId?: string | null;
  activeViewId: string; viewName: string; otherViews: Record<string, SavedView>;
  provenance: ProvenanceState; compatibility: Compatibility;
};
export type WorkingProject = Project & { authoring: AuthoringState };
