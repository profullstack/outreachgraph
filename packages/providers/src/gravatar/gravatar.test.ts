/**
 * Gravatar lookup.
 *
 * The hash tests are not ceremony. MD5 is hand-rolled here because
 * `crypto.subtle` refuses to provide it, and a subtly wrong implementation
 * fails in the worst possible way: every lookup returns 404, enrichment
 * reports a zero hit rate, and it looks exactly like "Gravatar just doesn't
 * have these people".
 */

import { describe, expect, test } from 'bun:test';
import { GRAVATAR_NETWORKS, gravatarHash, lookupGravatar } from './index';

describe('gravatarHash', () => {
  test('matches the published MD5 vectors', () => {
    // RFC 1321. If these drift, every lookup silently misses.
    expect(gravatarHash('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(gravatarHash('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(gravatarHash('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(gravatarHash('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(gravatarHash('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });

  test('matches a longer input that crosses a block boundary', () => {
    expect(
      gravatarHash(
        '12345678901234567890123456789012345678901234567890123456789012345678901234567890',
      ),
    ).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  test('normalises the way Gravatar specifies', () => {
    // Trimmed and lowercased, or the hash addresses nothing.
    const expected = gravatarHash('dave@example.com');

    expect(gravatarHash('  Dave@Example.COM  ')).toBe(expected);
  });
});

describe('lookupGravatar', () => {
  function respond(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  test('reads a profile into accounts we can act on', async () => {
    const profile = await lookupGravatar('dave@example.com', {
      fetchImpl: respond({
        entry: [
          {
            displayName: 'Dave Mackenzie',
            currentLocation: 'Glasgow',
            job_title: 'Staff Engineer',
            profileUrl: 'https://gravatar.com/dave',
            accounts: [
              { shortname: 'github', url: 'https://github.com/dave', username: 'dave' },
              { shortname: 'mastodon', url: 'https://fosstodon.org/@dave' },
            ],
            urls: [{ value: 'https://dave.dev' }],
          },
        ],
      }),
    });

    expect(profile?.displayName).toBe('Dave Mackenzie');
    expect(profile?.job).toBe('Staff Engineer');
    expect(profile?.accounts).toHaveLength(2);
    expect(profile?.accounts[0]).toMatchObject({ service: 'github', handle: 'dave' });
    expect(profile?.urls).toEqual(['https://dave.dev']);
  });

  test('a 404 is a normal answer, not an error', async () => {
    // The majority answer. It must be cheap.
    expect(
      await lookupGravatar('nobody@example.com', { fetchImpl: respond({}, 404) }),
    ).toBeUndefined();
  });

  test('an empty entry list is a miss', async () => {
    expect(
      await lookupGravatar('nobody@example.com', { fetchImpl: respond({ entry: [] }) }),
    ).toBeUndefined();
  });

  test('a network failure costs one person, not the run', async () => {
    const failing = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;

    expect(await lookupGravatar('dave@example.com', { fetchImpl: failing })).toBeUndefined();
  });

  test('malformed JSON is a miss rather than a throw', async () => {
    const garbage = (async () =>
      new Response('<html>nope', { status: 200 })) as unknown as typeof fetch;

    expect(await lookupGravatar('dave@example.com', { fetchImpl: garbage })).toBeUndefined();
  });

  test('accounts missing a url are dropped', async () => {
    const profile = await lookupGravatar('dave@example.com', {
      fetchImpl: respond({
        entry: [{ accounts: [{ shortname: 'github' }, { url: 'https://x.com/dave' }] }],
      }),
    });

    expect(profile?.accounts).toHaveLength(0);
  });
});

describe('GRAVATAR_NETWORKS', () => {
  test('maps twitter and x onto one network', () => {
    expect(GRAVATAR_NETWORKS.twitter).toBe('x');
    expect(GRAVATAR_NETWORKS.x).toBe('x');
  });
});
