/**
 * Confidence bands and merge thresholds (PRD §9.4).
 *
 * Thresholds are configurable per workspace, so nothing outside this module
 * should hard-code 0.9. Callers pass a `MergeThresholds` value through.
 */

export const CONFIDENCE_LEVELS = ['verified', 'high', 'probable', 'weak', 'rejected'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/** Lower bound of each band, ordered strongest first. */
const BANDS: readonly (readonly [ConfidenceLevel, number])[] = [
  ['verified', 0.95],
  ['high', 0.85],
  ['probable', 0.7],
  ['weak', 0.5],
  ['rejected', 0],
];

export function confidenceLevel(score: number): ConfidenceLevel {
  const clamped = clampConfidence(score);
  for (const [level, floor] of BANDS) {
    if (clamped >= floor) return level;
  }
  return 'rejected';
}

export function clampConfidence(score: number): number {
  if (!Number.isFinite(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

export interface MergeThresholds {
  /** At or above this, identities merge without human review. */
  readonly autoMerge: number;
  /** At or above this (but below autoMerge), a review candidate is created. */
  readonly candidate: number;
}

/**
 * V1 defaults from PRD §9.4: auto-merge >= 0.90, candidate 0.70–0.89,
 * reject < 0.70.
 */
export const DEFAULT_MERGE_THRESHOLDS: MergeThresholds = {
  autoMerge: 0.9,
  candidate: 0.7,
};

export const MERGE_DECISIONS = ['merge', 'candidate', 'reject'] as const;
export type MergeDecision = (typeof MERGE_DECISIONS)[number];

export function mergeDecision(
  score: number,
  thresholds: MergeThresholds = DEFAULT_MERGE_THRESHOLDS,
): MergeDecision {
  assertThresholds(thresholds);
  const clamped = clampConfidence(score);
  if (clamped >= thresholds.autoMerge) return 'merge';
  if (clamped >= thresholds.candidate) return 'candidate';
  return 'reject';
}

export function assertThresholds(thresholds: MergeThresholds): void {
  const { autoMerge, candidate } = thresholds;
  if (!Number.isFinite(autoMerge) || !Number.isFinite(candidate)) {
    throw new RangeError('merge thresholds must be finite numbers');
  }
  if (autoMerge < 0 || autoMerge > 1 || candidate < 0 || candidate > 1) {
    throw new RangeError('merge thresholds must fall within 0..1');
  }
  if (candidate > autoMerge) {
    throw new RangeError('candidate threshold cannot exceed the auto-merge threshold');
  }
}
