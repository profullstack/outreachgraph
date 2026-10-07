/**
 * `/api/v1/link-posts`: draft from a link, list, edit, regenerate, done, skip.
 *
 * What has to hold: a pasted URL is read and becomes one card per network,
 * LinkedIn when none is named; a regenerate rewrites one card; done and skip
 * leave the open list; a viewer reads but cannot draft; a private address is
 * refused before anything is fetched; an unreadable page needs notes; and with
 * no model drafting says so (503).
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import type { FetchLike, HostLookup } from '@outreachgraph/providers';
import { createApp } from './app';
import type { RequestActor } from './context';
import { extractLinkPage } from './link-posts';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

setDefaultTimeout(30_000);

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};
const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

const ARTICLE = 'https://blog.example.com/fast-builds';
const HTML = `<!doctype html><html><head>
<title>ignored when og:title exists</title>
<meta property="og:title" content="How we cut build times in half">
<meta name="description" content="A story about caching &amp; patience.">
</head><body><nav>Home About</nav>
<article><h1>How we cut build times in half</h1><p>Our CI took 22 minutes. We cached the dependency layer and split tests into four shards.</p><p>Now it takes 9 minutes.</p></article>
<footer>Copyright</footer></body></html>`;

const fetched: string[] = [];
const fakeFetch: FetchLike = async (input) => {
  const url = String(input);
  fetched.push(url);
  if (url === ARTICLE) {
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  }
  return new Response('nope', { status: 403, headers: { 'content-type': 'text/html' } });
};
const lookup: HostLookup = async (host) =>
  host === 'internal.example.com' ? ['10.0.0.7'] : ['93.184.216.34'];

const DRAFT = JSON.stringify({
  posts: [
    { network: 'linkedin', title: null, text: 'Our CI took 22 minutes. Now 9.\n\nHere is how.' },
    {
      network: 'reddit',
      title: 'Cutting CI from 22 to 9 minutes',
      text: 'Wrote this up.',
      subreddit: 'devops',
    },
  ],
});
const REDRAFT = JSON.stringify({
  posts: [{ network: 'linkedin', text: 'A new angle on caching.' }],
});

async function harness(label: string, opts: { actor?: RequestActor; model?: boolean } = {}) {
  const seeded = await seedDatabase(label);
  active = seeded;
  const model = new StubModel([DRAFT, REDRAFT]);
  const app = createApp({
    db: seeded.db,
    authenticate: async () => opts.actor ?? OWNER,
    ...(opts.model === false ? {} : { model }),
    linkFetch: fakeFetch,
    linkLookup: lookup,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1/link-posts${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, model };
}

describe('link posts API', () => {
  test('draft, list, edit, regenerate, done, skip', async () => {
    const { call, model } = await harness('link-posts-api');

    const created = await call('POST', '', {
      url: ARTICLE,
      networks: ['linkedin', 'reddit'],
      notes: 'mention it is open source',
    });
    expect(created.status).toBe(201);
    expect(created.body.page).toMatchObject({
      read: true,
      title: 'How we cut build times in half',
    });
    const posts = created.body.posts as Record<string, any>[];
    expect(posts.map((p) => p.network)).toEqual(['linkedin', 'reddit']);
    expect(posts[0]!.id).toStartWith('lpo_');
    expect(posts[0]!.text).toBe(`Our CI took 22 minutes. Now 9.\n\nHere is how.\n\n${ARTICLE}`);
    expect(posts[0]!.openUrl).toContain('linkedin.com/feed/?shareActive=true');
    expect(posts[1]!.openUrl).toContain('reddit.com/r/devops/submit');
    expect(posts[1]!.title).toBe('Cutting CI from 22 to 9 minutes');
    // The model was given the article, not the navigation, and the notes.
    expect(model.calls[0]!.user).toContain('We cached the dependency layer');
    expect(model.calls[0]!.user).not.toContain('Home About');
    expect(model.calls[0]!.user).toContain('mention it is open source');

    const listed = await call('GET', '');
    expect(listed.status).toBe(200);
    expect(listed.body.posts).toHaveLength(2);
    expect(listed.body.draftingEnabled).toBe(true);
    expect(listed.body.posting).toBe('manual');

    const linkedinId = posts[0]!.id as string;
    const edited = await call('PATCH', `/${linkedinId}`, { text: `Edited by hand.\n\n${ARTICLE}` });
    expect(edited.body.post.body).toBe('Edited by hand.');
    expect(edited.body.post.text).toBe(`Edited by hand.\n\n${ARTICLE}`);

    const again = await call('POST', `/${linkedinId}/regenerate`, {});
    expect(again.status).toBe(200);
    expect(again.body.post.body).toBe('A new angle on caching.');
    expect(again.body.post.regenerations).toBe(1);
    // Regenerate works from the stored page: no second fetch of the article.
    expect(fetched.filter((u) => u === ARTICLE)).toHaveLength(1);
    expect(model.calls[1]!.user).toContain('Edited by hand.');

    const done = await call('POST', `/${linkedinId}/done`, {
      postedUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1',
    });
    expect(done.body.post.status).toBe('done');
    expect(done.body.post.postedUrl).toContain('linkedin.com/feed/update');

    const skipped = await call('POST', `/${posts[1]!.id}/skip`);
    expect(skipped.body.post.status).toBe('skipped');

    expect((await call('GET', '')).body.posts).toHaveLength(0);
    expect((await call('GET', '?status=all')).body.posts).toHaveLength(2);
  });

  test('LinkedIn is the default network', async () => {
    const { call, model } = await harness('link-posts-default');
    const created = await call('POST', '', { url: 'blog.example.com/fast-builds' });
    expect(created.status).toBe(201);
    expect(created.body.posts.map((p: Record<string, unknown>) => p.network)).toEqual(['linkedin']);
    expect(model.calls[0]!.user).toContain('linkedin (LinkedIn):');
    expect(model.calls[0]!.user).not.toContain('reddit (Reddit):');
  });

  test('a private address is refused before it is fetched', async () => {
    const { call } = await harness('link-posts-ssrf');
    const before = fetched.length;
    const res = await call('POST', '', { url: 'https://internal.example.com/admin' });
    expect(res.status).toBe(422);
    expect(fetched.length).toBe(before);
  });

  test('an unreadable page needs notes', async () => {
    const { call } = await harness('link-posts-unreadable');
    const blocked = await call('POST', '', { url: 'https://blog.example.com/blocked' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('page_unreadable');

    const withNotes = await call('POST', '', {
      url: 'https://blog.example.com/blocked',
      notes: 'Our launch post: v2 adds sharded test runs.',
    });
    expect(withNotes.status).toBe(201);
    expect(withNotes.body.page.read).toBe(false);
  });

  test('a viewer reads but cannot draft; no model is a 503; bad networks are a 400', async () => {
    const viewer = await harness('link-posts-viewer', { actor: VIEWER });
    expect((await viewer.call('GET', '')).status).toBe(200);
    expect((await viewer.call('POST', '', { url: ARTICLE })).status).toBe(403);
    active?.cleanup();

    const bare = await harness('link-posts-nomodel', { model: false });
    expect((await bare.call('POST', '', { url: ARTICLE })).status).toBe(503);
    expect((await bare.call('POST', '', { url: ARTICLE, networks: ['myspace'] })).status).toBe(400);
  });
});

describe('extractLinkPage', () => {
  test('prefers og tags and the article body', () => {
    const page = extractLinkPage(HTML);
    expect(page.title).toBe('How we cut build times in half');
    expect(page.description).toBe('A story about caching & patience.');
    expect(page.text).toContain('Now it takes 9 minutes.');
    expect(page.text).not.toContain('Copyright');
  });
});
