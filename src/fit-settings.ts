import type { BranchDirection, FitSettings, Point } from './types.ts';

export const DEFAULT_FIT_SETTINGS: FitSettings = {
  algorithm: 'junction_fit_v1', borderScope: 'all', strength: 1,
  junctionDepth: .45, preserveFlow: .4, junctionSpacingMm: 3, smoothing: .7,
  routing: .75, forkSpread: .65,
};
export function validateFitSettings(s: FitSettings): void {
  if (!s || s.algorithm !== 'junction_fit_v1' || !['all', 'active'].includes(s.borderScope)) throw new Error('Unsupported automatic fit settings.');
  for (const key of ['strength', 'junctionDepth', 'preserveFlow', 'smoothing'] as const) {
    if (!Number.isFinite(s[key]) || s[key] < 0 || s[key] > 1) throw new Error(`${key} must be between 0 and 1.`);
  }
  if (s.direction !== undefined) validateBranchDirection(s.direction);
  for (const key of ['routing', 'forkSpread'] as const) if (s[key] !== undefined && (!Number.isFinite(s[key]) || s[key]! < 0 || s[key]! > 1)) throw new Error(`${key} must be between 0 and 1.`);
  if (!Number.isFinite(s.junctionSpacingMm) || s.junctionSpacingMm < .1 || s.junctionSpacingMm > 20) throw new Error('Junction spacing must be between 0.1 and 20 mm.');
}

export function validateBranchDirection(d: BranchDirection): void {
  if (!d || !Number.isFinite(d.angleDeg) || d.angleDeg < -360 || d.angleDeg > 360 || !Number.isFinite(d.strength) || d.strength < 0 || d.strength > 1) throw new Error('Branch direction needs an angle from −360° to 360° and strength from 0 to 1.');
}
/** Canvas coordinates: right = 0°, down = 90°, left = 180°, up = 270°. */
export function directionVector(d: BranchDirection | null | undefined): Point {
  if (!d) return { x: 0, y: 0 };
  const angle = d.angleDeg * Math.PI / 180;
  return { x: Math.cos(angle) * d.strength, y: Math.sin(angle) * d.strength };
}
export function directionAngle(from: Point, to: Point): number {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 1) throw new Error('Draw a direction arrow at least 1 mm long.');
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI + 360) % 360;
}
