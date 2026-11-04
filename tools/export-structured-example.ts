import { defaultUnrootedSpec, projectUnrooted } from '../src/structured/unrooted.ts';
import { mkdir,writeFile } from 'node:fs/promises';
import { classificationSample, sampleTree } from '../src/structured/example.ts';
import { projectClassification } from '../src/structured/classification.ts';
import { projectTree } from '../src/structured/projection.ts';
import { DEFAULT_STRUCTURED,estimatedMeasurements } from '../src/structured/layout.ts';
import { makeArtisticCopy, applyArtisticEdit } from '../src/structured/artistic.ts';
import { scaleBarText } from '../src/structured/metric.ts';
import { makeUnrootedView, makeClassificationView, makeMetricView, makeStructuredView } from '../src/structured/view.ts';
import { acceptCommand } from '../src/commands.ts';
import { exportStructuredFiles } from '../src/structured/export.ts';
import { zipFiles } from '../src/export.ts';
import { addArtifactManifest } from '../src/export-provenance.ts';
import { contentDigest } from '../src/provenance/identity.ts';
import type { StructuredSettings,ProjectionSpec,MetricSpec } from '../src/structured/types.ts';
const {filesUnder}=await import('./distribution-policy.mjs');
const {readRegular,sha256}=await import('./release-manifest.mjs');
const paths=[...(await filesUnder('src')).map(name=>`src/${name}`),'tools/export-structured-example.ts','tools/distribution-policy.mjs','tools/release-manifest.mjs','package-lock.json'].sort();
const files=await Promise.all(paths.map(async path=>{const bytes=await readRegular('.',path);return{path,bytes:bytes.length,sha256:sha256(bytes)};}));
const manifest={format:'clade-build-manifest' as const,version:1 as const,appVersion:'0.1.0',files};
const build={format:'clade-build-info' as const,version:1 as const,appVersion:'0.1.0',buildId:await contentDigest(manifest),manifest:'build-manifest.json' as const};
const example=await sampleTree(build),summary=[];
for(const kind of ['rectangular','circular','fan'] as const){
  const settings:StructuredSettings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360};
  const projection:ProjectionSpec={selection:kind==='fan'?{kind:'explicit-tips',tipIds:['n000002','n000005','n000007']}:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
  const graph=projectTree(example.source,example.rooted,projection),metrics=estimatedMeasurements(graph,settings),view=makeStructuredView(example.project,example.source,projection,settings,metrics,`structured-${kind}`,`Synthetic ${kind} sample`);
  const proposal=structuredClone(example.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(example.project,proposal,example.source,{methods:['selected-taxon-projection','clade-cluster','compound-validation'],replace:true,parameters:{projection,settings,fontStatus:metrics.fontStatus},notes:'Accepted CLI sample with explicitly estimated text metrics; browser regeneration is required for device-measured labels.'},build);
  const outputs=exportStructuredFiles(example.source,project,build),name=`structured-${kind}`,dir=`outputs/${name}`;outputs['build-manifest.json']=JSON.stringify(manifest,null,2);addArtifactManifest(outputs,project);
  await mkdir(dir,{recursive:true});for(const [name,data]of Object.entries(outputs))await writeFile(`${dir}/${name}`,data);await writeFile(`outputs/${name}.zip`,zipFiles(outputs));
  summary.push({name,status:view.qa.status,fontStatus:metrics.fontStatus,representedTips:graph.representedTips.length,omittedTips:graph.omittedTips.length,sourceCoverage:view.qa.coveragePassed,incidence:view.qa.incidencePassed,noStrokeContacts:view.qa.crossingPassed,clearance:view.qa.clearancePassed,labelCollisions:view.qa.labelCollisions});
  if(kind==='circular'){
    const copy=makeArtisticCopy(view,'artistic-sample','Synthetic artistic copy'),copied=structuredClone(project);copied.authoring.structuredViews![copy.id]=copy;copied.authoring.activeStructuredViewId=copy.id;
    const base=acceptCommand(project,copied,example.source,{methods:['compound-artistic-copy'],inputs:[`structured/${view.id}`],parameters:{originViewId:view.id,originSceneRevision:view.scene.revision},notes:'Copied exact structured geometry into a distinct artistic view.'},build);
    const edit={kind:'move-junction' as const,nodeIds:['n000004'],delta:{x:-12,y:8}},edited=applyArtisticEdit(copy,edit),proposal=structuredClone(base);proposal.authoring.structuredViews![copy.id]=edited;
    const saved=acceptCommand(base,proposal,example.source,{methods:['compound-artistic-edit','compound-validation'],inputs:[`structured/${copy.id}`],parameters:{edit},notes:'One explicit artistic connector translation; source graph and original structured view retained.'},build);
    const artwork=exportStructuredFiles(example.source,saved,build),folder='outputs/artistic-copy';artwork['build-manifest.json']=JSON.stringify(manifest,null,2);addArtifactManifest(artwork,saved);await mkdir(folder,{recursive:true});for(const [name,data]of Object.entries(artwork))await writeFile(`${folder}/${name}`,data);await writeFile('outputs/artistic-copy.zip',zipFiles(artwork));
    summary.push({name:'artistic-copy',status:edited.qa.status,fontStatus:metrics.fontStatus,representedTips:graph.representedTips.length,omittedTips:graph.omittedTips.length,sourceCoverage:edited.qa.coveragePassed,incidence:edited.qa.incidencePassed,noStrokeContacts:edited.qa.crossingPassed,clearance:edited.qa.clearancePassed,labelCollisions:edited.qa.labelCollisions});
  }
}
for(const kind of ['rectangular','circular','fan'] as const){
  const settings:StructuredSettings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360},projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}};
  const spec:MetricSpec={measure:{meaning:'other-distance',unit:'synthetic distance units',evidence:'Invented A–E sample distances; no empirical organism measurements.',referenceIds:[],sourceSha256:example.source.sha256,declaration:'user-supplied'},mmPerUnit:15,scaleBarValue:1};
  const graph=projectTree(example.source,example.rooted,projection),metrics=estimatedMeasurements(graph,settings),mm=settings.fontSizePt*25.4/72,text=scaleBarText(spec);metrics.scaleBar={text,widthMm:text.length*mm*.6,ascentMm:mm*.8,descentMm:mm*.2};
  const view=makeMetricView(example.project,example.source,projection,settings,metrics,spec,`metric-${kind}`,`Synthetic ${kind} phylogram`),proposal=structuredClone(example.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(example.project,proposal,example.source,{methods:['selected-taxon-projection','metric-distance-layout','metric-distance-validation','compound-validation'],replace:true,parameters:{projection,settings,metricSpec:spec,fontStatus:metrics.fontStatus},notes:'Synthetic source-distance example; estimated text metrics remain draft until browser remeasurement.'},build);
  const outputs=exportStructuredFiles(example.source,project,build),name=`metric-${kind}`,dir=`outputs/${name}`;outputs['build-manifest.json']=JSON.stringify(manifest,null,2);addArtifactManifest(outputs,project);
  await mkdir(dir,{recursive:true});for(const [file,data]of Object.entries(outputs))await writeFile(`${dir}/${file}`,data);await writeFile(`outputs/${name}.zip`,zipFiles(outputs));
  summary.push({name,status:view.qa.status,fontStatus:metrics.fontStatus,representedTips:graph.representedTips.length,omittedTips:graph.omittedTips.length,sourceCoverage:view.qa.coveragePassed,incidence:view.qa.incidencePassed,noStrokeContacts:view.qa.crossingPassed,clearance:view.qa.clearancePassed,labelCollisions:view.qa.labelCollisions});
}
const classification=await classificationSample(build);
for(const kind of ['rectangular','circular','fan'] as const){
  const settings:StructuredSettings={...DEFAULT_STRUCTURED,kind,sweepDeg:kind==='fan'?270:360},projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}},graph=projectClassification(classification.source,projection),metrics=estimatedMeasurements(graph,settings);
  const view=makeClassificationView(classification.project,classification.source,projection,settings,metrics,classification.spec,`classification-${kind}`,`Synthetic ${kind} classification`),proposal=structuredClone(classification.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(classification.project,proposal,classification.source,{methods:['classification-projection','classification-rank-layout','classification-validation','compound-validation'],replace:true,parameters:{projection,settings,classificationSpec:classification.spec,fontStatus:metrics.fontStatus},notes:'Original invented classification sample, with estimated labels. No empirical taxonomic authority or biological ancestry is claimed.'},build);
  const outputs=exportStructuredFiles(classification.source,project,build),name=`classification-${kind}`,dir=`outputs/${name}`;outputs['build-manifest.json']=JSON.stringify(manifest,null,2);addArtifactManifest(outputs,project);await mkdir(dir,{recursive:true});for(const [file,data]of Object.entries(outputs))await writeFile(`${dir}/${file}`,data);await writeFile(`outputs/${name}.zip`,zipFiles(outputs));
  summary.push({name,status:view.qa.status,fontStatus:metrics.fontStatus,representedTips:graph.representedTips.length,omittedTips:graph.omittedTips.length,sourceCoverage:view.qa.coveragePassed,incidence:view.qa.incidencePassed,noStrokeContacts:view.qa.crossingPassed,clearance:view.qa.clearancePassed,labelCollisions:view.qa.labelCollisions});
}
for(const algorithm of ['equal-angle','daylight'] as const){
  const settings:StructuredSettings={...DEFAULT_STRUCTURED,kind:'circular',curves:false},projection:ProjectionSpec={selection:{kind:'all'},collapse:[],expand:[],reveal:[],childOrder:{}},spec={...defaultUnrootedSpec(example.source),algorithm},graph=projectUnrooted(example.source,projection,spec),metrics=estimatedMeasurements(graph,settings);
  const name=`unrooted-${algorithm}`,view=makeUnrootedView(example.project,example.source,projection,settings,metrics,spec,name,`Synthetic unrooted ${algorithm}`),proposal=structuredClone(example.project);proposal.authoring.structuredViews={[view.id]:view};proposal.authoring.activeStructuredViewId=view.id;
  const project=acceptCommand(example.project,proposal,example.source,{methods:['unrooted-projection','unrooted-equal-angle',...(algorithm==='daylight'?['unrooted-daylight']:[]),'unrooted-validation','compound-validation'],replace:true,parameters:{projection,settings,unrootedSpec:spec,fontStatus:metrics.fontStatus},notes:'Original invented A–E unrooted sample. Stored hypothetical root is unused. Labels are estimated and remain draft until browser remeasurement.'},build);
  const outputs=exportStructuredFiles(example.source,project,build),dir=`outputs/${name}`;outputs['build-manifest.json']=JSON.stringify(manifest,null,2);addArtifactManifest(outputs,project);await mkdir(dir,{recursive:true});for(const [file,data]of Object.entries(outputs))await writeFile(`${dir}/${file}`,data);await writeFile(`outputs/${name}.zip`,zipFiles(outputs));
  summary.push({name,status:view.qa.status,fontStatus:metrics.fontStatus,representedTips:graph.representedTips.length,omittedTips:graph.omittedTips.length,sourceCoverage:view.qa.coveragePassed,incidence:view.qa.incidencePassed,noStrokeContacts:view.qa.crossingPassed,clearance:view.qa.clearancePassed,labelCollisions:view.qa.labelCollisions});
}
await writeFile('outputs/structured-example-verification.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
