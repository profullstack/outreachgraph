import { describe, expect, test } from 'bun:test';

import {
  parseFediverseHandle,
  parseFediverseUrl,
  verifyFediverseAccount,
  type FediverseAccount,
} from './fediverse';

describe('parseFediverseUrl', () => {
  test('reads a local profile', () => {
    expect(parseFediverseUrl('https://fosstodon.org/@kev')).toMatchObject({
      user: 'kev',
      host: 'fosstodon.org',
      acct: 'kev@fosstodon.org',
      profileUrl: 'https://fosstodon.org/@kev',
    });
  });

  test('a remote view belongs to the account host, not the viewing host', () => {
    const account = parseFediverseUrl('https://defcon.social/@b0rk@jvns.ca');

    // The whole point: defcon.social is only rendering it.
    expect(account?.acct).toBe('b0rk@jvns.ca');
    expect(account?.host).toBe('jvns.ca');
    expect(account?.profileUrl).toBe('https://jvns.ca/@b0rk');
    expect(account?.viewedVia).toBe('defcon.social');
  });

  test('a local profile has no viewedVia', () => {
    expect(parseFediverseUrl('https://jvns.ca/@b0rk')?.viewedVia).toBeUndefined();
  });

  test('reads the canonical actor URL form', () => {
    expect(parseFediverseUrl('https://hachyderm.io/users/nova')).toMatchObject({
      acct: 'nova@hachyderm.io',
      profileUrl: 'https://hachyderm.io/@nova',
    });
  });

  test('ignores hosts that use /@name for their own users', () => {
    expect(parseFediverseUrl('https://medium.com/@someone')).toBeUndefined();
    expect(parseFediverseUrl('https://www.youtube.com/@somechannel')).toBeUndefined();
    expect(parseFediverseUrl('https://tiktok.com/@someone')).toBeUndefined();
  });

  test('ignores pages that are not profiles', () => {
    expect(parseFediverseUrl('https://fosstodon.org/about')).toBeUndefined();
    expect(parseFediverseUrl('https://example.com/')).toBeUndefined();
    expect(parseFediverseUrl('not a url')).toBeUndefined();
  });

  test('rejects a host with no dot', () => {
    expect(parseFediverseUrl('https://localhost/@kev')).toBeUndefined();
  });
});

describe('parseFediverseHandle', () => {
  test('reads a written-out address', () => {
    expect(parseFediverseHandle('@b0rk@jvns.ca')).toMatchObject({ acct: 'b0rk@jvns.ca' });
  });

  test('leaves a bare email address alone', () => {
    // Ambiguous by shape, and far more likely to be email.
    expect(parseFediverseHandle('someone@example.com')).toBeUndefined();
  });

  test('rejects a single-part handle', () => {
    expect(parseFediverseHandle('@justaname')).toBeUndefined();
  });
});

const ACCOUNT: FediverseAccount = {
  user: 'b0rk',
  host: 'jvns.ca',
  acct: 'b0rk@jvns.ca',
  profileUrl: 'https://jvns.ca/@b0rk',
};

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/jrd+json' },
  });
}

describe('verifyFediverseAccount', () => {
  test('confirms an account its own host acknowledges', async () => {
    let requested = '';
    const verified = await verifyFediverseAccount(ACCOUNT, {
      fetchImpl: async (input) => {
        requested = String(input);
        return respond({
          subject: 'acct:b0rk@jvns.ca',
          links: [
            { rel: 'self', type: 'application/activity+json', href: 'https://jvns.ca/users/b0rk' },
          ],
        });
      },
    });

    expect(verified?.actorUrl).toBe('https://jvns.ca/users/b0rk');
    // Asks the account's host, never the host we happened to see it on.
    expect(requested).toContain('https://jvns.ca/.well-known/webfinger');
    expect(requested).toContain('acct%3Ab0rk%40jvns.ca');
  });

  test('rejects a host that answers about somebody else', async () => {
    const verified = await verifyFediverseAccount(ACCOUNT, {
      fetchImpl: async () =>
        respond({
          subject: 'acct:someoneelse@jvns.ca',
          links: [{ rel: 'self', type: 'application/activity+json', href: 'https://jvns.ca/x' }],
        }),
    });

    expect(verified).toBeUndefined();
  });

  test('rejects a host with no ActivityPub actor', async () => {
    const verified = await verifyFediverseAccount(ACCOUNT, {
      fetchImpl: async () => respond({ subject: 'acct:b0rk@jvns.ca', links: [] }),
    });

    expect(verified).toBeUndefined();
  });

  test('an unreachable host is not evidence either way', async () => {
    const verified = await verifyFediverseAccount(ACCOUNT, {
      fetchImpl: async () => {
        throw new Error('connection refused');
      },
    });

    expect(verified).toBeUndefined();
  });

  test('a 404 is not a verification', async () => {
    const verified = await verifyFediverseAccount(ACCOUNT, {
      fetchImpl: async () => respond({}, 404),
    });

    expect(verified).toBeUndefined();
  });
});
