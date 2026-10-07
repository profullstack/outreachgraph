/**
 * `/api/v1/buyer-leads`: monitors, scan, list, draft, mark.
 *
 * What has to hold: an owner creates a monitor, scans it and sees the leads
 * over its floor; a reply is drafted and returned but nothing posts it; a
 * viewer reads but cannot create, scan or draft; bad input is a 400; and with
 * no model a draft says so (503) instead of failing obscurely.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import type { FeedPost, FeedSource } from '@outreachgraph/providers';
import { createApp } from './app';
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
const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

const POST: FeedPost = {
  network: 'hackernews',
  externalId: '4242',
  authorHandle: 'ops_person',
  url: 'https://news.ycombinator.com/item?id=4242',
  text: 'Can anyone recommend an intrusion detection tool for a handful of VPSes?',
  postedAt: new Date(Date.now() - 3_600_000).toISOString(),
  container: 'HN comment',
};
const source: FeedSource = {
  network: 'hackernews',
  slug: 'hackernews',
  displayName: 'Hacker News',
  search: async () => [POST],
};

async function harness(label: string, opts: { actor?: RequestActor; model?: boolean } = {}) {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => opts.actor ?? OWNER,
    ...(opts.model === false
      ? {}
      : {
          model: new StubModel([
            JSON.stringify({ results: [{ id: '0', intent: 84, reason: 'wants an IDS' }] }),
            'I work on ThreatCrush. For a few VPSes, start with ...',
          ]),
        }),
    leadSources: () => [source],
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1/buyer-leads${path.replace(/^\/(?=\?|$)/, '')}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { seeded, call };
}

describe('leads API', () => {
  test('create, scan, list, draft, mark replied', async () => {
    const { call } = await harness('leads-api');
    const created = await call('POST', '/monitors', {
      name: 'ThreatCrush',
      url: 'https://threatcrush.com',
      keywords: ['intrusion detection'],
      subreddits: [],
      sources: ['hackernews'],
    });
    expect(created.status).toBe(201);
    const id = created.body.monitor.id as string;
    expect(id).toStartWith('lmn_');

    const scan = await call('POST', `/monitors/${id}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.body.result).toMatchObject({ read: 1, stored: 1, judged: 1, leads: 1 });

    const list = await call('GET', '/');
    expect(list.body.posting).toBe('manual');
    expect(list.body.monitors).toHaveLength(1);
    expect(list.body.leads).toHaveLength(1);
    const lead = list.body.leads[0];
    expect(lead).toMatchObject({ intent: 84, reason: 'wants an IDS', monitorName: 'ThreatCrush' });

    const drafted = await call('POST', `/${lead.id}/draft`);
    expect(drafted.status).toBe(200);
    expect(drafted.body.lead.replyDraft).toStartWith('I work on ThreatCrush');

    const marked = await call('PATCH', `/${lead.id}`, { status: 'replied' });
    expect(marked.body.lead.status).toBe('replied');

    const dismissedFilter = await call('GET', '/?status=dismissed');
    expect(dismissedFilter.body.leads).toHaveLength(0);
  });

  test('viewers read but cannot create, scan or draft', async () => {
    const { call } = await harness('leads-api-viewer', { actor: VIEWER });
    expect((await call('GET', '/')).status).toBe(200);
    expect((await call('POST', '/monitors', { name: 'X', keywords: ['x'] })).status).toBe(403);
  });

  test('bad input is a 400; a draft without a model is a 503', async () => {
    const { call } = await harness('leads-api-errors', { model: false });
    expect((await call('POST', '/monitors', {})).status).toBe(400);
    expect((await call('POST', '/monitors', { name: 'X', sources: ['myspace'] })).status).toBe(400);
    expect((await call('GET', '/?status=bogus')).status).toBe(400);

    const created = await call('POST', '/monitors', {
      name: 'ThreatCrush',
      keywords: ['intrusion detection'],
      sources: ['hackernews'],
    });
    const id = created.body.monitor.id as string;
    await call('POST', `/monitors/${id}/scan`);
    const [lead] = (await call('GET', '/')).body.leads;
    expect(lead.judged).toBe(false);
    const draft = await call('POST', `/${lead.id}/draft`);
    expect(draft.status).toBe(503);
    expect(draft.body.error.code).toBe('no_model');
  });
});
