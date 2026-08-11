import { describe, expect, test } from 'bun:test';
import { ACTION_KINDS, NETWORKS, type ActionKind, type Network } from '@outreachgraph/domain';
import { allowedActions, evaluatePolicy, isExecutable, type PolicyRequest } from './engine';
import { DEFAULT_CAPABILITY_RULES } from './capability-matrix';

/** A permissive baseline; each test tightens only the field under examination. */
function request(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    network: 'x',
    action: 'reply',
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

describe('fail-closed behaviour', () => {
  test('denies a capability the matrix does not describe', () => {
    const result = evaluatePolicy(request({ network: 'instagram', action: 'send_dm' }));

    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('unknown_capability');
  });

  test('denies every action on a network with no rules at all', () => {
    const result = evaluatePolicy(request({ rules: [] }));
    expect(result.decision).toBe('deny');
  });

  test('never returns allow for an outbound action absent from the matrix', () => {
    for (const network of NETWORKS) {
      for (const action of ACTION_KINDS) {
        const covered = DEFAULT_CAPABILITY_RULES.some(
          (r) => r.network === network && r.capability === action,
        );
        if (covered) continue;

        const result = evaluatePolicy(request({ network, action }));
        expect(result.decision).toBe('deny');
      }
    }
  });
});

describe('LinkedIn (PRD §16.3)', () => {
  const automationAttempts: ActionKind[] = [
    'send_dm',
    'connect',
    'like',
    'comment',
    'reply',
    'follow',
    'view_profile',
  ];

  test.each(automationAttempts)('never auto-executes %s', (action) => {
    const result = evaluatePolicy(
      request({ network: 'linkedin', action, approvalMode: 'trusted_automation' }),
    );

    // Manual-only means the product may draft it, but the human acts.
    expect(result.decision).toBe('manual_only');
    expect(isExecutable(result.decision, true)).toBe(false);
  });

  test('permits research', () => {
    const result = evaluatePolicy(request({ network: 'linkedin', action: 'observe' }));
    expect(result.decision).toBe('allow');
  });
});

describe('X (PRD §16.4)', () => {
  test('allows a public reply with human approval by default', () => {
    const result = evaluatePolicy(request({ network: 'x', action: 'reply' }));

    expect(result.decision).toBe('allow_with_approval');
    expect(result.gate).toBe('outbound_requires_approval');
    expect(isExecutable(result.decision, true)).toBe(true);
    expect(isExecutable(result.decision, false)).toBe(false);
  });

  test('allows a reply outright only under trusted automation', () => {
    const result = evaluatePolicy(
      request({ network: 'x', action: 'reply', approvalMode: 'trusted_automation' }),
    );
    expect(result.decision).toBe('allow');
  });

  test('keeps automated DMs manual even under trusted automation', () => {
    const result = evaluatePolicy(
      request({ network: 'x', action: 'send_dm', approvalMode: 'trusted_automation' }),
    );
    expect(result.decision).toBe('manual_only');
  });

  test('downgrades to manual when no account is connected', () => {
    const result = evaluatePolicy(request({ network: 'x', hasConnectedAccount: false }));

    expect(result.decision).toBe('manual_only');
    expect(result.gate).toBe('no_connected_account');
  });
});

describe('GitHub (PRD §16.6)', () => {
  test.each(['comment', 'reply', 'send_dm'] as ActionKind[])(
    'refuses sales %s on GitHub',
    (action) => {
      const result = evaluatePolicy(request({ network: 'github', action }));
      expect(result.decision).toBe('deny');
    },
  );

  test('still reads public activity as a signal source', () => {
    const result = evaluatePolicy(request({ network: 'github', action: 'observe' }));
    expect(result.decision).toBe('allow');
  });
});

describe('Bluesky (PRD §16.5)', () => {
  test('allows an approved reply through the connected account', () => {
    const result = evaluatePolicy(request({ network: 'bluesky', action: 'reply' }));
    expect(result.decision).toBe('allow_with_approval');
  });
});

describe('person eligibility', () => {
  test.each([
    ['personSuppressed', 'This person is on a suppression list.'],
    ['personBelievedMinor', 'This person is believed to be a minor.'],
    ['personDeleted', 'This person has been deleted.'],
  ] as const)('denies every action when %s', (field) => {
    for (const action of ACTION_KINDS) {
      for (const network of ['x', 'bluesky', 'linkedin', 'github'] as Network[]) {
        const result = evaluatePolicy(request({ network, action, [field]: true }));
        expect(result.decision).toBe('deny');
      }
    }
  });

  test('suppression outranks trusted automation', () => {
    const result = evaluatePolicy(
      request({ personSuppressed: true, approvalMode: 'trusted_automation' }),
    );
    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('person_ineligible');
  });
});

describe('identity confidence (PRD §48 Decision 4)', () => {
  test('blocks outbound below the workspace threshold', () => {
    const result = evaluatePolicy(
      request({ identityConfidence: 0.72, minIdentityConfidence: 0.85 }),
    );

    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('identity_confidence');
  });

  test('still permits research on a low-confidence identity', () => {
    const result = evaluatePolicy(
      request({ action: 'observe', identityConfidence: 0.4, minIdentityConfidence: 0.85 }),
    );
    expect(result.decision).toBe('allow');
  });

  test('permits outbound exactly at the threshold', () => {
    const result = evaluatePolicy(
      request({ identityConfidence: 0.85, minIdentityConfidence: 0.85 }),
    );
    expect(result.decision).toBe('allow_with_approval');
  });
});

describe('research-only campaigns (PRD §7.6)', () => {
  test('deny anything that touches the prospect', () => {
    // Actions X actually defines — an undefined one would fail closed at the
    // unknown_capability gate instead, which is a different code path.
    for (const action of ['reply', 'send_dm', 'follow', 'like'] as ActionKind[]) {
      const result = evaluatePolicy(request({ action, approvalMode: 'research_only' }));
      expect(result.decision).toBe('deny');
      expect(result.gate).toBe('approval_mode');
    }
  });

  test('deny an action the network does not define, via fail-closed', () => {
    const result = evaluatePolicy(request({ action: 'connect', approvalMode: 'research_only' }));
    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('unknown_capability');
  });

  test('still allow reading', () => {
    const result = evaluatePolicy(request({ action: 'observe', approvalMode: 'research_only' }));
    expect(result.decision).toBe('allow');
  });
});

describe('rate limits and budget (PRD §7.7, §18)', () => {
  test('deny once the daily cap is reached', () => {
    const result = evaluatePolicy(request({ actionsToday: 50, maxActionsPerDay: 50 }));

    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('rate_limit_daily');
  });

  test('deny a second contact in the same week', () => {
    const result = evaluatePolicy(
      request({ actionsToThisProspectThisWeek: 1, maxActionsPerProspectPerWeek: 1 }),
    );
    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('rate_limit_prospect');
  });

  test('deny inside the per-prospect cooldown', () => {
    const result = evaluatePolicy(
      request({ hoursSinceLastActionToProspect: 12, minHoursBetweenActions: 72 }),
    );
    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('cooldown');
  });

  test('allow once the cooldown has elapsed', () => {
    const result = evaluatePolicy(
      request({ hoursSinceLastActionToProspect: 96, minHoursBetweenActions: 72 }),
    );
    expect(result.decision).toBe('allow_with_approval');
  });

  test('deny when the budget is exhausted', () => {
    const result = evaluatePolicy(request({ budgetExhausted: true }));
    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('budget_exhausted');
  });

  test('exempt internal bookkeeping from the daily cap', () => {
    const result = evaluatePolicy(
      request({ action: 'observe', actionsToday: 999, maxActionsPerDay: 50 }),
    );
    expect(result.decision).toBe('allow');
  });
});

describe('feature flags (PRD §37)', () => {
  test('an explicit false is an immediate kill switch', () => {
    const result = evaluatePolicy(request({ featureFlags: { 'network.x.reply': false } }));

    expect(result.decision).toBe('deny');
    expect(result.gate).toBe('feature_flag');
  });

  test('a missing flag leaves the capability enabled', () => {
    const result = evaluatePolicy(request({ featureFlags: {} }));
    expect(result.decision).toBe('allow_with_approval');
  });

  test('a flag cannot re-enable a disabled capability', () => {
    const result = evaluatePolicy(
      request({
        network: 'github',
        action: 'send_dm',
        featureFlags: { 'network.github.send_dm': true },
      }),
    );
    expect(result.decision).toBe('deny');
  });
});

describe('determinism and auditability', () => {
  test('the same input always produces the same decision', () => {
    const input = request({ network: 'bluesky', action: 'reply' });
    const first = evaluatePolicy(input);

    for (let i = 0; i < 25; i += 1) {
      const repeat = evaluatePolicy(input);
      expect(repeat.decision).toBe(first.decision);
      expect(repeat.gate).toBe(first.gate);
      expect(repeat.trace).toEqual(first.trace);
    }
  });

  test('records every restriction in the trace', () => {
    const result = evaluatePolicy(
      request({ personSuppressed: true, actionsToday: 999, maxActionsPerDay: 1 }),
    );

    const gates = result.trace.map((entry) => entry.gate);
    expect(gates).toContain('person_ineligible');
    expect(gates).toContain('rate_limit_daily');
  });

  test('stamps the policy version on every decision', () => {
    expect(evaluatePolicy(request()).policyVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('an unrestricted decision carries an empty trace', () => {
    const result = evaluatePolicy(request({ action: 'observe' }));
    expect(result.decision).toBe('allow');
    expect(result.trace).toHaveLength(0);
  });
});

describe('allowedActions (PRD §20.6)', () => {
  test('hands the strategy agent only permitted actions', () => {
    const permitted = allowedActions(request({ network: 'linkedin' }), [...ACTION_KINDS]);

    expect(permitted).toContain('observe');
    // Present but manual — the agent may still propose it for the human to do.
    expect(permitted).toContain('send_dm');
    // Never offered: LinkedIn has no rule for it, so it fails closed.
    expect(permitted).not.toContain('send_email');
  });

  test('returns nothing actionable for a suppressed person', () => {
    const permitted = allowedActions(request({ personSuppressed: true }), [...ACTION_KINDS]);
    expect(permitted).toHaveLength(0);
  });
});
