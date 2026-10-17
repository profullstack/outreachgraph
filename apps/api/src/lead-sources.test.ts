/**
 * The lead base over HTTP: anyone signed in reads the status, only the
 * service token changes a source, and a campaign queues crawls for imported
 * companies it has not read.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { queryAll } from '@outreachgraph/db';
import { storeLeadCandidates } from '@outreachgraph/pipeline';
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

const SERVICE: RequestActor = { ...OWNER, userId: 'usr_service' };

async function setup(label: string, actor: RequestActor = OWNER) {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({ db: seeded.db, authenticate: async () => actor });
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

describe('lead sources API', () => {
  test('status lists every source with counts; only the service token may change one', async () => {
    const { call, db } = await setup('lead-sources-api');
    await storeLeadCandidates(
      db,
      'wikidata',
      [{ domain: 'roxio.com', name: 'Roxio', country: 'US' }],
      '2026-10-17T00:00:00.000Z',
    );
    const status = await call('GET', '/lead-sources');
    expect(status.status).toBe(200);
    const ids = status.body.sources.map((s: { id: string }) => s.id);
    expect(ids).toContain('wikidata');
    expect(ids).toContain('majestic-million');
    expect(ids).toContain('nichedb-podcasts');
    expect(status.body.sources.find((s: { id: string }) => s.id === 'wikidata').companies).toBe(1);
    expect(status.body.totals.imported).toBe(1);

    const denied = await call('PATCH', '/lead-sources/wikidata', { enabled: false });
    expect(denied.status).toBe(403);
  });

  test('the service token pauses a source and changes its cap', async () => {
    const { call } = await setup('lead-sources-api-service', SERVICE);
    const res = await call('PATCH', '/lead-sources/majestic-million', {
      enabled: false,
      dailyCap: 500,
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toMatchObject({
      id: 'majestic-million',
      enabled: false,
      dailyCap: 500,
    });
    const missing = await call('PATCH', '/lead-sources/nope', { enabled: false });
    expect(missing.status).toBe(404);
  });

  test('a campaign queues crawls for imported companies, once each', async () => {
    const { call, db } = await setup('lead-sources-api-pick');
    await storeLeadCandidates(
      db,
      'wikidata',
      [
        { domain: 'bakery.de', name: 'Bakery', industry: 'Food industry', country: 'DE' },
        { domain: 'roxio.com', name: 'Roxio', industry: 'software industry', country: 'US' },
      ],
      '2026-10-17T00:00:00.000Z',
    );
    const first = await call('POST', `/campaigns/${SEED.campaignId}/discover/leads`, {
      industry: 'software',
      limit: 10,
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ picked: 1, queued: 1 });
    expect(first.body.leads).toEqual([{ domain: 'roxio.com', name: 'Roxio', source: 'wikidata' }]);

    const jobs = await queryAll<{ payload_json: string; dedupe_key: string }>(
      db,
      `SELECT payload_json, dedupe_key FROM jobs WHERE kind = 'crawl_site'`,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.dedupe_key).toBe(`crawl:${SEED.campaignId}:roxio.com`);
    expect(JSON.parse(jobs[0]?.payload_json ?? '{}')).toEqual({
      url: 'https://roxio.com',
      campaignId: SEED.campaignId,
    });

    const again = await call('POST', `/campaigns/${SEED.campaignId}/discover/leads`, {
      industry: 'software',
    });
    expect(again.body).toMatchObject({ picked: 0, queued: 0 });

    const missing = await call('POST', '/campaigns/cmp_nope/discover/leads', {});
    expect(missing.status).toBe(404);
  });
});
