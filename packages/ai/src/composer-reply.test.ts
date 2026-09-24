/**
 * The composer's reply mode.
 *
 * The same gates as a cold draft, grounded in the conversation instead of a
 * signal: an answer may repeat the prospect's words, our own earlier message
 * and the offering, and nothing else. A price that appears in none of them is
 * an invented fact and the draft is withheld.
 */

import { describe, expect, test } from 'bun:test';
import { composeReply, type ReplyComposeInput } from './composer';
import { StubModel } from './model';

const INPUT: ReplyComposeInput = {
  network: 'email',
  offering: {
    name: 'ExamplePay',
    category: 'developer payments infrastructure',
    valuePropositions: ['cross-border payouts settle same day'],
    likelyPains: ['slow settlement'],
    competitors: [],
  },
  prospect: {
    displayName: 'Jane Smith',
    firstName: 'Jane',
    companyName: 'Acme',
    identityConfidence: 0.97,
  },
  thread: [
    { from: 'us', body: 'Hi Jane, saw your note about cross-border settlement taking days.' },
  ],
  inbound: {
    body: 'How fast does settlement actually happen for cross-border payouts?',
    subject: 'Re: Cross-border payouts',
  },
  label: 'question',
  minIdentityConfidence: 0.85,
};

describe('composeReply', () => {
  test('a grounded answer passes', async () => {
    const model = new StubModel(
      'Hi Jane, cross-border payouts settle same day, so settlement stops taking days. Happy to show you how it works.',
    );
    const result = await composeReply(model, INPUT);
    expect(result.ok).toBe(true);
    expect(model.calls[0]?.user).toContain('How fast does settlement');
  });

  test('an invented number is withheld, on every attempt', async () => {
    const model = new StubModel(
      'Hi Jane, settlement takes 4 minutes for cross-border payouts and costs 0.2% per transfer.',
    );
    const result = await composeReply(model, INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('failed_checks');
    expect(model.calls).toHaveLength(2);
  });

  test('nothing to answer means no draft and no model call', async () => {
    const model = new StubModel('anything');
    const result = await composeReply(model, { ...INPUT, inbound: { body: '> quoted only' } });
    expect(result.ok).toBe(false);
    expect(model.calls).toHaveLength(0);
  });
});
