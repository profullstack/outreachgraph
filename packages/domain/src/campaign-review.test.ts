import { describe, expect, test } from 'bun:test';
import {
  CAMPAIGN_REVIEW_MIN_EMAILS,
  CAMPAIGN_REVIEW_REPLY_RATE_FLOOR,
  campaignReviewSuggestion,
} from './campaign-review';

describe('campaignReviewSuggestion', () => {
  test('suggests a human review after a useful sample below the fresh-list benchmark', () => {
    expect(campaignReviewSuggestion({ status: 'active', emailsSent: 50, replies: 0 })).toEqual({
      kind: 'low_reply_rate',
      emailsSent: 50,
      replies: 0,
      replyRate: 0,
      benchmarkFloor: CAMPAIGN_REVIEW_REPLY_RATE_FLOOR,
    });
  });

  test('waits for the minimum sample', () => {
    expect(
      campaignReviewSuggestion({
        status: 'active',
        emailsSent: CAMPAIGN_REVIEW_MIN_EMAILS - 1,
        replies: 0,
      }),
    ).toBeUndefined();
  });

  test('does not make recommendations for paused or archived campaigns', () => {
    expect(campaignReviewSuggestion({ status: 'paused', emailsSent: 100, replies: 0 })).toBe(
      undefined,
    );
    expect(campaignReviewSuggestion({ status: 'archived', emailsSent: 100, replies: 0 })).toBe(
      undefined,
    );
  });

  test('does not suggest a pause at or above the benchmark', () => {
    expect(
      campaignReviewSuggestion({
        status: 'active',
        emailsSent: 100,
        replies: CAMPAIGN_REVIEW_REPLY_RATE_FLOOR * 100,
      }),
    ).toBeUndefined();
  });

  test('fails closed for malformed counts', () => {
    expect(campaignReviewSuggestion({ status: 'active', emailsSent: Number.NaN, replies: 0 })).toBe(
      undefined,
    );
    expect(campaignReviewSuggestion({ status: 'active', emailsSent: 100, replies: -1 })).toBe(
      undefined,
    );
  });
});
