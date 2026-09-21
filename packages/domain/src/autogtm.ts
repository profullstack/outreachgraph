/**
 * The arithmetic behind the AutoGTM surface.
 *
 * Everything an agent can set through that API is a number of dollars per
 * day, and everything the policy engine enforces is a number of actions per
 * day. This module is the exchange rate between the two, plus the allocator
 * that splits one project's dollars across its campaigns. Pure on purpose: it
 * is what the API, the worker and the tests all agree on, and none of them
 * should have to open a database to find out what a budget means.
 */

import { CREDIT_PACKS } from './credits';

/**
 * What one contacted prospect costs, in dollars.
 *
 * The list price of the smallest credit pack, per credit. Derived rather than
 * typed so a pricing change moves the exchange rate with it — two numbers that
 * are supposed to agree and live in two files eventually do not.
 */
export const CONTACT_PRICE_USD: number = (() => {
  const smallest = [...CREDIT_PACKS].sort((a, b) => a.credits - b.credits)[0];
  if (!smallest) return 0.15;
  return Math.round((smallest.priceUsd / smallest.credits) * 10_000) / 10_000;
})();

/** Dollars, rounded to the cent. */
export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How many contacts a daily budget buys.
 *
 * Floored: a budget that covers 2.9 contacts covers 2, because the third one
 * would be spent past the ceiling the customer set. Zero is a real answer and
 * means "do not send", which the policy engine already honours as a cap of 0.
 */
export function dailyContactsFor(dailyBudgetUsd: number): number {
  if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) return 0;
  return Math.floor(dailyBudgetUsd / CONTACT_PRICE_USD + 1e-9);
}

/** The dollars a given number of contacts costs. */
export function usdForContacts(contacts: number): number {
  return roundUsd(Math.max(0, contacts) * CONTACT_PRICE_USD);
}

export interface AllocationCandidate {
  readonly id: string;
  /** Outbound messages sent, over the window the caller chose. */
  readonly contacted: number;
  /** Replies received over the same window. */
  readonly replies: number;
}

export interface AllocationInput {
  /** The project's daily ceiling. */
  readonly totalUsd: number;
  readonly campaigns: readonly AllocationCandidate[];
  /**
   * The share of the budget spread evenly regardless of performance, so a new
   * campaign gets a chance to earn its keep. The rest follows reply rate.
   */
  readonly explorationShare?: number;
}

/**
 * Splits one daily budget across campaigns by how well each one is replying.
 *
 * Two parts. An exploration slice is shared evenly, so a campaign with no
 * history is not starved before it has had a chance to produce any. The rest
 * is proportional to a smoothed reply rate — `(replies + 1) / (contacted +
 * 10)` — which is a Laplace prior that reads a campaign with two replies from
 * twenty as better than one with zero from two, and both as unproven. No
 * randomness: the same inputs always produce the same split, so a budget
 * change is explainable after the fact.
 *
 * Cents that rounding leaves over go to the best-performing campaign, so the
 * shares sum to the total exactly.
 */
export function allocateDailyBudget(input: AllocationInput): ReadonlyMap<string, number> {
  const total = Math.max(0, input.totalUsd);
  const campaigns = input.campaigns;
  const out = new Map<string, number>();

  if (campaigns.length === 0 || total === 0) {
    for (const campaign of campaigns) out.set(campaign.id, 0);
    return out;
  }

  const exploration = clamp(input.explorationShare ?? 0.2, 0, 1);
  const evenPot = total * exploration;
  const ratedPot = total - evenPot;

  const scores = campaigns.map((campaign) => ({
    id: campaign.id,
    score: (Math.max(0, campaign.replies) + 1) / (Math.max(0, campaign.contacted) + 10),
  }));
  const scoreSum = scores.reduce((sum, entry) => sum + entry.score, 0);

  let allocated = 0;
  for (const entry of scores) {
    const share = roundUsd(evenPot / campaigns.length + (ratedPot * entry.score) / scoreSum);
    out.set(entry.id, share);
    allocated += share;
  }

  // Rounding drift lands on the leader rather than being lost or overspent.
  const drift = roundUsd(total - allocated);
  if (drift !== 0) {
    const leader = [...scores].sort((a, b) => b.score - a.score)[0];
    if (leader) out.set(leader.id, roundUsd((out.get(leader.id) ?? 0) + drift));
  }

  return out;
}

/**
 * Fits a set of campaign budgets under a project ceiling without reordering
 * them.
 *
 * Used when autopilot is off: the customer set each campaign's budget by hand
 * and the project ceiling is a cap, not a plan. Everything is scaled by the
 * same factor, so the relative sizes they chose survive. Campaigns with no
 * budget of their own are left alone.
 */
export function capUnderCeiling(
  budgets: ReadonlyMap<string, number>,
  ceilingUsd: number,
): ReadonlyMap<string, number> {
  const sum = [...budgets.values()].reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum <= ceilingUsd || sum === 0) return budgets;

  const factor = ceilingUsd / sum;
  const out = new Map<string, number>();
  for (const [id, value] of budgets) out.set(id, roundUsd(Math.max(0, value) * factor));
  return out;
}

/**
 * The lifecycle words the AutoGTM surface uses, mapped from what a campaign
 * row actually holds.
 *
 *   - `discovery`: finding leads, nothing sent yet (a draft, or nobody
 *     contacted).
 *   - `review`: sending is gated on a human — the approval queue.
 *   - `outreach`: sending unattended.
 *   - `listening`: paused; replies still land.
 *   - `archived`: finished.
 */
export type AutogtmStatus = 'discovery' | 'review' | 'outreach' | 'listening' | 'archived';

export function autogtmStatus(row: {
  readonly status: string;
  readonly approval_mode: string;
  readonly contacted?: number;
}): AutogtmStatus {
  if (row.status === 'archived') return 'archived';
  if (row.status === 'paused') return 'listening';
  if (row.status === 'draft') return 'discovery';
  if (row.approval_mode === 'trusted_automation') return 'outreach';
  if ((row.contacted ?? 0) === 0 && row.approval_mode === 'research_only') return 'discovery';
  return 'review';
}

/** Reply rate as a fraction, 0 when nothing has been sent. */
export function replyRate(contacted: number, replies: number): number {
  if (contacted <= 0) return 0;
  return Math.round((replies / contacted) * 10_000) / 10_000;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
