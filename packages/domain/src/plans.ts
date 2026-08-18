/**
 * What a plan includes (PRD §30).
 *
 * The unit is **unique prospects contacted in a calendar month**, and that
 * choice is the whole design. Three alternatives were available and each is
 * worse:
 *
 *   - *Messages sent* rewards volume, which is the behaviour that burns a
 *     sending domain, and is trivially gamed by splitting a message in two.
 *   - *Seats alone* means a workspace that doubles its output pays the same,
 *     so price stops tracking value in either direction.
 *   - *Model calls* is honest about our cost and meaningless to a buyer, who
 *     cannot predict it and did not ask for it.
 *
 * A contacted prospect is the thing the customer actually wanted, it is hard
 * to inflate, and it happens to track our own cost closely: composition spend
 * scales with prospects reasoned about rather than with messages produced.
 *
 * Research is metered separately, in cells. A grid is the one action in the
 * product where a single click can spend a large amount of model budget, and
 * folding it into the prospect count would let a two-hundred-cell grid consume
 * a month's sending allowance without sending anything.
 */

export const PLAN_IDS = ['free', 'solo', 'pro', 'team'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** Monthly price in whole US dollars. `null` means "talk to us". */
  readonly priceUsd: number | null;
  /** Unique prospects that may be contacted per calendar month. */
  readonly prospectsPerMonth: number;
  /** Research grid cells that may be answered per calendar month. */
  readonly gridCellsPerMonth: number;
  /** Whether unattended sending is available at all. */
  readonly autopilot: boolean;
  /** Whether the machine surfaces are included. */
  readonly api: boolean;
  readonly seats: number;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  free: {
    id: 'free',
    name: 'Free',
    priceUsd: 0,
    // Deliberately lower than a comparable free tier elsewhere, because a
    // prospect here arrives researched, scored and drafted for. The unit is
    // worth more, so the ceiling can be lower without the tier feeling thin.
    prospectsPerMonth: 25,
    gridCellsPerMonth: 50,
    autopilot: false,
    api: false,
    seats: 1,
  },
  solo: {
    id: 'solo',
    name: 'Solo',
    priceUsd: 29,
    prospectsPerMonth: 250,
    gridCellsPerMonth: 500,
    autopilot: false,
    api: true,
    seats: 1,
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceUsd: 79,
    prospectsPerMonth: 1500,
    gridCellsPerMonth: 5000,
    autopilot: true,
    api: true,
    seats: 1,
  },
  team: {
    id: 'team',
    name: 'Team',
    priceUsd: null,
    prospectsPerMonth: 5000,
    gridCellsPerMonth: 20000,
    autopilot: true,
    api: true,
    seats: 3,
  },
};

export function planById(id: string): Plan {
  // An unrecognised plan is treated as free rather than as unlimited. The
  // failure mode of the other default is a workspace on a typo'd plan name
  // sending without limit, which nobody notices until the bill or the
  // blocklist arrives.
  return PLANS[id as PlanId] ?? PLANS.free;
}

export interface UsageSnapshot {
  readonly prospectsContacted: number;
  readonly gridCells: number;
}

export interface QuotaVerdict {
  readonly exhausted: boolean;
  /** Which allowance ran out, when one has. */
  readonly limit?: 'prospects' | 'grid_cells';
  readonly used: number;
  readonly allowed: number;
  readonly reason?: string;
}

/**
 * Whether this workspace may contact one more prospect.
 *
 * Note what is *not* checked: whether this particular person has been
 * contacted before. Someone already contacted this month costs nothing more,
 * which is what makes a cadence's later steps free and stops the meter
 * punishing the follow-up that actually works.
 */
export function checkProspectQuota(plan: Plan, usage: UsageSnapshot): QuotaVerdict {
  const used = usage.prospectsContacted;
  const allowed = plan.prospectsPerMonth;

  if (used < allowed) return { exhausted: false, used, allowed };

  return {
    exhausted: true,
    limit: 'prospects',
    used,
    allowed,
    reason: `The ${plan.name} plan covers ${allowed} prospects a month and ${used} have been contacted.`,
  };
}

export function checkGridQuota(plan: Plan, usage: UsageSnapshot, cells: number): QuotaVerdict {
  const used = usage.gridCells;
  const allowed = plan.gridCellsPerMonth;

  if (used + cells <= allowed) return { exhausted: false, used, allowed };

  return {
    exhausted: true,
    limit: 'grid_cells',
    used,
    allowed,
    reason: `The ${plan.name} plan covers ${allowed} research answers a month; ${used} are used and this grid needs ${cells}.`,
  };
}

/**
 * The first instant of the calendar month containing `at`, in UTC.
 *
 * Calendar months rather than rolling thirty-day windows, because a customer
 * asking "how much have I used this month" means the month on their calendar,
 * and a window that drifts is one nobody can reconcile against an invoice.
 */
export function periodStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}
