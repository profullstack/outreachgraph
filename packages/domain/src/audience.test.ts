import { describe, expect, test } from 'bun:test';
import {
  AUDIENCE_KINDS,
  engagementKey,
  engagementSummary,
  excerptOf,
  isDue,
  modesFor,
  normaliseAccount,
  parseAudienceWatch,
  relevanceFor,
} from './audience';
import { isHighIntentSignal, isSignalType } from './signal';

describe('normaliseAccount', () => {
  test('takes a handle however it was pasted', () => {
    for (const raw of [
      'acme.bsky.social',
      '@acme.bsky.social',
      'https://bsky.app/profile/acme.bsky.social',
    ]) {
      expect(normaliseAccount('bluesky', raw)).toBe('acme.bsky.social');
    }
    expect(normaliseAccount('x', 'https://x.com/Acme')).toBe('acme');
    expect(normaliseAccount('linkedin', 'https://www.linkedin.com/in/acme-co/')).toBe('acme-co');
  });

  test('keeps a DID on Bluesky and refuses it elsewhere', () => {
    expect(normaliseAccount('bluesky', 'did:plc:abc123')).toBe('did:plc:abc123');
    expect(normaliseAccount('x', 'did:plc:abc123')).toBeUndefined();
  });

  test('refuses what is not a handle', () => {
    expect(normaliseAccount('x', '')).toBeUndefined();
    expect(normaliseAccount('x', 'two words')).toBeUndefined();
    expect(normaliseAccount('x', 'a'.repeat(201))).toBeUndefined();
  });
});

describe('parseAudienceWatch', () => {
  const base = { network: 'bluesky', account: '@acme.bsky.social', campaignId: 'cmp_1' };

  test('defaults every knob and every kind', () => {
    const spec = parseAudienceWatch(base);
    expect(spec).not.toHaveProperty('reason');
    if ('reason' in spec) throw new Error(spec.reason);

    expect(spec.account).toBe('acme.bsky.social');
    expect(spec.kinds).toEqual([...AUDIENCE_KINDS]);
    expect(spec.mode).toBe('poll');
    expect(spec.enabled).toBe(true);
    expect(spec.pollMinutes).toBeGreaterThan(0);
  });

  test('clamps the knobs rather than rejecting them', () => {
    const spec = parseAudienceWatch({ ...base, pollMinutes: 1, lookbackPosts: 9999, perRunCap: 0 });
    if ('reason' in spec) throw new Error(spec.reason);

    expect(spec.pollMinutes).toBe(5);
    expect(spec.lookbackPosts).toBe(50);
    expect(spec.perRunCap).toBe(1);
  });

  test('keeps only recognised kinds', () => {
    const spec = parseAudienceWatch({ ...base, kinds: ['like', 'nonsense', 'LIKE', 'reply'] });
    if ('reason' in spec) throw new Error(spec.reason);
    expect(spec.kinds).toEqual(['like', 'reply']);
  });

  test('a kinds list of pure nonsense is a refusal, not a silent default', () => {
    expect(parseAudienceWatch({ ...base, kinds: ['nonsense'] })).toEqual({
      reason: 'no recognised engagement kinds',
    });
  });

  test('refuses a campaign-less watch and an unknown network', () => {
    expect(parseAudienceWatch({ ...base, campaignId: '' })).toHaveProperty('reason');
    expect(parseAudienceWatch({ ...base, network: 'facebook' })).toHaveProperty('reason');
  });

  test('LinkedIn can only be a hand-off', () => {
    expect(modesFor('linkedin')).toEqual(['handoff']);

    const asked = parseAudienceWatch({
      ...base,
      network: 'linkedin',
      account: 'acme-co',
      mode: 'poll',
    });
    expect(asked).toEqual({ reason: 'linkedin watches can only be handoff' });

    const defaulted = parseAudienceWatch({ ...base, network: 'linkedin', account: 'acme-co' });
    if ('reason' in defaulted) throw new Error(defaulted.reason);
    expect(defaulted.mode).toBe('handoff');
  });
});

describe('engagementSummary', () => {
  test('names who did what, and quotes the post', () => {
    expect(
      engagementSummary({
        kind: 'repost',
        actor: '@dana',
        account: 'acme',
        subjectText: 'We shipped deterministic policy checks today.',
      }),
    ).toBe('@dana reposted @acme\'s post: "We shipped deterministic policy checks today."');
  });

  test('a follow has no post to quote', () => {
    expect(engagementSummary({ kind: 'follow', actor: 'dana', account: 'acme' })).toBe(
      '@dana followed @acme',
    );
  });

  test('falls back when the post text never arrived', () => {
    expect(engagementSummary({ kind: 'like', actor: 'dana', account: 'acme' })).toBe(
      '@dana liked a post by @acme',
    );
  });
});

describe('excerptOf', () => {
  test('collapses whitespace and leaves short text alone', () => {
    expect(excerptOf('  one   two\nthree ')).toBe('one two three');
  });

  test('cuts on a word boundary', () => {
    const excerpt = excerptOf('alpha beta gamma delta epsilon', 14);
    expect(excerpt).toBe('alpha beta…');
  });
});

describe('engagementKey', () => {
  test('the same act twice is one key, whatever the case', () => {
    expect(engagementKey({ kind: 'like', actor: '@Dana', subject: 'AT://post/1' })).toBe(
      engagementKey({ kind: 'like', actor: 'dana', subject: 'at://post/1' }),
    );
  });

  test('different acts on the same post are different keys', () => {
    expect(engagementKey({ kind: 'like', actor: 'dana', subject: 'p1' })).not.toBe(
      engagementKey({ kind: 'repost', actor: 'dana', subject: 'p1' }),
    );
  });
});

describe('relevance', () => {
  test('effort orders the weights', () => {
    expect(relevanceFor('follow')).toBeLessThan(relevanceFor('like'));
    expect(relevanceFor('like')).toBeLessThan(relevanceFor('repost'));
    expect(relevanceFor('repost')).toBeLessThan(relevanceFor('reply'));
  });
});

describe('isDue', () => {
  const at = new Date('2026-09-24T12:00:00.000Z');
  const watch = { pollMinutes: 30, enabled: true, mode: 'poll' } as const;

  test('never polled is due', () => {
    expect(isDue(watch, null, at)).toBe(true);
  });

  test('due once the interval has elapsed', () => {
    expect(isDue(watch, '2026-09-24T11:45:00.000Z', at)).toBe(false);
    expect(isDue(watch, '2026-09-24T11:30:00.000Z', at)).toBe(true);
  });

  test('disabled and hand-off watches are never due', () => {
    expect(isDue({ ...watch, enabled: false }, null, at)).toBe(false);
    expect(isDue({ ...watch, mode: 'handoff' }, null, at)).toBe(false);
  });

  test('a corrupt stamp holds rather than polling forever', () => {
    expect(isDue(watch, 'not a date', at)).toBe(false);
  });
});

describe('the signal type', () => {
  test('exists and decays fast', () => {
    expect(isSignalType('audience_engagement')).toBe(true);
    expect(isHighIntentSignal('audience_engagement')).toBe(true);
  });
});
