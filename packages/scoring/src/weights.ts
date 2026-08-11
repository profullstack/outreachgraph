/**
 * Opportunity weights (PRD §12.6).
 *
 * Weights are per-campaign configurable. They are normalised before use, so a
 * customer who sets weights summing to 120 gets sensible proportions rather
 * than scores above 100.
 */

export interface OpportunityWeights {
  readonly icpFit: number;
  readonly intent: number;
  readonly reachability: number;
  readonly relationship: number;
  readonly identity: number;
}

/** PRD §12.6 initial formula. */
export const DEFAULT_WEIGHTS: OpportunityWeights = {
  icpFit: 0.35,
  intent: 0.3,
  reachability: 0.15,
  relationship: 0.15,
  identity: 0.05,
};

export function normalizeWeights(weights: OpportunityWeights): OpportunityWeights {
  const entries = Object.entries(weights) as [keyof OpportunityWeights, number][];

  for (const [key, value] of entries) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`opportunity weight "${key}" must be a non-negative finite number`);
    }
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total <= 0) {
    throw new RangeError('opportunity weights must not all be zero');
  }

  return {
    icpFit: weights.icpFit / total,
    intent: weights.intent / total,
    reachability: weights.reachability / total,
    relationship: weights.relationship / total,
    identity: weights.identity / total,
  };
}
