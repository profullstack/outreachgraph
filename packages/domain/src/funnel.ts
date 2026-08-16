/**
 * The sales funnel — the sixteen-state machine, said in words a salesperson uses.
 *
 * `ProspectStatus` is an engineering state machine. It distinguishes
 * `enriching` from `resolved` from `researching` because the worker needs to
 * know exactly where to resume after a crash, and every one of those
 * distinctions is invisible and uninteresting to the person whose job is to
 * sell something.
 *
 * A funnel is the same run with the engineering removed: how many did we find,
 * how many were worth writing to, how many did we write to, how many wrote
 * back. Six stages, in order, each one a strictly smaller set than the last —
 * which is the property that makes it a funnel and makes the drop-off between
 * two stages mean something.
 *
 * `Lost` is deliberately not a stage. It is an exit, and putting it in the
 * sequence would break the "each stage is smaller than the last" rule that
 * lets the chart be read at a glance.
 */

import type { ProspectStatus } from './pipeline';

export const FUNNEL_STAGES = [
  'discovered',
  'researched',
  'ready',
  'contacted',
  'replied',
  'opportunity',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

/** Where a lead goes when it leaves the funnel, rather than a stage within it. */
export const FUNNEL_EXITS = ['lost'] as const;
export type FunnelExit = (typeof FUNNEL_EXITS)[number];

export type FunnelPosition = FunnelStage | FunnelExit;

/**
 * What each stage means, in the words shown in the UI.
 *
 * Kept next to the mapping rather than in the component so the API, the digest
 * email and the chart cannot describe the same stage three different ways.
 */
export const FUNNEL_STAGE_LABELS: Readonly<Record<FunnelStage, string>> = {
  discovered: 'Found',
  researched: 'Researched',
  ready: 'Ready to send',
  contacted: 'Contacted',
  replied: 'Replied',
  opportunity: 'Opportunity',
};

export const FUNNEL_STAGE_DESCRIPTIONS: Readonly<Record<FunnelStage, string>> = {
  discovered: 'Named on a company page and pulled in.',
  researched: 'Enriched, identities resolved, signals collected and scored.',
  ready: 'A message is written and waiting — for approval, or for autopilot.',
  contacted: 'The message went out.',
  replied: 'They answered. This is the only part that needs you.',
  opportunity: 'A real conversation is underway.',
};

const STAGE_BY_STATUS: Readonly<Record<ProspectStatus, FunnelPosition>> = {
  discovered: 'discovered',
  enriching: 'discovered',
  resolved: 'discovered',
  researching: 'researched',
  qualified: 'researched',
  // Not a loss — it means "researched, and not a fit". It stops here rather
  // than progressing, and the drop between Researched and Ready is where that
  // shows up, which is exactly what that number is for.
  unqualified: 'researched',
  recommended: 'ready',
  awaiting_approval: 'ready',
  approved: 'ready',
  executed: 'contacted',
  waiting: 'contacted',
  responded: 'replied',
  qualified_opportunity: 'opportunity',
  not_interested: 'lost',
  suppressed: 'lost',
  // An errored prospect has not left the funnel; it is stuck at the point it
  // reached. Calling it lost would quietly delete real leads from the chart.
  error: 'discovered',
};

export function stageForStatus(status: ProspectStatus): FunnelPosition {
  return STAGE_BY_STATUS[status];
}

export function isFunnelStage(value: unknown): value is FunnelStage {
  return typeof value === 'string' && (FUNNEL_STAGES as readonly string[]).includes(value);
}

/** Position in the sequence, or -1 for an exit. Used to order and compare. */
export function stageIndex(position: FunnelPosition): number {
  return (FUNNEL_STAGES as readonly string[]).indexOf(position);
}

/**
 * True when moving to `to` is forward progress through the funnel.
 *
 * Used to decide whether a stage change is worth telling anyone about: a lead
 * sliding from `researching` back to `qualified` is bookkeeping, while one
 * reaching `replied` is the whole point.
 */
export function isAdvance(from: FunnelPosition | undefined, to: FunnelPosition): boolean {
  if (to === 'lost') return false;
  if (from === undefined) return true;
  return stageIndex(to) > stageIndex(from);
}

export interface FunnelCount {
  readonly stage: FunnelStage;
  readonly label: string;
  /** Leads currently sitting at this stage. */
  readonly current: number;
  /**
   * Leads that have *ever* reached this stage, including those now further on.
   *
   * This is the number a funnel chart is drawn from. Using `current` instead
   * produces a chart where closing a deal makes the top of the funnel shrink,
   * which is both wrong and the most common way these charts are got wrong.
   */
  readonly reached: number;
}

export interface FunnelSummary {
  readonly stages: readonly FunnelCount[];
  readonly lost: number;
  readonly total: number;
}

/**
 * Builds the funnel from per-stage totals.
 *
 * `reached` is made cumulative here rather than trusted from the caller: every
 * lead that reached `contacted` necessarily reached `discovered`, whether or
 * not an event was ever recorded for it, and a funnel that widens as it
 * descends is a bug people will see instantly.
 */
export function summariseFunnel(
  current: Readonly<Partial<Record<FunnelPosition, number>>>,
  everReached: Readonly<Partial<Record<FunnelStage, number>>> = {},
): FunnelSummary {
  const stages: FunnelCount[] = [];

  for (let index = FUNNEL_STAGES.length - 1; index >= 0; index -= 1) {
    const stage = FUNNEL_STAGES[index] as FunnelStage;
    const deeper = stages[0]?.reached ?? 0;
    const reached = Math.max(everReached[stage] ?? 0, current[stage] ?? 0, deeper);

    stages.unshift({
      stage,
      label: FUNNEL_STAGE_LABELS[stage],
      current: current[stage] ?? 0,
      reached,
    });
  }

  return {
    stages,
    lost: current.lost ?? 0,
    total: stages[0]?.reached ?? 0,
  };
}

/**
 * Conversion from one stage to the next, as a percentage.
 *
 * Returns undefined rather than 0 when the earlier stage is empty: "0% of 0
 * converted" is a statement about nothing, and showing it as a zero makes an
 * empty funnel look like a failing one.
 */
export function conversionRate(from: FunnelCount, to: FunnelCount): number | undefined {
  if (from.reached === 0) return undefined;
  return Math.round((to.reached / from.reached) * 100);
}
