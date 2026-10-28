/**
 * Signing and Slack formatting. The signing tests hold both halves
 * to the same scheme, so a receiver written from the docs verifies what the
 * sender produces.
 */

import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { OutboundEvent } from '@outreachgraph/domain';
import { newWebhookSecret, signWebhook, verifyWebhookSignature } from './sign';
import { formatSlackMessage } from './slack';

describe('signing', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"reply.received"}';

  test('is Stripe-shaped: HMAC-SHA256 over "t.body", hex', () => {
    const header = signWebhook(secret, body, 1_700_000_000);
    const expected = createHmac('sha256', secret).update(`1700000000.${body}`).digest('hex');
    expect(header).toBe(`t=1700000000,v1=${expected}`);
  });

  test('verifies its own signature', () => {
    const header = signWebhook(secret, body, 1_700_000_000);
    expect(verifyWebhookSignature(secret, body, header, { now: 1_700_000_010 })).toBe(true);
  });

  test('rejects a changed body, a wrong secret and a stale timestamp', () => {
    const header = signWebhook(secret, body, 1_700_000_000);
    const opts = { now: 1_700_000_010 };
    expect(verifyWebhookSignature(secret, `${body} `, header, opts)).toBe(false);
    expect(verifyWebhookSignature('whsec_other', body, header, opts)).toBe(false);
    expect(verifyWebhookSignature(secret, body, header, { now: 1_700_001_000 })).toBe(false);
    expect(verifyWebhookSignature(secret, body, undefined, opts)).toBe(false);
    expect(verifyWebhookSignature(secret, body, 'v1=abc', opts)).toBe(false);
  });

  test('secrets are fresh and recognisable', () => {
    const a = newWebhookSecret();
    expect(a.startsWith('whsec_')).toBe(true);
    expect(a.length).toBeGreaterThan(40);
    expect(newWebhookSecret()).not.toBe(a);
  });
});

function event(type: OutboundEvent['type'], data: Record<string, unknown> = {}): OutboundEvent {
  return {
    id: 'evt_1',
    type,
    createdAt: '2026-09-24T00:00:00.000Z',
    workspaceId: 'wsp_1',
    data: {
      person: { id: 'per_1', name: 'Jane <Smith>', title: 'CTO', company: 'Acme & Co' },
      ...data,
    },
  };
}

describe('formatSlackMessage', () => {
  test('a reply names the person, their role and the subject', () => {
    const message = formatSlackMessage(event('reply.received', { subject: 'Re: pricing' }));
    expect(message.text).toContain('*Jane &lt;Smith&gt;* (CTO, Acme &amp; Co) replied');
    expect(message.text).toContain('Re: pricing');
  });

  test('every event type has a line', () => {
    for (const type of [
      'reply.received',
      'link.clicked',
      'prospect.created',
      'recommendation.approved',
      'action.sent',
      'cadence.completed',
      'person.suppressed',
      'ping',
    ] as const) {
      const text = formatSlackMessage(event(type, { network: 'x', action: 'reply' })).text;
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toContain('{');
    }
  });

  test('uses network labels and readable action names', () => {
    const text = formatSlackMessage(
      event('recommendation.approved', { action: 'send_email', network: 'linkedin' }),
    ).text;
    expect(text).toContain('send email');
    expect(text).toContain('LinkedIn');
  });

  test('survives an event about nobody', () => {
    const text = formatSlackMessage({ ...event('cadence.completed'), data: {} }).text;
    expect(text).toContain('someone');
  });
});
