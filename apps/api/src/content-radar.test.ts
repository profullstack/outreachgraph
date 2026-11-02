/**
 * `/api/v1/content-radar` and the sweep behind it.
 *
 * What has to hold: a product gets a radar on first look; a scan stores each
 * public post once with its numbers and names its hook (the model when there
 * is one, the wording otherwise); references save to collections; a follow
 * is read on the next scan; Create turns a reference into link-post cards for
 * the radar's networks plus a storyboard and an image card served as SVG; the
 * sweep drafts on its own, at most RADAR_DRAFTS_PER_DAY a workspace day; a
 * viewer reads but cannot change anything.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import type {
  FollowNetwork,
  TopPost,
  TopPostReader,
  TopPostSource,
} from '@outreachgraph/providers';
import { createApp } from './app';
import type { RequestActor } from './context';
import {
  draftPicks,
  normaliseHandle,
  runContentRadar,
  RADAR_DRAFTS_PER_DAY,
  withLift,
} from './content-radar';
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

const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function post(source: TopPostSource, id: string, likes: number, text: string): TopPost {
  return {
    source,
    externalId: id,
    url: `https://example.com/${source}/${id}`,
    authorHandle: `${source}-author`,
    text,
    postedAt: day(3),
    likes,
    reposts: 1,
    comments: 2,
    matched: 'habit tracker',
  };
}

function fakeReader(calls: string[] = []): TopPostReader {
  return {
    async top(source: TopPostSource) {
      calls.push(`top:${source}`);
      if (source === 'bluesky') {
        return [
          post('bluesky', 'b1', 40, "I stopped tracking streaks. Here's what changed."),
          post('bluesky', 'b2', 5, 'What is your minimum on a hard day?'),
        ];
      }
      if (source === 'hackernews') return [post('hackernews', 'h1', 120, 'Show HN: Daymark')];
      return [];
    },
    async follow(network: FollowNetwork, handle: string) {
      calls.push(`follow:${network}:${handle}`);
      return [
        { ...post('bluesky', 'f1', 300, 'We shipped streak freezes'), matched: `@${handle}` },
      ];
    },
  } as unknown as TopPostReader;
}

const HOOKS = JSON.stringify({
  results: [
    {
      id: 'REF',
      hook: 'contrarian',
      why: 'It breaks a habit-app rule.',
      angle: 'Say why streaks fail.',
    },
  ],
});
const LINK_POSTS = JSON.stringify({
  posts: [
    { network: 'bluesky', text: 'Streaks punish a bad day. Daymark keeps your week.' },
    { network: 'linkedin', text: 'We built Daymark for the day after a missed day.' },
  ],
});
const STUDIO = JSON.stringify({
  storyboard: {
    title: 'Missed a day?',
    caption: 'Keep the progress.',
    scenes: [
      {
        beat: 'hook',
        onScreen: 'Missed a day?',
        voiceover: 'You missed Tuesday.',
        shot: 'Calendar',
      },
      { beat: 'invitation', onScreen: 'Try Daymark', voiceover: 'Start again.', shot: 'App' },
    ],
  },
  image: {
    eyebrow: 'Daymark',
    headline: 'Missed a day? Keep going.',
    support: 'Your week still counts.',
    footer: 'daymark.app',
    caption: 'Small steps.',
  },
});

async function harness(label: string, opts: { actor?: RequestActor; model?: StubModel } = {}) {
  const seeded = await seedDatabase(label);
  active = seeded;
  await seeded.db.execute({
    sql: `UPDATE offerings SET name = 'Daymark', url = 'https://daymark.app',
            description = 'A habit tracker that forgives missed days' WHERE id = ?`,
    args: [SEED.offeringId],
  });
  const readerCalls: string[] = [];
  const reader = fakeReader(readerCalls);
  const app = createApp({
    db: seeded.db,
    authenticate: async () => opts.actor ?? OWNER,
    ...(opts.model ? { model: opts.model } : {}),
    radarReader: reader,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1/content-radar${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const type = res.headers.get('content-type') ?? '';
    return {
      status: res.status,
      type,
      body: (type.includes('json') ? await res.json() : await res.text()) as any,
    };
  };
  return { call, db: seeded.db, reader, readerCalls };
}

describe('content radar API', () => {
  test('radar, scan, hooks by wording, save, follow', async () => {
    const { call, readerCalls } = await harness('radar-basic');

    const listed = await call('GET', '');
    expect(listed.status).toBe(200);
    expect(listed.body.radars).toHaveLength(1);
    const radar = listed.body.radars[0];
    expect(radar.offeringId).toBe(SEED.offeringId);
    // No lead monitor and no model: the category is the first term.
    expect(radar.terms).toContain('developer payments infrastructure');
    expect(radar.autoDraft).toBe(true);
    expect(listed.body.draftingEnabled).toBe(false);

    const put = await call('PUT', `/radars/${SEED.offeringId}`, {
      terms: ['habit tracker'],
      subreddits: ['r/habits'],
      sources: ['bluesky', 'hackernews'],
    });
    expect(put.body.radar.subreddits).toEqual(['habits']);

    const followed = await call('POST', '/follows', {
      network: 'bluesky',
      handle: 'https://bsky.app/profile/rival.app',
      label: 'Rival',
    });
    expect(followed.status).toBe(201);
    expect(followed.body.follow.handle).toBe('rival.app');
    expect(
      (await call('POST', '/follows', { network: 'bluesky', handle: 'rival.app' })).status,
    ).toBe(409);

    const scan = await call('POST', `/radars/${SEED.offeringId}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.body.result).toMatchObject({ read: 4, stored: 4, judged: 0 });
    expect(readerCalls).toEqual(['top:bluesky', 'top:hackernews', 'follow:bluesky:rival.app']);

    const refs = await call('GET', `/references?offeringId=${SEED.offeringId}`);
    const list = refs.body.references as any[];
    expect(list.map((r) => r.engagement)).toEqual([305, 125, 45, 10]);
    expect(list.find((r) => r.url.endsWith('/b1')).hook).toMatchObject({
      type: 'contrarian',
      judged: false,
    });
    expect(list[0]).toMatchObject({ origin: 'follow', matched: 'Rival' });

    // Scanning again updates numbers instead of storing twice.
    const again = await call('POST', `/radars/${SEED.offeringId}/scan`);
    expect(again.body.result.stored).toBe(0);

    const saved = await call('PATCH', `/references/${list[1].id}`, { collection: 'Hooks to try' });
    expect(saved.body.reference).toMatchObject({ status: 'saved', collection: 'Hooks to try' });
    const byCollection = await call('GET', '/references?collection=Hooks%20to%20try');
    expect(byCollection.body.references).toHaveLength(1);
    expect(byCollection.body.collections).toEqual([{ name: 'Hooks to try', count: 1 }]);

    await call('PATCH', `/references/${list[3].id}`, { status: 'dismissed' });
    expect((await call('GET', '/references')).body.references).toHaveLength(3);

    // No model: Create says so.
    expect((await call('POST', `/references/${list[0].id}/create`, {})).status).toBe(503);
  });

  test('create: link-post cards, a storyboard and an SVG image card', async () => {
    const model = new StubModel([HOOKS, LINK_POSTS, STUDIO]);
    const { call, db } = await harness('radar-create', { model });
    await call('GET', '');
    await call('PUT', `/radars/${SEED.offeringId}`, {
      terms: ['habit tracker'],
      sources: ['bluesky'],
      networks: ['bluesky', 'linkedin'],
    });
    // The hook reply must name a real id: patch it in once the rows exist.
    await call('POST', `/radars/${SEED.offeringId}/scan`);
    const refs = (await call('GET', '/references')).body.references as any[];
    const top = refs[0];
    expect(top.hook.judged).toBe(false); // "REF" matched no id, so the wording stands.

    const created = await call('POST', `/references/${top.id}/create`, {});
    expect(created.status).toBe(201);
    expect(created.body.posts).toBe(2);
    expect(created.body.batchId).toStartWith('lpo_');
    expect(created.body.assets.map((a: any) => a.kind)).toEqual(['storyboard', 'image']);
    // The post writer was told to borrow the structure, not the words.
    expect(model.calls[1]!.user).toContain('Do not copy');
    expect(model.calls[1]!.user).toContain('I stopped tracking streaks');

    const cards = await db.execute({
      sql: 'SELECT network, url, status FROM link_posts WHERE batch_id = ? ORDER BY network',
      args: [created.body.batchId],
    });
    expect(cards.rows.map((r: any) => [r.network, r.url, r.status])).toEqual([
      ['bluesky', 'https://daymark.app', 'open'],
      ['linkedin', 'https://daymark.app', 'open'],
    ]);

    const image = created.body.assets.find((a: any) => a.kind === 'image');
    const svg = await call('GET', `/assets/${image.id}/image.svg`);
    expect(svg.status).toBe(200);
    expect(svg.type).toContain('image/svg+xml');
    expect(svg.body).toContain('DAYMARK');

    const used = (await call('GET', '/references?status=used')).body.references as any[];
    expect(used.map((r) => r.id)).toEqual([top.id]);
    expect((await call('GET', '/assets')).body.assets).toHaveLength(2);
  });

  test('a viewer reads but cannot change the radar', async () => {
    const { call } = await harness('radar-viewer', { actor: VIEWER });
    expect((await call('GET', '')).status).toBe(200);
    expect((await call('POST', `/radars/${SEED.offeringId}/scan`)).status).toBe(403);
    expect((await call('POST', '/follows', { network: 'bluesky', handle: 'a.b' })).status).toBe(
      403,
    );
  });
});

describe('content radar sweep', () => {
  test('scans running products, then drafts on its own under the daily cap', async () => {
    const model = new StubModel(['{"results":[]}', LINK_POSTS, STUDIO]);
    const { db, reader } = await harness('radar-sweep');
    await db.execute({
      sql: `INSERT INTO content_radars (workspace_id, offering_id, terms, sources, networks,
              created_at, updated_at) VALUES (?, ?, '["habit tracker"]', '["bluesky","hackernews"]',
              '["bluesky"]', ?, ?)`,
      args: [SEED.workspaceId, SEED.offeringId, day(0), day(0)],
    });
    // Hook analysis comes back empty, so the wording's guess stands.
    const first = await runContentRadar({ db, model, reader });
    expect(first.scans).toHaveLength(1);
    expect(first.scans[0]!.stored).toBe(3);
    expect(first.drafted).toHaveLength(1);
    // The best reference (HN, 125) was used.
    const used = await db.execute(
      "SELECT external_id FROM content_references WHERE status = 'used'",
    );
    expect(used.rows.map((r: any) => r.external_id)).toEqual(['h1']);

    // Same day: the product already drafted and was scanned; nothing more.
    const second = await runContentRadar({ db, model, reader });
    expect(second.scans).toHaveLength(0);
    expect(second.drafted).toHaveLength(0);
  });

  test('draftPicks honours the per-workspace daily cap', async () => {
    const { db } = await harness('radar-cap');
    const at = new Date();
    for (let i = 0; i < RADAR_DRAFTS_PER_DAY; i += 1) {
      await db.execute({
        sql: `INSERT INTO link_posts (id, workspace_id, batch_id, url, network, body, status,
                created_by, created_at, updated_at)
              VALUES (?, ?, ?, 'https://daymark.app', 'bluesky', 'x', 'open', 'content_radar', ?, ?)`,
        args: [`lpo_${i}`, SEED.workspaceId, `lpo_b${i}`, at.toISOString(), at.toISOString()],
      });
    }
    expect(await draftPicks(db, SEED.workspaceId, at)).toEqual([]);
  });
});

describe('ranking', () => {
  test('lift compares a post with its own source and origin', () => {
    const lifted = withLift([
      { source: 'bluesky', origin: 'follow', engagement: 10_000 },
      { source: 'bluesky', origin: 'follow', engagement: 9_000 },
      { source: 'bluesky', origin: 'follow', engagement: 11_000 },
      { source: 'reddit', origin: 'keyword', engagement: 600 },
      { source: 'reddit', origin: 'keyword', engagement: 100 },
      { source: 'reddit', origin: 'keyword', engagement: 120 },
    ]);
    // The celebrity's usual post is 1x; the subreddit's stand-out is 5x.
    expect(lifted.map((r) => r.lift)).toEqual([1, 0.9, 1.1, 5, 0.83, 1]);
  });

  test('drafts skip off-topic posts and prefer the product terms over follows', async () => {
    const { db } = await harness('radar-picks');
    await db.execute({
      sql: `INSERT INTO content_radars (workspace_id, offering_id, created_at, updated_at)
            VALUES (?, ?, ?, ?)`,
      args: [SEED.workspaceId, SEED.offeringId, day(0), day(0)],
    });
    const insert = (id: string, origin: string, engagement: number, relevant: number | null) =>
      db.execute({
        sql: `INSERT INTO content_references (id, workspace_id, offering_id, source, external_id,
                url, text, posted_at, engagement, origin, hook_type, hook_judged, relevant,
                created_at, updated_at)
              VALUES (?, ?, ?, 'bluesky', ?, 'https://x.test', 't', ?, ?, ?, 'story', 1, ?, ?, ?)`,
        args: [
          id,
          SEED.workspaceId,
          SEED.offeringId,
          id,
          day(2),
          engagement,
          origin,
          relevant,
          day(0),
          day(0),
        ],
      });
    await insert('crf_offtopic', 'keyword', 9_000, 0);
    await insert('crf_follow', 'follow', 5_000, 1);
    await insert('crf_term', 'keyword', 40, 1);
    expect(await draftPicks(db, SEED.workspaceId, new Date())).toEqual([
      { offeringId: SEED.offeringId, referenceId: 'crf_term' },
    ]);
  });
});

describe('normaliseHandle', () => {
  test('profile URLs and @ prefixes', () => {
    expect(normaliseHandle('bluesky', 'https://bsky.app/profile/rival.app')).toBe('rival.app');
    expect(normaliseHandle('mastodon', 'https://fosstodon.org/@maya')).toBe('maya@fosstodon.org');
    expect(normaliseHandle('hackernews', 'https://news.ycombinator.com/user?id=pg')).toBe('pg');
    expect(normaliseHandle('reddit', 'u/spez')).toBe('spez');
    expect(normaliseHandle('devto', '@ben')).toBe('ben');
    expect(normaliseHandle('bluesky', 'bad handle!')).toBeUndefined();
  });
});
