/**
 * The Idea Generator: scan, group, judge, flag.
 *
 * What has to hold: posts shaped like an ask are kept and others are not; the
 * judge throws out a founder's pitch; different people asking for the same
 * thing land in one idea, which is flagged 'build' at `build_at` askers; a
 * second scan reads nothing twice; and nothing leaks between workspaces.
 */

import { afterEach, describe, expect, test } from 'bun:test';
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
});
