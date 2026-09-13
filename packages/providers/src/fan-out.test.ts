import { describe, expect, test } from 'bun:test';
import { findIdentities } from './fan-out';
import { GitHubProvider } from './github/provider';
import type { PersonCandidate } from './provider';

const candidate: PersonCandidate = {
  fullName: 'Jane Smith',
  identities: [{ network: 'github', handle: 'janesmith' }],
  observedAt: '2026-09-13T00:00:00Z',
};

function github(login: string) {
  return new GitHubProvider({
    fetchImpl: (async () =>
      Response.json({
        login,
        id: 123,
        name: 'Jane Smith',
        html_url: `https://github.com/${login}`,
        avatar_url: 'https://avatars.githubusercontent.com/u/123?v=4',
      })) as unknown as typeof fetch,
  });
}

describe('enrichment portraits', () => {
  test('keeps a photo only when the response confirms a known account', async () => {
    const result = await findIdentities(candidate, [github('janesmith')]);
    expect(result.photo?.value.url).toBe('https://avatars.githubusercontent.com/u/123?v=4');
    expect(result.photo?.capabilities.slug).toBe('github');
    expect(result.photo?.capabilities.sourceType).toBe('official_api');
  });

  test('a different account with the same name cannot supply a portrait', async () => {
    expect((await findIdentities(candidate, [github('somebodyelse')])).photo).toBeUndefined();
  });

  test('a provider error leaves the original candidate usable', async () => {
    const provider = new GitHubProvider({
      fetchImpl: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
    });
    const result = await findIdentities(candidate, [provider]);
    expect(result.photo).toBeUndefined();
    expect(result.candidate.fullName).toBe(candidate.fullName);
    expect(result.attempts[0]?.ok).toBe(false);
  });
});
