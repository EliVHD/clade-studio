export type Id = string;
export type Annotation = { text: string; position: 'before' | 'label' | 'length' };
export type SourceNode = {
  id: Id; children: Id[]; rawLabel: string; label: string; length: number | null;
  lengthToken: string | null; annotations: Annotation[];
};
export type Source = {
  text: string; sha256: string; nodes: Record<Id, SourceNode>; order: Id[];
  rootId: Id; tips: Id[]; warnings: string[]; distanceUsable: boolean;
};
export type RootSpec =
  | { kind: 'node'; sourceNodeId: Id; status: string }
  | { kind: 'edge'; sourceEdge: [Id, Id]; fraction: number; status: string };
export type RootedNode = {
  id: Id; parent: Id | null; children: Id[]; length: number | null;
  sourceEdgeId: Id | null; annotations: Annotation[]; members: Id[];
  count: number; sum: number; mean: number;
};
export type Rooted = { rootId: Id; nodes: Record<Id, RootedNode>; order: Id[]; root: RootSpec; distanceUsable: boolean };
export type Recipe = {
  algorithm: 'maximal_frontier_v1'; sourceSha256: string; root: RootSpec;
  globalThreshold: number; thresholdOverrides: { sourceNodeId: Id; threshold: number }[];
  protectOverridePaths: true; comparison: 'strict_less_than';
  protect: Id[]; collapse: Id[]; expand: Id[]; resolvedFrontierSourceNodeIds?: Id[];
};
export type FrontierEntry = { id: Id; members: Id[]; mean: number | null; threshold: number; rule: string };
export type Reduction = { frontier: FrontierEntry[]; visible: Id[]; tipCount: number; counts: Record<string, number> };
export type Point = { x: number; y: number };
export type Curve = { c1: Point; c2: Point; end: Point };
export type Route = { segments: Curve[] };
export type Layout = {
  nodes: Record<Id, Point>; routes: Record<Id, Route>; pinnedNodes: Id[]; pinnedEdges: Id[];
  childOrder: Record<Id, Id[]>; mode: 'organic' | 'scientific';
  lineStyle?: 'curved' | 'straight'; // Straight mode connects stored waypoints; curve handles are retained.
};
export type Presentation = {
  widthMm: number; heightMm: number; strokeMm: number; taper: number; clearanceMm: number;
  toleranceMm: number; junctionMm: number; sourceUnitMm: number;
  labels: boolean; labelOffsets: Record<Id, Point>;
};
export type Correction = { source_node_id: Id; raw_label: string; status: string; display_taxonomy: string | null; evidence_url: string | null; review_date: string; [key: string]: unknown };
export type BranchDirection = { angleDeg: number; strength: number };
export type EndpointBorder = {
  id: string; name: string; points: Point[]; closed: boolean;
  placement: 'nearest' | 'spread'; insetMm: number; variationMm: number; seed: number;
  direction?: BranchDirection | null; // Undefined inherits the overall fit; null explicitly disables direction.
  assignments: { sourceNodeId: Id; fraction: number; normalSign: 1 | -1 }[];
};
export type ReferenceImage = {
  name: string; dataUrl: string; pixelWidth: number; pixelHeight: number;
  x: number; y: number; widthMm: number; heightMm: number; rotationDeg: number;
  opacity: number; visible: boolean; layer: 'behind' | 'above';
};
export type Design = {
  borders: EndpointBorder[]; activeBorderId?: string; showBorders: boolean; referenceImage?: ReferenceImage;
  fitSettings?: FitSettings;
};
export type FitSettings = {
  algorithm: 'junction_fit_v1'; borderScope: 'all' | 'active'; strength: number;
  junctionDepth: number; preserveFlow: number; junctionSpacingMm: number; smoothing: number;
  direction?: BranchDirection;
  routing?: number; forkSpread?: number; // Optional for projects saved before spacing-aware routing.
};
export type FitResult = {
  layout: Layout; beforeQA: QA; afterQA: QA;
  movedJunctions: { id: Id; from: Point; to: Point }[];
  movedEndpoints: number; assignedEndpoints: number; pinnedEndpoints: number; hiddenAssignments: number;
  fixedJunctions: number; errorBeforeMm: number; errorAfterMm: number; crowdedJunctionPairs: number;
  directedEdges: number; directionConflicts: number;
  refinedRoutes: number; routingLimited: boolean;
};
export type Project = {
  format: 'phylogenetic-tree-studio'; version: 1; appVersion: '0.1.0'; title: string;
  sourceText: string; sourceSha256: string; provenance: Record<string, unknown>;
  corrections: Correction[]; recipe: Recipe; layout: Layout; presentation: Presentation;
  selection?: Id[];
  design?: Design;
  // Session-only authoring state. Persist through project-v2, never as a V1 file.
  authoring?: import('./model/document.ts').AuthoringState;
};
export type Issue = { type: 'crossing' | 'clearance' | 'junction' | 'self-intersection' | 'bounds' | 'labels'; edges: Id[]; point?: Point; detail: string };
export type QA = {
  schemaVersion: 1; generatedAt: string; sourceSha256: string; endpoints: number; sourceTips: number;
  coveragePassed: boolean; incidencePassed: boolean; crossingPassed: boolean; clearancePassed: boolean;
  status: 'checked' | 'draft'; issues: Issue[]; root: RootSpec;
  toleranceMm: number; clearanceMm: number; junctionMm: number; checkedEdgePairs: number;
  minClearanceMm: number | null; annotationCollisions: number; omittedIssueCount: number;
  limitations: string[]; distortion: { sourceUnitMm: number; minRatio: number | null; maxRatio: number | null; undefinedEdges: number };
};
