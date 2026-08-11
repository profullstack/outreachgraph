/**
 * The Policy Engine (PRD §16, §20.8).
 *
 * This is not an AI agent. It is a pure, deterministic function: the same
 * input always yields the same decision, and every decision names the gate
 * that produced it so it can be audited and explained to the user.
 *
 * Two rules govern the whole module:
 *
 *   1. Fail closed. An unknown network, an unknown capability or a missing
 *      rule is DENY, never a permissive default.
 *   2. Never upgrade. Each gate may only hold or tighten the decision, so the
 *      order of gates cannot accidentally re-permit something a prior gate
 *      restricted.
 */

import {
  isInternalAction,
  isOutboundAction,
  type ActionKind,
  type Network,
} from '@outreachgraph/domain';
import {
  capabilityKey,
  DEFAULT_CAPABILITY_RULES,
  featureFlagKey,
  indexRules,
  POLICY_VERSION,
  type CapabilityRule,
  type PolicyMode,
} from './capability-matrix';

/** PRD §20.8 output set. */
export const POLICY_DECISIONS = ['allow', 'allow_with_approval', 'manual_only', 'deny'] as const;
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];

/** Ordered least to most restrictive. Used to enforce the never-upgrade rule. */
const RESTRICTIVENESS: Readonly<Record<PolicyDecision, number>> = {
  allow: 0,
  allow_with_approval: 1,
  manual_only: 2,
  deny: 3,
};

function tighten(current: PolicyDecision, next: PolicyDecision): PolicyDecision {
  return RESTRICTIVENESS[next] > RESTRICTIVENESS[current] ? next : current;
}

/** Every gate that can restrict an action, for audit and UI display. */
export const POLICY_GATES = [
  'unknown_capability',
  'feature_flag',
  'capability_disabled',
  'person_ineligible',
  'identity_confidence',
  'approval_mode',
  'budget_exhausted',
  'rate_limit_daily',
  'rate_limit_prospect',
  'cooldown',
  'no_connected_account',
  'capability_mode',
  'outbound_requires_approval',
] as const;

export type PolicyGate = (typeof POLICY_GATES)[number];

export interface PolicyRequest {
  readonly network: Network;
  readonly action: ActionKind;

  /** Campaign execution mode (PRD §7.6). */
  readonly approvalMode: 'research_only' | 'draft_and_approve' | 'trusted_automation';

  /** Whether the workspace has a usable connected account for this network. */
  readonly hasConnectedAccount: boolean;

  /** Outcome of the eligibility gate (PRD §17.5, §6.6). */
  readonly personSuppressed: boolean;
  readonly personBelievedMinor: boolean;
  readonly personDeleted: boolean;

  readonly identityConfidence: number;
  readonly minIdentityConfidence: number;

  /** Rate-limit and budget state, already counted by the caller. */
  readonly actionsToday: number;
  readonly maxActionsPerDay: number;
  readonly actionsToThisProspectThisWeek: number;
  readonly maxActionsPerProspectPerWeek: number;
  readonly hoursSinceLastActionToProspect?: number;
  readonly minHoursBetweenActions?: number;
  readonly budgetExhausted?: boolean;

  /** Explicit flag overrides. A missing key means enabled (PRD §37). */
  readonly featureFlags?: Readonly<Record<string, boolean>>;

  /** Override the capability matrix, e.g. with rules loaded from the database. */
  readonly rules?: readonly CapabilityRule[];
}

export interface PolicyResult {
  readonly decision: PolicyDecision;
  /** The gate that produced the final decision; undefined when nothing restricted it. */
  readonly gate?: PolicyGate;
  readonly reason: string;
  readonly mode?: PolicyMode;
  readonly policyVersion: string;
  /** Every restriction applied, in order. Written to the audit log. */
  readonly trace: readonly PolicyTraceEntry[];
}

export interface PolicyTraceEntry {
  readonly gate: PolicyGate;
  readonly decision: PolicyDecision;
  readonly reason: string;
}

const DEFAULT_COOLDOWN_HOURS = 72;

/**
 * Evaluates a single (network, action) request.
 *
 * Gates run in a fixed order. Cheap, absolute prohibitions come first so that
 * a suppressed person short-circuits before any rate-limit arithmetic.
 */
export function evaluatePolicy(request: PolicyRequest): PolicyResult {
  const rules = indexRules(request.rules ?? DEFAULT_CAPABILITY_RULES);
  const rule = rules.get(capabilityKey(request.network, request.action));

  const trace: PolicyTraceEntry[] = [];
  let decision: PolicyDecision = 'allow';

  // The trace records restrictions only, so an all-clear evaluation has an
  // empty trace and falls back to the rule's own reason.
  const restrict = (gate: PolicyGate, next: PolicyDecision, reason: string): void => {
    if (next !== 'allow') trace.push({ gate, decision: next, reason });
    decision = tighten(decision, next);
  };

  // 1. Fail closed on anything the matrix does not describe.
  if (!rule) {
    return {
      decision: 'deny',
      gate: 'unknown_capability',
      reason: `No policy rule covers ${request.action} on ${request.network}. Denied by default.`,
      policyVersion: POLICY_VERSION,
      trace: [
        {
          gate: 'unknown_capability',
          decision: 'deny',
          reason: 'no matching capability rule',
        },
      ],
    };
  }

  // 2. Kill switches (PRD §37).
  const flagKey = featureFlagKey(request.network, request.action);
  if (request.featureFlags?.[flagKey] === false) {
    restrict('feature_flag', 'deny', `Capability ${flagKey} is switched off.`);
  }

  // 3. The matrix itself may disable a capability outright.
  if (rule.mode === 'disabled') {
    restrict('capability_disabled', 'deny', rule.reason);
  }

  // 4. Absolute prohibitions on contacting this person (PRD §17.5, §6.6).
  if (request.personDeleted) {
    restrict('person_ineligible', 'deny', 'This person has been deleted.');
  }
  if (request.personSuppressed) {
    restrict('person_ineligible', 'deny', 'This person is on a suppression list.');
  }
  if (request.personBelievedMinor) {
    restrict('person_ineligible', 'deny', 'This person is believed to be a minor.');
  }

  // 5. Wrong-person outreach destroys trust, so low-confidence identities may
  //    be researched but never contacted (PRD §9.4, §48 Decision 4).
  if (
    isOutboundAction(request.action) &&
    request.identityConfidence < request.minIdentityConfidence
  ) {
    restrict(
      'identity_confidence',
      'deny',
      `Identity confidence ${round(request.identityConfidence)} is below the ` +
        `workspace threshold of ${round(request.minIdentityConfidence)}.`,
    );
  }

  // 6. Research-only campaigns never touch anyone.
  if (request.approvalMode === 'research_only' && !isResearchAction(request.action)) {
    restrict('approval_mode', 'deny', 'This campaign is in research-only mode.');
  }

  // 7. Budget and rate limits (PRD §7.7, §18). Internal bookkeeping actions are
  //    exempt — they cost nothing and are invisible to the prospect.
  if (!isInternalAction(request.action)) {
    if (request.budgetExhausted === true) {
      restrict('budget_exhausted', 'deny', 'The campaign budget is exhausted.');
    }
    if (request.actionsToday >= request.maxActionsPerDay) {
      restrict(
        'rate_limit_daily',
        'deny',
        `Daily action limit reached (${request.actionsToday}/${request.maxActionsPerDay}).`,
      );
    }
    if (request.actionsToThisProspectThisWeek >= request.maxActionsPerProspectPerWeek) {
      restrict(
        'rate_limit_prospect',
        'deny',
        `Weekly limit for this prospect reached ` +
          `(${request.actionsToThisProspectThisWeek}/${request.maxActionsPerProspectPerWeek}).`,
      );
    }

    const cooldown = request.minHoursBetweenActions ?? DEFAULT_COOLDOWN_HOURS;
    const elapsed = request.hoursSinceLastActionToProspect;
    if (elapsed !== undefined && elapsed < cooldown) {
      restrict(
        'cooldown',
        'deny',
        `Only ${round(elapsed)}h since the last contact; the cooldown is ${cooldown}h.`,
      );
    }
  }

  // 8. What the platform rule permits.
  restrict(...modeRestriction(rule, request));

  // 9. Outbound messages default to individual human approval (PRD §15, §48
  //    Decision 2). Only trusted automation may skip it, and only for an
  //    action the platform explicitly permits through an official API.
  if (decision === 'allow' && isOutboundAction(request.action)) {
    const automatable =
      request.approvalMode === 'trusted_automation' &&
      (rule.mode === 'official_api' || rule.mode === 'customer_managed');
    if (!automatable) {
      restrict(
        'outbound_requires_approval',
        'allow_with_approval',
        'Outbound messages require human approval.',
      );
    }
  }

  const final = trace.filter((entry) => entry.decision === decision).at(-1);

  return {
    decision,
    ...(final ? { gate: final.gate } : {}),
    reason: final?.reason ?? rule.reason,
    mode: rule.mode,
    policyVersion: POLICY_VERSION,
    trace,
  };
}

/** Maps a capability mode onto a decision. */
function modeRestriction(
  rule: CapabilityRule,
  request: PolicyRequest,
): [PolicyGate, PolicyDecision, string] {
  switch (rule.mode) {
    case 'disabled':
      return ['capability_mode', 'deny', rule.reason];

    case 'research_only':
      return isResearchAction(request.action)
        ? ['capability_mode', 'allow', rule.reason]
        : ['capability_mode', 'manual_only', rule.reason];

    case 'draft_only':
      // The system may compose the message but may never send it.
      return ['capability_mode', 'manual_only', rule.reason];

    case 'manual_only':
      return ['capability_mode', 'manual_only', rule.reason];

    case 'official_api':
    case 'approved_partner':
    case 'customer_managed':
      // An API-permitted action still needs an account to act through;
      // without one the user must do it by hand.
      return request.hasConnectedAccount || isResearchAction(request.action)
        ? ['capability_mode', 'allow', rule.reason]
        : [
            'no_connected_account',
            'manual_only',
            `No connected ${request.network} account, so this must be done manually.`,
          ];

    default: {
      // Exhaustiveness: a new mode must be handled explicitly, not defaulted.
      const never: never = rule.mode;
      return ['capability_mode', 'deny', `Unhandled policy mode: ${String(never)}`];
    }
  }
}

/** Actions that only read. These stay available in research-only campaigns. */
function isResearchAction(action: ActionKind): boolean {
  return action === 'observe' || action === 'refresh_research' || action === 'view_profile';
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Filters the action list down to what the Strategy Agent may choose from.
 *
 * The agent receives only permitted actions; it cannot invent capabilities
 * (PRD §20.6).
 */
export function allowedActions(
  request: Omit<PolicyRequest, 'action'>,
  candidates: readonly ActionKind[],
): readonly ActionKind[] {
  return candidates.filter((action) => {
    const result = evaluatePolicy({ ...request, action });
    return result.decision !== 'deny';
  });
}

/** True when the decision permits the executor to act (PRD §20.9). */
export function isExecutable(decision: PolicyDecision, approved: boolean): boolean {
  if (decision === 'allow') return true;
  if (decision === 'allow_with_approval') return approved;
  return false;
}
