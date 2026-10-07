import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { NewsResult, WebResult } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { scanListSources } from './list-sources';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const AT = new Date('2026-10-07T15:00:00Z');

function fakeSearcher() {
  const calls: string[] = [];
  return {
    calls,
    searcher: {
      async search(query: string): Promise<readonly WebResult[]> {
        calls.push(`web:${query}`);
        if (query.includes('official site')) {
          return [{ link: 'https://www.acmepay.com/', title: 'AcmePay' }];
        }
        // The event search.
        return [
          { link: 'https://paycon.example/2026/speakers', title: 'PayCon 2026 speakers' },
          { link: 'https://paycon.example/blog/recap', title: 'Recap' },
        ];
      },
      async searchNews(query: string): Promise<readonly NewsResult[]> {
        calls.push(`news:${query}`);
        if (query.includes('raises')) {
          return [
            {
              title: 'AcmePay raises $12M Series A to speed up payouts',
              link: 'https://news.example/acmepay-series-a',
              snippet: 'The round was led by Example Ventures.',
            },
            { title: 'Why payments startups struggle', link: 'https://news.example/opinion' },
          ];
        }
        return [];
      },
    },
  };
}

async function productIsPlanned(db: Client): Promise<void> {
  await db.execute({
    sql: `UPDATE offerings SET category = 'cross-border payments infrastructure' WHERE id = ?`,
    args: [SEED.offeringId],
  });
}

describe('scanListSources', () => {
  test('a funding headline becomes a company, a grounded signal and a crawl, once a week', async () => {
    seeded = await seedDatabase('lists-funding');
    const { db } = seeded;
    await productIsPlanned(db);
    const { searcher, calls } = fakeSearcher();

    const scans = await scanListSources({ db, searcher, now: AT }, SEED.workspaceId);
    expect(scans.map((scan) => [scan.kind, scan.items])).toEqual([
      ['funding', 1],
      ['leadership', 0],
      ['event', 1],
    ]);

    const signal = await queryOne<{ summary: string; evidence: string; signal_type: string }>(
      db,
      `SELECT s.summary, s.evidence, s.signal_type FROM signals s
         JOIN companies c ON c.id = s.company_id WHERE c.domain = 'acmepay.com'`,
    );
    expect(signal).toEqual({
      summary: 'AcmePay raised $12M Series A',
      evidence:
        'AcmePay raises $12M Series A to speed up payouts. The round was led by Example Ventures.',
      signal_type: 'funding',
    });

    const campaign = await queryOne<{ id: string; seed_kind: string; name: string }>(
      db,
      `SELECT id, seed_kind, name FROM campaigns WHERE seed_kind = 'signals'`,
    );
    expect(campaign?.name).toContain('Funding, new leaders and events');

    const crawls = await queryAll<{ payload_json: string }>(
      db,
      `SELECT payload_json FROM jobs WHERE kind = 'crawl_site' ORDER BY created_at`,
    );
    expect(crawls.map((job) => JSON.parse(job.payload_json).url)).toEqual([
      'https://acmepay.com',
      'https://paycon.example/2026/speakers',
    ]);
    expect(JSON.parse(crawls[0]!.payload_json).campaignId).toBe(campaign!.id);

    // The same week does not search again.
    const before = calls.length;
    expect(await scanListSources({ db, searcher, now: AT }, SEED.workspaceId)).toEqual([]);
    expect(calls.length).toBe(before);
  });

  test('stops at the daily search cap', async () => {
    seeded = await seedDatabase('lists-cap');
    const { db } = seeded;
    await productIsPlanned(db);
    await db.execute({
      sql: `INSERT INTO enrichment_usage (workspace_id, day, provider, lookups)
            VALUES (?, '2026-10-07', 'list_sources', 40)`,
      args: [SEED.workspaceId],
    });
    const { searcher, calls } = fakeSearcher();

    expect(await scanListSources({ db, searcher, now: AT }, SEED.workspaceId)).toEqual([]);
    expect(calls).toEqual([]);
  });
});
