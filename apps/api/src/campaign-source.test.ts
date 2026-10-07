/**
 * A campaign's source URL, read on a schedule into drafted posts.
 *
 * What has to hold: a feed's first read drafts only its newest item; later
 * reads draft only new items; a plain page drafts when its title or
 * description changes, never on the first read; the daily cap holds; the
 * campaign's voice and target customer reach the writer; and the API requires
 * a source when the product has no site.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import { now, queryAll, type Client } from '@outreachgraph/db';
import type { FetchLike, HostLookup } from '@outreachgraph/providers';
import { createApp } from './app';
import { BATCHES_PER_CAMPAIGN_PER_DAY, feedLink, runCampaignSources } from './campaign-source';
import type { RequestActor } from './context';
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

const SITE = 'https://acme.example.com/';
const FEED = 'https://acme.example.com/feed.xml';
const article = (n: number) => `https://acme.example.com/blog/post-${n}`;

const lookup: HostLookup = async () => ['93.184.216.34'];

function rss(items: number[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Acme</title>${items
    .map(
      (n) =>
        `<item><title>Post ${n}</title><link>${article(n)}</link><pubDate>Mon, 0${n} Oct 2026 10:00:00 GMT</pubDate></item>`,
    )
    .join('')}</channel></rss>`;
}

const ARTICLE_HTML = (n: number) =>
  `<html><head><meta property="og:title" content="Post ${n}"></head><body><article><p>Post ${n} explains how we cut costs by half with caching.</p></article></body></html>`;

function site(state: { items: number[]; withFeed: boolean; title: string }): FetchLike {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === SITE) {
      const link = state.withFeed
        ? `<link rel="alternate" type="application/rss+xml" href="/feed.xml">`
        : '';
      return new Response(
        `<html><head><title>${state.title}</title>${link}<meta name="description" content="${state.title} desc"></head><body><p>Home</p></body></html>`,
        { headers: { 'content-type': 'text/html' } },
      );
    }
    if (url === FEED) {
      return new Response(rss(state.items), { headers: { 'content-type': 'application/rss+xml' } });
    }
    const match = /post-(\d+)$/.exec(url);
    if (match) {
      return new Response(ARTICLE_HTML(Number(match[1])), {
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response('nope', { status: 404 });
  };
}

const POSTS = JSON.stringify({
  posts: [{ network: 'linkedin', text: 'We cut costs by half with caching.' }],
});

async function setup(label: string): Promise<Client> {
  active = await seedDatabase(label);
  const db = active.db;
  await db.execute({
    sql: `UPDATE campaigns SET source_url = ?, status = 'active' WHERE id = ?`,
    args: [SITE, SEED.campaignId],
  });
  return db;
}

async function batches(db: Client) {
  return queryAll<{ batch_id: string; url: string }>(
    db,
    'SELECT DISTINCT batch_id, url FROM link_posts WHERE campaign_id = ? ORDER BY url',
    [SEED.campaignId],
  );
}

const later = (hours: number) => new Date(Date.now() + hours * 3_600_000);

describe('campaign sources', () => {
  test('a feed: the first read drafts only the newest item, later reads only new ones', async () => {
    const db = await setup('campaign-source-feed');
    const state = { items: [3, 2, 1], withFeed: true, title: 'Acme' };
    const model = new StubModel([POSTS, POSTS, POSTS, POSTS]);
    const deps = { db, model, fetchImpl: site(state), lookup };

    const first = await runCampaignSources(deps);
    expect(first[0]).toMatchObject({ mode: 'feed', newItems: 3, drafted: 1 });
    expect((await batches(db)).map((b) => b.url)).toEqual([article(3)]);

    // Not due again until the interval has passed.
    expect(await runCampaignSources(deps)).toEqual([]);

    state.items = [4, 3, 2, 1];
    const second = await runCampaignSources({ ...deps, now: later(7) });
    expect(second[0]).toMatchObject({ mode: 'feed', newItems: 1, drafted: 1 });
    expect((await batches(db)).map((b) => b.url)).toEqual([article(3), article(4)]);
  });

  test("the campaign's voice and target customer reach the writer", async () => {
    const db = await setup('campaign-source-voice');
    const stamp = now();
    await db.execute({
      sql: `INSERT INTO voice_profiles (id, workspace_id, name, style, instructions, created_at, updated_at)
            VALUES ('vp_dry', ?, 'Dry', 'dry and specific', 'No exclamation marks.', ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    });
    await db.execute({
      sql: `UPDATE campaigns SET voice_profile_id = 'vp_dry' WHERE id = ?`,
      args: [SEED.campaignId],
    });
    await db.execute({
      sql: `INSERT INTO campaign_filters (campaign_id, titles, industries, updated_at)
            VALUES (?, '["CTO","VP Engineering"]', '["fintech"]', ?)
            ON CONFLICT (campaign_id) DO UPDATE SET titles = excluded.titles,
              industries = excluded.industries`,
      args: [SEED.campaignId, stamp],
    });
    const model = new StubModel([POSTS]);
    await runCampaignSources({
      db,
      model,
      fetchImpl: site({ items: [1], withFeed: true, title: 'Acme' }),
      lookup,
    });

    const prompt = model.calls[0]!.user;
    expect(prompt).toContain('dry and specific');
    expect(prompt).toContain('No exclamation marks.');
    expect(prompt).toContain('CTO, VP Engineering in fintech');
  });

  test('a plain page drafts when its title changes, never on the first read', async () => {
    const db = await setup('campaign-source-page');
    const state = { items: [], withFeed: false, title: 'Acme' };
    const model = new StubModel([POSTS, POSTS]);
    const deps = { db, model, fetchImpl: site(state), lookup };

    expect((await runCampaignSources(deps))[0]).toMatchObject({ mode: 'page', drafted: 0 });
    expect((await runCampaignSources({ ...deps, now: later(7) }))[0]).toMatchObject({
      mode: 'page',
      drafted: 0,
    });

    state.title = 'Acme: now with caching';
    expect((await runCampaignSources({ ...deps, now: later(14) }))[0]).toMatchObject({
      mode: 'page',
      newItems: 1,
    });
    expect(await batches(db)).toHaveLength(1);
  });

  test('the daily cap holds however much is new', async () => {
    const db = await setup('campaign-source-cap');
    const state = { items: [1], withFeed: true, title: 'Acme' };
    const model = new StubModel(Array.from({ length: 12 }, () => POSTS));
    const deps = { db, model, fetchImpl: site(state), lookup };

    await runCampaignSources(deps);
    state.items = [9, 8, 7, 6, 5, 4, 3, 2, 1];
    const second = await runCampaignSources({ ...deps, now: later(7) });
    // Same UTC day unless the test straddles midnight.
    if (later(7).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) {
      expect(second[0]!.drafted).toBe(BATCHES_PER_CAMPAIGN_PER_DAY - 1);
    }
  });

  test('a page advertises its feed', () => {
    expect(feedLink('<link rel="alternate" type="application/atom+xml" href="/atom">', SITE)).toBe(
      'https://acme.example.com/atom',
    );
    expect(feedLink('<link rel="stylesheet" href="/a.css">', SITE)).toBeUndefined();
  });
});

describe('campaign source API', () => {
  async function harness(label: string) {
    const seeded = await seedDatabase(label);
    active = seeded;
    const app = createApp({ db: seeded.db, authenticate: async () => OWNER });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    return { call, db: seeded.db };
  }

  test('a source URL and networks are set and read back', async () => {
    const { call } = await harness('campaign-source-api');
    const patched = await call('PATCH', `/campaigns/${SEED.campaignId}`, {
      sourceUrl: 'acme.example.com/blog',
      postNetworks: ['linkedin', 'x', 'nonsense'],
    });
    expect(patched.status).toBe(200);

    const read = await call('GET', `/campaigns/${SEED.campaignId}`);
    expect(read.body.source).toMatchObject({
      url: 'https://acme.example.com/blog',
      postNetworks: ['linkedin', 'x'],
    });

    expect(
      (await call('PATCH', `/campaigns/${SEED.campaignId}`, { sourceUrl: 'not a url' })).status,
    ).toBe(400);
  });

  test('starting a campaign needs a URL when the product has no site', async () => {
    const { call } = await harness('campaign-source-required');
    const res = await call('POST', '/campaigns', { input: 'CTOs at fintech startups' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('sourceUrl');
  });
});
