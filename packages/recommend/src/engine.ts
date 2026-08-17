/**
 * The Next-Best-Action engine (PRD §13, §20.6).
 *
 * Instead of advancing a fixed sequence, this picks an action from the current
 * state: the freshest relevant signal, the channels where the person is
 * actually reachable, and whatever the Policy Engine currently permits.
 *
 * Two invariants:
 *
 *   1. **It cannot invent capabilities.** The candidate action list is filtered
 *      through `allowedActions` before anything is chosen, so a denied action
 *      is never even considered (PRD §20.6).
 *   2. **It cannot invent a reason.** Every recommendation names the signal
 *      that triggered it, and a signal with no stored evidence can prompt an
 *      action but may not ground a personalised claim (PRD §14.1).
 */

import {
  isOutboundAction,
  type ActionKind,
  type Network,
  type RecommendationGoal,
} from '@outreachgraph/domain';
import { allowedActions, evaluatePolicy, type PolicyRequest } from '@outreachgraph/policy';
import { effectiveWeight, type DecayableSignal } from '@outreachgraph/signals';

/** A stored signal, with the identifiers the recommendation must reference. */
export interface CandidateSignal extends DecayableSignal {
  readonly id: string;
  readonly network: Network;
  readonly summary: string;
  /** Verbatim excerpt. Without it, the composer may not quote this signal. */
  readonly evidence?: string;
  readonly sourceUrl?: string;
}

export interface RecommendationInput {
  readonly personId: string;
  readonly campaignId: string;
  readonly signals: readonly CandidateSignal[];
  /** Networks where a confirmed identity exists for this person. */
  readonly reachableNetworks: readonly Network[];
  /** 0–100 opportunity score; drives queue ordering. */
  readonly opportunity: number;
  /** Policy inputs, minus the action and network this engine is choosing. */
  readonly policy: Omit<PolicyRequest, 'action' | 'network'>;
  readonly now?: Date;
}

export interface GeneratedRecommendation {
  readonly personId: string;
  readonly campaignId: string;
  readonly action: ActionKind;
  readonly network: Network;
  readonly priority: number;
  readonly reason: string;
  readonly triggerSignalId?: string;
  readonly policyDecision: 'allow' | 'allow_with_approval' | 'manual_only';
  readonly policyVersion: string;
  readonly expectedGoal: RecommendationGoal;
  readonly expiresAt?: string;
  /** Signals whose evidence may be quoted. Empty means: do not personalise. */
  readonly groundedSignalIds: readonly string[];
}

export type NoRecommendationReason =
  'no_permitted_action' | 'no_relevant_signal' | 'person_ineligible';

export type RecommendationResult =
  | { readonly ok: true; readonly recommendation: GeneratedRecommendation }
  | { readonly ok: false; readonly reason: NoRecommendationReason; readonly detail?: string };

/**
 * Ranked preference among engagement actions.
 *
 * Ordered by how intrusive each is. PRD §13.3 asks the strategy to prefer
 * joining a relevant public conversation over a direct message, and to treat
 * email as a fallback — this list is that preference, made explicit so it can
 * be reviewed rather than buried in branching logic.
 */
const ACTION_PREFERENCE: readonly ActionKind[] = [
  'reply',
  'comment',
  'follow',
  'like',
  'connect',
  'send_dm',
  'send_email',
];

/** Actions worth proposing when there is nothing to respond to yet. */
const PASSIVE_PREFERENCE: readonly ActionKind[] = ['refresh_research', 'observe'];

/** Below this, a signal is too stale or too irrelevant to act on. */
const MIN_TRIGGER_WEIGHT = 0.15;

export function generateRecommendation(input: RecommendationInput): RecommendationResult {
  const now = input.now ?? new Date();

  if (
    input.policy.personSuppressed ||
    input.policy.personDeleted ||
    input.policy.personBelievedMinor
  ) {
    return { ok: false, reason: 'person_ineligible' };
  }

  const trigger = strongestSignal(input.signals, now);

  // Networks to consider, most-preferred first: where the triggering signal
  // happened, then anywhere else we can reach them.
  const networks = orderNetworks(input.reachableNetworks, trigger?.signal.network);

  const candidateActions = trigger ? ACTION_PREFERENCE : PASSIVE_PREFERENCE;

  // Having something to say does not guarantee a way to say it.
  //
  // A prospect found by crawling is usually reachable only on `website`, which
  // is a place to read and not a place to message, so no engagement action
  // survives the policy check. Returning nothing there meant the person
  // vanished — no card, no queue entry, no trace of a lead that had been
  // enriched, resolved and scored. Falling back to the passive set keeps them
  // visible as research, which is the honest description of the state: we know
  // something about them and have no permitted channel to use it on.
  //
  // The fallback is only reached when the outbound set came back empty, so a
  // reachable prospect is never downgraded to research by it.
  const choice =
    chooseAction(input, networks, candidateActions) ??
    (trigger ? chooseAction(input, networks, PASSIVE_PREFERENCE) : undefined);

  if (!choice) {
    return {
      ok: false,
      reason: 'no_permitted_action',
      detail: 'no action on any reachable network survived the policy check',
    };
  }

  // An engagement action with no signal behind it would be outreach with no
  // reason — exactly what the product exists to avoid.
  if (!trigger && isOutboundAction(choice.action)) {
    return { ok: false, reason: 'no_relevant_signal' };
  }

  const priority = computePriority(input.opportunity, trigger?.weight ?? 0);

  return {
    ok: true,
    recommendation: {
      personId: input.personId,
      campaignId: input.campaignId,
      action: choice.action,
      network: choice.network,
      priority,
      reason: buildReason(choice.action, trigger?.signal, trigger?.ageHours),
      ...(trigger ? { triggerSignalId: trigger.signal.id } : {}),
      policyDecision: choice.decision,
      policyVersion: choice.policyVersion,
      expectedGoal: goalFor(choice.action),
      ...(trigger ? { expiresAt: expiryFor(trigger.signal, now) } : {}),
      // Only signals carrying verbatim evidence may be quoted (PRD §14.1).
      groundedSignalIds: trigger?.signal.evidence ? [trigger.signal.id] : [],
    },
  };
}

interface Trigger {
  readonly signal: CandidateSignal;
  readonly weight: number;
  readonly ageHours: number;
}

function strongestSignal(signals: readonly CandidateSignal[], now: Date): Trigger | undefined {
  let best: Trigger | undefined;

  for (const signal of signals) {
    const weight = effectiveWeight(signal, now);
    if (weight < MIN_TRIGGER_WEIGHT) continue;
    if (best && weight <= best.weight) continue;

    const stamp = Date.parse(signal.sourceTimestamp ?? signal.observedAt);
    best = {
      signal,
      weight,
      ageHours: Number.isNaN(stamp)
        ? Number.POSITIVE_INFINITY
        : (now.getTime() - stamp) / 3_600_000,
    };
  }

  return best;
}

/** The signal's own network first — replying where they spoke is least intrusive. */
function orderNetworks(
  reachable: readonly Network[],
  preferred: Network | undefined,
): readonly Network[] {
  if (!preferred) return reachable;
  if (!reachable.includes(preferred)) return [preferred, ...reachable];
  return [preferred, ...reachable.filter((n) => n !== preferred)];
}

interface Choice {
  readonly action: ActionKind;
  readonly network: Network;
  readonly decision: 'allow' | 'allow_with_approval' | 'manual_only';
  readonly policyVersion: string;
}

/**
 * Walks networks in preference order, and within each, actions in preference
 * order, returning the first combination the policy engine permits.
 */
function chooseAction(
  input: RecommendationInput,
  networks: readonly Network[],
  candidates: readonly ActionKind[],
): Choice | undefined {
  for (const network of networks) {
    const permitted = allowedActions({ ...input.policy, network }, candidates);
    if (permitted.length === 0) continue;

    // Preserve the preference ordering; `allowedActions` preserves input order,
    // but being explicit keeps this correct if that ever changes.
    for (const action of candidates) {
      if (!permitted.includes(action)) continue;

      const result = evaluatePolicy({ ...input.policy, network, action });
      if (result.decision === 'deny') continue;

      return {
        action,
        network,
        decision: result.decision,
        policyVersion: result.policyVersion,
      };
    }
  }

  return undefined;
}

/**
 * Priority blends fit with urgency: a perfect-fit prospect with a week-old
 * signal should sit below a good-fit prospect who asked a question an hour ago.
 */
export function computePriority(opportunity: number, triggerWeight: number): number {
  const base = clamp(opportunity, 0, 100);
  const urgency = clamp(triggerWeight, 0, 1);
  return Math.round(base * 0.7 + urgency * 100 * 0.3);
}

/**
 * A recommendation expires when its trigger has decayed past usefulness —
 * replying to a three-week-old "what should I use?" reads as automated.
 */
function expiryFor(signal: CandidateSignal, now: Date): string | undefined {
  const stamp = Date.parse(signal.sourceTimestamp ?? signal.observedAt);
  if (Number.isNaN(stamp)) return undefined;

  // Probe forward for the point where this signal's weight falls below the
  // actionable floor, using the same decay curve the scorer uses.
  for (const hours of [24, 72, 168, 336, 720, 2160]) {
    const at = new Date(stamp + hours * 3_600_000);
    if (at <= now) continue;
    if (effectiveWeight(signal, at) < MIN_TRIGGER_WEIGHT) return at.toISOString();
  }

  return undefined;
}

function goalFor(action: ActionKind): RecommendationGoal {
  switch (action) {
    case 'reply':
    case 'comment':
    case 'send_dm':
    case 'send_email':
      return 'start_conversation';
    case 'follow':
    case 'like':
    case 'connect':
      return 'build_relationship';
    case 'observe':
    case 'refresh_research':
      return 'gather_context';
    default:
      return 'stay_visible';
  }
}

function buildReason(
  action: ActionKind,
  signal: CandidateSignal | undefined,
  ageHours: number | undefined,
): string {
  if (!signal) {
    return 'No recent public activity yet — refresh research before reaching out.';
  }

  const when = describeAge(ageHours);
  const verb = action.replace(/_/g, ' ');

  return `${signal.summary} (${signal.network}, ${when}). Recommended: ${verb}.`;
}

function describeAge(hours: number | undefined): string {
  if (hours === undefined || !Number.isFinite(hours)) return 'recently';
  if (hours < 1) return 'in the last hour';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
