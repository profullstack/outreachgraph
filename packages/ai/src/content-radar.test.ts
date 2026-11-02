import { describe, expect, test } from 'bun:test';
import {
  analyzeHooks,
  draftStudio,
  heuristicHook,
  parseHookAnalyses,
  parseStudio,
  referenceDirection,
  renderImageCardSvg,
  wrapLines,
} from './content-radar';
import { StubModel } from './model';

describe('heuristicHook', () => {
  test('reads the obvious hooks from the wording', () => {
    expect(heuristicHook("I stopped tracking streaks. Here's what changed.")).toBe('contrarian');
    expect(heuristicHook('Show HN: a habit tracker')).toBe('launch');
    expect(heuristicHook('How I got 1,000 users in 30 days')).toBe('data');
    expect(heuristicHook("What's your minimum on a hard day?")).toBe('question');
    expect(heuristicHook('Consistency can be kind.')).toBe('fresh_angle');
  });
});

describe('hook analysis', () => {
  test('parses results, normalises the type and drops unknown ids', async () => {
    const model = new StubModel(
      '```json\n{"results":[{"id":"r1","hook":"Mindset Shift","why":"It reframes failure.","angle":"Show a missed day as normal."},{"id":"zz","hook":"story"}]}\n```',
    );
    const out = await analyzeHooks(model, { name: 'Daymark' }, [
      {
        id: 'r1',
        source: 'bluesky',
        text: 'A missed day is not a failed habit.',
        likes: 9,
        reposts: 1,
        comments: 2,
      },
    ]);
    expect(out).toEqual([
      {
        id: 'r1',
        hookType: 'mindset_shift',
        why: 'It reframes failure.',
        angle: 'Show a missed day as normal.',
        relevant: true,
      },
    ]);
    expect(model.calls[0]!.user).toContain('PRODUCT: Daymark');
    expect(model.calls[0]!.user).toContain('9 likes');
  });

  test('only an explicit "relevant": false marks a post off-topic', () => {
    const out = parseHookAnalyses(
      '{"results":[{"id":"a","hook":"story","relevant":false},{"id":"b","hook":"story"}]}',
    );
    expect(out.map((r) => r.relevant)).toEqual([false, true]);
  });

  test('an unknown hook type falls back to fresh_angle', () => {
    expect(parseHookAnalyses('{"results":[{"id":1,"hook":"vibes"}]}')[0]!.hookType).toBe(
      'fresh_angle',
    );
  });
});

describe('studio', () => {
  const RAW = JSON.stringify({
    storyboard: {
      title: 'Missed a day?',
      caption: 'Keep the progress.',
      scenes: [
        {
          beat: 'hook',
          onScreen: 'Missed a day?',
          voiceover: 'You missed Tuesday.',
          shot: 'Calendar',
          seconds: 3,
        },
        {
          beat: 'weird',
          onScreen: 'Monday still counts',
          voiceover: 'The week is not lost.',
          shot: 'App',
          seconds: 99,
        },
        { onScreen: 'Try Daymark', voiceover: 'Start again today.', shot: 'Logo' },
      ],
    },
    image: {
      eyebrow: 'Daymark',
      headline: 'Missed a day? You are still moving forward.',
      support: 'One day off. Plenty ahead.',
      footer: 'daymark.app',
      caption: 'Small steps.',
    },
  });

  test('parses a storyboard and an image card, fixing beats and lengths', () => {
    const out = parseStudio(RAW, 'Daymark');
    expect(out.storyboard!.scenes.map((s) => s.beat)).toEqual(['hook', 'story', 'invitation']);
    expect(out.storyboard!.scenes[1]!.seconds).toBe(15);
    expect(out.image!.headline).toBe('Missed a day? You are still moving forward.');
  });

  test('draftStudio passes the reference as a structure, not as copy', async () => {
    const model = new StubModel(RAW);
    const out = await draftStudio(model, {
      brand: { name: 'Daymark', url: 'https://daymark.app' },
      reference: {
        source: 'tiktok',
        text: 'I stopped tracking streaks.',
        hookType: 'Contrarian hook',
      },
    });
    expect(out.model).toBe('stub');
    expect(out.image).toBeDefined();
    expect(model.calls[0]!.system).toContain('never the words');
    expect(model.calls[0]!.user).toContain('HOOK TYPE: Contrarian hook');
  });

  test('referenceDirection tells the post writer not to copy', () => {
    const text = referenceDirection({
      source: 'x',
      text: 'A missed day is not a failure',
      why: 'reframe',
    });
    expect(text).toContain('Do not copy');
    expect(text).toContain('Why it worked: reframe');
  });
});

describe('studio from a small model', () => {
  // What qwen2.5 on c0mpute actually answered the JSON prompt with, 2026-11-02.
  const MARKDOWN = [
    '**Scene 1: Introduction**',
    '- **Beat:** "Max 8 words"',
    '- **Voiceover:** "Are you ready to turn your ideas into reality?"',
    '- **Shot:** A computer screen showing the website.',
    '- **Seconds:** 3',
    '',
    '**Scene 2: The Challenge**',
    '- **Voiceover:** "You are not just an idea."',
    '- **Shot:** A person at a desk, overwhelmed.',
    '- **Seconds:** 6',
    '',
    '**Scene 3: The Impact**',
    '- **Voiceover:** "Talk to us this week."',
    '- **Shot:** Logo.',
    '- **Seconds:** 40',
  ].join('\n');

  test('a markdown storyboard is read, and the image card comes from its hook', () => {
    const out = parseStudio(MARKDOWN, 'Profullstack');
    expect(out.storyboard!.scenes.map((s) => s.beat)).toEqual(['hook', 'story', 'invitation']);
    expect(out.storyboard!.scenes[0]!.voiceover).toBe(
      'Are you ready to turn your ideas into reality?',
    );
    expect(out.storyboard!.scenes[2]!.seconds).toBe(15);
    expect(out.image!.eyebrow).toBe('PROFULLSTACK');
    expect(out.image!.headline.length).toBeGreaterThan(5);
  });

  test('prose with no scenes yields nothing', () => {
    expect(parseStudio('Sorry, I cannot help with that.', 'X')).toEqual({});
  });
});

describe('image card', () => {
  test('wraps and truncates', () => {
    expect(wrapLines('one two three four five six', 9, 2)).toEqual(['one two', 'three…']);
  });

  test('renders escaped SVG at Instagram portrait size', () => {
    const svg = renderImageCardSvg({
      eyebrow: 'A&B',
      headline: 'Less <pressure> to be perfect',
      support: 'More reasons to keep going',
      footer: 'ab.app',
      caption: '',
    });
    expect(svg).toStartWith('<svg');
    expect(svg).toContain('width="1080" height="1350"');
    expect(svg).toContain('A&amp;B');
    expect(svg).toContain('&lt;pressure&gt;');
    expect(svg).not.toContain('<pressure>');
  });
});
