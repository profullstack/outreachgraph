/**
 * Asking a campaign's seed again.
 *
 * The cases are about restraint: only an idle campaign, only after the
 * interval, only once per interval — and then the right kind of job for the
 * kind of seed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { reseedIdleCampaigns } from './reseed';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const TEN_DAYS_AGO = new Date(Date.now() - 10 * 86_400_000).toISOString();

async function seededCampaign(
  db: Client,
  options: { kind: 'url' | 'keyword'; value: string; startedAt?: string },
): Promise<void> {
  await db.execute({
    sql: `UPDATE campaigns SET status = 'active', seed_kind = ?, seed_value = ?, started_at = ?
           WHERE id = ?`,
    args: [options.kind, options.value, options.startedAt ?? TEN_DAYS_AGO, SEED.campaignId],
  });
}

async function jobs(db: Client): Promise<{ kind: string; payload_json: string; status: string }[]> {
  return queryAll(db, 'SELECT kind, payload_json, status FROM jobs WHERE workspace_id = ?', [
    SEED.workspaceId,
  ]);
}

describe('reseedIdleCampaigns', () => {
  test('reads a URL seed again after the interval, once', async () => {
    seeded = await seedDatabase('reseed-url');
    const { db } = seeded;
    await seededCampaign(db, { kind: 'url', value: 'acme.com/team' });

    const first = await reseedIdleCampaigns(db, { workspaceId: SEED.workspaceId });
    expect(first).toEqual({ considered: 1, queued: 1 });

    const queued = await jobs(db);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.kind).toBe('crawl_site');
    expect(JSON.parse(queued[0]?.payload_json ?? '{}')).toEqual({
      url: 'https://acme.com/team',
      campaignId: SEED.campaignId,
    });

    const campaign = await queryOne<{ reseeded_at: string | null }>(
      db,
      'SELECT reseeded_at FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(campaign?.reseeded_at).not.toBeNull();

    // The stamp holds it for another interval.
    const second = await reseedIdleCampaigns(db, { workspaceId: SEED.workspaceId });
    expect(second).toEqual({ considered: 0, queued: 0 });
  });

  test('a keyword seed is discovered again rather than crawled', async () => {
    seeded = await seedDatabase('reseed-keyword');
    const { db } = seeded;
    await seededCampaign(db, { kind: 'keyword', value: 'dental practices in Austin' });

    await reseedIdleCampaigns(db, { workspaceId: SEED.workspaceId });

    const queued = await jobs(db);
    expect(queued.map((job) => job.kind)).toEqual(['discover_domains']);
    expect(JSON.parse(queued[0]?.payload_json ?? '{}').keyword).toBe('dental practices in Austin');
  });

  test('a campaign seeded recently is left alone', async () => {
    seeded = await seedDatabase('reseed-recent');
    const { db } = seeded;
    await seededCampaign(db, { kind: 'url', value: 'acme.com', startedAt: now() });

    const result = await reseedIdleCampaigns(db, { workspaceId: SEED.workspaceId });
    expect(result.considered).toBe(0);
    expect(await jobs(db)).toHaveLength(0);
  });

  test('a campaign with work outstanding is not idle', async () => {
    seeded = await seedDatabase('reseed-busy');
    const { db } = seeded;
    await seededCampaign(db, { kind: 'url', value: 'acme.com' });

    await db.execute({
      sql: `INSERT INTO jobs (id, workspace_id, kind, payload_json, status, attempts, max_attempts,
            run_after, created_at, updated_at)
            VALUES ('job_busy', ?, 'crawl_site', ?, 'pending', 0, 5, ?, ?, ?)`,
      args: [
        SEED.workspaceId,
        JSON.stringify({ url: 'https://acme.com/about', campaignId: SEED.campaignId }),
        now(),
        now(),
        now(),
      ],
    });

    const result = await reseedIdleCampaigns(db, { workspaceId: SEED.workspaceId });
    expect(result.considered).toBe(0);
    expect(await jobs(db)).toHaveLength(1);
  });
});
