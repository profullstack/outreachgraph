/**
 * A conservative review signal for campaigns that have not earned replies.
 *
 * This is a prompt for a person to review the audience and message, never an
 * instruction to change a campaign. The pause only happens after an explicit
 * user action in the product UI.
 */

export const CAMPAIGN_REVIEW_MIN_EMAILS = 50;

/** Lower end of the fresh-list reply benchmark in the Outreach Planner. */
export const CAMPAIGN_REVIEW_REPLY_RATE_FLOOR = 0.02;

export interface CampaignReviewInput {
  readonly status: string;
  readonly emailsSent: number;
  readonly replies: number;
}

export interface CampaignReviewSuggestion {
  readonly kind: 'low_reply_rate';
  readonly emailsSent: number;
  readonly replies: number;
  readonly replyRate: number;
  readonly benchmarkFloor: number;
}

/**
 * Returns a review suggestion only when there is a useful sample and the
 * active campaign is below the planner's low-end reply benchmark.
 */
export function campaignReviewSuggestion(
  input: CampaignReviewInput,
): CampaignReviewSuggestion | undefined {
  if (input.status !== 'active') return undefined;
  if (!Number.isFinite(input.emailsSent) || !Number.isFinite(input.replies)) return undefined;
  if (input.emailsSent < CAMPAIGN_REVIEW_MIN_EMAILS || input.replies < 0) return undefined;

  const replyRate = input.replies / input.emailsSent;
  if (replyRate >= CAMPAIGN_REVIEW_REPLY_RATE_FLOOR) return undefined;

  return {
    kind: 'low_reply_rate',
    emailsSent: input.emailsSent,
    replies: input.replies,
    replyRate,
    benchmarkFloor: CAMPAIGN_REVIEW_REPLY_RATE_FLOOR,
  };
}
