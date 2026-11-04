import type { SceneIssue, SceneQA } from './types.ts';

/** Current profiles count every finding; historical profiles retain bounded examples. */
export function sceneIssueCount(qa: SceneQA, type: SceneIssue['type']): number {
  return qa.issueCounts?.[type] ?? qa.issues.filter(issue => issue.type === type).length;
}

export function sceneChecksComplete(qa: SceneQA): boolean {
  return !qa.limited && qa.completeness?.incidence !== false && qa.completeness?.strokes !== false && qa.completeness?.labels !== false;
}

export function sceneIncidenceSummary(qa: SceneQA): string {
  return qa.completeness?.incidence === false ? 'incomplete' : qa.incidencePassed ? 'pass' : 'review';
}

export function sceneContactSummary(qa: SceneQA): string {
  if (qa.completeness?.strokes === false || (qa.limited && !qa.completeness)) return 'Contact check incomplete';
  return qa.crossingPassed ? 'No detected contacts' : 'Refinement needed';
}
