import type { Layout, Project, Recipe, Source, Rooted, Reduction } from './types.ts';
import type { WorkingProject } from './model/document.ts';
import type { BuildInfo } from './provenance/identity.ts';
import { parseNewick } from './newick.ts';
import { defaultRecipe, orient, reduce } from './science.ts';
import { DEFAULT_PRESENTATION, generateLayout } from './geometry.ts';
import { loadAnyProject, startAuthoring } from './project-v2.ts';
import { BUNDLED_DATASETS, bundledDataset } from './datasets.ts';

export type PreparedImport = {kind:'recipe';recipe:Recipe} | {kind:'newick'|'project';project:WorkingProject;source:Source;rooted:Rooted;reduction:Reduction;scientificLayout:Layout;migrated:boolean};
/** Prepare everything that can fail before the UI replaces its current document. */
export async function prepareLocalImport(text:string,filename:string,build:BuildInfo|null,current:{source:Source;recipe:Recipe}):Promise<PreparedImport> {
  if(new TextEncoder().encode(text).length>50_000_000)throw new Error('File exceeds the 50 MB limit.');
  if(text.trimStart().startsWith('{')) {
    const json=JSON.parse(text);
    if(json.format==='phylogenetic-tree-studio') {
      const loaded=await loadAnyProject(text,build);
      return {...loaded,kind:'project',scientificLayout:generateLayout(loaded.rooted,loaded.reduction,loaded.project.presentation,'scientific',loaded.project.layout)};
    }
    if(json.algorithm!=='maximal_frontier_v1')throw new Error('This JSON file is not a project or a reduction recipe.');
    const recipe:Recipe={...defaultRecipe(current.source),...json},rooted=orient(current.source,recipe.root);reduce(current.source,rooted,recipe,true);
    if(JSON.stringify(recipe.root)!==JSON.stringify(current.recipe.root))throw new Error('This recipe uses a different root. Set that biological root before importing its reduction rules.');
    return {kind:'recipe',recipe};
  }
  return prepareNewick(text,filename,build);
}

/** Collapse a deterministic, exhaustive frontier without inventing relationships or dropping tips. */
export function overviewRecipe(source:Source,limit=100):Recipe {
  if(!Number.isInteger(limit)||limit<2||limit>500)throw new Error('Overview limit must be between 2 and 500.');
  const recipe=defaultRecipe(source);recipe.globalThreshold=0;
  const rooted=orient(source,recipe.root),frontier=new Set(rooted.nodes[rooted.rootId].children);
  if(frontier.size>limit)throw new Error('The source root has too many direct children for this overview. Import the file to choose a subset.');
  while(true){
    const candidate=[...frontier].filter(id=>rooted.nodes[id].children.length&&frontier.size-1+rooted.nodes[id].children.length<=limit).sort((a,b)=>rooted.nodes[b].count-rooted.nodes[a].count||a.localeCompare(b))[0];
    if(!candidate)break;
    frontier.delete(candidate);for(const child of rooted.nodes[candidate].children)frontier.add(child);
  }
  recipe.collapse=rooted.order.filter(id=>frontier.has(id)&&rooted.nodes[id].children.length>0);
  return recipe;
}

export async function prepareBundledDataset(id:string,text:string,build:BuildInfo|null):Promise<Exclude<PreparedImport,{kind:'recipe'}>> {
  const dataset=BUNDLED_DATASETS.find(d=>d.id===id);if(!dataset)throw new Error('Unknown bundled dataset.');
  return prepareNewick(text,dataset.name,build,id);
}
async function prepareNewick(text:string,filename:string,build:BuildInfo|null,expectedDatasetId?:string):Promise<Exclude<PreparedImport,{kind:'recipe'}>> {
  const source=await parseNewick(text),dataset=bundledDataset(source.sha256);
  if(expectedDatasetId&&dataset?.id!==expectedDatasetId)throw new Error('Bundled dataset checksum does not match its reviewed source. Current project retained.');
  if(dataset&&(source.tips.length!==dataset.tipCount||source.order.length!==dataset.nodeCount))throw new Error('Bundled source counts do not match its reviewed metadata.');
  const recipe=dataset?overviewRecipe(source):defaultRecipe(source),rooted=orient(source,recipe.root),reduction=reduce(source,rooted,recipe);
  recipe.resolvedFrontierSourceNodeIds=reduction.frontier.map(entry=>entry.id);
  const provenance=dataset?{filename,datasetId:dataset.id,release:dataset.release,sourceUrl:dataset.sourceUrl,license:dataset.license,licenseUrl:dataset.licenseUrl,attribution:dataset.references,modifications:dataset.changes,limitations:dataset.limitations,overview:'Explicit collapsed groups; all original tips retained. Search the full source in Reduce or Layout.'}:{filename,importedAt:new Date().toISOString(),license:'Not supplied',modifications:'Imported without changing source bytes.'};
  const legacy:Project={format:'phylogenetic-tree-studio',version:1,appVersion:'0.1.0',title:dataset?.name??(filename.replace(/\.[^.]+$/,'')||'Imported tree'),sourceText:text,sourceSha256:source.sha256,provenance,corrections:[],recipe,layout:generateLayout(rooted,reduction,DEFAULT_PRESENTATION,'organic'),presentation:structuredClone(DEFAULT_PRESENTATION)};
  const project=startAuthoring(legacy,source,build,'new',['newick-parser',...(dataset?['bounded-overview']:[]),'maximal-frontier','organic-initializer']);
  return {kind:'newick',project,source,rooted,reduction,scientificLayout:generateLayout(rooted,reduction,project.presentation,'scientific',project.layout),migrated:false};
}
