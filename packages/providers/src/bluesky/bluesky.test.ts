import { describe, expect, test } from 'bun:test';
import { BlueskyProvider, BlueskyRateLimitError } from './provider';
import { findIdentities } from '../fan-out';
import type { PersonCandidate, PersonEnrichmentProvider } from '../provider';

function jsonFetch(status: number, body: unknown) {
  return async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

const PROFILE = {
  did: 'did:plc:abc123',
  handle: 'alex.bsky.social',
  displayName: 'Alex Chen',
  description: 'agent reliability',
};

describe('BlueskyProvider', () => {
  test('a known handle resolves to an identity carrying the stable did', async () => {
    const provider = new BlueskyProvider({ fetchImpl: jsonFetch(200, PROFILE) });

    const result = await provider.enrich({ handles: { bluesky: 'alex.bsky.social' } });

    expect(result.matchConfidence).toBe(1);
    expect(result.candidate?.fullName).toBe('Alex Chen');
    // The did, not the handle: handles on this network are renameable.
    expect(result.candidate?.identities[0]!.platformUserId).toBe('did:plc:abc123');
    expect(result.candidate?.identities[0]!.profileUrl).toContain('alex.bsky.social');
  });

  test('a name alone resolves to nothing', async () => {
    let called = false;
    const provider = new BlueskyProvider({
      fetchImpl: async () => {
        called = true;
        return new Response('{}', { status: 200 });
      },
    });

    const result = await provider.enrich({ fullName: 'Alex Chen' });

    // Taking the first search hit for a display name is how the wrong human
    // reaches an approval queue. Finding nobody is the correct answer.
    expect(result.matchConfidence).toBe(0);
    expect(called).toBe(false);
  });

  test('an unknown actor is an answer, not an error', async () => {
    const provider = new BlueskyProvider({
      fetchImpl: jsonFetch(400, { error: 'InvalidRequest' }),
    });

    const result = await provider.enrich({ handles: { bluesky: 'nobody.bsky.social' } });
    expect(result.candidate).toBeUndefined();
  });

  test('a quota wall is typed so callers can keep partial work', async () => {
    const provider = new BlueskyProvider({ fetchImpl: jsonFetch(429, {}) });

    await expect(
      provider.enrich({ handles: { bluesky: 'alex.bsky.social' } }),
    ).rejects.toBeInstanceOf(BlueskyRateLimitError);
  });

  test('search returns candidates for keywords', async () => {
    const provider = new BlueskyProvider({ fetchImpl: jsonFetch(200, { actors: [PROFILE] }) });

    const result = await provider.search({ keywords: ['agent reliability'] });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.identities[0]!.network).toBe('bluesky');
  });

  test('it reports itself as free, so the waterfall reaches it early', () => {
    expect(new BlueskyProvider().capabilities().costPerEnrichmentUsd).toBe(0);
  });
});

describe('findIdentities', () => {
  const BASE: PersonCandidate = {
    fullName: 'Alex Chen',
    identities: [{ network: 'github', handle: 'alexchen' }],
    observedAt: '2026-08-13T00:00:00.000Z',
  };

  function stub(
    slug: string,
    networks: readonly ('github' | 'bluesky')[],
    result: () => Promise<{
      candidate?: PersonCandidate;
      matchConfidence: number;
      costUsd: number;
    }>,
  ): PersonEnrichmentProvider {
    return {
      capabilities: () => ({
        slug,
        displayName: slug,
        networks,
        canSearch: false,
        canEnrich: true,
        licenseClass: 'public_api',
        sourceType: 'official_api',
        costPerEnrichmentUsd: 0,
      }),
      search: async () => ({ candidates: [], costUsd: 0 }),
      enrich: result,
      costEstimate: async () => 0,
    };
  }

  test('a provider is only asked about a network we already hold a handle for', async () => {
    let asked = false;
    const bluesky = stub('bluesky', ['bluesky'], async () => {
      asked = true;
      return { matchConfidence: 0, costUsd: 0 };
    });

    await findIdentities(BASE, [bluesky]);

    // The candidate has a GitHub handle and nothing else. Asking Bluesky to
    // find "Alex Chen" would be a guess, so it is not asked at all.
    expect(asked).toBe(false);
  });

  test('discovered identities are folded in without duplicating what we had', async () => {
    const candidate: PersonCandidate = {
      ...BASE,
      identities: [
        { network: 'github', handle: 'alexchen' },
        { network: 'bluesky', handle: 'alex.bsky.social' },
      ],
    };

    const provider = stub('bluesky', ['bluesky'], async () => ({
      candidate: {
        ...candidate,
        identities: [
          { network: 'bluesky', handle: 'alex.bsky.social', platformUserId: 'did:plc:abc' },
        ],
      },
      matchConfidence: 1,
      costUsd: 0,
    }));

    const result = await findIdentities(candidate, [provider]);

    // The returned identity keys on the did while ours keyed on the handle, so
    // both survive — the resolver, not the fan-out, decides they are one person.
    expect(result.attempts[0]!.found).toBe(1);
    expect(result.candidate.identities.length).toBeGreaterThanOrEqual(2);
  });

  test('one provider failing does not lose the others', async () => {
    const angry = stub('angry', ['github'], async () => {
      throw new Error('rate limited');
    });
    const calm = stub('calm', ['github'], async () => ({
      candidate: { ...BASE, identities: [{ network: 'bluesky', handle: 'found.bsky.social' }] },
      matchConfidence: 1,
      costUsd: 0,
    }));

    const result = await findIdentities(BASE, [angry, calm]);

    expect(result.attempts.find((a) => a.provider === 'angry')?.ok).toBe(false);
    expect(result.attempts.find((a) => a.provider === 'calm')?.found).toBe(1);
    expect(result.candidate.identities.map((i) => i.network)).toContain('bluesky');
  });

  test('with no providers the candidate is returned untouched', async () => {
    const result = await findIdentities(BASE, []);
    expect(result.candidate).toEqual(BASE);
    expect(result.attempts).toHaveLength(0);
  });
});
