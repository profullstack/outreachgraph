/**
 * Recommendations, drafts, approvals, actions and interactions
 * (PRD §13.2, §14, §15, §27).
 */

import type { PrefixedId } from './ids';
import type { ActionKind, Network } from './networks';

/**
 * A proposed next step. `policyStatus` is copied from the Policy Engine at
 * generation time and re-checked at execution time — a recommendation that
 * was allowed yesterday may not be today (PRD §37 feature flags).
 */
export interface Recommendation {
  readonly id: PrefixedId<'recommendation'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly campaignId: PrefixedId<'campaign'>;
  readonly personId: PrefixedId<'person'>;
  readonly action: ActionKind;
  readonly network: Network;
  /** 0..100, drives approval-queue ordering. */
  readonly priority: number;
  /** Plain-language justification shown as "why now". */
  readonly reason: string;
  readonly triggerSignalId?: PrefixedId<'signal'>;
  readonly draftId?: PrefixedId<'draft'>;
  readonly policyStatus: PolicyStatus;
  readonly expectedGoal: RecommendationGoal;
  readonly status: RecommendationStatus;
  readonly createdAt: string;
  readonly expiresAt?: string;
}

/** Mirrors the Policy Engine's decision set (PRD §20.8). */
export const POLICY_STATUS = ['allow', 'allow_with_approval', 'manual_only', 'deny'] as const;
export type PolicyStatus = (typeof POLICY_STATUS)[number];

export const RECOMMENDATION_GOALS = [
  'start_conversation',
  'build_relationship',
  'gather_context',
  'book_meeting',
  'stay_visible',
] as const;

export type RecommendationGoal = (typeof RECOMMENDATION_GOALS)[number];

export const RECOMMENDATION_STATUS = [
  'pending',
  'approved',
  'skipped',
  'snoozed',
  'expired',
  'executed',
] as const;

export type RecommendationStatus = (typeof RECOMMENDATION_STATUS)[number];

/**
 * A generated message. `groundedSignalIds` is not decorative: the composer
 * refuses to emit a personalised claim that no listed signal supports
 * (PRD §14.1).
 */
export interface Draft {
  readonly id: PrefixedId<'draft'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly recommendationId: PrefixedId<'recommendation'>;
  readonly body: string;
  readonly subject?: string;
  readonly groundedSignalIds: readonly PrefixedId<'signal'>[];
  readonly checks: readonly QualityCheckResult[];
  readonly model?: string;
  readonly editedByUser: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Pre-display gates from PRD §14.2. */
export const QUALITY_CHECKS = [
  'grounding',
  'unsupported_claim',
  'identity_confidence',
  'excessive_flattery',
  'spam_pattern',
  'duplicate_similarity',
  'policy',
  'sensitive_topic',
] as const;

export type QualityCheck = (typeof QUALITY_CHECKS)[number];

export interface QualityCheckResult {
  readonly check: QualityCheck;
  readonly passed: boolean;
  readonly detail?: string;
}

export function allChecksPassed(results: readonly QualityCheckResult[]): boolean {
  return results.length > 0 && results.every((r) => r.passed);
}

export interface Approval {
  readonly id: PrefixedId<'approval'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly recommendationId: PrefixedId<'recommendation'>;
  readonly decision: ApprovalDecision;
  readonly decidedBy: PrefixedId<'user'>;
  readonly decidedAt: string;
  readonly note?: string;
  /** Set when the user rewrote the draft before approving; feeds draft-quality metrics. */
  readonly editedBody?: string;
  readonly snoozedUntil?: string;
}

export const APPROVAL_DECISIONS = [
  'approve',
  'edit_and_approve',
  'skip',
  'snooze',
  'do_not_contact',
] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/** A concrete attempt to do the thing. One row per execution attempt. */
export interface Action {
  readonly id: PrefixedId<'action'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly recommendationId: PrefixedId<'recommendation'>;
  readonly personId: PrefixedId<'person'>;
  readonly kind: ActionKind;
  readonly network: Network;
  readonly mode: ActionMode;
  readonly status: ActionStatus;
  readonly body?: string;
  readonly externalUrl?: string;
  readonly externalId?: string;
  readonly error?: string;
  readonly createdAt: string;
  readonly executedAt?: string;
}

/** How the action reached the network (PRD §16.2). */
export const ACTION_MODES = ['official_api', 'manual', 'crm'] as const;
export type ActionMode = (typeof ACTION_MODES)[number];

export const ACTION_STATUS = ['queued', 'executing', 'completed', 'failed', 'cancelled'] as const;
export type ActionStatus = (typeof ACTION_STATUS)[number];

/** Conversation state, enough to know where things stand (PRD §27). */
export const INTERACTION_STATES = [
  'never_contacted',
  'contacted',
  'waiting',
  'responded',
  'positive',
  'negative',
  'not_interested',
  'meeting',
  'customer',
] as const;

export type InteractionState = (typeof INTERACTION_STATES)[number];

export interface Interaction {
  readonly id: PrefixedId<'interaction'>;
  readonly workspaceId: PrefixedId<'workspace'>;
  readonly personId: PrefixedId<'person'>;
  readonly campaignId?: PrefixedId<'campaign'>;
  readonly actionId?: PrefixedId<'action'>;
  readonly network: Network;
  readonly direction: 'outbound' | 'inbound';
  readonly state: InteractionState;
  readonly body?: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
}

/** States that count toward the North Star metric (PRD §32). */
export function isQualifiedConversation(state: InteractionState): boolean {
  return state === 'positive' || state === 'meeting' || state === 'customer';
}
