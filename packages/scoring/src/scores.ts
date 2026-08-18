/**
 * Prospect scoring (PRD §12).
 *
 * Five independent 0–100 scores combine into one opportunity score. They are
 * kept separate rather than collapsed early so the UI can explain a ranking
 * ("great fit, no intent yet") instead of showing an unexplained number.
 *
 * Nothing here may use a sensitive characteristic as an input (PRD §12.4,
 * §17.4) — the available inputs are professional, behavioural and public.
 */

import type { CampaignFilters, SignalType } from '@outreachgraph/domain';
import { effectiveWeight, type DecayableSignal } from '@outreachgraph/signals';
import { DEFAULT_WEIGHTS, normalizeWeights, type OpportunityWeights } from './weights';

/** Every score in this module is an integer 0–100. */
export type Score = number;

export function toScore(fraction: number): Score {
  if (!Number.isFinite(fraction)) return 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

export interface IcpInput {
  readonly title?: string;
  readonly seniority?: string;
  readonly industry?: string;
  readonly country?: string;
  readonly employeeCount?: number;
  readonly technologies?: readonly string[];
  readonly fundingStage?: string;
  readonly hiring?: boolean;
}

export interface IcpBreakdown {
  readonly score: Score;
  /** Criteria that matched, for the "why this person" panel. */
  readonly matched: readonly string[];
  readonly missed: readonly string[];
  /** True when an exclusion rule fired; the prospect is disqualified. */
  readonly excluded: boolean;
}

/**
 * ICP fit (PRD §12.1).
 *
 * Scored as "matched criteria / applicable criteria", so a campaign that
 * specifies only titles is not penalised for saying nothing about funding.
 * An exclusion match short-circuits to zero.
 */
export function scoreIcpFit(person: IcpInput, filters: CampaignFilters): IcpBreakdown {
  const haystack = [person.title, person.industry, person.country, ...(person.technologies ?? [])]
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.toLowerCase());

  for (const exclusion of filters.exclusions) {
    if (haystack.some((value) => value.includes(exclusion.toLowerCase()))) {
      return { score: 0, matched: [], missed: [`excluded by "${exclusion}"`], excluded: true };
    }
  }

  const matched: string[] = [];
  const missed: string[] = [];

  const check = (label: string, applicable: boolean, hit: boolean): void => {
    if (!applicable) return;
    (hit ? matched : missed).push(label);
  };

  check('title', filters.titles.length > 0, matchesAny(person.title, filters.titles));
  check(
    'seniority',
    filters.seniorities.length > 0,
    matchesAny(person.seniority, filters.seniorities),
  );
  check('industry', filters.industries.length > 0, matchesAny(person.industry, filters.industries));
  check('country', filters.countries.length > 0, matchesAny(person.country, filters.countries));
  check(
    'technology',
    filters.technologies.length > 0,
    filters.technologies.some((tech) =>
      (person.technologies ?? []).some((owned) => owned.toLowerCase() === tech.toLowerCase()),
    ),
  );
  check(
    'funding stage',
    (filters.fundingStages?.length ?? 0) > 0,
    matchesAny(person.fundingStage, filters.fundingStages ?? []),
  );
  check('hiring', filters.hiring !== undefined, person.hiring === filters.hiring);

  const boundsApply =
    filters.employeeCountMin !== undefined || filters.employeeCountMax !== undefined;
  check('company size', boundsApply, withinBounds(person.employeeCount, filters));

  const applicable = matched.length + missed.length;
  // With no criteria at all there is nothing to disagree with, so everyone is
  // a neutral fit rather than a perfect one.
  const fraction = applicable === 0 ? 0.5 : matched.length / applicable;

  return { score: toScore(fraction), matched, missed, excluded: false };
}

function matchesAny(value: string | undefined, candidates: readonly string[]): boolean {
  if (!value) return false;
  const lower = value.toLowerCase();
  return candidates.some((candidate) => lower.includes(candidate.toLowerCase()));
}

function withinBounds(count: number | undefined, filters: CampaignFilters): boolean {
  if (count === undefined) return false;
  if (filters.employeeCountMin !== undefined && count < filters.employeeCountMin) return false;
  if (filters.employeeCountMax !== undefined && count > filters.employeeCountMax) return false;
  return true;
}

export interface IntentInput {
  readonly signals: readonly DecayableSignal[];
  /** Per-campaign multipliers by signal type (PRD §7.3). */
  readonly signalWeights?: Readonly<Partial<Record<SignalType, number>>>;
  readonly now?: Date;
}

export interface IntentBreakdown {
  readonly score: Score;
  /** The signal that contributed most — the "why now" the UI shows. */
  readonly topSignal?: DecayableSignal;
  readonly contributingCount: number;
}

/**
 * Intent (PRD §12.3).
 *
 * Signals combine with a noisy-OR, matching the identity resolver: several
 * corroborating signals raise intent with diminishing returns, and no volume
 * of weak chatter reaches certainty. One explicit "what should I use for X?"
 * outranks twenty vague mentions, which is the behaviour the North Star metric
 * rewards.
 */
export function scoreIntent(input: IntentInput): IntentBreakdown {
  const now = input.now ?? new Date();

  const weighted = input.signals
    .map((signal) => ({
      signal,
      weight: effectiveWeight(signal, now) * clamp01(input.signalWeights?.[signal.type] ?? 1),
    }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  let remaining = 1;
  for (const entry of weighted) {
    remaining *= 1 - clamp01(entry.weight);
  }

  const top = weighted[0]?.signal;

  return {
    score: toScore(1 - remaining),
    ...(top ? { topSignal: top } : {}),
    contributingCount: weighted.length,
  };
}

export interface ReachabilityInput {
  /** Days since the person last posted anywhere we can see. */
  readonly daysSinceLastActivity?: number;
  /** Networks where we hold a confirmed identity and a permitted channel. */
  readonly reachableNetworkCount: number;
  readonly hasConnectedAccount: boolean;
  readonly publicRepliesEnabled?: boolean;
  readonly hasRespondedBefore?: boolean;
}

/**
 * Reachability (PRD §12.4).
 *
 * Deliberately built only from activity and channel availability. No invasive
 * or private trait may appear here.
 */
export function scoreReachability(input: ReachabilityInput): Score {
  let total = 0;

  // Recency of public activity — an abandoned account is unreachable.
  const days = input.daysSinceLastActivity;
  if (days !== undefined) {
    if (days <= 3) total += 0.4;
    else if (days <= 14) total += 0.3;
    else if (days <= 45) total += 0.15;
    else if (days <= 120) total += 0.05;
  }

  // Having somewhere to actually say it.
  total += Math.min(0.25, input.reachableNetworkCount * 0.125);
  if (input.hasConnectedAccount) total += 0.15;
  if (input.publicRepliesEnabled === true) total += 0.1;
  if (input.hasRespondedBefore === true) total += 0.1;

  return toScore(total);
}

export interface RelationshipInput {
  readonly followsYou?: boolean;
  readonly followsYourCompany?: boolean;
  readonly previouslyReplied?: boolean;
  readonly mutualPublicInteraction?: boolean;
  readonly existingCustomerContact?: boolean;
  readonly sharedPublicEvent?: boolean;
  readonly optedIn?: boolean;
  /**
   * They followed a tracked link we sent (PRD §12.5).
   *
   * Weighted well below a reply on purpose. A click says the subject line was
   * interesting enough to open something; a reply says a person decided to
   * spend their own time on us. Treating the two as comparable would let a
   * campaign that generates curiosity outrank one that generates conversations,
   * which is the opposite of what the North Star metric rewards.
   */
  readonly clickedLink?: boolean;
}

/** Relationship (PRD §12.5). Warmer context earns a higher score. */
export function scoreRelationship(input: RelationshipInput): Score {
  let total = 0;
  if (input.optedIn === true) total += 0.35;
  if (input.previouslyReplied === true) total += 0.25;
  if (input.existingCustomerContact === true) total += 0.2;
  if (input.mutualPublicInteraction === true) total += 0.15;
  if (input.followsYou === true) total += 0.15;
  if (input.followsYourCompany === true) total += 0.1;
  // Subsumed by a reply rather than added to it: someone who answered has
  // already demonstrated everything the click was evidence for, and stacking
  // both would make one conversation look like two relationships.
  if (input.clickedLink === true && input.previouslyReplied !== true) total += 0.1;
  if (input.sharedPublicEvent === true) total += 0.05;
  return toScore(total);
}

export interface OpportunityInput {
  readonly icpFit: Score;
  readonly intent: Score;
  readonly reachability: Score;
  readonly relationship: Score;
  /** Identity confidence as a 0–100 score (PRD §12.2). */
  readonly identity: Score;
  readonly weights?: OpportunityWeights;
}

export interface OpportunityBreakdown {
  readonly opportunity: Score;
  readonly components: {
    readonly icpFit: Score;
    readonly intent: Score;
    readonly reachability: Score;
    readonly relationship: Score;
    readonly identity: Score;
  };
  /** The normalised weights actually used, stored alongside the score. */
  readonly weights: OpportunityWeights;
}

/** Weighted combination per PRD §12.6. */
export function scoreOpportunity(input: OpportunityInput): OpportunityBreakdown {
  const weights = normalizeWeights(input.weights ?? DEFAULT_WEIGHTS);

  const opportunity =
    input.icpFit * weights.icpFit +
    input.intent * weights.intent +
    input.reachability * weights.reachability +
    input.relationship * weights.relationship +
    input.identity * weights.identity;

  return {
    opportunity: Math.round(Math.min(100, Math.max(0, opportunity))),
    components: {
      icpFit: input.icpFit,
      intent: input.intent,
      reachability: input.reachability,
      relationship: input.relationship,
      identity: input.identity,
    },
    weights,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
