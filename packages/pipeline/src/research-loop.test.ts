/**
 * Breaking the research loop.
 *
 * Production sat in a state that looked like a broken composer and was really
 * a closed cycle. 73 pending cards, all `refresh_research`, none with a signal
 * attached. The correlation across all 208 people was exact: every one of the
 * 131 with a job title had a signal, and 76 of the 77 without had none.
 *
 * The cause was one condition. `storeSiteSignal` returned early when a crawled
 * person had no title, so an untitled person got no signal at all — and
 * `generateRecommendation` refuses to propose an outbound action without a
 * triggering signal, falling back to `refresh_research`, which nothing
 * executed. The card that existed *because* there was nothing to say could
 * never produce anything to say.
 *
 * These tests pin the three halves of the fix: an untitled listing is a
 * signal, following a team page is what turns it into a titled one, and a
 * second crawl retires the research card it replaces instead of stacking a
 * duplicate next to it.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { SiteProvider, type FetchLike } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { drainQueue, enqueue } from './queue';
import { runCrawlJob } from './crawl';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

/** A homepage that names a person and gives no role — the common shape. */
const HOME_UNTITLED = `<!doctype html><html><head>
  <title>Brightsmile Dental</title>
  <meta property="og:site_name" content="Brightsmile Dental" />
</head><body>
  <h1>Brightsmile Dental</h1>
  <p>Care from Dana Whitfield and the team.</p>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Dana Whitfield"}
  </script>
</body></html>`;

/** The same, plus the shared inbox that makes them reachable. */
const HOME_UNTITLED_INBOX = `<!doctype html><html><head>
  <title>Brightsmile Dental</title>
  <meta property="og:site_name" content="Brightsmile Dental" />
</head><body>
  <h1>Brightsmile Dental</h1>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Dana Whitfield"}
  </script>
  <a href="mailto:hello@brightsmile.test">hello@brightsmile.test</a>
</body></html>`;

/** The same homepage, but linking a team page that states the role. */
const HOME_WITH_TEAM = `<!doctype html><html><head>
  <title>Brightsmile Dental</title>
  <meta property="og:site_name" content="Brightsmile Dental" />
</head><body>
  <nav><a href="/about/our-team">Meet the team</a></nav>
  <footer><a href="https://www.linkedin.com/company/brightsmile">LinkedIn</a></footer>
</body></html>`;

const TEAM_PAGE = `<!doctype html><html><head><title>Our team</title></head><body>
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Person","name":"Dana Whitfield",
     "jobTitle":"Clinic Director"}
  </script>
  <a href="mailto:hello@brightsmile.test">hello@brightsmile.test</a>
</body></html>`;

/** Serves per-path HTML, and a permissive robots.txt. */
function network(pages: Record<string, string>): FetchLike {
  return async (input) => {
    const url = new URL(input.toString());

    if (url.pathname === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /', {
        headers: { 'content-type': 'text/plain' },
      });
    }

    const body = pages[url.pathname.replace(/\/+$/, '') || '/'];
    if (body === undefined) return new Response('nope', { status: 404 });

    return new Response(body, { headers: { 'content-type': 'text/html' } });
  };
}

async function crawlOnce(db: SeededDatabase['db'], site: SiteProvider): Promise<void> {
  await enqueue(db, {
    workspaceId: SEED.workspaceId,
    kind: 'crawl_site',
    payload: { url: 'https://brightsmile.test' },
  });
  await drainQueue(db, async (job) => {
    await runCrawlJob({ db, site, providers: [] }, job);
  });
}

async function personNamed(db: SeededDatabase['db'], name: string) {
  return queryOne<{ id: string; current_title: string | null }>(
    db,
    'SELECT id, current_title FROM people WHERE display_name = ?',
    [name],
  );
}

describe('an untitled person still produces a signal', () => {
  test('a name with no role on the page is a citable fact, not nothing', async () => {
    const { db } = await seedDatabase('loop-untitled').then((s) => ((seeded = s), s));

    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_UNTITLED }) }));

    const person = await personNamed(db, 'Dana Whitfield');
    expect(person).toBeTruthy();
    expect(person?.current_title ?? null).toBeNull();

    const signals = await queryAll<{ summary: string; evidence: string; relevance: number }>(
      db,
      `SELECT summary, evidence, relevance FROM signals WHERE person_id = ?`,
      [person!.id],
    );

    // Before the fix this was zero, and zero is what made the card unactionable.
    expect(signals).toHaveLength(1);
    expect(signals[0]?.summary).toContain('Named on the company website');

    // Evidence is only ever what the page said. With no title, that is the name.
    expect(signals[0]?.evidence).toBe('Dana Whitfield');

    // Weaker than a stated role: 0.9 x 0.35 = 0.315, over the 0.15 floor while
    // fresh and under it by sixty days.
    expect(signals[0]?.relevance).toBeCloseTo(0.35, 5);
  });

  /**
   * The signal is necessary but not sufficient: the engine also needs a
   * channel. A published inbox is what turns an untitled name into something
   * that can actually be sent, and in production 30 of the 73 stuck cards had
   * one already — they were blocked purely on having nothing to say.
   */
  test('an untitled person with a published inbox becomes sendable', async () => {
    const { db } = await seedDatabase('loop-actionable').then((s) => ((seeded = s), s));

    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_UNTITLED_INBOX }) }));

    const person = await personNamed(db, 'Dana Whitfield');
    const recs = await queryAll<{ action: string; network: string }>(
      db,
      `SELECT action, network FROM recommendations WHERE person_id = ? AND status = 'pending'`,
      [person!.id],
    );

    expect(recs).toHaveLength(1);
    expect(recs[0]?.action).toBe('send_email');
  });

  /**
   * With no channel it stays research — which is correct, not a failure.
   * `website` is somewhere to read, not somewhere to message, so no outbound
   * action survives the policy check.
   *
   * What changed is that the card is no longer a dead end: the person now has
   * a signal, and approving the card queues a real re-crawl, so the state can
   * actually move. Before, approving it wrote three rows and nothing else.
   */
  test('with no channel it stays research, but the person now has a signal', async () => {
    const { db } = await seedDatabase('loop-unreachable').then((s) => ((seeded = s), s));

    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_UNTITLED }) }));

    const person = await personNamed(db, 'Dana Whitfield');
    const recs = await queryAll<{ action: string }>(
      db,
      `SELECT action FROM recommendations WHERE person_id = ? AND status = 'pending'`,
      [person!.id],
    );

    // Still visible. Returning no card at all would drop an enriched, scored
    // lead out of the funnel with no trace.
    expect(recs).toHaveLength(1);
    expect(recs[0]?.action).toBe('refresh_research');

    const signals = await queryAll(db, `SELECT id FROM signals WHERE person_id = ?`, [person!.id]);
    expect(signals).toHaveLength(1);
  });
});

describe('following the pages that name people', () => {
  test('a team page turns an untitled name into a titled one', async () => {
    const { db } = await seedDatabase('loop-team-page').then((s) => ((seeded = s), s));

    await crawlOnce(
      db,
      new SiteProvider({
        fetchImpl: network({ '/': HOME_WITH_TEAM, '/about/our-team': TEAM_PAGE }),
      }),
    );

    // The homepage named nobody at all; every person here came from the link.
    const person = await personNamed(db, 'Dana Whitfield');
    expect(person?.current_title).toBe('Clinic Director');

    const signals = await queryAll<{ summary: string; relevance: number }>(
      db,
      `SELECT summary, relevance FROM signals WHERE person_id = ?`,
      [person!.id],
    );
    expect(signals[0]?.summary).toContain('Clinic Director');
    // A stated role is worth more than a bare mention.
    expect(signals[0]?.relevance).toBeCloseTo(0.5, 5);
  });

  test('the shared inbox on a followed page is still found', async () => {
    const { db } = await seedDatabase('loop-team-inbox').then((s) => ((seeded = s), s));

    await crawlOnce(
      db,
      new SiteProvider({
        fetchImpl: network({ '/': HOME_WITH_TEAM, '/about/our-team': TEAM_PAGE }),
      }),
    );

    // The address is on `/about/our-team`, not on the page that was queued.
    const company = await queryOne<{ contact_email: string | null }>(
      db,
      `SELECT contact_email FROM companies WHERE domain = ?`,
      ['brightsmile.test'],
    );
    expect(company?.contact_email).toBe('hello@brightsmile.test');
  });

  test('the company profile in the footer is kept', async () => {
    const { db } = await seedDatabase('loop-footer-social').then((s) => ((seeded = s), s));

    await crawlOnce(
      db,
      new SiteProvider({
        fetchImpl: network({ '/': HOME_WITH_TEAM, '/about/our-team': TEAM_PAGE }),
      }),
    );

    const identities = await queryAll<{ network: string; handle: string }>(
      db,
      `SELECT ci.network, ci.handle FROM company_identities ci
         JOIN companies co ON co.id = ci.company_id
        WHERE co.domain = ?`,
      ['brightsmile.test'],
    );

    expect(identities.map((row) => row.network)).toContain('linkedin');
  });

  test('an unreachable sub-page does not discard the page that linked it', async () => {
    const { db } = await seedDatabase('loop-dead-link').then((s) => ((seeded = s), s));

    // `/about/our-team` 404s; the homepage still has to be read.
    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_WITH_TEAM }) }));

    const company = await queryOne<{ name: string }>(
      db,
      `SELECT name FROM companies WHERE domain = ?`,
      ['brightsmile.test'],
    );
    expect(company?.name).toBe('Brightsmile Dental');
  });
});

/**
 * `webmaster` is a mailbox, not a lead.
 *
 * Production stored `webmaster` (twice at one company) and `admin` as people.
 * They were inert only because an untitled person had no signal and so could
 * never reach outreach — protection this change removed. Without the guard the
 * next regeneration pass would propose emailing them.
 */
describe('role accounts never become prospects', () => {
  const HOME_WEBMASTER = `<!doctype html><html><head>
    <title>Brightsmile Dental</title>
    <meta property="og:site_name" content="Brightsmile Dental" />
  </head><body>
    <script type="application/ld+json">
      {"@context":"https://schema.org","@type":"Person","name":"webmaster"}
    </script>
    <a href="mailto:hello@brightsmile.test">hello@brightsmile.test</a>
  </body></html>`;

  test('a page naming "webmaster" creates no person and no card', async () => {
    const { db } = await seedDatabase('loop-role-account').then((s) => ((seeded = s), s));

    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_WEBMASTER }) }));

    const person = await personNamed(db, 'webmaster');
    expect(person).toBeFalsy();

    // The company is still recorded — the page was read fine, it just named
    // nobody worth calling a person.
    const company = await queryOne<{ contact_email: string | null }>(
      db,
      `SELECT contact_email FROM companies WHERE domain = ?`,
      ['brightsmile.test'],
    );
    expect(company?.contact_email).toBe('hello@brightsmile.test');
  });

  test('a real person on the same kind of page is still created', async () => {
    const { db } = await seedDatabase('loop-role-account-control').then((s) => ((seeded = s), s));

    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_UNTITLED_INBOX }) }));

    expect(await personNamed(db, 'Dana Whitfield')).toBeTruthy();
  });
});

describe('a second crawl replaces the card it supersedes', () => {
  test('re-crawling does not leave two pending cards for one person', async () => {
    const { db } = await seedDatabase('loop-supersede').then((s) => ((seeded = s), s));

    // First pass: homepage only, so the person is found without a role.
    await crawlOnce(db, new SiteProvider({ fetchImpl: network({ '/': HOME_UNTITLED }) }));

    const person = await personNamed(db, 'Dana Whitfield');
    const afterFirst = await queryAll(
      db,
      `SELECT id FROM recommendations WHERE person_id = ? AND status = 'pending'`,
      [person!.id],
    );
    expect(afterFirst).toHaveLength(1);

    // Second pass: the site now has a team page stating the role.
    await crawlOnce(
      db,
      new SiteProvider({
        fetchImpl: network({ '/': HOME_WITH_TEAM, '/about/our-team': TEAM_PAGE }),
      }),
    );

    const pending = await queryAll(
      db,
      `SELECT id FROM recommendations WHERE person_id = ? AND status = 'pending'`,
      [person!.id],
    );

    // Recommendations were only ever inserted, never reconciled. Re-reading a
    // site would otherwise stack a second card on the same person.
    expect(pending).toHaveLength(1);
  });
});
