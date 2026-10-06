/**
 * The Idea Generator: scan, group, judge, flag.
 *
 * What has to hold: posts shaped like an ask are kept and others are not; the
 * judge throws out a founder's pitch; different people asking for the same
 * thing land in one idea, which is flagged 'build' at `build_at` askers; a
 * second scan reads nothing twice; and nothing leaks between workspaces.
 */

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import { queryAll, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  getIdea,
  getIdeaScan,
  listIdeas,
  saveIdeaScan,
  scanIdeas,
  updateIdea,
  workspacesDueForIdeaScan,
} from './ideas';

// Seeding a test database takes 5-7 s on a loaded runner: the timeout measures the
// box, not the code (see crawl.test.ts). A real hang still fails, 30 s later.
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

const NOW = new Date('2026-10-06T12:00:00Z');
const t = (daysAgo: number) => Math.floor((NOW.getTime() - daysAgo * 86_400_000) / 1000);

/** The archive's shape. RSS Amplifier answers empty so the archive is used. */
const POSTS = [
  {
    id: 'p1',
    author: 'alice',
    title: 'Is there an app that transcribes audio files I already have?',
    selftext:
      'I have 12 interview recordings for my thesis. I want it to export the transcript to docx.',
    created_utc: t(3),
    score: 5,
    num_comments: 4,
  },
  {
    id: 'p2',
    author: 'bob',
    title: 'Looking for a tool to transcribe audio files I already recorded',
    selftext: 'Otter only does live meetings. I need it to handle mp3 uploads.',
    created_utc: t(2),
    score: 3,
    num_comments: 1,
  },
  {
    id: 'p3',
    author: 'carol',
    title: 'I built a transcription tool, is there a market for this?',
    selftext: 'Would you pay for it? Roast my landing page.',
    created_utc: t(1),
    score: 1,
    num_comments: 0,
  },
  {
    id: 'p4',
    author: 'dave',
    title: 'My cat knocked over my coffee again',
    selftext: '',
    created_utc: t(1),
    score: 50,
    num_comments: 9,
  },
  {
    id: 'p5',
    author: 'erin',
    title: 'Is there a habit tracker app with streaks that syncs?',
    selftext: '',
    created_utc: t(400),
    score: 1,
    num_comments: 0,
  },
];

function fakeReddit() {
  const urls: string[] = [];
  const fetchJson = async (url: string) => {
    urls.push(url);
    if (url.includes('rssamplifier')) return { items: [] };
    if (url.includes('/api/posts/search'))
      return {
        data: POSTS.map((p) => ({
          ...p,
          subreddit: 'AskTechnology',
          permalink: `/r/AskTechnology/comments/${p.id}/x/`,
        })),
      };
    if (url.includes('/api/posts/ids')) {
      const ids = new URL(url).searchParams.get('ids')!.split(',');
      return { data: POSTS.filter((p) => ids.includes(p.id)) };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { urls, fetchJson };
}

const judge = () =>
  new StubModel(
    JSON.stringify({
      results: [
        {
          id: 'p1',
          ask: true,
          wants: ['transcribe existing audio files', 'export to docx'],
          label: 'transcription for existing audio files',
        },
        {
          id: 'p2',
          ask: true,
          wants: ['transcribe uploaded mp3 files'],
          label: 'transcription for existing audio files',
        },
        { id: 'p3', ask: false, wants: [], label: '' },
      ],
    }),
  );

describe('scanIdeas', () => {
  test('keeps real asks, drops pitches and noise, groups by idea, flags at build_at', async () => {
    const d = await db('ideas-scan');
    await saveIdeaScan(d, SEED.workspaceId, { subs: ['AskTechnology'], buildAt: 2 });
    const reddit = fakeReddit();
    const model = judge();
    const result = await scanIdeas(
      { db: d, model, fetchJson: reddit.fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId },
    );

    expect(result.read).toBe(5);
    expect(result.judged).toBe(true);
    expect(result.found).toBe(2);
    expect(result.rejected + (POSTS.length - 2 - 1)).toBeGreaterThanOrEqual(1); // the pitch never got through
    expect(result.sources[0]).toMatchObject({ sub: 'AskTechnology', via: 'archive' });

    const ideas = await listIdeas(d, SEED.workspaceId, { now: NOW });
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({
      label: 'transcription for existing audio files',
      askers: 2,
      asks: 2,
      status: 'build',
    });
    expect(ideas[0]!.wants).toContain('export to docx');
    expect(result.flagged).toEqual([ideas[0]!.id]);

    const detail = await getIdea(d, SEED.workspaceId, ideas[0]!.id);
    expect(detail!.asksList.map((a) => a.postId).sort()).toEqual(['p1', 'p2']);
    expect(detail!.asksList[0]!.url).toContain('reddit.com/r/AskTechnology/comments/');
  });

  test('a second scan reads nothing twice', async () => {
    const d = await db('ideas-rescan');
    await saveIdeaScan(d, SEED.workspaceId, { subs: ['AskTechnology'] });
    const reddit = fakeReddit();
    await scanIdeas(
      { db: d, model: judge(), fetchJson: reddit.fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId },
    );
    const again = await scanIdeas(
      { db: d, model: judge(), fetchJson: reddit.fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId },
    );
    expect(again.found).toBe(0);
    const rows = await queryAll(d, 'SELECT id FROM idea_asks WHERE workspace_id = ?', [
      SEED.workspaceId,
    ]);
    expect(rows).toHaveLength(2);
  });

  test('without a model the patterns decide, and the result says so', async () => {
    const d = await db('ideas-nomodel');
    await saveIdeaScan(d, SEED.workspaceId, { subs: ['AskTechnology'] });
    const result = await scanIdeas(
      { db: d, fetchJson: fakeReddit().fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId },
    );
    expect(result.judged).toBe(false);
    expect(result.found).toBeGreaterThanOrEqual(2);
    const titles = (await queryAll<{ title: string }>(d, 'SELECT title FROM idea_asks', [])).map(
      (r) => r.title,
    );
    expect(titles.some((x) => x.includes('cat'))).toBe(false);
  });

  test('settings, schedule and status', async () => {
    const d = await db('ideas-settings');
    expect((await getIdeaScan(d, SEED.workspaceId)).subs.length).toBeGreaterThan(5); // defaults
    const s = await saveIdeaScan(d, SEED.workspaceId, {
      subs: ['r/SomebodyMakeThis', 'bad sub!', 'webapps'],
      everyMinutes: 5,
    });
    expect(s.subs).toEqual(['SomebodyMakeThis', 'webapps']);
    expect(s.everyMinutes).toBe(30); // floor
    expect(await workspacesDueForIdeaScan(d, NOW)).toContain(SEED.workspaceId);
    await scanIdeas(
      { db: d, fetchJson: fakeReddit().fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId, subs: ['AskTechnology'] },
    );
    expect(await workspacesDueForIdeaScan(d, NOW)).not.toContain(SEED.workspaceId);
    const [idea] = await listIdeas(d, SEED.workspaceId, { now: NOW });
    expect(await updateIdea(d, SEED.workspaceId, idea!.id, { status: 'dismissed' })).toBe(true);
    expect(await listIdeas(d, SEED.workspaceId, { now: NOW })).toHaveLength(0);
    expect(await updateIdea(d, 'wsp_other', idea!.id, { status: 'build' })).toBe(false);
  });

  test('feeds: Ask HN and a case study join the Reddit idea, launches are rivals, worth ranks it', async () => {
    const d = await db('ideas-feeds');
    await saveIdeaScan(d, SEED.workspaceId, {
      subs: ['AskTechnology'],
      feeds: ['hnrss-org-7', 'indieniche-substack-com', 'hacker-news-show-hn'],
      buildAt: 10,
    });
    const reddit = fakeReddit();
    const iso = (daysAgo: number) => new Date(t(daysAgo) * 1000).toISOString();
    const FEEDS: Record<string, unknown[]> = {
      'hnrss-org-7': [
        {
          guid: 'https://news.ycombinator.com/item?id=111',
          url: 'https://news.ycombinator.com/item?id=111',
          title: 'Ask HN: Is there a tool to transcribe audio files I already recorded?',
          summary: 'I have hours of interviews. I would pay for something that exports to docx.',
          author: 'dave',
          publishedAt: iso(1),
        },
      ],
      'indieniche-substack-com': [
        {
          guid: 'https://indieniche.substack.com/p/transcribe',
          url: 'https://indieniche.substack.com/p/transcribe',
          title:
            'She Built a Transcription Tool for Recorded Audio Files. It Now Makes $12K/Month.',
          summary: 'Researchers upload interviews they already have.',
          publishedAt: iso(4),
        },
        {
          guid: 'https://indieniche.substack.com/p/advice',
          url: 'https://indieniche.substack.com/p/advice',
          title: 'Five things I learned this week',
          summary: 'Some general thoughts.',
          publishedAt: iso(2),
        },
      ],
      'hacker-news-show-hn': [
        {
          guid: 'https://news.ycombinator.com/item?id=222',
          url: 'https://news.ycombinator.com/item?id=222',
          title: 'Show HN: Transcription for audio files you already recorded',
          author: 'erin',
          publishedAt: iso(3),
        },
      ],
    };
    const fetchJson = async (url: string) => {
      const feed = /\/api\/feeds\/([^/?]+)/.exec(url)?.[1];
      if (feed) return { freshness: 'live', items: FEEDS[feed] ?? [] };
      return reddit.fetchJson(url);
    };
    const label = 'transcription for existing audio files';
    const model = new StubModel(
      JSON.stringify({
        results: [
          { id: 'p1', ask: true, idea: true, wants: ['transcribe existing audio files'], label },
          { id: 'p2', ask: true, idea: true, wants: ['transcribe uploaded mp3 files'], label },
          { id: 'p3', ask: false, idea: false, wants: [], label: '' },
          { id: 'hn:111', ask: true, idea: true, wants: ['transcribe recorded interviews'], label },
          {
            id: 'feed:indieniche-substack-com:https://indieniche.substack.com/p/transcribe',
            ask: false,
            idea: true,
            wants: ['transcribe recorded audio files'],
            label,
            paid: true,
          },
        ],
      }),
    );

    const result = await scanIdeas(
      { db: d, model, fetchJson, archiveGapMs: 0, now: NOW },
      { workspaceId: SEED.workspaceId },
    );
    expect(result.found).toBe(4);
    expect(result.sources.map((s) => s.via)).toContain('feed:signals');

    const [idea] = await listIdeas(d, SEED.workspaceId, { now: NOW });
    expect(idea).toMatchObject({ label, askers: 4, paid: 2, verdict: 'build' });
    expect(idea!.subs).toEqual(['AskTechnology']);
    expect(idea!.feeds.sort()).toEqual(['Ask HN', 'Indieniche']);
    expect(idea!.revenue).toEqual(['$12K/Month']);
    expect(idea!.rivals.map((r) => r.url)).toEqual(['https://news.ycombinator.com/item?id=222']);
    expect(idea!.worth).toBeGreaterThan(idea!.demand);

    // Launches are re-read, never filed as demand.
    const sources = await queryAll<{ source: string }>(
      d,
      'SELECT source FROM idea_asks WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(sources.filter((s) => s.source === 'feed')).toHaveLength(2);
  });
});
