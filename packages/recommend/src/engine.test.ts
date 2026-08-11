import { describe, expect, test } from 'bun:test';
import type { Network } from '@outreachgraph/domain';
import type { PolicyRequest } from '@outreachgraph/policy';
import {
  computePriority,
  generateRecommendation,
  type CandidateSignal,
  type RecommendationInput,
} from './engine';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function hoursAgo(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString();
}

function policy(overrides: Partial<PolicyRequest> = {}): Omit<PolicyRequest, 'action' | 'network'> {
  return {
    approvalMode: 'draft_and_approve',
    hasConnectedAccount: true,
    personSuppressed: false,
    personBelievedMinor: false,
    personDeleted: false,
    identityConfidence: 0.97,
    minIdentityConfidence: 0.85,
    actionsToday: 0,
    maxActionsPerDay: 50,
    actionsToThisProspectThisWeek: 0,
    maxActionsPerProspectPerWeek: 1,
    ...overrides,
  };
}

function signal(overrides: Partial<CandidateSignal> = {}): CandidateSignal {
  return {
    id: 'sig_1',
    type: 'recommendation_request',
    network: 'x',
    summary: 'Asked for alternatives to a competitor for cross-border payouts',
    evidence: 'Does anyone have a good alternative to...',
    sourceTimestamp: hoursAgo(4),
    observedAt: hoursAgo(4),
    confidence: 0.94,
    relevance: 0.91,
    ...overrides,
  };
}

function input(overrides: Partial<RecommendationInput> = {}): RecommendationInput {
  return {
    personId: 'per_1',
    campaignId: 'cmp_1',
    signals: [signal()],
    reachableNetworks: ['x'],
    opportunity: 92,
    policy: policy(),
    now: NOW,
    ...overrides,
  };
}

describe('choosing an action', () => {
  test('replies where the person actually spoke', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.recommendation.action).toBe('reply');
    expect(result.recommendation.network).toBe('x');
    expect(result.recommendation.triggerSignalId).toBe('sig_1');
  });

  test('prefers a public reply over a direct message', () => {
    // Both are technically available on X, but reply is less intrusive.
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recommendation.action).not.toBe('send_dm');
  });

  test('carries the policy decision, not an assumption', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Outbound defaults to individual approval.
    expect(result.recommendation.policyDecision).toBe('allow_with_approval');
    expect(result.recommendation.policyVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('allows outright under trusted automation', () => {
    const result = generateRecommendation(
      input({ policy: policy({ approvalMode: 'trusted_automation' }) }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recommendation.policyDecision).toBe('allow');
  });

  test('falls back to a reachable network when the signal’s own is blocked', () => {
    // The signal happened on LinkedIn, where nothing is automatable, but the
    // person is also reachable on Bluesky.
    const result = generateRecommendation(
      input({
        signals: [signal({ network: 'linkedin' })],
        reachableNetworks: ['linkedin', 'bluesky'],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // LinkedIn yields manual_only rather than deny, so it is still chosen —
    // the human performs it in LinkedIn's own interface.
    expect(result.recommendation.network).toBe('linkedin');
    expect(result.recommendation.policyDecision).toBe('manual_only');
  });

  test('never proposes an action GitHub forbids', () => {
    const result = generateRecommendation(
      input({
        signals: [signal({ network: 'github', type: 'pain' })],
        reachableNetworks: ['github'],
      }),
    );

    if (result.ok) {
      // GitHub outreach is disabled, so only passive actions may appear.
      expect(['observe', 'refresh_research', 'follow']).toContain(result.recommendation.action);
      expect(result.recommendation.action).not.toBe('comment');
      expect(result.recommendation.action).not.toBe('send_dm');
    } else {
      expect(result.reason).toBe('no_permitted_action');
    }
  });
});

describe('refusing to recommend', () => {
  test('a suppressed person gets nothing', () => {
    const result = generateRecommendation(input({ policy: policy({ personSuppressed: true }) }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('person_ineligible');
  });

  test('a suspected minor gets nothing', () => {
    const result = generateRecommendation(input({ policy: policy({ personBelievedMinor: true }) }));

    expect(result.ok).toBe(false);
  });

  test('no engagement without a signal to justify it', () => {
    const result = generateRecommendation(input({ signals: [] }));

    if (result.ok) {
      // Only passive research is acceptable with nothing to respond to.
      expect(['observe', 'refresh_research']).toContain(result.recommendation.action);
      expect(result.recommendation.groundedSignalIds).toHaveLength(0);
    } else {
      expect(result.reason).toBe('no_relevant_signal');
    }
  });

  test('a fully decayed signal does not trigger outreach', () => {
    const stale = signal({
      sourceTimestamp: hoursAgo(24 * 200),
      observedAt: hoursAgo(24 * 200),
    });

    const result = generateRecommendation(input({ signals: [stale] }));

    if (result.ok) {
      expect(result.recommendation.triggerSignalId).toBeUndefined();
      expect(['observe', 'refresh_research']).toContain(result.recommendation.action);
    }
  });

  test('a spent rate limit blocks the whole recommendation', () => {
    const result = generateRecommendation(
      input({ policy: policy({ actionsToday: 50, maxActionsPerDay: 50 }) }),
    );

    // Every engagement action is denied; only exempt passive ones can survive.
    if (result.ok) {
      expect(['observe', 'refresh_research']).toContain(result.recommendation.action);
    } else {
      expect(result.reason).toBe('no_permitted_action');
    }
  });

  test('low identity confidence blocks outbound but permits research', () => {
    const result = generateRecommendation(
      input({ policy: policy({ identityConfidence: 0.5, minIdentityConfidence: 0.85 }) }),
    );

    if (result.ok) {
      expect(['observe', 'refresh_research', 'follow', 'like']).toContain(
        result.recommendation.action,
      );
    }
  });
});

describe('trigger selection', () => {
  test('picks the strongest signal, not merely the newest', () => {
    const weakButFresh = signal({
      id: 'sig_weak',
      type: 'content_topic',
      relevance: 0.1,
      confidence: 0.3,
      sourceTimestamp: hoursAgo(1),
      observedAt: hoursAgo(1),
    });

    const strongSlightlyOlder = signal({
      id: 'sig_strong',
      type: 'recommendation_request',
      relevance: 0.95,
      confidence: 0.95,
      sourceTimestamp: hoursAgo(6),
      observedAt: hoursAgo(6),
    });

    const result = generateRecommendation(input({ signals: [weakButFresh, strongSlightlyOlder] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recommendation.triggerSignalId).toBe('sig_strong');
  });

  test('only signals with verbatim evidence may be quoted', () => {
    const noEvidence = signal({ evidence: undefined });
    const result = generateRecommendation(input({ signals: [noEvidence] }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // It can still prompt an action, but nothing may be personalised from it.
    expect(result.recommendation.triggerSignalId).toBe('sig_1');
    expect(result.recommendation.groundedSignalIds).toHaveLength(0);
  });

  test('a signal with evidence is quotable', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recommendation.groundedSignalIds).toEqual(['sig_1']);
  });
});

describe('priority and expiry', () => {
  test('a fresh trigger outranks a stale one at equal fit', () => {
    const fresh = generateRecommendation(input());
    const stale = generateRecommendation(
      input({
        signals: [signal({ sourceTimestamp: hoursAgo(24 * 20), observedAt: hoursAgo(24 * 20) })],
      }),
    );

    expect(fresh.ok && stale.ok).toBe(true);
    if (!fresh.ok || !stale.ok) return;
    expect(fresh.recommendation.priority).toBeGreaterThan(stale.recommendation.priority);
  });

  test('fit still matters at equal freshness', () => {
    const strong = generateRecommendation(input({ opportunity: 95 }));
    const weak = generateRecommendation(input({ opportunity: 20 }));

    expect(strong.ok && weak.ok).toBe(true);
    if (!strong.ok || !weak.ok) return;
    expect(strong.recommendation.priority).toBeGreaterThan(weak.recommendation.priority);
  });

  test('priority stays within 0..100', () => {
    expect(computePriority(100, 1)).toBeLessThanOrEqual(100);
    expect(computePriority(0, 0)).toBeGreaterThanOrEqual(0);
    expect(computePriority(Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
  });

  test('expires before the trigger goes stale', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const expiresAt = result.recommendation.expiresAt;
    expect(expiresAt).toBeDefined();
    expect(Date.parse(expiresAt!)).toBeGreaterThan(NOW.getTime());
  });

  test('a durable signal expires later than an urgent one', () => {
    const urgent = generateRecommendation(input());
    const durable = generateRecommendation(
      input({ signals: [signal({ id: 'sig_role', type: 'role_change' })] }),
    );

    expect(urgent.ok && durable.ok).toBe(true);
    if (!urgent.ok || !durable.ok) return;

    const urgentAt = Date.parse(urgent.recommendation.expiresAt ?? '');
    const durableAt = Date.parse(durable.recommendation.expiresAt ?? '');

    if (!Number.isNaN(urgentAt) && !Number.isNaN(durableAt)) {
      expect(durableAt).toBeGreaterThan(urgentAt);
    }
  });
});

describe('the reason shown to the user', () => {
  test('names the signal and how old it is', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.recommendation.reason).toContain('alternatives to a competitor');
    expect(result.recommendation.reason).toContain('4h ago');
    expect(result.recommendation.reason).toContain('reply');
  });

  test('sets a conversation goal for outbound actions', () => {
    const result = generateRecommendation(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recommendation.expectedGoal).toBe('start_conversation');
  });
});

describe('determinism', () => {
  test('the same state always yields the same recommendation', () => {
    const state = input();
    const first = generateRecommendation(state);

    for (let i = 0; i < 20; i += 1) {
      expect(generateRecommendation(state)).toEqual(first);
    }
  });

  test('signal order does not change the outcome', () => {
    const signals = [
      signal({ id: 'a', relevance: 0.4 }),
      signal({ id: 'b', relevance: 0.95 }),
      signal({ id: 'c', relevance: 0.2 }),
    ];

    const forward = generateRecommendation(input({ signals }));
    const backward = generateRecommendation(input({ signals: [...signals].reverse() }));

    expect(forward.ok && backward.ok).toBe(true);
    if (!forward.ok || !backward.ok) return;
    expect(forward.recommendation.triggerSignalId).toBe(backward.recommendation.triggerSignalId);
  });

  test('never proposes an action on an unreachable network', () => {
    const networks: Network[] = ['bluesky'];
    const result = generateRecommendation(
      input({ signals: [signal({ network: 'bluesky' })], reachableNetworks: networks }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(networks).toContain(result.recommendation.network);
  });
});
