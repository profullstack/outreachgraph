/**
 * The deterministic reply rules.
 *
 * Two directions of error, and the tests lean on the expensive one: a person
 * mislabelled as a robot is a prospect we keep mailing after they answered, or
 * a customer who asked to stop and did not. Most cases below are about what a
 * rule must *not* claim.
 */

import { describe, expect, test } from 'bun:test';
import { classifyReplyByRules, newReplyText, replySubject } from './replies';

describe('out of office', () => {
  test('the header verdict wins', () => {
    const result = classifyReplyByRules({ subject: 'Re: payouts', automated: 'auto_reply' });
    expect(result?.label).toBe('out_of_office');
    expect(result?.source).toBe('rule');
  });

  test('an autoresponder subject', () => {
    for (const subject of [
      'Automatic reply: Cross-border payouts',
      'Out of Office: Cross-border payouts',
      'Autoreply: hello',
      'Auto: hello',
    ]) {
      expect(classifyReplyByRules({ subject, body: 'Thanks' })?.label).toBe('out_of_office');
    }
  });

  test('a short absence notice with no subject clue', () => {
    const result = classifyReplyByRules({
      subject: 'Re: payouts',
      body: "I'm currently out of the office and will be back on 14 September.",
    });
    expect(result?.label).toBe('out_of_office');
    expect(result?.confidence).toBeLessThan(1);
  });

  test('a person mentioning an absence and asking something is not an autoresponder', () => {
    const result = classifyReplyByRules({
      subject: 'Re: payouts',
      body: "I'm on leave next week, but could you send pricing before then?",
    });
    expect(result).toBeUndefined();
  });

  test('a question about an absence in the subject is not one', () => {
    expect(
      classifyReplyByRules({ subject: 'Re: out of office next week?', body: 'Sure' }),
    ).toBeUndefined();
  });
});

describe('bounces', () => {
  test('the header verdict', () => {
    expect(classifyReplyByRules({ automated: 'bounce' })?.label).toBe('bounce');
  });

  test('a DSN subject', () => {
    expect(
      classifyReplyByRules({ subject: 'Undeliverable: Cross-border payouts', body: '' })?.label,
    ).toBe('bounce');
    expect(classifyReplyByRules({ subject: 'Delivery Status Notification (Failure)' })?.label).toBe(
      'bounce',
    );
  });

  test('a DSN body', () => {
    const result = classifyReplyByRules({
      subject: 'Returned',
      body: 'Your message could not be delivered.\nFinal-Recipient: rfc822; jane@acme.com\nStatus: 5.1.1',
    });
    expect(result?.label).toBe('bounce');
  });
});

describe('unsubscribe requests', () => {
  test('explicit requests addressed to us', () => {
    for (const body of [
      'Please remove me from your list.',
      'Stop emailing me.',
      "Don't contact me again",
      'Take me off this',
      'unsubscribe',
      'Unsubscribe please',
      'Opt me out, thanks',
    ]) {
      expect(classifyReplyByRules({ subject: 'Re: payouts', body })?.label).toBe(
        'unsubscribe_request',
      );
    }
  });

  test('our own quoted footer is not their request', () => {
    const body = [
      'Sounds interesting, send me the pricing.',
      '',
      'On Tue, 2 Sep 2026 at 10:00, Ada <ada@examplepay.com> wrote:',
      '> Hi Jane',
      '> --',
      "> Don't want these? Unsubscribe: https://og.test/u/abc",
    ].join('\n');
    expect(classifyReplyByRules({ subject: 'Re: payouts', body })).toBeUndefined();
  });

  test('the word appearing in a question does not suppress anyone', () => {
    expect(
      classifyReplyByRules({
        subject: 'Re: payouts',
        body: 'How do your customers let their users unsubscribe from payout notices?',
      }),
    ).toBeUndefined();
  });
});

describe('everything else is left to the model', () => {
  test('an interested reply matches no rule', () => {
    expect(
      classifyReplyByRules({ subject: 'Re: payouts', body: 'Sure, tell me more.' }),
    ).toBeUndefined();
  });
});

describe('newReplyText', () => {
  test('drops quoted lines and everything after the attribution', () => {
    expect(newReplyText('Yes please\n\n> earlier\nOn Mon, Ada wrote:\nold')).toBe('Yes please');
  });

  test('stops at an Outlook separator', () => {
    expect(newReplyText('Yes\n-----Original Message-----\nFrom: us')).toBe('Yes');
  });
});

describe('replySubject', () => {
  test('adds one Re: and never two', () => {
    expect(replySubject('Payouts')).toBe('Re: Payouts');
    expect(replySubject('RE: Payouts')).toBe('RE: Payouts');
    expect(replySubject(null)).toBe('Re: Following up');
  });
});
