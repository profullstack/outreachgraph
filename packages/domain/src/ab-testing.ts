/**
 * Deciding an A/B test without a person reading the table (Hunter's planner:
 * one variable at a time, 50+ recipients per variant, measured by reply rate,
 * winners become the default).
 *
 * The arms of a cadence step are the step's intent (A) and up to three
 * variants. A step is decided when every arm has at least `MIN_ARM_SAMPLE`
 * sends and either:
 *
 *   - **the best arm is ahead with confidence** — a one-sided two-proportion
 *     z-test against the runner-up at `Z_CONFIDENT` (95%), or
 *   - **every arm has reached `MAX_ARM_SAMPLE`** — at reply rates of a few
 *     percent a real difference may never reach significance, and a test that
 *     runs for ever teaches nothing. The best arm wins; a tie keeps A.
 *
 * Opens are not an input. Apple Mail fetches every pixel on delivery, so open
 * rates measure the recipient's mail client more than the message.
 */

export const MIN_ARM_SAMPLE = 50;
export const MAX_ARM_SAMPLE = 200;
/** One-sided 95%. */
export const Z_CONFIDENT = 1.645;

export interface ArmResult {
  /** `A`, `B`, … */
  readonly variant: string;
  readonly sent: number;
  readonly replied: number;
}

export type AbDecision =
  | { readonly decided: false; readonly reason: string }
  | {
      readonly decided: true;
      readonly winner: string;
      readonly reason: string;
      /** How the call was made. */
      readonly basis: 'significant' | 'sample_cap';
    };

export function armReplyRate(arm: ArmResult): number {
  return arm.sent > 0 ? arm.replied / arm.sent : 0;
}

/** Two-proportion z statistic of `a` over `b` (positive when a is ahead). */
export function zScore(a: ArmResult, b: ArmResult): number {
  if (a.sent === 0 || b.sent === 0) return 0;
  const pooled = (a.replied + b.replied) / (a.sent + b.sent);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.sent + 1 / b.sent));
  if (se === 0) return 0;
  return (armReplyRate(a) - armReplyRate(b)) / se;
}

export function decideAbTest(arms: readonly ArmResult[]): AbDecision {
  if (arms.length < 2) return { decided: false, reason: 'fewer than two arms' };

  const short = arms.filter((arm) => arm.sent < MIN_ARM_SAMPLE);
  if (short.length > 0) {
    const least = Math.min(...arms.map((arm) => arm.sent));
    return {
      decided: false,
      reason: `needs ${MIN_ARM_SAMPLE} sends per arm (smallest has ${least})`,
    };
  }

  // Best first; at equal rates A (the incumbent) stays ahead of a challenger.
  const ranked = [...arms].sort(
    (a, b) => armReplyRate(b) - armReplyRate(a) || a.variant.localeCompare(b.variant),
  );
  const best = ranked[0] as ArmResult;
  const runnerUp = ranked[1] as ArmResult;
  const z = zScore(best, runnerUp);
  const pct = (arm: ArmResult): string => `${(armReplyRate(arm) * 100).toFixed(1)}%`;

  if (z >= Z_CONFIDENT && best.replied > 0) {
    return {
      decided: true,
      winner: best.variant,
      basis: 'significant',
      reason: `${best.variant} replied ${pct(best)} vs ${runnerUp.variant} ${pct(runnerUp)} (z=${z.toFixed(2)})`,
    };
  }

  if (arms.every((arm) => arm.sent >= MAX_ARM_SAMPLE)) {
    // Ranking puts A first among equal rates, so `best` is A whenever no
    // challenger out-replied it.
    return {
      decided: true,
      winner: best.variant,
      basis: 'sample_cap',
      reason:
        best.variant === 'A'
          ? `no arm out-replied the original after ${MAX_ARM_SAMPLE}+ sends each; keeping A`
          : `${best.variant} led at ${pct(best)} vs ${runnerUp.variant} ${pct(runnerUp)} after ${MAX_ARM_SAMPLE}+ sends each`,
    };
  }

  return {
    decided: false,
    reason: `${best.variant} leads ${pct(best)} vs ${pct(runnerUp)}, not yet conclusive (z=${z.toFixed(2)})`,
  };
}
