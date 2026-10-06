import { describe, expect, test } from 'bun:test';
import { worthScore, rivalsFor } from './demand';
import { classifySignal, cleanFeeds, feedPostId, readFeed, DEFAULT_FEEDS, PAYS } from './feeds';

describe('classifySignal', () => {
  test('a case study with revenue is a paid signal naming the product', () => {
    const v = classifySignal(
      'He Built a Scheduling Tool for Vet Clinics. It Now Makes $25K/Month.',
      'Started for one clinic.',
    );
    expect(v.kind).toBe('revenue');
    expect(v.paid).toBe(true);
    expect(v.revenue).toBe('$25K/Month');
    expect(v.score).toBeGreaterThanOrEqual(0.5);
    expect(v.wants[0]).toContain('Scheduling Tool for Vet Clinics');
  });

  test('MRR, paying customers and acquisitions count as money', () => {
    expect(classifySignal('From 0 to 4k MRR with a niche invoicing app').paid).toBe(true);
    expect(classifySignal('How 900 teams pay to use our agency tool').kind).toBe('revenue');
    expect(classifySignal('We sold the company to a PE firm').kind).toBe('revenue');
    expect(classifySignal('My invoicing app was acquired by Intuit').kind).toBe('revenue');
    expect(classifySignal('Why customers acquired through ads churn').kind).toBe('none');
  });

  test('pains and "someone should build" are signals; would-pay raises them', () => {
    const pain = classifySignal('Someone should build a calendar that understands timezones');
    expect(pain.kind).toBe('pain');
    expect(pain.paid).toBe(false);
    const paying = classifySignal(
      'I wish there was a tool that reconciles Stripe and QuickBooks',
      'I would pay $50 a month for it.',
    );
    expect(paying.paid).toBe(true);
    expect(paying.score).toBeGreaterThan(pain.score);
  });

  test('general writing is not a signal', () => {
    expect(classifySignal('Five things I learned this week').score).toBeLessThan(0.5);
    expect(classifySignal('Notes from a conference in Lisbon').kind).toBe('none');
  });

  test('PAYS catches the ways people say they would pay', () => {
    for (const text of ["I'd pay for this", 'shut up and take my money', 'happy to pay'])
      expect(PAYS.test(text)).toBe(true);
    expect(PAYS.test('the payroll tool is fine')).toBe(false);
  });
});

describe('feeds', () => {
  test('cleanFeeds keeps known roles, accepts directory URLs, drops junk', () => {
    const feeds = cleanFeeds([
      'hnrss-org-7',
      'https://rssamplifier.com/mtlynch-io',
      { slug: 'someblog-com', role: 'asks' },
      'not a slug!',
      'hnrss-org-7',
    ]);
    expect(feeds.map((f) => [f.slug, f.role])).toEqual([
      ['hnrss-org-7', 'asks'],
      ['mtlynch-io', 'signals'],
      ['someblog-com', 'asks'],
    ]);
  });

  test('every default feed has a valid slug and one of the three roles', () => {
    expect(cleanFeeds([...DEFAULT_FEEDS])).toHaveLength(DEFAULT_FEEDS.length);
  });

  test('post ids: HN by item, Reddit by post, others by guid', () => {
    expect(feedPostId('hnrss-org-7', 'https://news.ycombinator.com/item?id=42')).toBe('hn:42');
    expect(feedPostId('r', 'https://www.reddit.com/r/bootstrapping/comments/abc12/x/')).toBe(
      'abc12',
    );
    expect(feedPostId('blog', 'https://x.dev/p/1')).toBe('feed:blog:https://x.dev/p/1');
  });

  test('readFeed decodes entities and says when a feed is not live', async () => {
    const got = await readFeed({ slug: 'b', role: 'signals', name: 'B' }, async () => ({
      freshness: 'overdue',
      items: [
        {
          guid: 'g1',
          url: 'https://b.dev/1',
          title: 'I&#39;m done &amp; dusted',
          summary: '<p>Hi&hellip;</p>',
          publishedAt: '2026-10-01T00:00:00Z',
        },
      ],
    }));
    expect(got.posts[0]).toMatchObject({
      title: "I'm done & dusted",
      text: 'Hi…',
      author: 'feed:b',
    });
    expect(got.note).toContain('overdue');
  });
});

describe('worthScore', () => {
  const base = { demand: 30, askers: 3, sources: ['a', 'b'], paidSources: [], rivals: 0 };

  test('money turns a wanted idea into one worth building', () => {
    expect(worthScore(base).verdict).toBe('validate');
    const paid = worthScore({ ...base, paidSources: ['b'] });
    expect(paid.verdict).toBe('build');
    expect(paid.worth).toBe(30 + 15 + 8);
  });

  test('one launch is a market, four is a crowd', () => {
    expect(worthScore({ ...base, rivals: 1 }).worth).toBe(30 + 8 + 5);
    const crowded = worthScore({ ...base, paidSources: ['a'], rivals: 4 });
    expect(crowded.verdict).toBe('crowded');
  });

  test('one lone asker with no money is only watched', () => {
    expect(
      worthScore({ demand: 10, askers: 1, sources: ['a'], paidSources: [], rivals: 0 }),
    ).toEqual({ worth: 10, paid: 0, reach: 0, verdict: 'watch' });
  });

  test('rivalsFor matches launches that share the idea name and its terms', () => {
    const idea = {
      label: 'invoice reminder app',
      terms: ['invoice', 'reminder', 'overdue', 'client'],
    };
    const found = rivalsFor(idea, [
      { title: 'Show HN: Invoice reminders for overdue clients', url: 'a' },
      { title: 'Show HN: A faster JSON parser', url: 'b' },
    ]);
    expect(found.map((f) => f.url)).toEqual(['a']);
  });
});
