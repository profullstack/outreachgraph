/**
 * nichedb discovery: items in, crawls out, and the next run queued.
 *
 * Only the network is stubbed. The queue is the real one, so what the test
 * asserts is the row a worker would claim next.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { enqueue, claimNext } from './queue';
import {
  candidateUrl,
  hostOf,
  isSkippedHost,
  nichedbDiscoveryStatus,
  originOf,
  runNichedbDiscoveryJob,
  stopNichedbDiscovery,
} from './nichedb-discovery';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ITEMS: Record<string, unknown[]> = {
  webrings: [
    {
      id: 1,
      collection: 'webrings',
      kind: 'ring',
      url: 'https://rssamplifier.com/ring/small-web',
      updated_at: '2026-09-13T10:00:00.000Z',
    },
    {
      id: 2,
      collection: 'webrings',
      kind: 'member',
      url: 'https://chovy.com/',
      updated_at: '2026-09-13T10:05:00.000Z',
      data: { made_by: 'human' },
    },
    {
      id: 3,
      collection: 'webrings',
      kind: 'member',
      url: 'https://www.chovy.com/blog',
      updated_at: '2026-09-13T10:06:00.000Z',
    },
    {
      id: 4,
      collection: 'webrings',
      kind: 'member',
      url: 'https://github.com/profullstack',
      updated_at: '2026-09-13T10:07:00.000Z',
    },
  ],
  sites: [
    {
      id: 5,
      collection: 'sites',
      kind: 'page',
      url: 'https://example-com.l.ink/',
      updated_at: '2026-09-13T11:00:00.000Z',
    },
    {
      id: 6,
      collection: 'sites',
      kind: 'page',
      url: 'https://david.weekly.org/about',
      updated_at: '2026-09-13T11:30:00.000Z',
    },
  ],
  profiles: [
    {
      id: 7,
      collection: 'profiles',
      kind: 'person',
      url: 'https://nichedb.dev/c/profiles/ada-1',
      updated_at: '2026-09-13T09:00:00.000Z',
      data: {
        accounts: [
          { network: 'github', url: 'https://github.com/ada' },
          { network: 'website', url: 'https://ada.example/' },
        ],
      },
    },
    {
      id: 8,
      collection: 'profiles',
      kind: 'person',
      url: 'https://nichedb.dev/c/profiles/nobody-2',
      updated_at: '2026-09-13T09:30:00.000Z',
      data: {},
    },
  ],
};

function stubNichedb(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const parsed = new URL(url);
    const collection = parsed.searchParams.get('collection') ?? '';
    const since = parsed.searchParams.get('since');
    const items = (ITEMS[collection] ?? []).filter(
      (i) => !since || String((i as { updated_at: string }).updated_at) > since,
    );
    return { count: items.length, items };
  };
}

describe('candidate urls', () => {
  test('a webring member is its site; a ring is not; a profile is its website or nothing', () => {
    expect(candidateUrl(ITEMS.webrings![0] as never)).toBeNull();
    expect(candidateUrl(ITEMS.webrings![1] as never)).toBe('https://chovy.com/');
    expect(candidateUrl(ITEMS.profiles![0] as never)).toBe('https://ada.example/');
    expect(candidateUrl(ITEMS.profiles![1] as never)).toBeNull();
    expect(candidateUrl(ITEMS.sites![1] as never)).toBe('https://david.weekly.org/about');
  });

  test('hosts drop www, refuse junk, and skip platforms and our own', () => {
    expect(hostOf('https://www.chovy.com/blog')).toBe('chovy.com');
    expect(hostOf('mailto:a@b.c')).toBeNull();
    expect(hostOf('https://localhost/')).toBeNull();
    expect(originOf('https://www.chovy.com/blog?x=1')).toBe('https://chovy.com');
    expect(isSkippedHost('github.com')).toBe(true);
    expect(isSkippedHost('gist.github.com')).toBe(true);
    expect(isSkippedHost('nichedb.dev')).toBe(true);
    expect(isSkippedHost('example-com.l.ink')).toBe(true);
    expect(isSkippedHost('david.weekly.org')).toBe(false);
  });
});

describe('discover_nichedb', () => {
  test('reads each collection, queues one crawl per new site, and queues itself again', async () => {
    seeded = await seedDatabase('nichedb-discovery');
    const { db } = seeded;
    const calls: string[] = [];

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'discover_nichedb',
      payload: { campaignId: SEED.campaignId, everyMs: 3_600_000 },
    });
    const job = await claimNext(db, SEED.workspaceId);
    expect(job?.kind).toBe('discover_nichedb');

    const result = await runNichedbDiscoveryJob({ db, fetchJson: stubNichedb(calls) }, job!);

    expect(result.read).toBe(8);
    // chovy.com once (www and path folded), david.weekly.org, ada.example.
    // github.com and the l.ink page are skipped; the ring and the empty
    // profile are not sites.
    expect(result.candidates).toBe(3);
    expect(result.queued).toBe(3);
    expect(result.next).toBe('2026-09-13T11:30:00.000Z');
    expect(result.rescheduled).toBe(true);
    expect(calls.length).toBe(3);

    const crawls = await queryAll<{ payload_json: string; dedupe_key: string; batch_id: string }>(
      db,
      `SELECT payload_json, dedupe_key, batch_id FROM jobs WHERE kind = 'crawl_site' ORDER BY dedupe_key`,
    );
    expect(crawls.map((c) => c.dedupe_key)).toEqual([
      `crawl:${SEED.campaignId}:ada.example`,
      `crawl:${SEED.campaignId}:chovy.com`,
      `crawl:${SEED.campaignId}:david.weekly.org`,
    ]);
    expect(crawls.every((c) => c.batch_id === job!.id)).toBe(true);
    expect(JSON.parse(crawls[1]!.payload_json)).toEqual({
      url: 'https://chovy.com',
      campaignId: SEED.campaignId,
    });

    const pending = await nichedbDiscoveryStatus(db, SEED.workspaceId, SEED.campaignId);
    expect(pending.length).toBe(2);
    const next = pending.find((p) => p.status === 'pending');
    expect(next?.since).toBe('2026-09-13T11:30:00.000Z');
  });

  test('the next run reads only what changed, and a second run cannot double the next', async () => {
    seeded = await seedDatabase('nichedb-discovery-next');
    const { db } = seeded;
    const calls: string[] = [];

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'discover_nichedb',
      payload: {
        campaignId: SEED.campaignId,
        collections: ['sites'],
        since: '2026-09-13T11:00:00.000Z',
        everyMs: 3_600_000,
      },
    });
    const job = await claimNext(db, SEED.workspaceId);
    const result = await runNichedbDiscoveryJob({ db, fetchJson: stubNichedb(calls) }, job!);
    expect(result.read).toBe(1);
    expect(result.queued).toBe(1);
    expect(calls[0]).toContain('since=2026-09-13T11%3A00%3A00.000Z');

    // Running it again while the next is still queued does not queue a third.
    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'discover_nichedb',
      payload: { campaignId: SEED.campaignId, collections: ['sites'], everyMs: 3_600_000 },
      dedupeKey: 'test:second',
    });
    // The crawl the first run queued is older and claims first; skip past it.
    let again = await claimNext(db, SEED.workspaceId);
    while (again && again.kind !== 'discover_nichedb')
      again = await claimNext(db, SEED.workspaceId);
    expect(again?.kind).toBe('discover_nichedb');
    const second = await runNichedbDiscoveryJob({ db, fetchJson: stubNichedb(calls) }, again!);
    expect(second.rescheduled).toBe(false);
  });

  test('stopping removes the pending run and a stopped job does not requeue', async () => {
    seeded = await seedDatabase('nichedb-discovery-stop');
    const { db } = seeded;

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'discover_nichedb',
      payload: { campaignId: SEED.campaignId, collections: ['sites'], everyMs: 3_600_000 },
    });
    expect(await stopNichedbDiscovery(db, SEED.workspaceId, SEED.campaignId)).toBe(1);
    expect(await nichedbDiscoveryStatus(db, SEED.workspaceId, SEED.campaignId)).toEqual([]);
    expect(await claimNext(db, SEED.workspaceId)).toBeUndefined();

    // A run whose own row was deleted under it finishes without a successor.
    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'discover_nichedb',
      payload: { campaignId: SEED.campaignId, collections: ['sites'], everyMs: 3_600_000 },
    });
    const job = await claimNext(db, SEED.workspaceId);
    await db.execute({ sql: `DELETE FROM jobs WHERE id = ?`, args: [job!.id] });
    const result = await runNichedbDiscoveryJob({ db, fetchJson: stubNichedb([]) }, job!);
    expect(result.rescheduled).toBe(false);
    expect(await nichedbDiscoveryStatus(db, SEED.workspaceId, SEED.campaignId)).toEqual([]);
  });
});
