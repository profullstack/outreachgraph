import { describe, expect, test } from 'bun:test';
import { FeedRateLimitError } from './source';
import { suggestSubreddits } from './subreddit-search';

interface Community {
  display_name: string;
  title?: string;
  public_description?: string;
  subscribers?: number;
  over18?: boolean;
  subreddit_type?: string;
  quarantine?: boolean;
}

function listing(communities: Community[]): Response {
  return new Response(
    JSON.stringify({ data: { children: communities.map((c) => ({ data: c })) } }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  );
}

describe('suggestSubreddits', () => {
  test('turns campaign keywords into real communities', async () => {
    const fetchImpl = async () =>
      listing([
        { display_name: 'Plumbing', title: 'Plumbing', subscribers: 120_000 },
        { display_name: 'HVAC', title: 'HVAC', subscribers: 90_000 },
      ]);

    const suggestions = await suggestSubreddits(['scheduling software'], { fetchImpl });

    expect(suggestions.map((s) => s.name)).toEqual(['Plumbing', 'HVAC']);
    // Stored form, not display form: `r/` prefixes do not belong in targeting.
    expect(suggestions[0]?.url).toBe('https://www.reddit.com/r/Plumbing');
  });

  test('a community matching two terms outranks a bigger one matching one', async () => {
    const fetchImpl = async (url: string | URL | Request) => {
      const target = url instanceof Request ? url.url : url.toString();
      const term = new URL(target).searchParams.get('q');
      return term === 'plumbing'
        ? listing([
            { display_name: 'Plumbing', subscribers: 1_000 },
            { display_name: 'BigGeneral', subscribers: 2_000_000 },
          ])
        : listing([{ display_name: 'Plumbing', subscribers: 1_000 }]);
    };

    const suggestions = await suggestSubreddits(['plumbing', 'scheduling'], { fetchImpl });

    // Breadth of match beats size: a small community that matches the whole
    // campaign is a better target than a huge one that matched a single word.
    expect(suggestions[0]?.name).toBe('Plumbing');
    expect(suggestions[0]?.matchedTerms).toHaveLength(2);
  });

  test('leaves out communities that cannot be searched or should not be', async () => {
    const fetchImpl = async () =>
      listing([
        { display_name: 'Private', subscribers: 50_000, subreddit_type: 'private' },
        { display_name: 'Adult', subscribers: 50_000, over18: true },
        { display_name: 'Quarantined', subscribers: 50_000, quarantine: true },
        { display_name: 'Ghost', subscribers: 3 },
        { display_name: 'Good', subscribers: 5_000 },
      ]);

    const suggestions = await suggestSubreddits(['plumbing'], { fetchImpl });

    // A private community returns an empty listing rather than an error, so
    // suggesting one produces targeting that silently finds nothing.
    expect(suggestions.map((s) => s.name)).toEqual(['Good']);
  });

  test('a rate limit is raised, not silently returned as no matches', async () => {
    const fetchImpl = async () => new Response('', { status: 429 });

    const thrown = await suggestSubreddits(['plumbing'], { fetchImpl })
      .then(() => undefined)
      .catch((error: unknown) => error);

    // "Reddit would not answer" and "there are no communities" must not look
    // the same to the operator choosing where to listen.
    expect(thrown).toBeInstanceOf(FeedRateLimitError);
  });

  test('short and empty terms are not searched for', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return listing([]);
    };

    expect(await suggestSubreddits(['ai', ' '], { fetchImpl })).toEqual([]);
    expect(calls).toBe(0);
  });
});
