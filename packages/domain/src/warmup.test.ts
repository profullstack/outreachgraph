import { describe, expect, test } from 'bun:test';
import {
  composeWarmup,
  composeWarmupReply,
  inboxPlacement,
  newWarmupTag,
  pickWarmupPeer,
  warmupNetworkDay,
  warmupNetworkTarget,
  warmupSendDue,
  warmupShouldReply,
} from './warmup';

function seq(...values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length]!;
}

describe('volume', () => {
  test('ramps from 2 by 2 and holds at 20', () => {
    expect(warmupNetworkTarget(0)).toBe(2);
    expect(warmupNetworkTarget(4)).toBe(10);
    expect(warmupNetworkTarget(30)).toBe(20);
  });

  test('counts UTC calendar days', () => {
    expect(warmupNetworkDay('2026-10-06T23:00:00Z', new Date('2026-10-07T01:00:00Z'))).toBe(1);
    expect(warmupNetworkDay('2026-10-06T01:00:00Z', new Date('2026-10-06T23:00:00Z'))).toBe(0);
  });

  test('spreads the day’s sends out', () => {
    const at = new Date('2026-10-06T12:00:00Z');
    expect(warmupSendDue({ sentToday: 0, target: 4, lastSentAt: null, at, random: 0.5 })).toBe(
      true,
    );
    expect(warmupSendDue({ sentToday: 4, target: 4, lastSentAt: null, at, random: 0.5 })).toBe(
      false,
    );
    // 16h / 4 = 4h gap at random 0.5; one hour is too soon, five is not.
    expect(
      warmupSendDue({
        sentToday: 1,
        target: 4,
        lastSentAt: '2026-10-06T11:00:00Z',
        at,
        random: 0.5,
      }),
    ).toBe(false);
    expect(
      warmupSendDue({
        sentToday: 1,
        target: 4,
        lastSentAt: '2026-10-06T07:00:00Z',
        at,
        random: 0.5,
      }),
    ).toBe(true);
  });
});

describe('pickWarmupPeer', () => {
  const self = { id: 'a', email: 'ana@acme.com' };

  test('never picks itself, prefers another domain, then the least written to', () => {
    const peers = [
      { id: 'a', email: 'ana@acme.com', sentToPeerToday: 0 },
      { id: 'b', email: 'bo@acme.com', sentToPeerToday: 0 },
      { id: 'c', email: 'cy@other.io', sentToPeerToday: 2 },
      { id: 'd', email: 'di@third.dev', sentToPeerToday: 1 },
    ];
    expect(pickWarmupPeer(self, peers, 0)?.id).toBe('d');
  });

  test('falls back to the same domain, and to nobody', () => {
    expect(
      pickWarmupPeer(self, [{ id: 'b', email: 'bo@acme.com', sentToPeerToday: 0 }], 0)?.id,
    ).toBe('b');
    expect(pickWarmupPeer(self, [{ ...self, sentToPeerToday: 0 }], 0)).toBeUndefined();
  });
});

describe('content', () => {
  test('a first message greets, asks, signs and ends with the recipient’s tag', () => {
    const message = composeWarmup({
      recipientName: 'Jane Doe',
      senderName: 'Anthony Ettinger',
      recipientTag: 'ogk7q3xz',
      random: seq(0, 0.5, 0.2, 0.7, 0.1),
    });
    expect(message.text.startsWith('Hi Jane,')).toBe(true);
    expect(message.text).toContain('Anthony');
    expect(message.text.trim().split('\n').at(-1)).toBe('ogk7q3xz');
  });

  test('a reply threads its subject once', () => {
    const reply = composeWarmupReply({
      subject: 'Re: Checking in',
      recipientTag: 'ogaaaaaa',
      random: seq(0.3),
    });
    expect(reply.subject).toBe('Re: Checking in');
    expect(
      composeWarmupReply({ subject: 'Thoughts?', recipientTag: 't', random: seq(0) }).subject,
    ).toBe('Re: Thoughts?');
  });

  test('tags are og plus six unambiguous characters', () => {
    expect(newWarmupTag(seq(0, 0.99, 0.5))).toMatch(/^og[a-z2-9]{6}$/);
  });
});

describe('replies and placement', () => {
  test('answers first messages more often than replies, and never deep threads', () => {
    expect(warmupShouldReply(0, 0.4)).toBe(true);
    expect(warmupShouldReply(1, 0.4)).toBe(false);
    expect(warmupShouldReply(2, 0)).toBe(false);
  });

  test('placement is inbox over all seen', () => {
    expect(inboxPlacement(9, 1)).toBe(0.9);
    expect(inboxPlacement(0, 0)).toBeNull();
  });
});
