/**
 * The seam test.
 *
 * Every piece of the URL-first path has unit tests; none of them proved the
 * pieces compose. This drives the real queue, the real crawl job and the real
 * chain, and asserts that a URL goes in and an approval card comes out.
 *
 * Only the network is stubbed — the HTML below is the shape a real company page
 * has, taken from what stripe.com and vercel.com actually serve: an
 * Organization block, social links in the footer, and a Person block of the
 * sort a team page carries.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { SiteProvider, type FetchLike } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { drainQueue, enqueue, type QueuedJob } from './queue';
import { runCrawlJob } from './crawl';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const COMPANY_HTML = `<!doctype html><html><head>
  <title>Loopwright — agent reliability</title>
  <meta property="og:site_name" content="Loopwright" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Loopwright",
     "description":"Reliability tooling for agent teams.",
     "sameAs":["https://github.com/loopwright","https://x.com/loopwright"]}
  </script>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Alex Chen",
     "jobTitle":"Staff Engineer","sameAs":["https://github.com/alexchen"]}
  </script>
</head><body>
  <footer>
    <a href="https://www.youtube.com/watch?v=xyz">our video</a>
    <a href="https://github.com/loopwright">code</a>
  </footer>
</body></html>`;

function stubNetwork(html = COMPANY_HTML): FetchLike {
  return async (input) => {
    const url = input.toString();
    if (url.endsWith('/robots.txt')) {
      return new Response('User-agent: *\nAllow: /', {
        headers: { 'content-type': 'text/plain' },
      });
    }
    return new Response(html, { headers: { 'content-type': 'text/html' } });
  };
}

async function setup(label: string): Promise<SeededDatabase> {
  seeded = await seedDatabase(label);
  return seeded;
}

describe('URL to approval card', () => {
  test('a queued URL becomes a person, a score and a recommendation', async () => {
    const { db } = await setup('e2e-happy');

    const added = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://loopwright.io' },
    });
    expect(added.queued).toBe(true);

    const site = new SiteProvider({ fetchImpl: stubNetwork() });

    // The real drain, claiming the real row and calling the real handler.
    const summary = await drainQueue(db, async (job: QueuedJob) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    expect(summary.processed).toBe(1);
    expect(summary.succeeded).toBe(1);

    const person = await queryOne<{ id: string; display_name: string; current_title: string }>(
      db,
      'SELECT id, display_name, current_title FROM people WHERE display_name = ?',
      ['Alex Chen'],
    );
    expect(person?.display_name).toBe('Alex Chen');
    expect(person?.current_title).toBe('Staff Engineer');

    // Filed into the workspace's campaign, or the card has nowhere to appear.
    const membership = await queryOne<{ status: string }>(
      db,
      'SELECT status FROM campaign_people WHERE person_id = ?',
      [person!.id],
    );
    expect(membership).toBeDefined();

    const scores = await queryAll(db, 'SELECT id FROM scores WHERE person_id = ?', [person!.id]);
    expect(scores.length).toBeGreaterThan(0);

    const recommendation = await queryOne<{ id: string; action: string; network: string }>(
      db,
      'SELECT id, action, network FROM recommendations WHERE person_id = ?',
      [person!.id],
    );
    expect(recommendation).toBeDefined();

    const job = await queryOne<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', [
      added.id!,
    ]);
    expect(job?.status).toBe('done');
  });

  test('provenance records the crawler, not GitHub', async () => {
    const { db } = await setup('e2e-provenance');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://loopwright.io' },
    });

    const site = new SiteProvider({ fetchImpl: stubNetwork() });
    await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    const provenance = await queryOne<{
      provider: string;
      source_type: string;
      license_class: string;
    }>(
      db,
      `SELECT provider, source_type, license_class FROM field_provenance
         WHERE field = 'fullName' LIMIT 1`,
    );

    // Attribution decides what may be retained and exported (PRD §35). A
    // scraped name labelled as an API fact would misclassify it.
    expect(provenance?.provider).toBe('site');
    expect(provenance?.source_type).toBe('public_web');
    expect(provenance?.license_class).toBe('public_web');
  });

  test('a page naming nobody completes the job rather than retrying it', async () => {
    const { db } = await setup('e2e-nobody');

    const added = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://empty.example' },
    });

    const site = new SiteProvider({
      fetchImpl: stubNetwork('<html><body><p>We build things.</p></body></html>'),
    });

    const summary = await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    // Homepages routinely name nobody. Retrying that four more times would
    // spend the crawl budget re-reading a page whose answer will not change.
    expect(summary.succeeded).toBe(1);
    expect(summary.retried).toBe(0);

    const job = await queryOne<{ status: string }>(db, 'SELECT status FROM jobs WHERE id = ?', [
      added.id!,
    ]);
    expect(job?.status).toBe('done');
  });

  test('a page nobody could read retries instead of reporting success', async () => {
    const { db } = await setup('e2e-model-down');

    const added = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://bespoke.example' },
    });

    const site = new SiteProvider({
      fetchImpl: stubNetwork('<html><body><p>We build things.</p></body></html>'),
      model: {
        generate: async () => {
          throw new Error('400 you have reached your specified API usage limits');
        },
      },
    });

    const summary = await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    // The distinction the whole fix turns on: this page looks exactly like the
    // one above — no people — but nothing actually read it, so calling it done
    // would report success for work that never happened.
    expect(summary.succeeded).toBe(0);
    expect(summary.retried).toBe(1);

    const job = await queryOne<{ status: string; last_error: string }>(
      db,
      'SELECT status, last_error FROM jobs WHERE id = ?',
      [added.id!],
    );
    expect(job?.status).toBe('pending');
    expect(job?.last_error).toContain('usage limits');
  });

  test('a blocked site completes rather than burning retries', async () => {
    const { db } = await setup('e2e-blocked');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://blocked.example' },
    });

    const site = new SiteProvider({
      fetchImpl: async (input) =>
        input.toString().endsWith('/robots.txt')
          ? new Response('User-agent: *\nDisallow: /', {
              headers: { 'content-type': 'text/plain' },
            })
          : new Response('<html></html>'),
    });

    const summary = await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    expect(summary.succeeded).toBe(1);
    expect(summary.dead).toBe(0);
  });

  test('a job with no url fails loudly and keeps the reason', async () => {
    const { db } = await setup('e2e-nourl');

    const added = await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: {},
      maxAttempts: 1,
    });

    const site = new SiteProvider({ fetchImpl: stubNetwork() });
    const summary = await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    expect(summary.dead).toBe(1);

    const job = await queryOne<{ status: string; last_error: string }>(
      db,
      'SELECT status, last_error FROM jobs WHERE id = ?',
      [added.id!],
    );
    expect(job?.status).toBe('failed');
    expect(job?.last_error).toContain('url');
  });

  test('the same person crawled twice is one person', async () => {
    const { db } = await setup('e2e-idempotent');

    const site = new SiteProvider({ fetchImpl: stubNetwork() });

    for (let i = 0; i < 2; i += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: 'https://loopwright.io' },
      });
      await drainQueue(db, async (job) => {
        await runCrawlJob({ db, site, providers: [] }, job);
      });
    }

    const people = await queryAll(db, 'SELECT id FROM people WHERE display_name = ?', [
      'Alex Chen',
    ]);
    expect(people).toHaveLength(1);
  });

  /**
   * The extractor has always read these; nothing ever stored them.
   *
   * Production is what this test is written against: 208 people, 207 `website`
   * identities, one GitHub and one X, from 64 crawled companies whose footers
   * between them published far more than two profiles. The links were parsed
   * on every crawl and dropped, so "we have no social contact info" was a
   * persistence bug rather than a crawling one.
   */
  test('the social profiles on the page are kept, against the company', async () => {
    const { db } = await setup('e2e-company-identities');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://loopwright.io' },
    });

    const site = new SiteProvider({ fetchImpl: stubNetwork() });
    await drainQueue(db, async (job) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    const identities = await queryAll<{ network: string; handle: string; profile_url: string }>(
      db,
      `SELECT ci.network, ci.handle, ci.profile_url
         FROM company_identities ci
         JOIN companies co ON co.id = ci.company_id
        WHERE co.domain = ?
     ORDER BY ci.network`,
      ['loopwright.io'],
    );

    const byNetwork = new Map(identities.map((row) => [row.network, row.handle]));

    // `sameAs` on the Organization block, and the footer link.
    expect(byNetwork.get('github')).toBe('loopwright');
    expect(byNetwork.get('x')).toBe('loopwright');

    // The company's handle, never the person's: Alex Chen's own GitHub is on
    // the same page, and attributing `loopwright` to them would be a merge
    // with nothing behind it.
    expect(identities.every((row) => row.handle !== 'alexchen')).toBe(true);

    // `/watch` is a YouTube video, not somebody's channel — the extractor
    // refuses to read a handle out of it, so nothing is stored for it.
    expect(byNetwork.has('youtube')).toBe(false);
  });

  test('re-crawling refreshes a profile rather than duplicating it', async () => {
    const { db } = await setup('e2e-company-identities-idempotent');

    const site = new SiteProvider({ fetchImpl: stubNetwork() });

    for (let i = 0; i < 2; i += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: 'https://loopwright.io' },
      });
      await drainQueue(db, async (job) => {
        await runCrawlJob({ db, site, providers: [] }, job);
      });
    }

    // A page crawled weekly would otherwise turn one link into fifty-two.
    const rows = await queryAll(
      db,
      `SELECT ci.id FROM company_identities ci
         JOIN companies co ON co.id = ci.company_id
        WHERE co.domain = ? AND ci.network = 'github'`,
      ['loopwright.io'],
    );
    expect(rows).toHaveLength(1);
  });
});
