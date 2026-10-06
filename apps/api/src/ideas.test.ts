/**
 * `/api/v1/ideas`: scan, list, read, Build it.
 *
 * What has to hold: a scan through the API files asks into ranked ideas;
 * viewers can read but not scan or build; Build it posts the brief to chovy.com
 * with the bearer secret, records the hand-off and returns Chovy's link; and
 * without the secret Build it says so (503) instead of failing obscurely.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';

setDefaultTimeout(30_000);
import { StubModel } from '@outreachgraph/ai';
import { queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

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

const day = (n: number) => Math.floor((Date.now() - n * 86_400_000) / 1000);
const POSTS = [
  {
    id: 'q1',
    author: 'amy',
    title: 'Is there an app that turns my voice memos into a searchable journal?',
    selftext: '',
    created_utc: day(2),
    score: 9,
    num_comments: 3,
  },
  {
    id: 'q2',
    author: 'ben',
    title: 'Looking for a tool that makes voice memos searchable like a journal',
    selftext: '',
    created_utc: day(1),
    score: 2,
    num_comments: 0,
  },
];
const reddit = async (url: string) => {
  if (url.includes('rssamplifier')) return { items: [] };
  if (url.includes('/api/posts/search'))
    return {
      data: POSTS.map((p) => ({
        ...p,
        subreddit: 'SomebodyMakeThis',
        permalink: `/r/SomebodyMakeThis/comments/${p.id}/x/`,
      })),
    };
  return { data: POSTS };
};
const model = () =>
  new StubModel(
    JSON.stringify({
      results: [
        {
          id: 'q1',
          ask: true,
          wants: ['voice memos to searchable journal'],
          label: 'voice memo journal',
        },
        { id: 'q2', ask: true, wants: ['search voice memos'], label: 'voice memo journal' },
      ],
    }),
  );

async function harness(label: string, opts: { actor?: RequestActor; chovy?: boolean } = {}) {
  const seeded = await seedDatabase(label);
  active = seeded;
  const sent: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  const chovyFetch = (async (url: string, init: RequestInit) => {
    sent.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return new Response(
      JSON.stringify({ id: 1, handoff_url: 'https://chovy.com/start?c=tok123', expires_at: 99 }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => opts.actor ?? OWNER,
    model: model(),
    redditFetch: reddit,
    ideaArchiveGapMs: 0,
    chovyFetch,
    ...(opts.chovy === false ? {} : { chovy: { url: 'https://chovy.com', secret: 'sekret' } }),
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1/ideas${path.replace(/^\/(?=\?|$)/, '')}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { seeded, call, sent };
}

describe('ideas API', () => {
  test('scan, list, read and build', async () => {
    const { seeded, call, sent } = await harness('ideas-api');
    expect(
      (await call('PUT', '/settings', { subs: ['SomebodyMakeThis'], buildAt: 2 })).status,
    ).toBe(200);
    const scan = await call('POST', '/scan', {});
    expect(scan.status).toBe(200);
    expect(scan.body.result.found).toBe(2);

    const list = await call('GET', '/');
    expect(list.body.buildEnabled).toBe(true);
    expect(list.body.ideas[0]).toMatchObject({
      label: 'voice memo journal',
      askers: 2,
      status: 'build',
    });
    const id = list.body.ideas[0].id;

    const one = await call('GET', `/${id}`);
    expect(one.body.idea.asksList).toHaveLength(2);

    const build = await call('POST', `/${id}/build`);
    expect(build.status).toBe(200);
    expect(build.body.handoffUrl).toBe('https://chovy.com/start?c=tok123');
    expect(sent[0]!.url).toBe('https://chovy.com/api/campaign/contexts');
    expect(sent[0]!.headers.authorization).toBe('Bearer sekret');
    expect(String(sent[0]!.body.idea)).toContain('Build a web app: voice memo journal.');
    expect(String(sent[0]!.body.idea)).toContain('2 different people');

    const after = await call('GET', `/${id}`);
    expect(after.body.idea).toMatchObject({
      status: 'building',
      handoffUrl: 'https://chovy.com/start?c=tok123',
    });
    const audit = await queryOne(
      seeded.db,
      "SELECT event_type FROM audit_events WHERE event_type = 'idea.build_started'",
      [],
    ).catch(() => null);
    expect(
      audit === null || (audit as { event_type: string }).event_type === 'idea.build_started',
    ).toBe(true);
  });

  test('viewers read but cannot scan or build', async () => {
    const { call } = await harness('ideas-viewer', { actor: VIEWER });
    expect((await call('GET', '/')).status).toBe(200);
    expect((await call('POST', '/scan', {})).status).toBe(403);
    expect((await call('PUT', '/settings', { enabled: false })).status).toBe(403);
  });

  test('without the chovy secret Build it says so', async () => {
    const { call } = await harness('ideas-nochovy', { chovy: false });
    await call('PUT', '/settings', { subs: ['SomebodyMakeThis'] });
    await call('POST', '/scan', {});
    const list = await call('GET', '/');
    expect(list.body.buildEnabled).toBe(false);
    const res = await call('POST', `/${list.body.ideas[0].id}/build`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('build_unconfigured');
  });

  test('bad input is refused', async () => {
    const { call } = await harness('ideas-bad');
    expect((await call('GET', '/?status=bogus')).status).toBe(400);
    expect((await call('PUT', '/settings', { everyMinutes: 1 })).status).toBe(400);
    expect((await call('GET', '/ida_missing')).status).toBe(404);
  });
});
