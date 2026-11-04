import type { BuildInfo } from '../provenance/identity.ts';
import { parseNewick } from '../newick.ts';
import { defaultRecipe,orient,reduce } from '../science.ts';
import { DEFAULT_PRESENTATION,generateLayout } from '../geometry.ts';
import { startAuthoring } from '../project-v2.ts';
import { acceptBasisEdit,acceptCommand } from '../commands.ts';
import type { Project } from '../types.ts';
/** Entirely invented A–E topology; no factual relationships between organisms are asserted. */
export async function sampleTree(build:BuildInfo|null=null){
  const text='((A:1,B:2):3,(C:1,D:1,E:1):2);',source=await parseNewick(text),recipe=defaultRecipe(source);recipe.root.status='declared_assumption';recipe.globalThreshold=0;
  const rooted=orient(source,recipe.root),reduction=reduce(source,rooted,recipe);recipe.resolvedFrontierSourceNodeIds=reduction.frontier.map(e=>e.id);
  const legacy:Project={format:'phylogenetic-tree-studio',version:1,appVersion:'0.1.0',title:'Synthetic sample tree A–E',sourceText:text,sourceSha256:source.sha256,provenance:{kind:'synthetic-sample-tree',title:'Original Clade Studio A–E sample topology',license:'0BSD',empiricalEvidence:false,reviewStatus:'Hypothetical topology; not an empirically reviewed organism tree',modifications:'Original invented topology; artistic and structured geometry may be generated.'},recipe,corrections:[],layout:generateLayout(rooted,reduction,DEFAULT_PRESENTATION,'organic'),presentation:structuredClone(DEFAULT_PRESENTATION)};
  let project=startAuthoring(legacy,source,build,'new',['newick-parser','maximal-frontier','organic-initializer']);
  project=acceptBasisEdit(project,{...project.authoring.basis,name:'Synthetic A–E topology',question:'Relationships in an explicitly synthetic A–E topology.',relationshipKind:'phylogeny',entityKind:'taxon-concepts',edgeMeaning:'Invented ancestry in a synthetic sample tree.',evidenceBasis:'No empirical evidence. A–E and their relationships were invented as sample data for authoring layouts.',provider:'Clade Studio original sample',release:'A–E v1',epistemicStatus:'teaching-example',limitations:'Does not describe real organisms. The C/D/E split is deliberately unresolved; drawing order does not resolve it.'},source,build);
  const proposal=structuredClone(project);proposal.authoring.root={status:'rooted',basis:'hypothetical',explanation:'Explicitly hypothetical root at the supplied serialization origin for this synthetic sample.',referenceIds:[]};
  project=acceptCommand(project,proposal,source,{notes:'Declared the sample root as explicitly hypothetical; source and geometry unchanged.'},build);
  return {source,rooted,reduction,project};
}

/** Invented classification parent links and rank policy; no real taxonomic authority. */
export async function classificationSample(build:BuildInfo|null=null){
  const f=await sampleTree(build),basis={...f.project.authoring.basis,name:'Synthetic A–E classification',question:'Membership in explicitly invented classification groups.',relationshipKind:'classification' as const,entityKind:'taxon-concepts' as const,edgeMeaning:'Membership in supplied classification groups; not evolutionary ancestry.',evidenceBasis:'Entirely invented parent links and ranks for demonstrating authoring controls. No empirical organism or authority claims.',provider:'Clade Studio synthetic framework',release:'A–E classification v1',epistemicStatus:'teaching-example' as const,limitations:'Invented groups and ranks. Equal rank spacing is a drawing convention; source branch numbers are ignored.'};
  let project=acceptBasisEdit(f.project,basis,f.source,build),proposal=structuredClone(project);proposal.title='Synthetic classification A–E';proposal.authoring.root={status:'unspecified',explanation:'Classification top is the supplied serialization origin, not a biological root.',referenceIds:[]};project=acceptCommand(project,proposal,f.source,{notes:'Synthetic classification input; no biological root or ancestry claim.'},build);
  const spec:import('./types.ts').ClassificationSpec={sourceSha256:f.source.sha256,authority:basis.provider,release:basis.release,evidence:'Invented A–E classification ranks. Division is deliberately absent; group and unit describe synthetic categories only.',referenceIds:[],rankOrder:['division','group','unit'],ranks:{n000000:null,n000001:'group',n000002:'unit',n000003:'unit',n000004:'group',n000005:'unit',n000006:'unit',n000007:'unit'},unrankedPolicy:'parent-link-interpolation-v1'};
  return {...f,project,spec};
}
