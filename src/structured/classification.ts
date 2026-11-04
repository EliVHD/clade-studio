import type { Source, RootSpec } from '../types.ts';
import type { ScientificBasis, WorkingProject } from '../model/document.ts';
import type { ClassificationSpec, DisplayGraph, RenderScene, StructuredSettings, TextMeasurements, SceneQA, ProjectionSpec } from './types.ts';
import { orient } from '../science.ts';
import { projectTree } from './projection.ts';
import { buildSceneFromDepthCoordinates } from './coordinates.ts';
import { validateStructuredSettings, sceneRevision } from './layout.ts';
import { validateScene } from './validate.ts';
import { digestSync } from '../provenance/sync-identity.ts';
const exact=(o:object,keys:string[])=>!!o&&!Array.isArray(o)&&Object.keys(o).sort().join('|')===keys.sort().join('|');
export const classificationTraversal=(source:Source):RootSpec=>({kind:'node',sourceNodeId:source.rootId,status:'classification-parent-links'});
export function requireClassificationBasis(basis:ScientificBasis):void{
  if(basis.relationshipKind!=='classification'||basis.entityKind!=='taxon-concepts'||!basis.provider?.trim()||!basis.release?.trim()||!basis.edgeMeaning.trim()||!basis.evidenceBasis.trim())throw new Error('Classification requires taxon concepts, a named authority/framework and release, and documented parent-link meaning/evidence in Scientific basis. It does not require a biological root.');
}
export function validateClassificationSpec(spec:ClassificationSpec,source:Source,basis?:ScientificBasis):void{
  if(!spec||!exact(spec,['sourceSha256','authority','release','evidence','referenceIds','rankOrder','ranks','unrankedPolicy'])||spec.sourceSha256!==source.sha256||spec.unrankedPolicy!=='parent-link-interpolation-v1')throw new Error('Classification ranks must identify the exact source and supported placement policy.');
  for(const key of ['authority','release','evidence'] as const)if(typeof spec[key]!=='string'||!spec[key].trim()||spec[key].length>(key==='evidence'?5000:500))throw new Error('Supply the classification authority/framework, release and rank evidence.');
  if(basis){requireClassificationBasis(basis);if(spec.authority!==basis.provider||spec.release!==basis.release)throw new Error('Rank authority/release must match this scientific basis.');}
  if(!Array.isArray(spec.referenceIds)||spec.referenceIds.length>100||new Set(spec.referenceIds).size!==spec.referenceIds.length||spec.referenceIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,150}$/.test(id)))throw new Error('Invalid classification evidence citations.');
  if(!Array.isArray(spec.rankOrder)||!spec.rankOrder.length||spec.rankOrder.length>32||new Set(spec.rankOrder).size!==spec.rankOrder.length||spec.rankOrder.some(rank=>typeof rank!=='string'||!rank||rank.trim()!==rank||rank.length>100))throw new Error('Supply 1–32 distinct rank names in broad-to-specific order.');
  if(!spec.ranks||typeof spec.ranks!=='object'||Array.isArray(spec.ranks)||Object.keys(spec.ranks).length>source.order.length||Object.entries(spec.ranks).some(([id,rank])=>!Object.hasOwn(source.nodes,id)||(rank!==null&&!spec.rankOrder.includes(rank))))throw new Error('Ranks use exact source node IDs and policy names; null means explicitly unranked, omitted means unknown. Names and Newick numbers never establish ranks.');
}
export function classificationLevels(source:Source,spec:ClassificationSpec):Record<string,number>{
  validateClassificationSpec(spec,source);const ceiling:Record<string,number>={},remaining:Record<string,number>={},levels:Record<string,number>={},parent:Record<string,string>={},end=spec.rankOrder.length+1;
  const fixed=(id:string)=>typeof spec.ranks[id]==='string'?spec.rankOrder.indexOf(spec.ranks[id]!)+1:null;
  for(const id of [...source.order].reverse()){
    const children=source.nodes[id].children,rank=fixed(id);for(const child of children)parent[child]=id;
    ceiling[id]=rank??(children.length?Math.min(...children.map(c=>ceiling[c])):end);
    remaining[id]=rank===null?1+Math.max(0,...children.map(c=>remaining[c])):0;
  }
  for(const id of source.order){const rank=fixed(id),p=parent[id],low=p?levels[p]:0;
    const level=rank??(p?low+(ceiling[id]-low)/(remaining[id]+1):0);
    if(!Number.isFinite(level)||level<0||level>=end||(p&&level<=low))throw new Error(`Classification rank order conflicts with parent links at ${id}. Child ranks must be more specific than every ranked parent; fix the records or policy instead of inventing a rank.`);
    levels[id]=level;
  }
  return Object.fromEntries(Object.entries(levels).map(([id,level])=>[id,level/end]));
}
export function projectClassification(source:Source,projection:ProjectionSpec,corrections:WorkingProject['corrections']=[]):DisplayGraph{
  // Use the supplied classification parent links, independently of biological rooting controls.
  if(projection.collapse.includes(source.rootId))throw new Error('The supplied classification top cannot be collapsed.');
  const graph=projectTree(source,orient(source,classificationTraversal(source)),projection,corrections);for(const node of Object.values(graph.nodes))if(node.aggregate||source.nodes[node.id].children.length&&!source.nodes[node.id].label)node.label=node.label.replace(/^Source clade /,'Source group ');return graph;
}
export function classificationRank(spec:ClassificationSpec,id:string):{status:'ranked'|'unranked'|'unknown';rank:string|null}{
  return Object.hasOwn(spec.ranks,id)?spec.ranks[id]===null?{status:'unranked',rank:null}:{status:'ranked',rank:spec.ranks[id]}:{status:'unknown',rank:null};
}
export function classificationScale(graph:DisplayGraph,s:StructuredSettings,m:TextMeasurements):number{
  return s.kind==='rectangular'?Math.max(10,s.widthMm-2*s.marginMm-Math.max(0,...graph.endpoints.map(id=>m.metrics[id].widthMm))-s.labelGapMm):s.outerRadiusMm-s.innerRadiusMm;
}
export function layoutClassification(source:Source,graph:DisplayGraph,s:StructuredSettings,m:TextMeasurements,spec:ClassificationSpec,nodes:RenderScene['nodeOffsets']={},labels:RenderScene['labelOffsets']={}):RenderScene{
  validateStructuredSettings(s);validateClassificationSpec(spec,source);if(graph.sourceSha256!==source.sha256||graph.rootId!==source.rootId)throw new Error('A classification view must preserve its supplied top and parent orientation.');
  if(Object.values(nodes).some(offset=>offset.depth!==0))throw new Error('Classification levels are fixed by rank records and the stated interpolation policy. Adjust across groups or move labels; start a new view to remove old depth offsets.');
  const levels=classificationLevels(source,spec),displayed=Object.fromEntries(graph.order.map(id=>[id,levels[id]]));
  const scene=buildSceneFromDepthCoordinates(graph,s,m,displayed,classificationScale(graph,s,m),nodes,labels);
  scene.classification={spec:structuredClone(spec),topNodeId:source.rootId,levels,rankLevels:Object.fromEntries(spec.rankOrder.map((rank,i)=>[rank,(i+1)/(spec.rankOrder.length+1)]))};scene.revision=sceneRevision(scene);return scene;
}
export function validateClassificationScene(source:Source,graph:DisplayGraph,scene:RenderScene,baseValidator:typeof validateScene=validateScene):SceneQA{
  const data=scene.classification;if(!data||scene.metric)throw new Error('Classification scenes require rank records and must not carry a distance scale.');
  const levels=classificationLevels(source,data.spec);if(digestSync(levels)!==digestSync(data.levels)||data.topNodeId!==source.rootId)throw new Error('Classification levels disagree with source parent links/rank records.');
  const s=scene.settings,k=classificationScale(graph,s,scene.measurements),cx=s.widthMm/2,cy=s.heightMm/2,a=s.orientationDeg*Math.PI/180;
  const coordinate=(p:{x:number;y:number})=>s.kind==='rectangular'?((p.x-cx)*Math.cos(a)+(p.y-cy)*Math.sin(a)+cx-s.marginMm)/k:(Math.hypot(p.x-cx,p.y-cy)-s.innerRadiusMm)/k;
  if(scene.junctionGlyphs.some(g=>Math.abs(coordinate(g.anchor)-levels[g.nodeId])>1e-8)||scene.ports.some(p=>Math.abs(coordinate(p.point)-levels[p.nodeId])>1e-8))throw new Error('Classification geometry does not encode its declared rank placement.');
  const qa=baseValidator(graph,scene);qa.limitations=['Classification parent links are group membership, not evolutionary ancestry. No MRCA, elapsed time or evolutionary-distance interpretation is available.','Rank levels follow the supplied broad-to-specific policy. Missing ranks stay absent; explicitly unranked and unknown records use disclosed geometric interpolation, not invented taxa/ranks.','The supplied top classification node is independent of any biological rooting assumption; source branch lengths are retained only as input data and are ignored for placement.',...qa.limitations.filter(l=>!l.startsWith('Nonmetric cladogram:'))];return qa;
}
