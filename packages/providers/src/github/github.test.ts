import { describe, expect, test } from 'bun:test';
import { resolveIdentity } from '@outreachgraph/identity';
import {
  GitHubNotFoundError,
  GitHubRateLimitError,
  type GitHubEvent,
  type GitHubRepo,
} from './client';
import { cleanCompany, domainOf, GitHubProvider, toCandidate } from './provider';
import { extractSignals } from './signals';

/** A real profile payload, trimmed to the fields the adapter reads. */
const USER = {
  login: 'janesmith',
  id: 27381,
  name: 'Jane Smith',
  company: '@Acme',
  blog: 'https://jane.dev',
  location: 'San Francisco, CA',
  email: null,
  bio: 'Payments infrastructure',
  twitter_username: 'janesmith',
  public_repos: 42,
  followers: 900,
  html_url: 'https://github.com/janesmith',
  created_at: '2012-01-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

/** Builds a fetch stub that serves canned responses by path suffix. */
function stubFetch(routes: Record<string, unknown>, status = 200): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const match = Object.keys(routes).find((key) => url.includes(key));

    if (!match) {
      return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return new Response(JSON.stringify(routes[match]), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

describe('profile mapping', () => {
  test('turns self-declared profile fields into linked identities', () => {
    const candidate = toCandidate(USER as never);

    const networks = candidate.identities.map((i) => i.network);
    expect(networks).toContain('github');
    // These are the whole point: the person published them themselves.
    expect(networks).toContain('x');
    expect(networks).toContain('website');

    expect(candidate.identities.find((i) => i.network === 'x')?.handle).toBe('janesmith');
    expect(candidate.personalDomain).toBe('jane.dev');
  });

  test('keeps the stable numeric id, not just the renameable handle', () => {
    const candidate = toCandidate(USER as never);
    const github = candidate.identities.find((i) => i.network === 'github');

    expect(github?.platformUserId).toBe('27381');
  });

  test('strips the @ from a GitHub company field', () => {
    expect(cleanCompany('@Acme')).toBe('Acme');
    expect(cleanCompany('  Acme  Inc  ')).toBe('Acme Inc');
  });

  test('omits identities the profile does not declare', () => {
    const bare = toCandidate({ ...USER, twitter_username: null, blog: null } as never);

    expect(bare.identities.map((i) => i.network)).toEqual(['github']);
    expect(bare.personalDomain).toBeUndefined();
  });

  test('handles a blog field with no scheme', () => {
    expect(domainOf('jane.dev')).toBe('jane.dev');
    expect(domainOf('https://www.jane.dev/blog')).toBe('jane.dev');
    expect(domainOf('not a url at all')).toBeUndefined();
    expect(domainOf(null)).toBeUndefined();
  });

  test('falls back to the login when the profile has no name', () => {
    const candidate = toCandidate({ ...USER, name: null } as never);
    expect(candidate.fullName).toBe('janesmith');
  });
});

describe('enrichment', () => {
  test('an exact handle lookup is near-certain', async () => {
    const provider = new GitHubProvider({ fetchImpl: stubFetch({ '/users/janesmith': USER }) });
    const result = await provider.enrich({ handles: { github: 'janesmith' } });

    expect(result.matchConfidence).toBeGreaterThan(0.95);
    expect(result.candidate?.fullName).toBe('Jane Smith');
    expect(result.costUsd).toBe(0);
  });

  test('a missing profile is a miss, not an error', async () => {
    const provider = new GitHubProvider({ fetchImpl: stubFetch({}) });
    const result = await provider.enrich({ handles: { github: 'nobody' } });

    expect(result.candidate).toBeUndefined();
    expect(result.matchConfidence).toBe(0);
  });

  test('a name-only match scores too low to stop the waterfall', async () => {
    const provider = new GitHubProvider({
      fetchImpl: stubFetch({
        '/search/users': { items: [{ login: 'janesmith' }] },
        '/users/janesmith': USER,
      }),
    });

    const result = await provider.enrich({ fullName: 'Jane Smith' });

    // Below the 0.9 default target, so the waterfall keeps looking.
    expect(result.matchConfidence).toBeLessThan(0.9);
    expect(result.matchConfidence).toBeGreaterThan(0);
  });

  test('a corroborating employer raises a name match', async () => {
    const provider = new GitHubProvider({
      fetchImpl: stubFetch({
        '/search/users': { items: [{ login: 'janesmith' }] },
        '/users/janesmith': USER,
      }),
    });

    const bare = await provider.enrich({ fullName: 'Jane Smith' });
    const corroborated = await provider.enrich({ fullName: 'Jane Smith', companyName: 'Acme' });

    expect(corroborated.matchConfidence).toBeGreaterThan(bare.matchConfidence);
  });

  test('is free, so the waterfall consults it first', () => {
    expect(new GitHubProvider().capabilities().costPerEnrichmentUsd).toBe(0);
  });
});

describe('rate limiting', () => {
  test('distinguishes quota exhaustion from an ordinary failure', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"rate limit"}', {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        },
      })) as unknown as typeof fetch;

    const provider = new GitHubProvider({ fetchImpl });

    await expect(provider.enrich({ handles: { github: 'janesmith' } })).rejects.toBeInstanceOf(
      GitHubRateLimitError,
    );
  });

  test('a plain 403 is not treated as a rate limit', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"forbidden"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '58' },
      })) as unknown as typeof fetch;

    const provider = new GitHubProvider({ fetchImpl });
    const error = await provider.enrich({ handles: { github: 'janesmith' } }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(GitHubRateLimitError);
    expect(error).not.toBeInstanceOf(GitHubNotFoundError);
  });
});

describe('identity evidence from a GitHub profile', () => {
  test('a declared X handle plus employer supports a merge', () => {
    const candidate = toCandidate(USER as never);
    const x = candidate.identities.find((i) => i.network === 'x')!;

    const resolution = resolveIdentity([
      { kind: 'provider_asserted_link', strength: x.providerConfidence ?? 0.9 },
      { kind: 'cross_linked_profile', strength: 1 },
      { kind: 'same_employer', strength: 1 },
    ]);

    expect(resolution.decision).toBe('merge');
  });

  test('a provider assertion alone stays in the review band', () => {
    const resolution = resolveIdentity([{ kind: 'provider_asserted_link', strength: 0.9 }]);
    expect(resolution.decision).toBe('candidate');
  });
});

describe('signal extraction', () => {
  const at = '2026-08-10T12:00:00Z';

  function event(type: string, payload: Record<string, unknown>): GitHubEvent {
    return { id: '1', type, created_at: at, repo: { id: 1, name: 'acme/api', url: '' }, payload };
  }

  test('a new repository is a project start', () => {
    const signals = extractSignals([event('CreateEvent', { ref_type: 'repository' })], []);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.type).toBe('project_start');
  });

  test('branch creation is ignored as noise', () => {
    expect(extractSignals([event('CreateEvent', { ref_type: 'branch' })], [])).toHaveLength(0);
  });

  test('pushes are ignored — high volume, low information', () => {
    expect(extractSignals([event('PushEvent', { ref: 'refs/heads/main' })], [])).toHaveLength(0);
  });

  test('a release is a launch', () => {
    const signals = extractSignals(
      [event('ReleaseEvent', { release: { name: 'v2.0', html_url: 'https://x', body: 'notes' } })],
      [],
    );

    expect(signals[0]?.type).toBe('launch');
    expect(signals[0]?.evidence).toBe('notes');
  });

  test('an issue asking for a recommendation is a public question', () => {
    const signals = extractSignals(
      [
        event('IssuesEvent', {
          action: 'opened',
          issue: { title: 'Anyone know a good alternative for payouts?', html_url: 'https://x' },
        }),
      ],
      [],
    );

    expect(signals[0]?.type).toBe('public_question');
    // The person's own words, so a reply can quote them.
    expect(signals[0]?.evidence).toContain('alternative');
  });

  test('an issue describing a failure is pain', () => {
    const signals = extractSignals(
      [
        event('IssuesEvent', {
          action: 'opened',
          issue: { title: 'Webhook delivery keeps failing under load', body: 'times out' },
        }),
      ],
      [],
    );

    expect(signals[0]?.type).toBe('pain');
    expect(signals[0]?.sentiment).toBe('negative');
  });

  test('a competitor mention outranks the generic classification', () => {
    const signals = extractSignals(
      [
        event('IssuesEvent', {
          action: 'opened',
          issue: { title: 'Stripe fees are killing us on cross-border' },
        }),
      ],
      [],
      { competitors: ['Stripe'] },
    );

    expect(signals[0]?.type).toBe('competitor_mention');
    expect(signals[0]?.subtype).toBe('Stripe');
  });

  test('a closed issue produces nothing', () => {
    const signals = extractSignals(
      [event('IssuesEvent', { action: 'closed', issue: { title: 'done' } })],
      [],
    );
    expect(signals).toHaveLength(0);
  });

  test('a repository using a campaign technology is technology adoption', () => {
    const repo: GitHubRepo = {
      name: 'payments-api',
      full_name: 'acme/payments-api',
      html_url: 'https://github.com/acme/payments-api',
      description: 'billing service',
      language: 'TypeScript',
      topics: ['nextjs'],
      fork: false,
      stargazers_count: 3,
      created_at: at,
      pushed_at: at,
    };

    const signals = extractSignals([], [repo], { technologies: ['Next.js', 'nextjs'] });

    expect(signals[0]?.type).toBe('technology_adoption');
    expect(signals[0]?.relevance).toBeGreaterThan(0.8);
  });

  test('forks are ignored — they describe someone else’s choices', () => {
    const repo: GitHubRepo = {
      name: 'forked',
      full_name: 'acme/forked',
      html_url: '',
      description: null,
      language: 'TypeScript',
      topics: ['nextjs'],
      fork: true,
      stargazers_count: 0,
      created_at: at,
      pushed_at: at,
    };

    expect(extractSignals([], [repo], { technologies: ['nextjs'] })).toHaveLength(0);
  });

  test('off-topic activity scores low relevance rather than vanishing', () => {
    const signals = extractSignals([event('CreateEvent', { ref_type: 'repository' })], [], {
      technologies: ['rust'],
      keywords: ['payments'],
    });

    expect(signals[0]?.relevance).toBeLessThan(0.3);
    expect(signals[0]?.relevance).toBeGreaterThan(0);
  });

  test('returns signals newest first', () => {
    const older: GitHubEvent = {
      id: '2',
      type: 'CreateEvent',
      created_at: '2026-08-01T00:00:00Z',
      repo: { id: 2, name: 'acme/old', url: '' },
      payload: { ref_type: 'repository' },
    };

    const signals = extractSignals([older, event('CreateEvent', { ref_type: 'repository' })], []);
    expect(signals[0]?.sourceTimestamp).toBe(at);
  });
});
