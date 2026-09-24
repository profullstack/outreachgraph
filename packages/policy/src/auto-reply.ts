/**
 * Whether an inbound reply may be answered with nobody watching.
 *
 * The answer is almost always no, and this function exists so that "almost"
 * is written down in one place rather than scattered through a worker loop.
 * It is pure and deterministic like the engine beside it: a model supplied the
 * label and a confidence, but whether those are *enough* is a fixed rule over
 * numbers, and the same inputs always produce the same decision.
 *
 * Every condition below must hold for `autonomous`. Anything else that would
 * have drafted a reply falls back to `copilot` — a card with the draft on it —
 * and names the first condition that failed, so a campaign set to autonomous
 * that keeps producing cards says why instead of looking broken:
 *
 *   1. The campaign asked for it (`auto_reply_mode = 'autonomous'`).
 *   2. The campaign is on `trusted_automation`. Autonomous replies are not a
 *      way around a campaign whose owner wants to approve everything.
 *   3. The label is `interested` or `question`. A `referral` names someone
 *      else, and writing to a third party because a model read an email is
 *      exactly the unattended outreach the approval default exists to stop.
 *   4. The classifier's confidence meets the campaign's threshold, which is
 *      itself never below `MIN_AUTO_REPLY_THRESHOLD`.
 *   5. The draft passed every §14.2 quality gate.
 *   6. The policy engine, asked with `autonomousReply: true`, answered plain
 *      `allow` — not `allow_with_approval`, which is the engine saying a human
 *      still has to look.
 */

import type { AutoReplyMode, ReplyLabel, ReplyLabelSource } from '@outreachgraph/domain';
import type { PolicyResult } from './engine';

/**
 * The floor under any campaign's threshold. A threshold of zero would make
 * "autonomous" mean "whatever the model said", which is not a setting this
 * product offers.
 */
export const MIN_AUTO_REPLY_THRESHOLD = 0.5;

/** The labels a machine may answer on its own. */
export const AUTONOMOUS_REPLY_LABELS: readonly ReplyLabel[] = ['interested', 'question'];

/** Labels worth a drafted answer at all. */
const DRAFTABLE: readonly ReplyLabel[] = ['interested', 'question', 'referral'];

export interface AutoReplyInput {
  readonly mode: AutoReplyMode;
  readonly approvalMode: 'research_only' | 'draft_and_approve' | 'trusted_automation';
  readonly label: ReplyLabel;
  readonly labelSource: ReplyLabelSource;
  readonly confidence: number;
  readonly threshold: number;
  /** Whether a draft exists and passed every quality gate. */
  readonly draftPassed: boolean;
  /** The engine's answer for this send, asked with `autonomousReply: true`. */
  readonly policy?: Pick<PolicyResult, 'decision' | 'reason'> | undefined;
}

export type AutoReplyDecision =
  | { readonly outcome: 'none'; readonly reason: string }
  | { readonly outcome: 'copilot'; readonly reason: string }
  | { readonly outcome: 'autonomous'; readonly reason: string };

/** Whether this reply gets a drafted answer, and whether a human must send it. */
export function decideAutoReply(input: AutoReplyInput): AutoReplyDecision {
  if (input.mode === 'off') {
    return { outcome: 'none', reason: 'auto-reply is off for this campaign' };
  }
  if (!DRAFTABLE.includes(input.label)) {
    return { outcome: 'none', reason: `a ${input.label.replace(/_/g, ' ')} reply is not answered` };
  }

  const hold = firstHold(input);
  return hold
    ? { outcome: 'copilot', reason: hold }
    : { outcome: 'autonomous', reason: 'every autonomous-reply condition held' };
}

/** Whether the campaign may run unattended at all; the questions asked before drafting. */
export function autonomousRequested(
  mode: AutoReplyMode,
  approvalMode: AutoReplyInput['approvalMode'],
): boolean {
  return mode === 'autonomous' && approvalMode === 'trusted_automation';
}

function firstHold(input: AutoReplyInput): string | undefined {
  if (input.mode !== 'autonomous') return 'this campaign drafts replies for approval';
  if (input.approvalMode !== 'trusted_automation') {
    return 'autonomous replies need the campaign on trusted automation';
  }
  if (!AUTONOMOUS_REPLY_LABELS.includes(input.label)) {
    return `only interested and question replies are answered unattended, not ${input.label}`;
  }
  if (input.labelSource === 'unclassified') return 'the reply has not been classified';

  const threshold = Math.max(MIN_AUTO_REPLY_THRESHOLD, Math.min(1, input.threshold));
  if (!(input.confidence >= threshold)) {
    return `classifier confidence ${round(input.confidence)} is below the ${round(threshold)} threshold`;
  }
  if (!input.draftPassed) return 'the draft did not pass its quality checks';
  if (!input.policy) return 'the policy engine was not asked';
  if (input.policy.decision !== 'allow') {
    return input.policy.decision === 'allow_with_approval'
      ? `the policy engine requires approval: ${input.policy.reason}`
      : `the policy engine refused: ${input.policy.reason}`;
  }
  return undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
