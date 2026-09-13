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
     "jobTitle":"Staff Engineer","sameAs":["https://github.com/alexchen"],"image":"/alex.jpg"}
  </script>
</head><body>
  <footer>
    <a href="https://www.youtube.com/watch?v=xyz">our video</a>
    <a href="https://github.com/loopwright">code</a>
  </footer>
</body></html>`;

/** A small store's homepage: a company, a line about itself, an inbox, nobody named. */
const INBOX_ONLY_HTML = `<!doctype html><html><head>
  <title>Family Shop</title>
  <meta property="og:site_name" content="Family Shop" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Family Shop",
     "description":"A family-owned store shipping research supplies the same day."}
  </script>
</head><body>
  <p>We are family-owned and operated. Orders before 4 PM ship today.</p>
  <footer><a href="mailto:hello@familyshop.example">hello@familyshop.example</a></footer>
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

/**
 * How long the full-chain tests are allowed.
 *
 * Two tests in this file drive a whole crawl through extraction, identity
 * resolution, scoring and a recommendation against a real SQLite file. That is
 * comfortably under a second on a developer machine and intermittently over
 * bun's 5000ms default on a loaded CI runner, which is how `main` came to be
 * red on a commit that had passed the same suite minutes earlier.
 *
 * Raised rather than diagnosed further because the timeout is measuring the
 * runner, not the code: the assertions are unchanged and a genuine hang still
 * fails, thirty seconds later.
 */
const SLOW_CHAIN_MS = 30_000;

describe('URL to approval card', () => {
  test(
    'a queued URL becomes a person, a score and a recommendation',
    async () => {
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

      const person = await queryOne<{
        id: string;
        display_name: string;
        current_title: string;
        avatar_url: string;
        avatar_source: string;
      }>(
        db,
        'SELECT id, display_name, current_title, avatar_url, avatar_source FROM people WHERE display_name = ?',
        ['Alex Chen'],
      );
      expect(person?.display_name).toBe('Alex Chen');
      expect(person?.current_title).toBe('Staff Engineer');
      expect(person?.avatar_url).toBe('https://loopwright.io/alex.jpg');
      expect(person?.avatar_source).toBe('site');
      const photoSource = await queryOne<{ source_record_id: string; provider: string }>(
        db,
        "SELECT source_record_id, provider FROM field_provenance WHERE entity_id = ? AND field = 'avatar_url'",
        [person!.id],
      );
      expect(photoSource?.source_record_id).toBe('https://loopwright.io/');
      expect(photoSource?.provider).toBe('site');

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
    },
    SLOW_CHAIN_MS,
  );

  test(
    'provenance records the crawler, not GitHub',
    async () => {
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
    },
    SLOW_CHAIN_MS,
  );

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

  test(
    'a page naming nobody but publishing an inbox makes the inbox the lead',
    async () => {
      const { db } = await setup('e2e-inbox-lead');

      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: 'https://familyshop.example' },
      });

      const site = new SiteProvider({ fetchImpl: stubNetwork(INBOX_ONLY_HTML) });

      const summary = await drainQueue(db, async (job: QueuedJob) => {
        await runCrawlJob({ db, site, providers: [], emailSendingEnabled: true }, job);
      });
      expect(summary.succeeded).toBe(1);

      // The lead is the company's inbox, typed as such, not a scraped "person".
      const lead = await queryOne<{
        id: string;
        kind: string;
        display_name: string;
        first_name: string | null;
        current_title: string | null;
        identity_confidence: number;
      }>(
        db,
        `SELECT id, kind, display_name, first_name, current_title, identity_confidence
           FROM people WHERE kind = 'company_inbox'`,
      );
      expect(lead?.display_name).toBe('Family Shop');
      expect(lead?.first_name).toBeNull();
      expect(lead?.current_title).toBeNull();
      // Its own site published the address: clears the default outreach bar.
      expect(lead!.identity_confidence).toBeGreaterThanOrEqual(0.85);

      // The address stays the company's. No email identity is written, so the
      // send path resolves the company inbox and flags it shared, and every
      // shared-inbox limit applies exactly as it does for a named colleague.
      const personal = await queryOne<{ id: string }>(
        db,
        `SELECT id FROM social_identities WHERE person_id = ? AND network = 'email'`,
        [lead!.id],
      );
      expect(personal).toBeUndefined();

      const company = await queryOne<{ contact_email: string }>(
        db,
        `SELECT co.contact_email FROM companies co
           JOIN people p ON p.current_company_id = co.id WHERE p.id = ?`,
        [lead!.id],
      );
      expect(company?.contact_email).toBe('hello@familyshop.example');

      // What the site said is the evidence, and it names the address.
      const signal = await queryOne<{ summary: string; evidence: string }>(
        db,
        'SELECT summary, evidence FROM signals WHERE person_id = ?',
        [lead!.id],
      );
      expect(signal?.summary).toContain('hello@familyshop.example');
      expect(signal?.evidence).toContain('family-owned');

      // And it reaches the queue as an email to approve, like anyone else.
      const card = await queryOne<{ action: string; network: string; status: string }>(
        db,
        'SELECT action, network, status FROM recommendations WHERE person_id = ?',
        [lead!.id],
      );
      expect(card).toEqual({ action: 'send_email', network: 'email', status: 'pending' });

      // Re-reading the site finds the same lead, not a second one.
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: 'https://familyshop.example/contact' },
      });
      await drainQueue(db, async (job: QueuedJob) => {
        await runCrawlJob({ db, site, providers: [], emailSendingEnabled: true }, job);
      });
      const leads = await queryAll(db, `SELECT id FROM people WHERE kind = 'company_inbox'`);
      expect(leads).toHaveLength(1);
    },
    SLOW_CHAIN_MS,
  );

  test('a page naming someone does not also queue the inbox', async () => {
    const { db } = await setup('e2e-inbox-not-doubled');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://loopwright.io' },
    });

    // The team page above, plus a published inbox.
    const html = COMPANY_HTML.replace(
      '<footer>',
      '<footer><a href="mailto:hello@loopwright.io">hello@loopwright.io</a>',
    );
    const site = new SiteProvider({ fetchImpl: stubNetwork(html) });

    await drainQueue(db, async (job: QueuedJob) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    const named = await queryOne<{ kind: string }>(
      db,
      'SELECT kind FROM people WHERE display_name = ?',
      ['Alex Chen'],
    );
    expect(named?.kind).toBe('person');

    const inboxes = await queryAll(db, `SELECT id FROM people WHERE kind = 'company_inbox'`);
    expect(inboxes).toHaveLength(0);
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

/**
 * A team page of the shape small businesses actually publish: no JSON-LD
 * `Person`, just cards with a name, a couple of profile links and an address.
 * This is the layout the product exists to read, and until attribution landed
 * every one of these links was filed against the company instead.
 */
const TEAM_HTML = `<!doctype html><html><head>
  <title>Northwind Dental</title>
  <meta property="og:site_name" content="Northwind Dental" />
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Priya Raghunathan",
     "jobTitle":"Practice Principal"}
  </script>
</head><body>
  <main>
    <div class="member">
      <h3>Priya Raghunathan</h3><p>Practice Principal</p>
      <a href="https://x.com/priyarague">X</a>
      <a href="mailto:p.raghunathan@northwind.example">Email</a>
    </div>
  </main>
  <footer>
    <a href="https://x.com/northwinddental">the practice</a>
    <a href="mailto:info@northwind.example">enquiries</a>
  </footer>
</body></html>`;

describe('social handles and addresses reach the person', () => {
  test('a card’s links are stored against that person, not the company', async () => {
    const { db } = await setup('e2e-attribution');

    await enqueue(db, {
      workspaceId: SEED.workspaceId,
      kind: 'crawl_site',
      payload: { url: 'https://northwind.example' },
    });

    const site = new SiteProvider({ fetchImpl: stubNetwork(TEAM_HTML) });

    const summary = await drainQueue(db, async (job: QueuedJob) => {
      await runCrawlJob({ db, site, providers: [] }, job);
    });

    // The job must actually succeed. Storing a personal address used to throw
    // `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`
    // — the conflict target omitted the partial index's WHERE clause — and
    // nothing had ever reached that line before, because no personal address
    // was ever recognised.
    expect(summary.succeeded).toBe(1);
    expect(summary.dead).toBe(0);

    const person = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM people WHERE display_name = ?',
      ['Priya Raghunathan'],
    );
    expect(person).toBeDefined();

    const identities = await queryAll<{ network: string; handle: string; confidence: number }>(
      db,
      'SELECT network, handle, confidence FROM social_identities WHERE person_id = ? ORDER BY network',
      [person!.id],
    );

    const byNetwork = new Map(identities.map((row) => [row.network, row]));

    // Hers, from her own card.
    expect(byNetwork.get('x')?.handle).toBe('priyarague');
    expect(byNetwork.get('email')?.handle).toBe('p.raghunathan@northwind.example');

    // The practice's own account stays the practice's.
    expect(identities.map((row) => row.handle)).not.toContain('northwinddental');

    // And she is still contactable: `identity_confidence` is the minimum across
    // a person's identities, so a weakly-scored handle would push her under the
    // outreach floor and finding more about her would make her unreachable.
    const confidence = await queryOne<{ identity_confidence: number }>(
      db,
      'SELECT identity_confidence FROM people WHERE id = ?',
      [person!.id],
    );
    expect(confidence?.identity_confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('re-crawling the same page', () => {
  test('refreshes an identity instead of storing it again', async () => {
    // Re-crawling is routine. A handle-only identity matches no unique index —
    // the one on social_identities is partial and needs a platform id, which a
    // web page never supplies — so without an explicit check one Bluesky handle
    // becomes a new row on every pass.
    const { db } = await setup('e2e-recrawl');
    const site = new SiteProvider({ fetchImpl: stubNetwork(TEAM_HTML) });

    for (let pass = 0; pass < 2; pass += 1) {
      await enqueue(db, {
        workspaceId: SEED.workspaceId,
        kind: 'crawl_site',
        payload: { url: 'https://northwind.example' },
        dedupeKey: `pass-${pass}`,
      });
      await drainQueue(db, async (job: QueuedJob) => {
        await runCrawlJob({ db, site, providers: [] }, job);
      });
    }

    const person = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM people WHERE display_name = ?',
      ['Priya Raghunathan'],
    );

    const handles = await queryAll<{ network: string }>(
      db,
      `SELECT network FROM social_identities WHERE person_id = ? AND network = 'x'`,
      [person!.id],
    );

    expect(handles).toHaveLength(1);
  });
});
