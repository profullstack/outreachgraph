/**
 * OpenProfile assembly from pages and profiles, with no network.
 *
 * What has to hold: a page's OpenGraph card and rel=me links are read in
 * either attribute order; a plain link only counts when it names a network
 * we know; the Bluesky and Mastodon readers turn a public profile into the
 * same facts a page would; merging lets the most trusted source win and
 * never downgrades a `me` to a `link`; and the Markdown that comes out obeys
 * the spec's shape, one heading, an identity block, one headline line.
 */

import { describe, expect, test } from 'bun:test';
import {
  buildOpenProfile,
  extractProfilePage,
  hashtagsIn,
  mergeFacts,
  readBlueskyProfile,
  readMastodonProfile,
  readPublishedOpenProfile,
  urlsInText,
  wellKnownOpenProfile,
} from './openprofile';

const SITE = `<!doctype html><html><head>
<title>Ada Lovelace</title>
<meta content="Ada Lovelace" property="og:title">
<meta property="og:description" content="Writes about machines that do not exist yet. #babbage">
<meta property="og:image" content="/ada.png">
<link rel="me" href="https://github.com/ada">
<link rel="openprofile" href="/profile.md">
</head><body>
<a rel="me" href="https://bsky.app/profile/ada.example">Bluesky</a>
<a href="https://mathstodon.xyz/@ada" rel="me nofollow">Mastodon</a>
<a href="https://www.youtube.com/@ada">videos</a>
<a href="https://example.org/some/other/page">a friend</a>
<a rel="me" href="mailto:ada@example.com">mail me</a>
<a href="#top">top</a>
</body></html>`;

describe('extractProfilePage', () => {
  test('reads the card, every rel=me, the mailto and the openprofile link', () => {
    const facts = extractProfilePage(SITE, 'https://ada.example/');

    expect(facts.name).toBe('Ada Lovelace');
    expect(facts.headline).toBe('Writes about machines that do not exist yet. #babbage');
    expect(facts.avatar).toBe('https://ada.example/ada.png');
    expect(facts.openprofileUrl).toBe('https://ada.example/profile.md');
    expect(facts.topics).toEqual(['babbage']);

    const byUrl = Object.fromEntries(facts.accounts.map((entry) => [entry.url, entry]));
    expect(byUrl['https://github.com/ada']).toMatchObject({
      relation: 'me',
      network: 'github',
      label: 'GitHub',
    });
    expect(byUrl['https://bsky.app/profile/ada.example']).toMatchObject({
      relation: 'me',
      network: 'bluesky',
    });
    expect(byUrl['https://mathstodon.xyz/@ada']).toMatchObject({
      relation: 'me',
      network: 'mastodon',
    });
    expect(byUrl['https://www.youtube.com/@ada']).toMatchObject({
      relation: 'link',
      network: 'youtube',
    });
    expect(byUrl['mailto:ada@example.com']).toMatchObject({ relation: 'me', label: 'Email' });
    // A plain link to a site we cannot place is not an account.
    expect(byUrl['https://example.org/some/other/page']).toBeUndefined();
  });

  test('a page with no card still yields its title and nothing invented', () => {
    const facts = extractProfilePage(
      '<html><head><title>Plain</title></head><body>hi</body></html>',
      'https://p.example/',
    );
    expect(facts).toMatchObject({ name: 'Plain', accounts: [], topics: [] });
    expect(facts.headline).toBeUndefined();
    expect(facts.avatar).toBeUndefined();
  });
});

describe('text helpers', () => {
  test('urls and hashtags come out of a bio', () => {
    expect(urlsInText('site: https://ada.example/ and https://github.com/ada.')).toEqual([
      'https://ada.example/',
      'https://github.com/ada',
    ]);
    expect(hashtagsIn('I write about #Babbage and #babbage, plus #ai-safety')).toEqual([
      'babbage',
      'ai-safety',
    ]);
  });

  test('the well-known path is derived from any page on the site', () => {
    expect(wellKnownOpenProfile('https://ada.example/blog/post?x=1')).toBe(
      'https://ada.example/.well-known/openprofile.md',
    );
    expect(wellKnownOpenProfile('not a url')).toBeUndefined();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('network readers', () => {
  test('a Bluesky actor becomes facts, with the bio links and the DID', async () => {
    const calls: string[] = [];
    const facts = await readBlueskyProfile('ada.example', {
      fetchImpl: async (input) => {
        calls.push(String(input));
        return jsonResponse({
          did: 'did:plc:ada',
          handle: 'ada.example',
          displayName: 'Ada',
          description:
            'Engines and poetry.\nMore at https://ada.example and https://github.com/ada #babbage',
          avatar: 'https://cdn.bsky.app/ada.jpg',
        });
      },
    });
    expect(calls[0]).toBe(
      'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=ada.example',
    );
    expect(facts).toMatchObject({
      source: 'https://bsky.app/profile/ada.example',
      name: 'Ada',
      headline: 'Engines and poetry.',
      web: 'https://ada.example',
      platformUserId: 'did:plc:ada',
      topics: ['babbage'],
    });
    expect(facts?.accounts.map((entry) => entry.url)).toEqual([
      'https://ada.example',
      'https://github.com/ada',
    ]);
  });

  test('a Mastodon account becomes facts, and a verified field is rel=me', async () => {
    const facts = await readMastodonProfile('https://mathstodon.xyz/@ada', {
      fetchImpl: async (input) => {
        expect(String(input)).toBe('https://mathstodon.xyz/api/v1/accounts/lookup?acct=ada');
        return jsonResponse({
          id: '42',
          acct: 'ada',
          url: 'https://mathstodon.xyz/@ada',
          display_name: 'Ada Lovelace',
          note: '<p>Analytical engines. Poetry on Sundays.</p>',
          avatar: 'https://files.mathstodon.xyz/ada.png',
          fields: [
            {
              name: 'Web',
              value: '<a href="https://ada.example" rel="me">ada.example</a>',
              verified_at: '2026-01-01T00:00:00Z',
            },
            {
              name: 'Code',
              value: '<a href="https://github.com/ada">github.com/ada</a>',
              verified_at: null,
            },
          ],
        });
      },
    });
    expect(facts).toMatchObject({
      name: 'Ada Lovelace',
      headline: 'Analytical engines.',
      web: 'https://ada.example',
      platformUserId: 'mathstodon.xyz:42',
    });
    expect(facts?.accounts).toEqual([
      { url: 'https://ada.example', network: undefined, relation: 'me', label: 'ada.example' },
      { url: 'https://github.com/ada', network: 'github', relation: 'link', label: 'GitHub' },
    ]);
  });

  test('a network that answers 404 yields nothing rather than a half profile', async () => {
    expect(
      await readBlueskyProfile('nobody.example', {
        fetchImpl: async () => new Response('', { status: 404 }),
      }),
    ).toBeUndefined();
  });

  test('a published OpenProfile.md is taken only when it is Markdown', async () => {
    const pages: Record<string, Response> = {
      'https://ada.example/profile.md': new Response('<html>home</html>', { status: 200 }),
      'https://ada.example/.well-known/openprofile.md': new Response(
        '# Ada Lovelace\n\n- **Kind**: person\n',
        { status: 200 },
      ),
    };
    const found = await readPublishedOpenProfile(
      ['https://ada.example/profile.md', 'https://ada.example/.well-known/openprofile.md'],
      {
        fetchImpl: async (input) => pages[String(input)] ?? new Response('', { status: 404 }),
      },
    );
    expect(found?.url).toBe('https://ada.example/.well-known/openprofile.md');
    expect(found?.markdown.startsWith('# Ada Lovelace')).toBe(true);
  });
});

describe('mergeFacts and buildOpenProfile', () => {
  test('the first source wins on scalars, me beats link, and the profile itself is always listed', () => {
    const merged = mergeFacts('ada.example', 'https://bsky.app/profile/ada.example', [
      {
        source: 'bsky',
        name: 'Ada',
        accounts: [
          { url: 'https://github.com/ada', network: 'github', relation: 'link', label: 'GitHub' },
        ],
        topics: ['babbage'],
      },
      {
        source: 'site',
        name: 'Ada Lovelace',
        headline: 'Writes about machines that do not exist yet.',
        avatar: 'https://ada.example/ada.png',
        accounts: [
          { url: 'https://github.com/ada', network: 'github', relation: 'me', label: 'GitHub' },
          { url: 'mailto:ada@example.com', relation: 'me', label: 'Email' },
        ],
        topics: ['poetry', 'babbage'],
      },
    ]);
    expect(merged.name).toBe('Ada');
    expect(merged.headline).toBe('Writes about machines that do not exist yet.');
    expect(merged.email).toBe('ada@example.com');
    expect(merged.topics).toEqual(['babbage', 'poetry']);
    expect(merged.accounts.map((entry) => [entry.url, entry.relation])).toEqual([
      ['https://bsky.app/profile/ada.example', 'me'],
      ['https://github.com/ada', 'me'],
    ]);

    const markdown = buildOpenProfile({ ...merged, web: 'https://ada.example' });
    expect(markdown).toBe(
      [
        '# Ada',
        '',
        '- **Kind**: person',
        '- **Handle**: @ada.example',
        '- **Web**: https://ada.example',
        '- **Email**: ada@example.com',
        '- **Avatar**: https://ada.example/ada.png',
        '',
        'Writes about machines that do not exist yet.',
        '',
        '## Accounts',
        '',
        '- [Bluesky](https://bsky.app/profile/ada.example)',
        '- [GitHub](https://github.com/ada)',
        '',
        '## Topics',
        '',
        '- babbage',
        '- poetry',
        '',
      ].join('\n'),
    );
    // One heading, and it is the name.
    expect(markdown.match(/^# /gm)).toHaveLength(1);
  });

  test('a person with nothing but a handle still gets a valid file', () => {
    const markdown = buildOpenProfile(mergeFacts('@bob', 'https://x.com/bob', []));
    expect(markdown).toBe(
      '# bob\n\n- **Kind**: person\n- **Handle**: @bob\n\n## Accounts\n\n- [X](https://x.com/bob)\n',
    );
  });
});
