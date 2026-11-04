import type { Source } from '../types.ts';
import type { SceneQA, StructuredView } from './types.ts';
import { validateScene } from './validate.ts';
import { validateScene as validateSceneV1 } from './validate-v1.ts';
import { validateScene as validateSceneV2 } from './validate-v2.ts';
import { validateMetricScene } from './metric.ts';
import { validateClassificationScene } from './classification.ts';
import { validateUnrootedScene } from './unrooted.ts';

/** Missing on historical V3/V4 views. Layout adapter versions remain independent. */
export const CURRENT_VALIDATION_PROFILE = 'compound-v3' as const;

function validate(view: StructuredView, source: Source, base: typeof validateScene): SceneQA {
  if (view.intent === 'unrooted') return validateUnrootedScene(view.graph, view.scene, base);
  if (view.intent === 'taxonomy') return validateClassificationScene(source, view.graph, view.scene, base);
  if (view.intent === 'phylogram') return validateMetricScene(view.graph, view.scene, base);
  return base(view.graph, view.scene);
}

/** Verify saved evidence using the exact numerical profile under which it was stored. */
export function replayStructuredQA(view: StructuredView, source: Source): SceneQA {
  if (view.validationProfile === undefined) return validate(view, source, validateSceneV1);
  if (view.validationProfile === 'compound-v2') return validate(view, source, validateSceneV2);
  if (view.validationProfile === CURRENT_VALIDATION_PROFILE) return validate(view, source, validateScene);
  throw new Error('Unsupported structured validation profile.');
}

/** A current check is independent of the historical saved check and never edits geometry. */
export function currentStructuredQA(view: StructuredView, source: Source): SceneQA {
  return validate(view, source, validateScene);
}

export function currentValidationMethodKey(view: StructuredView): string {
  const id = view.intent === 'unrooted' ? 'unrooted-validation' : view.intent === 'taxonomy' ? 'classification-validation' : view.intent === 'phylogram' ? 'metric-distance-validation' : 'compound-validation';
  return `${id}@3.0.0`;
}
