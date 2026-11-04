import { projectUnrooted, layoutUnrooted, validateUnrootedScene } from './structured/unrooted.ts';
import { parseNewick } from './newick.ts';
import { orient, reduce } from './science.ts';
import { validateGeometry } from './geometry.ts';
import { fitSilhouette } from './fitting.ts';
import { validateLayout } from './project.ts';
import type { Source, Recipe, Layout, Presentation, Design, FitSettings, Correction } from './types.ts';

import { projectClassification, layoutClassification, validateClassificationScene } from './structured/classification.ts';
import { projectTree } from './structured/projection.ts';
import { layoutCluster } from './structured/layout.ts';
import { validateScene } from './structured/validate.ts';
import { layoutMetric, validateMetricScene } from './structured/metric.ts';
import { improveReadability, type ReadabilityPolicy } from './structured/readability.ts';
import type { ProjectionSpec, StructuredSettings, TextMeasurements, RenderScene, MetricSpec, ClassificationSpec, UnrootedSpec } from './structured/types.ts';

let source: Source | null = null;
const workerScope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (data: unknown) => void };
workerScope.onmessage = async (event: MessageEvent<{ id: number; baseRevision: string; viewId: string; kind: 'reduce' | 'validate' | 'fit' | 'structured'; metricSpec?:MetricSpec; classificationSpec?:ClassificationSpec; unrootedSpec?:UnrootedSpec; readabilityPolicy?:ReadabilityPolicy; projection?:ProjectionSpec; corrections?:Correction[]; settingsStructured?:StructuredSettings; measurements?:TextMeasurements; nodeOffsets?:RenderScene['nodeOffsets']; labelOffsets?:RenderScene['labelOffsets']; sourceText: string; recipe: Recipe; layout?: Layout; presentation?: Presentation; design?: Design; settings?: FitSettings }>) => {
  const job = event.data;
  try {
    if (!source || source.text !== job.sourceText) source = await parseNewick(job.sourceText);
    if(job.kind==='structured'){
      const graph=job.unrootedSpec?projectUnrooted(source,job.projection!,job.unrootedSpec,job.corrections):job.classificationSpec?projectClassification(source,job.projection!,job.corrections):projectTree(source,orient(source,job.recipe.root),job.projection!,job.corrections);
      if(job.unrootedSpec){if(job.readabilityPolicy||job.metricSpec||job.classificationSpec)throw new Error('Unrooted layout has a separate nonmetric spacing policy.');const scene=layoutUnrooted(graph,job.settingsStructured!,job.measurements!,job.unrootedSpec,job.nodeOffsets,job.labelOffsets);workerScope.postMessage({id:job.id,baseRevision:job.baseRevision,viewId:job.viewId,value:{graph,scene,qa:validateUnrootedScene(graph,scene)}});return;}
      if(job.classificationSpec){if(job.readabilityPolicy||job.metricSpec)throw new Error('Classification uses its own rank placement, without metric scaling or nonmetric readability search.');const scene=layoutClassification(source,graph,job.settingsStructured!,job.measurements!,job.classificationSpec,job.nodeOffsets,job.labelOffsets);workerScope.postMessage({id:job.id,baseRevision:job.baseRevision,viewId:job.viewId,value:{graph,scene,qa:validateClassificationScene(source,graph,scene)}});return;}
      if(job.metricSpec){if(job.readabilityPolicy)throw new Error('Metric scale is explicit; the nonmetric spacing search cannot change it.');const scene=layoutMetric(graph,job.settingsStructured!,job.measurements!,job.metricSpec,job.nodeOffsets,job.labelOffsets);workerScope.postMessage({id:job.id,baseRevision:job.baseRevision,viewId:job.viewId,value:{graph,scene,qa:validateMetricScene(graph,scene)}});return;}
      const scene=job.readabilityPolicy?null:layoutCluster(graph,job.settingsStructured!,job.measurements!,job.nodeOffsets,job.labelOffsets);
      const result=job.readabilityPolicy?improveReadability(graph,job.settingsStructured!,job.measurements!,job.readabilityPolicy,job.nodeOffsets,job.labelOffsets):{scene:scene!,qa:validateScene(graph,scene!)};
      workerScope.postMessage({id:job.id,baseRevision:job.baseRevision,viewId:job.viewId,value:{graph,...result}});return;
    }
    const rooted = orient(source, job.recipe.root), reduction = reduce(source, rooted, job.recipe);
    let value: unknown;
    if (job.kind === 'fit') {
      validateLayout(job.layout!, rooted, reduction);
      const result = fitSilhouette(rooted, reduction, job.layout!, job.presentation!, job.design!, job.settings!);
      validateLayout(result.layout, rooted, reduction);
      value = { ...result, beforeQA: validateGeometry(source, rooted, job.recipe, reduction, job.layout!, job.presentation!), afterQA: validateGeometry(source, rooted, job.recipe, reduction, result.layout, job.presentation!) };
    } else value = job.kind === 'reduce' ? reduction : validateGeometry(source, rooted, job.recipe, reduction, job.layout!, job.presentation!);
    workerScope.postMessage({ id: job.id, baseRevision: job.baseRevision, viewId: job.viewId, value });
  } catch (error) { workerScope.postMessage({ id: job.id, baseRevision: job.baseRevision, viewId: job.viewId, error: error instanceof Error ? error.message : String(error) }); }
};
