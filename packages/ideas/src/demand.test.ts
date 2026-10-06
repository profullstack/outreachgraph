import { describe, expect, test } from 'bun:test';
import { briefText, chovyConfig, handToChovy } from './chovy';
import { askTerms, bestIdea, classifyAsk, demandScore, ideaTermsOf } from './demand';
import { pacedFetch, readSub } from './reddit';

describe('classifyAsk', () => {
  test('the two posts typeheard.com was built for are asks', () => {
    const a = classifyAsk(
      'What is the best transcription software for interviews? Doing 12 for my thesis',
    );
    const b = classifyAsk('What are the best Otter.ai alternatives for files I already have?');
    expect(a.score).toBeGreaterThanOrEqual(0.5);
    expect(b.score).toBeGreaterThanOrEqual(0.45);
  });
  test('is there an app that... with features in the body', () => {
    const v = classifyAsk(
      'Is there an app that tracks subscriptions and warns me before renewals?',
      'I want it to export to csv and support multiple currencies.',
    );
    expect(v.kind).toBe('is-there');
    expect(v.score).toBeGreaterThan(0.7);
    expect(v.wants.join(' | ')).toContain('subscriptions');
    expect(v.wants.join(' | ')).toMatch(/csv/);
  });
  test('a founder pitching their own tool is not demand', () => {
    const v = classifyAsk(
      'I built a tool that tracks subscriptions, is there a market for this?',
      'Would you pay for it?',
    );
    expect(v.score).toBeLessThan(0.5);
  });
  test('an unrelated post is not an ask', () => {
    expect(classifyAsk('My cat knocked over my coffee again').score).toBe(0);
  });
});

describe('grouping', () => {
  const habit1 = {
    title: 'Is there a habit tracker with streaks that syncs across devices?',
    wants: ['habit tracker with streaks', 'syncs across devices'],
    label: 'habit tracker with streaks',
  };
  const habit2 = {
    title: 'Looking for a habit tracker app with streaks and widgets',
    wants: ['habit tracker app with streaks', 'widgets'],
    label: 'habit tracker with streaks',
  };
  const signage = {
    title: 'Is there digital signage software that plays a video playlist?',
    wants: ['digital signage', 'video playlist'],
    label: 'digital signage software',
  };

  test('two people asking for the same thing land in one idea', () => {
    const idea = { id: 'i1', label: habit1.label, named: true, terms: ideaTermsOf([habit1]) };
    expect(bestIdea([idea], habit2)?.id).toBe('i1');
  });
  test('different things do not merge just because they share a word', () => {
    const downloader = {
      id: 'i2',
      label: 'playlist video downloader',
      named: true,
      terms: askTerms({ title: 'video playlist downloader', wants: ['download video playlist'] }),
    };
    expect(bestIdea([downloader], signage)).toBeUndefined();
  });
  test('demand counts distinct people first', () => {
    const one = demandScore([{ author: 'a', score: 50, comments: 30 }]);
    const three = demandScore([{ author: 'a' }, { author: 'b' }, { author: 'c' }]);
    expect(three.askers).toBe(3);
    expect(three.demand).toBeGreaterThan(one.demand);
  });
});

describe('reading', () => {
  test('falls back to the archive when RSS Amplifier has nothing', async () => {
    const urls: string[] = [];
    const fake = async (url: string) => {
      urls.push(url);
      if (url.includes('rssamplifier')) return { items: [] };
      return {
        data: [
          {
            id: 'abc',
            title: 'Is there an app for X?',
            author: 'u1',
            subreddit: 'software',
            created_utc: 1_790_000_000,
            permalink: '/r/software/comments/abc/x/',
            score: 3,
            num_comments: 2,
          },
        ],
      };
    };
    const r = await readSub('software', fake);
    expect(r.via).toBe('archive');
    expect(r.posts[0]).toMatchObject({ id: 'abc', author: 'u1', score: 3, comments: 2 });
    expect(r.posts[0]?.url).toBe('https://www.reddit.com/r/software/comments/abc/x/');
  });
  test('archive calls are paced and retried once when told to slow down', async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1)
        throw Object.assign(new Error('Timeout. Maybe slow down a bit'), { status: 422 });
      return { data: [] };
    };
    const paced = pacedFetch(flaky, 5);
    await paced('https://arctic-shift.photon-reddit.com/api/posts/search?subreddit=x');
    expect(calls).toBe(2);
  });
});

describe('chovy hand-off', () => {
  const brief = {
    label: 'transcription for files I already have',
    wants: ['upload audio', 'export transcript'],
    askers: 3,
    subs: ['AskTechnology'],
    examples: [
      {
        title: 'Otter.ai alternatives for files I already have?',
        url: 'https://www.reddit.com/r/AskTechnology/comments/1wuoyvc/',
      },
    ],
  };
  test('the brief says what to build, what it must do and who asked', () => {
    const t = briefText(brief);
    expect(t).toContain('Build a web app: transcription for files I already have.');
    expect(t).toContain('upload audio; export transcript');
    expect(t).toContain('3 different people');
    expect(t).toContain('1wuoyvc');
  });
  test('no secret, no hand-off', () => {
    expect(chovyConfig({})).toBeNull();
    expect(chovyConfig({ CHOVY_CAMPAIGN_SECRET: 's' })?.url).toBe('https://chovy.com');
  });
  test('posts the brief with the bearer secret and returns the link', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({ id: 7, handoff_url: 'https://chovy.com/start?c=tok', expires_at: 1 }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const h = await handToChovy({ url: 'https://chovy.com', secret: 'sek' }, brief, 'idea-1', fake);
    expect(h.handoff_url).toBe('https://chovy.com/start?c=tok');
    expect(seen?.url).toBe('https://chovy.com/api/campaign/contexts');
    expect((seen?.init.headers as Record<string, string>).authorization).toBe('Bearer sek');
    expect(JSON.parse(String(seen?.init.body)).first_touch.utm_campaign).toBe('idea-1');
  });
});
