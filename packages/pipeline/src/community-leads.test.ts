/**
 * Buyer leads: monitors, scans, scoring, drafts, the digest.
 *
 * What has to hold: a monitor can be created from a product alone and gets
 * suggested keywords; a scan stores each post once and never scores it twice;
 * the model's verdict wins over the wording classifier, which still works with
 * no model; posts under the floor are kept but are not leads; a reply is
 * drafted and stored but nothing posts it; the digest goes once a day, only
 * with leads, and never repeats a lead; and nothing leaks between workspaces.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import { queryAll, type Client } from '@outreachgraph/db';
import type { Mailer, Message } from '@outreachgraph/email';
import type { FeedPost, FeedSource } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  buildLeadSources,
  containsKeyword,
  judgeOrder,
  createLeadMonitor,
  draftCommunityLeadReply,
  listCommunityLeads,
  monitorsDueForScan,
  scanLeadMonitor,
  sendCommunityLeadDigest,
  updateCommunityLead,
  MonitorInputError,
  NoModelError,
} from './community-leads';

setDefaultTimeout(30_000);

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});
async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

const NOW = new Date('2026-10-07T15:00:00Z');
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const POSTS: FeedPost[] = [
  {
    network: 'reddit',
    externalId: 'r1',
    authorHandle: 'secops_sam',
    url: 'https://www.reddit.com/r/devsecops/comments/r1/',
    title: 'Any recommendations for a lightweight SIEM alternative to Splunk?',
    text: 'Any recommendations for a lightweight SIEM alternative to Splunk? 20 servers, small team.',
    postedAt: ago(3),
    container: 'r/devsecops',
  },
  {
    network: 'reddit',
    externalId: 'r2',
    authorHandle: 'vendorbot',
    url: 'https://www.reddit.com/r/redhand/comments/r2/',
    title: 'We just shipped v3 of our threat intel feed',
    text: 'We just shipped v3 of our threat intel feed. Full changelog on our site.',
    postedAt: ago(5),
    container: 'r/redhand',
  },
];

const HN: FeedPost[] = [
  {
    network: 'hackernews',
    externalId: '42',
    authorHandle: 'pg_fan',
    url: 'https://news.ycombinator.com/item?id=42',
    text: 'We are evaluating intrusion detection tools for our VPS fleet, what do you use?',
    postedAt: ago(2),
    container: 'HN comment',
  },
];

function fake(
  slug: string,
  posts: FeedPost[],
  calls: string[][] = [],
  slugs: string[] = [],
): FeedSource {
  return {
    network: posts[0]?.network ?? 'reddit',
    slug,
    displayName: slug,
    async search(input) {
      calls.push([...input.terms]);
      slugs.push(slug);
      return posts;
    },
  };
}

const JUDGED = JSON.stringify({
  results: [
    { id: '0', intent: 70, reason: 'evaluating IDS tools for a VPS fleet' },
    { id: '1', intent: 88, reason: 'asking for a Splunk alternative' },
    { id: '2', intent: 5, reason: 'vendor changelog' },
  ],
});

class CaptureMailer implements Mailer {
  readonly sent: Message[] = [];
  async send(message: Message) {
    this.sent.push(message);
    return { id: `m${this.sent.length}` };
  }
}

describe('lead monitors', () => {
  test('created from a product alone, with suggested keywords and subreddits', async () => {
    const client = await db('leads-create');
    const model = new StubModel(
      JSON.stringify({
        keywords: ['SIEM', 'intrusion detection', 'splunk alternative'],
        subreddits: ['r/devsecops', 'sysadmin', 'not a sub!'],
      }),
    );
    const monitor = await createLeadMonitor({ db: client, model }, SEED.workspaceId, {
      offeringId: SEED.offeringId,
    });
    expect(monitor.offeringId).toBe(SEED.offeringId);
    expect(monitor.name.length).toBeGreaterThan(0);
    expect(monitor.keywords).toEqual(['siem', 'intrusion detection', 'splunk alternative']);
    expect(monitor.subreddits).toEqual(['devsecops', 'sysadmin']);
    expect(monitor.sources).toEqual(['reddit', 'hackernews', 'bluesky', 'web']);
    expect(monitor.everyMinutes).toBe(360);
  });

  test('without a model the brand name and host are the keywords; polling is floored at an hour', async () => {
    const client = await db('leads-nomodel');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      url: 'https://www.threatcrush.com',
      everyMinutes: 5,
    });
    expect(monitor.keywords).toEqual(['threatcrush', 'threatcrush.com']);
    expect(monitor.everyMinutes).toBe(60);
  });

  test('refuses a monitor with nothing to name it, and another workspace’s product', async () => {
    const client = await db('leads-refuse');
    await expect(createLeadMonitor({ db: client }, SEED.workspaceId, {})).rejects.toBeInstanceOf(
      MonitorInputError,
    );
    await expect(
      createLeadMonitor({ db: client }, SEED.workspaceId, { offeringId: 'off_elsewhere' }),
    ).rejects.toBeInstanceOf(MonitorInputError);
  });

  test('keywords match whole words only', () => {
    expect(containsKeyword('Looking for a SIEM.', 'siem')).toBe(true);
    expect(containsKeyword('wszystkiem się zajmę', 'siem')).toBe(false);
    expect(containsKeyword('any good threat\nintel feeds?', 'threat intel')).toBe(true);
    expect(containsKeyword('c++ (and c#) tools', 'c++')).toBe(true);
  });

  test('Reddit is only read with subreddits: the archive cannot search all of it', () => {
    expect(buildLeadSources({ sources: ['reddit'], subreddits: [] })).toHaveLength(0);
    expect(
      buildLeadSources({
        sources: ['reddit', 'hackernews', 'bluesky'],
        subreddits: ['sysadmin'],
      }).map((s) => s.slug),
    ).toEqual(['reddit', 'hackernews', 'bluesky']);
    // The web source needs a searcher (ValueSERP); without one it reads nothing.
    const searcher = { search: async () => [] };
    expect(
      buildLeadSources({ sources: ['web'], subreddits: [] }, { searcher }).map((s) => s.slug),
    ).toEqual(['web']);
  });

  test('the web search runs at most once a day, however often the monitor scans', async () => {
    const client = await db('leads-web-daily');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem'],
      sources: ['hackernews', 'web'],
    });
    const calls: string[] = [];
    const sources = () => [fake('hackernews', HN, [], calls), fake('web', [], [], calls)];
    const scan = (hours: number) =>
      scanLeadMonitor(
        { db: client, sources, now: new Date(NOW.getTime() + hours * 3_600_000) },
        SEED.workspaceId,
        monitor.id,
      );
    await scan(0);
    await scan(6);
    await scan(21);
    expect(calls).toEqual(['hackernews', 'web', 'hackernews', 'hackernews', 'web']);
  });
});

describe('scanning', () => {
  test('stores each post once, model verdicts win, floor decides what is a lead', async () => {
    const client = await db('leads-scan');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem', 'threat intel', 'intrusion detection'],
      subreddits: ['devsecops'],
    });
    const calls: string[][] = [];
    const sources = () => [fake('reddit', POSTS, calls), fake('hackernews', HN)];
    const model = new StubModel(JUDGED);

    const first = await scanLeadMonitor(
      { db: client, model, sources, now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(calls[0]).toEqual(['siem', 'threat intel', 'intrusion detection']);
    expect(first).toMatchObject({ read: 3, stored: 3, judged: 3, leads: 2 });

    const leads = await listCommunityLeads(client, SEED.workspaceId);
    expect(leads.map((l) => [l.externalId, l.intent])).toEqual([
      ['42', 70],
      ['r1', 88],
    ]);
    expect(leads[1]).toMatchObject({
      source: 'reddit',
      container: 'r/devsecops',
      matchedTerm: 'siem',
      reason: 'asking for a Splunk alternative',
      judged: true,
      status: 'new',
    });

    // The vendor post is kept, so it is never scored again, but is not a lead.
    const all = await listCommunityLeads(client, SEED.workspaceId, { minIntent: 0 });
    expect(all).toHaveLength(3);

    const second = await scanLeadMonitor(
      { db: client, model, sources, now: new Date(NOW.getTime() + 3_600_000) },
      SEED.workspaceId,
      monitor.id,
    );
    expect(second).toMatchObject({ read: 3, stored: 0, judged: 0 });
    expect(model.calls).toHaveLength(1);
  });

  test('with no model, the wording classifier scores and says it did', async () => {
    const client = await db('leads-patterns');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem', 'threat intel'],
      subreddits: ['devsecops'],
    });
    const r = await scanLeadMonitor(
      { db: client, sources: () => [fake('reddit', POSTS)], now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(r.judged).toBe(0);
    const [lead] = await listCommunityLeads(client, SEED.workspaceId);
    expect(lead).toMatchObject({ externalId: 'r1', intent: 70, judged: false });
  });

  test('with a model, an unjudged post waits below the floor and the next scan judges it', async () => {
    const client = await db('leads-backlog');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem', 'threat intel', 'intrusion detection'],
      subreddits: ['devsecops'],
    });
    const sources = () => [fake('reddit', POSTS), fake('hackernews', HN)];
    const down = {
      generate: async () => {
        throw new Error('429 insufficient_quota');
      },
    };

    const first = await scanLeadMonitor(
      { db: client, model: down, sources, now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(first).toMatchObject({ stored: 3, judged: 0, leads: 0 });
    expect(first.failures[0]).toMatchObject({ source: 'judge' });
    // The wording guess for "Any recommendations for…" is 70, held at 45.
    expect(await listCommunityLeads(client, SEED.workspaceId)).toEqual([]);

    const second = await scanLeadMonitor(
      {
        db: client,
        model: new StubModel(JUDGED),
        sources,
        now: new Date(NOW.getTime() + 3_600_000),
      },
      SEED.workspaceId,
      monitor.id,
    );
    expect(second).toMatchObject({ stored: 0, judged: 3, leads: 2 });
    expect((await listCommunityLeads(client, SEED.workspaceId)).map((l) => l.externalId)).toEqual([
      '42',
      'r1',
    ]);
  });

  test('judging order: best wording first per source, sources take turns', () => {
    const row = (source: string, pattern: number, hoursAgo: number) => ({
      source,
      pattern,
      postedAt: ago(hoursAgo),
      key: `${source}-${pattern}-${hoursAgo}`,
    });
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => row('bluesky', 15, i)),
      row('bluesky', 70, 9),
      row('reddit', 35, 1),
      row('reddit', 70, 8),
    ];
    expect(judgeOrder(rows, 4).map((r) => r.key)).toEqual([
      'bluesky-70-9',
      'reddit-70-8',
      'bluesky-15-0',
      'reddit-35-1',
    ]);
  });

  test('a failing source costs that source, and is reported', async () => {
    const client = await db('leads-fail');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem', 'threat intel'],
      subreddits: ['devsecops'],
    });
    const broken: FeedSource = {
      network: 'bluesky',
      slug: 'bluesky',
      displayName: 'Bluesky',
      search: async () => {
        throw new Error('HTTP 403');
      },
    };
    const r = await scanLeadMonitor(
      { db: client, sources: () => [broken, fake('reddit', POSTS)], now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(r.failures).toEqual([{ source: 'bluesky', reason: 'HTTP 403' }]);
    expect(r.stored).toBe(2);
  });

  test('excluded words drop a post before it is stored', async () => {
    const client = await db('leads-exclude');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem', 'threat intel'],
      subreddits: ['devsecops'],
      exclude: ['changelog'],
    });
    const r = await scanLeadMonitor(
      { db: client, sources: () => [fake('reddit', POSTS)], now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(r.stored).toBe(1);
  });

  test('due: never scanned, or older than the interval', async () => {
    const client = await db('leads-due');
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      keywords: ['siem'],
      everyMinutes: 120,
    });
    expect(await monitorsDueForScan(client, NOW)).toEqual([
      { workspaceId: SEED.workspaceId, monitorId: monitor.id },
    ]);
    await scanLeadMonitor(
      { db: client, sources: () => [], now: NOW },
      SEED.workspaceId,
      monitor.id,
    );
    expect(await monitorsDueForScan(client, new Date(NOW.getTime() + 60 * 60_000))).toEqual([]);
    expect(await monitorsDueForScan(client, new Date(NOW.getTime() + 121 * 60_000))).toHaveLength(
      1,
    );
  });
});

describe('replies and the digest', () => {
  async function scanned(label: string) {
    const client = await db(label);
    const monitor = await createLeadMonitor({ db: client }, SEED.workspaceId, {
      name: 'ThreatCrush',
      url: 'https://threatcrush.com',
      keywords: ['siem', 'threat intel', 'intrusion detection'],
      subreddits: ['devsecops'],
    });
    await scanLeadMonitor(
      {
        db: client,
        model: new StubModel(JUDGED),
        sources: () => [fake('reddit', POSTS), fake('hackernews', HN)],
        now: NOW,
      },
      SEED.workspaceId,
      monitor.id,
    );
    return { client, monitor };
  }

  test('a reply is drafted and stored, never posted', async () => {
    const { client } = await scanned('leads-draft');
    const [lead] = await listCommunityLeads(client, SEED.workspaceId);
    await expect(
      draftCommunityLeadReply({ db: client }, SEED.workspaceId, lead!.id),
    ).rejects.toBeInstanceOf(NoModelError);

    const model = new StubModel('I work on ThreatCrush, so take this with salt: start with ...');
    const drafted = await draftCommunityLeadReply(
      { db: client, model },
      SEED.workspaceId,
      lead!.id,
    );
    expect(drafted?.replyDraft).toStartWith('I work on ThreatCrush');
    expect(model.calls[0]?.user).toContain('threatcrush.com');
    expect(drafted?.status).toBe('new');

    const replied = await updateCommunityLead(client, SEED.workspaceId, lead!.id, {
      status: 'replied',
    });
    expect(replied?.status).toBe('replied');
    expect(replied?.replyDraft).toBe(drafted?.replyDraft);
  });

  test('the digest: after the hour, only leads, once a day, never the same lead twice', async () => {
    const { client } = await scanned('leads-digest');
    const mailer = new CaptureMailer();
    const deps = { db: client, mailer, appUrl: 'https://outreachgraph.com' };

    expect(
      await sendCommunityLeadDigest(
        { ...deps, now: new Date('2026-10-07T05:00:00Z') },
        SEED.workspaceId,
      ),
    ).toBe(0);

    expect(await sendCommunityLeadDigest({ ...deps, now: NOW }, SEED.workspaceId)).toBe(2);
    expect(mailer.sent).toHaveLength(1);
    const mail = mailer.sent[0]!;
    expect(mail.subject).toBe('2 fresh buyer leads for ThreatCrush · OutreachGraph');
    expect(mail.text).toContain(
      '“Any recommendations for a lightweight SIEM alternative to Splunk?',
    );
    expect(mail.text).toContain('https://www.reddit.com/r/devsecops/comments/r1/');
    expect(mail.html).toContain('Draft AI reply');
    expect(mail.html).toContain('https://outreachgraph.com/buyer-leads?lead=cld_');
    expect(mail.text).not.toContain('vendor changelog');

    // Same day: nothing more.
    expect(
      await sendCommunityLeadDigest(
        { ...deps, now: new Date(NOW.getTime() + 3_600_000) },
        SEED.workspaceId,
      ),
    ).toBe(0);
    // Next day: the same leads were already digested.
    expect(
      await sendCommunityLeadDigest(
        { ...deps, now: new Date(NOW.getTime() + 86_400_000) },
        SEED.workspaceId,
      ),
    ).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  test('nothing leaks between workspaces', async () => {
    const { client } = await scanned('leads-tenancy');
    expect(await listCommunityLeads(client, 'wsp_other')).toEqual([]);
    const rows = await queryAll<{ workspace_id: string }>(
      client,
      'SELECT DISTINCT workspace_id FROM community_leads',
      [],
    );
    expect(rows).toEqual([{ workspace_id: SEED.workspaceId }]);
  });
});
