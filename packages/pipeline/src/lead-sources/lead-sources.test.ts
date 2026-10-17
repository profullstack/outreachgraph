/**
 * Lead importers: open lists in, companies out, deduped on the domain, each
 * source on its own cap and cursor.
 *
 * Only the network is stubbed. The database is the real one, so what the
 * tests assert is what a status view or a campaign would read next.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../../apps/api/src/test-seed';
import { enqueue } from '../queue';
import { countryFromDomain, leadDomain, registrableDomain } from './domains';
import {
  leadBaseStatus,
  pickImportedLeads,
  storeLeadCandidates,
  sweepLeadSources,
  updateLeadSource,
} from './runner';
import {
  majesticSource,
  nichedbSource,
  wikidataQuery,
  wikidataSource,
  type LeadSourceDefinition,
} from './sources';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('leadDomain', () => {
  test('reduces a URL to the registered domain', () => {
    expect(leadDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(leadDomain('shop.acme.co.uk')).toBe('acme.co.uk');
    expect(leadDomain('https://podcast.chs.harvard.edu/series/x/')).toBe('harvard.edu');
    expect(registrableDomain('a.b.example.com.au')).toBe('example.com.au');
  });

  test('drops infrastructure, public bodies, adult sites and junk', () => {
    expect(leadDomain('d1.cloudfront.net')).toBeNull();
    expect(leadDomain('googletagmanager.com')).toBeNull();
    expect(leadDomain('bit.ly')).toBeNull();
    expect(leadDomain('https://www.irs.gov')).toBeNull();
    expect(leadDomain('https://www.gov.uk')).toBeNull();
    expect(leadDomain('army.mil')).toBeNull();
    expect(leadDomain('somepornsite.com')).toBeNull();
    expect(leadDomain('fastcdnhost.net')).toBeNull();
    expect(leadDomain('not a url')).toBeNull();
    expect(leadDomain('http://192.168.1.1/')).toBeNull();
    expect(leadDomain('')).toBeNull();
  });

  test('a page on a platform is not the platform, but the platform root is a company', () => {
    expect(leadDomain('https://friendsoflulu.wordpress.com/')).toBeNull();
    expect(leadDomain('https://someone.github.io')).toBeNull();
    expect(leadDomain('https://github.com/acme/tool')).toBe('github.com');
    expect(leadDomain('https://wordpress.com')).toBe('wordpress.com');
    expect(leadDomain('https://anchor.fm/show', { dropPlatformRoots: true })).toBeNull();
    expect(
      leadDomain('https://dts.podtrac.com/redirect.mp3/x', { dropPlatformRoots: true }),
    ).toBeNull();
  });

  test('country comes from a real ccTLD only', () => {
    expect(countryFromDomain('frieling.de')).toBe('DE');
    expect(countryFromDomain('acme.co.uk')).toBe('GB');
    expect(countryFromDomain('klarivo.ai')).toBeNull();
    expect(countryFromDomain('acme.io')).toBeNull();
    expect(countryFromDomain('acme.com')).toBeNull();
  });
});

describe('wikidata source', () => {
  test('keyset-pages on the item and maps the fields', async () => {
    expect(wikidataQuery(null, 10)).not.toContain('FILTER(STR(?item)');
    expect(wikidataQuery('Q42', 10)).toContain('"http://www.wikidata.org/entity/Q42"');
    // Nothing but a Q-id ever reaches the query text.
    expect(wikidataQuery('Q1"} DROP', 10)).toContain('entity/Q1"');

    const bodies: string[] = [];
    const source = wikidataSource('https://sparql.test/');
    const batch = await source.read({
      cursor: 'Q1',
      max: 3,
      fetch: (async (_url: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ''));
        return json({
          results: {
            bindings: [
              {
                item: { value: 'http://www.wikidata.org/entity/Q10' },
                website: { value: 'https://www.frieling.de/' },
                country: { value: 'DE' },
                industry: { value: 'food industry' },
                employees: { value: '120' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q11' },
                website: { value: 'https://friendsoflulu.wordpress.com/' },
                name: { value: 'Friends of Lulu' },
              },
              {
                item: { value: 'http://www.wikidata.org/entity/Q12' },
                website: { value: 'http://www.roxio.com' },
                name: { value: 'Roxio' },
              },
            ],
          },
        });
      }) as typeof fetch,
    });
    expect(decodeURIComponent(bodies[0] ?? '')).toContain('entity/Q1"');
    expect(batch.candidates).toEqual([
      {
        domain: 'frieling.de',
        name: 'frieling.de',
        industry: 'food industry',
        country: 'DE',
        employees: 120,
        ref: 'Q10',
      },
      {
        domain: 'roxio.com',
        name: 'Roxio',
        industry: null,
        country: null,
        employees: null,
        ref: 'Q12',
      },
    ]);
    // A full page: more to come, from after the last item read (kept or not).
    expect(batch).toMatchObject({ cursor: 'Q12', seen: 3, done: false });
  });

  test('a short page is the end of the list', async () => {
    const batch = await wikidataSource('https://sparql.test/').read({
      cursor: 'Q99',
      max: 10,
      fetch: (async () => json({ results: { bindings: [] } })) as unknown as typeof fetch,
    });
    expect(batch).toMatchObject({ cursor: null, done: true, seen: 0 });
  });
});

const MAJESTIC =
  [
    'GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs',
    '1,1,google.com,com,1,1,google.com,com,1,1,1,1',
    '2,2,googletagmanager.com,com,1,1,googletagmanager.com,com,2,2,1,1',
    '3,3,acme.de,de,1,1,acme.de,de,3,3,1,1',
    '4,4,sites.google.com,com,1,1,sites.google.com,com,4,4,1,1',
    '5,5,widgets.io,io,1,1,widgets.io,io,5,5,1,1',
    '6,6,shop.example.co.uk,uk,1,1,x,uk,6,6,1,1',
    '7,7,zeta.com,com,1,1,zeta.com,com,7,7,1,1',
  ].join('\n') + '\n';

function rangedFetch(text: string, chunk = 17): typeof fetch {
  const bytes = new TextEncoder().encode(text);
  return (async (_url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    if (from >= bytes.length) return new Response(null, { status: 416 });
    const slice = bytes.slice(from);
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= slice.length) return controller.close();
        controller.enqueue(slice.slice(at, at + chunk));
        at += chunk;
      },
    });
    return new Response(stream, { status: range ? 206 : 200 });
  }) as typeof fetch;
}

describe('majestic source', () => {
  test('reads by byte range and resumes where it stopped', async () => {
    const source = majesticSource('https://majestic.test/m.csv');
    const doFetch = rangedFetch(MAJESTIC);
    const first = await source.read({ cursor: null, max: 2, fetch: doFetch });
    expect(first.candidates.map((c) => c.domain)).toEqual(['google.com', 'acme.de']);
    expect(first.candidates[1]).toMatchObject({ country: 'DE', rank: 3, ref: '3' });
    expect(first.done).toBe(false);

    const second = await source.read({ cursor: first.cursor, max: 10, fetch: doFetch });
    // sites.google.com is a page on Google; shop.example.co.uk is not a registered domain.
    expect(second.candidates.map((c) => c.domain)).toEqual(['widgets.io', 'zeta.com']);
    expect(second.done).toBe(true);
    expect(second.cursor).toBeNull();
  });

  test('a range past the end is the end', async () => {
    const batch = await majesticSource('https://majestic.test/m.csv').read({
      cursor: JSON.stringify({ offset: 10_000 }),
      max: 5,
      fetch: rangedFetch(MAJESTIC),
    });
    expect(batch).toMatchObject({ done: true, cursor: null, candidates: [] });
  });

  test('refuses a server that ignores the range', async () => {
    const ignoring = (async () =>
      new Response(MAJESTIC, { status: 200 })) as unknown as typeof fetch;
    await expect(
      majesticSource('https://majestic.test/m.csv').read({
        cursor: JSON.stringify({ offset: 40 }),
        max: 5,
        fetch: ignoring,
      }),
    ).rejects.toThrow('ignored the byte range');
  });
});

describe('nichedb source', () => {
  test('pages by since and keeps the business site', async () => {
    const urls: string[] = [];
    const source = nichedbSource(
      {
        collection: 'saas',
        label: 'saas',
        dailyCap: 10,
        siteOf: (item) => (item.data?.website as string | undefined) ?? null,
        industryOf: (item) => (item.data?.category as string | undefined) ?? null,
      },
      'https://nichedb.test/api/v1/items',
    );
    const batch = await source.read({
      cursor: '2026-10-01T00:00:00.000Z',
      max: 10,
      fetch: (async (url: string) => {
        urls.push(url);
        return json({
          items: [
            {
              id: 1,
              title: 'Klarivo',
              updated_at: '2026-10-02T00:00:00.000Z',
              data: { website: 'https://www.klarivo.ai', category: 'Marketing' },
            },
            {
              id: 2,
              title: 'On Anchor',
              updated_at: '2026-10-03T00:00:00.000Z',
              data: { website: 'https://anchor.fm/x' },
            },
          ],
        });
      }) as typeof fetch,
    });
    expect(urls[0]).toContain('since=2026-10-01T00%3A00%3A00.000Z');
    expect(urls[0]).toContain('collection=saas');
    expect(batch.candidates).toEqual([
      {
        domain: 'klarivo.ai',
        name: 'Klarivo',
        industry: 'Marketing',
        country: null,
        ref: '1',
      },
    ]);
    // Caught up: keeps the newest timestamp, and says so.
    expect(batch).toMatchObject({ cursor: '2026-10-03T00:00:00.000Z', done: true, seen: 2 });
  });
});

function fakeSource(
  id: string,
  pages: string[][],
  overrides: Partial<LeadSourceDefinition> = {},
): LeadSourceDefinition & { calls: { cursor: string | null; max: number }[] } {
  const calls: { cursor: string | null; max: number }[] = [];
  return {
    id,
    label: id,
    homepage: 'https://example.test',
    license: 'test',
    dailyCap: 100,
    batchSize: 50,
    everyMinutes: 10,
    restartAfterDays: 7,
    calls,
    async read({ cursor, max }) {
      calls.push({ cursor, max });
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index] ?? [];
      const done = index + 1 >= pages.length;
      return {
        candidates: page.slice(0, max).map((domain) => ({ domain, name: domain, country: null })),
        cursor: done ? null : String(index + 1),
        seen: page.length,
        done,
      };
    },
    ...overrides,
  };
}

describe('sweepLeadSources', () => {
  test('stores new domains once, books the cursor, and skips a source until it is due', async () => {
    seeded = await seedDatabase('lead-sweep-store');
    const db = seeded.db;
    // The seed already holds Acme (acme.com), as the crawler would have made it.
    const source = fakeSource('fake', [
      ['acme.com', 'beta.com', 'beta.com', 'gamma.io'],
      ['delta.de'],
    ]);
    const at = new Date('2026-10-17T12:00:00.000Z');

    const first = await sweepLeadSources({ db, sources: [source], now: () => at });
    expect(first).toEqual([{ source: 'fake', seen: 4, candidates: 4, added: 2, done: false }]);
    const acme = await queryOne<{ name: string; lead_source: string | null }>(
      db,
      `SELECT name, lead_source FROM companies WHERE domain = 'acme.com'`,
    );
    // A domain already known is left exactly as it was.
    expect(acme).toEqual({ name: 'Acme', lead_source: null });

    // Not due yet: nothing read.
    const again = await sweepLeadSources({ db, sources: [source], now: () => at });
    expect(again[0]?.skipped).toBe('not_due');
    expect(source.calls).toHaveLength(1);

    const later = new Date(at.getTime() + 11 * 60_000);
    const second = await sweepLeadSources({ db, sources: [source], now: () => later });
    expect(second[0]).toMatchObject({ added: 1, done: true });
    expect(source.calls[1]?.cursor).toBe('1');

    const row = await queryOne<{
      cursor: string | null;
      added_today: number;
      added_total: number;
      next_run_at: string;
      exhausted_at: string | null;
    }>(
      db,
      `SELECT cursor, added_today, added_total, next_run_at, exhausted_at FROM lead_sources WHERE id = 'fake'`,
    );
    expect(row?.cursor).toBeNull();
    expect(Number(row?.added_today)).toBe(3);
    expect(Number(row?.added_total)).toBe(3);
    expect(row?.exhausted_at).not.toBeNull();
    // At the end of the list it waits restartAfterDays before reading from the top.
    expect(row?.next_run_at).toBe(new Date(later.getTime() + 7 * 86_400_000).toISOString());

    const status = await leadBaseStatus(db, { sources: [source], now: later });
    expect(status.sources[0]).toMatchObject({
      id: 'fake',
      companies: 3,
      addedToday: 3,
      dailyCap: 100,
    });
    expect(status.totals.imported).toBe(3);
    expect(status.totals.companies).toBeGreaterThanOrEqual(4);
  });

  test('honours the daily cap and the total across sources, then waits for midnight', async () => {
    seeded = await seedDatabase('lead-sweep-cap');
    const db = seeded.db;
    const a = fakeSource('a', [['a1.com', 'a2.com', 'a3.com', 'a4.com'], ['a5.com']], {
      dailyCap: 3,
    });
    const b = fakeSource('b', [['b1.com', 'b2.com', 'b3.com']]);
    const at = new Date('2026-10-17T12:00:00.000Z');

    const results = await sweepLeadSources({ db, sources: [a, b], dailyTotal: 4, now: () => at });
    expect(results.map((r) => [r.source, r.added])).toEqual([
      ['a', 3],
      ['b', 1],
    ]);
    expect(a.calls[0]?.max).toBe(3);
    expect(b.calls[0]?.max).toBe(1);

    const capped = await sweepLeadSources({
      db,
      sources: [a, b],
      dailyTotal: 4,
      now: () => at,
      force: true,
    });
    expect(capped.map((r) => r.skipped)).toEqual(['cap_reached', 'cap_reached']);
    const next = await queryOne<{ next_run_at: string }>(
      db,
      `SELECT next_run_at FROM lead_sources WHERE id = 'a'`,
    );
    expect(next?.next_run_at).toBe('2026-10-18T00:00:00.000Z');

    // A new day resets the count.
    const tomorrow = new Date('2026-10-18T00:05:00.000Z');
    const day2 = await sweepLeadSources({
      db,
      sources: [a, b],
      dailyTotal: 4,
      now: () => tomorrow,
    });
    expect(day2.find((r) => r.source === 'a')?.added).toBe(1);
  });

  test('records a failure and backs off instead of throwing', async () => {
    seeded = await seedDatabase('lead-sweep-fail');
    const db = seeded.db;
    const broken = fakeSource('broken', [], {
      async read() {
        throw new Error('upstream 503');
      },
    });
    const at = new Date('2026-10-17T12:00:00.000Z');
    const results = await sweepLeadSources({ db, sources: [broken], now: () => at });
    expect(results[0]).toMatchObject({ source: 'broken', added: 0, error: 'upstream 503' });
    const row = await queryOne<{ last_error: string; next_run_at: string }>(
      db,
      `SELECT last_error, next_run_at FROM lead_sources WHERE id = 'broken'`,
    );
    expect(row?.last_error).toBe('upstream 503');
    expect(row?.next_run_at).toBe('2026-10-17T12:30:00.000Z');
  });

  test('a disabled source is not read; a cap change and run-now apply', async () => {
    seeded = await seedDatabase('lead-sweep-toggle');
    const db = seeded.db;
    const source = fakeSource('s', [['x1.com', 'x2.com']]);
    const at = new Date('2026-10-17T12:00:00.000Z');
    expect(await updateLeadSource(db, 'nope', { enabled: false }, { sources: [source] })).toBe(
      false,
    );
    expect(
      await updateLeadSource(db, 's', { enabled: false }, { sources: [source], now: at }),
    ).toBe(true);
    const off = await sweepLeadSources({ db, sources: [source], now: () => at });
    expect(off[0]?.skipped).toBe('disabled');
    expect(source.calls).toHaveLength(0);

    await updateLeadSource(
      db,
      's',
      { enabled: true, dailyCap: 1, runNow: true },
      { sources: [source], now: at },
    );
    const on = await sweepLeadSources({ db, sources: [source], now: () => at });
    expect(on[0]?.added).toBe(1);
  });
});

describe('pickImportedLeads', () => {
  test('picks imported companies a campaign has not crawled, best rank first', async () => {
    seeded = await seedDatabase('lead-pick');
    const db = seeded.db;
    const stamp = '2026-10-17T12:00:00.000Z';
    await storeLeadCandidates(
      db,
      'majestic-million',
      [
        { domain: 'rank9.com', name: 'rank9.com', rank: 9, country: null },
        { domain: 'rank2.de', name: 'rank2.de', rank: 2, country: 'DE' },
      ],
      stamp,
    );
    await storeLeadCandidates(
      db,
      'wikidata',
      [{ domain: 'bakery.de', name: 'Bakery', industry: 'Food industry', country: 'DE' }],
      stamp,
    );
    const campaignId = SEED.campaignId;
    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://rank2.de', campaignId },
      dedupeKey: `crawl:${campaignId}:rank2.de`,
    });

    const all = await pickImportedLeads(db, SEED.workspaceId, campaignId, { limit: 10 });
    expect(all.map((l) => l.domain)).toEqual(['rank9.com', 'bakery.de']);

    const food = await pickImportedLeads(db, SEED.workspaceId, campaignId, {
      industry: 'food',
      country: 'de',
      limit: 10,
    });
    expect(food.map((l) => l.domain)).toEqual(['bakery.de']);

    const bySource = await pickImportedLeads(db, SEED.workspaceId, campaignId, {
      sources: ['majestic-million'],
      limit: 10,
    });
    expect(bySource.map((l) => l.source)).toEqual(['majestic-million']);

    const rows = await queryAll<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM companies WHERE lead_source IS NOT NULL`,
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  test('weakest reachable SEO first, unreachable never, maxScore and rank sort', async () => {
    seeded = await seedDatabase('lead-pick-seo');
    const db = seeded.db;
    const stamp = '2026-10-17T12:00:00.000Z';
    await storeLeadCandidates(
      db,
      'majestic-million',
      [
        { domain: 'strong.com', name: 'strong.com', rank: 1, country: null },
        { domain: 'weak-few.com', name: 'weak-few.com', rank: 2, country: null },
        { domain: 'weak-many.com', name: 'weak-many.com', rank: 3, country: null },
        { domain: 'unaudited.com', name: 'unaudited.com', rank: 4, country: null },
        { domain: 'down.com', name: 'down.com', rank: 5, country: null },
      ],
      stamp,
    );
    const audit = async (
      domain: string,
      status: string,
      score: number | null,
      issues: number | null,
    ) => {
      const row = await queryAll<{ id: string }>(db, 'SELECT id FROM companies WHERE domain = ?', [
        domain,
      ]);
      await db.execute({
        sql: `INSERT INTO site_audits (company_id, url, status, score, grade, fixes_json, issues,
                attempts, checked_at, next_audit_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'X', '[]', ?, 0, ?, ?, ?, ?)`,
        args: [row[0]!.id, `https://${domain}/`, status, score, issues, stamp, stamp, stamp, stamp],
      });
    };
    await audit('strong.com', 'ok', 95, 1);
    await audit('weak-few.com', 'ok', 55, 4);
    await audit('weak-many.com', 'ok', 62, 9);
    await audit('down.com', 'failed', null, null);

    const picked = await pickImportedLeads(db, SEED.workspaceId, SEED.campaignId, { limit: 10 });
    expect(picked.map((l) => l.domain)).toEqual([
      'weak-many.com',
      'weak-few.com',
      'unaudited.com',
      'strong.com',
    ]);
    expect(picked[0]).toMatchObject({ score: 62, issues: 9 });
    expect(picked[2]).toMatchObject({ score: null, issues: null });

    const capped = await pickImportedLeads(db, SEED.workspaceId, SEED.campaignId, {
      maxScore: 60,
      limit: 10,
    });
    expect(capped.map((l) => l.domain)).toEqual(['weak-few.com']);

    const byRank = await pickImportedLeads(db, SEED.workspaceId, undefined, {
      sort: 'rank',
      limit: 10,
    });
    expect(byRank.map((l) => l.domain)).toEqual([
      'strong.com',
      'weak-few.com',
      'weak-many.com',
      'unaudited.com',
    ]);
  });
});
