/**
 * Autonomous replies are off unless every condition holds.
 *
 * The test that matters is the table at the bottom: start from the one input
 * that sends, break exactly one condition, and it must fall back to copilot.
 * A new condition added without a row here is a condition nobody proved can
 * stop a send.
 */

import { describe, expect, test } from 'bun:test';
import { decideAutoReply, type AutoReplyInput } from './auto-reply';
import { evaluatePolicy, type PolicyRequest } from './engine';

const SENDS: AutoReplyInput = {
  mode: 'autonomous',
  approvalMode: 'trusted_automation',
  label: 'question',
  labelSource: 'model',
  confidence: 0.93,
  threshold: 0.85,
  draftPassed: true,
  policy: { decision: 'allow', reason: 'ok' },
};

function emailReply(overrides: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    network: 'email',
    action: 'send_email',
    approvalMode: 'trusted_automation',
    hasConnectedAccount: true,
    personSuppressed: false,
    personBelievedMinor: false,
    personDeleted: false,
    identityConfidence: 0.97,
    minIdentityConfidence: 0.85,
    actionsToday: 0,
    maxActionsPerDay: 50,
    actionsToThisProspectThisWeek: 1,
    maxActionsPerProspectPerWeek: 1,
    hoursSinceLastActionToProspect: 3,
    actionsToThisAddressThisWeek: 1,
    hoursSinceLastActionToAddress: 3,
    addressShared: false,
    conversationOpen: true,
    isFollowUp: true,
    autonomousReply: true,
    ...overrides,
  };
}

describe('decideAutoReply', () => {
  test('sends only when everything holds', () => {
    expect(decideAutoReply(SENDS).outcome).toBe('autonomous');
  });

  test('off drafts nothing', () => {
    expect(decideAutoReply({ ...SENDS, mode: 'off' }).outcome).toBe('none');
  });

  test('labels that get no answer at all', () => {
    for (const label of [
      'not_interested',
      'out_of_office',
      'bounce',
      'unsubscribe_request',
      'other',
    ] as const) {
      expect(decideAutoReply({ ...SENDS, label }).outcome).toBe('none');
    }
  });

  test('copilot is the default fallback', () => {
    expect(decideAutoReply({ ...SENDS, mode: 'copilot' }).outcome).toBe('copilot');
  });

  const breaks: [string, Partial<AutoReplyInput>][] = [
    ['campaign not autonomous', { mode: 'copilot' }],
    ['approval mode is draft and approve', { approvalMode: 'draft_and_approve' }],
    ['a referral', { label: 'referral' }],
    ['confidence under the threshold', { confidence: 0.84 }],
    ['a threshold of zero is floored', { threshold: 0, confidence: 0.4 }],
    ['unclassified', { labelSource: 'unclassified' }],
    ['draft failed its checks', { draftPassed: false }],
    ['policy wants approval', { policy: { decision: 'allow_with_approval', reason: 'x' } }],
    ['policy denies', { policy: { decision: 'deny', reason: 'x' } }],
    ['policy never asked', { policy: undefined }],
  ];

  for (const [label, change] of breaks) {
    test(`falls back to copilot: ${label}`, () => {
      const decision = decideAutoReply({ ...SENDS, ...change });
      expect(decision.outcome).toBe('copilot');
      expect(decision.reason.length).toBeGreaterThan(5);
    });
  }
});

describe('the engine and autonomous replies', () => {
  test('allows an opted-in answer on trusted automation, inside the pacing window', () => {
    const result = evaluatePolicy(emailReply());
    expect(result.decision).toBe('allow');
  });

  test('without the opt-in an open thread still needs a human', () => {
    const result = evaluatePolicy(emailReply({ autonomousReply: false }));
    expect(result.decision).toBe('allow_with_approval');
    expect(result.gate).toBe('conversation_open');
  });

  test('the opt-in means nothing on draft and approve', () => {
    const result = evaluatePolicy(emailReply({ approvalMode: 'draft_and_approve' }));
    expect(result.decision).toBe('allow_with_approval');
  });

  test('the kill switch stops it', () => {
    const result = evaluatePolicy(
      emailReply({ featureFlags: { 'automation.email.auto_reply': false } }),
    );
    expect(result.decision).toBe('allow_with_approval');
  });

  test('suppression and the daily cap still bind', () => {
    expect(evaluatePolicy(emailReply({ personSuppressed: true })).decision).toBe('deny');
    expect(evaluatePolicy(emailReply({ actionsToday: 50 })).decision).toBe('deny');
  });

  test('a shared inbox is still paced even when answering', () => {
    const result = evaluatePolicy(emailReply({ addressShared: true }));
    expect(result.decision).toBe('deny');
  });

  test('it cannot open a cold conversation', () => {
    const result = evaluatePolicy(emailReply({ isFollowUp: false }));
    expect(result.decision).toBe('deny');
  });

  test('a network whose capability is manual-only never gets there', () => {
    const result = evaluatePolicy(emailReply({ network: 'x', action: 'send_dm' }));
    expect(result.decision).not.toBe('allow');
  });
});
