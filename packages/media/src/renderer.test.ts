import { describe, expect, test } from 'bun:test';
import type { VideoScript } from '@outreachgraph/domain';
import {
  FixtureVideoRenderer,
  GenMediaVideoRenderer,
  RenderFailedError,
  type GenMediaClient,
} from './renderer';

const SCRIPT: VideoScript = {
  segments: [
    { kind: 'hook', text: 'I saw your question about payouts.', groundedSignalIds: ['sig_fees'] },
    { kind: 'context', text: 'We settle in 40 markets.', groundedSignalIds: [] },
    { kind: 'ask', text: 'Worth a look?', groundedSignalIds: [] },
  ],
  groundedSignalIds: ['sig_fees'],
  wordCount: 13,
  estimatedSeconds: 7,
};

describe('FixtureVideoRenderer', () => {
  test('renders without credentials', async () => {
    const rendered = await new FixtureVideoRenderer().render(SCRIPT);

    expect(rendered.renderer).toBe('fixture');
    expect(rendered.assetUrl).toMatch(/^https:\/\/fixtures\..*\.mp4$/);
    expect(rendered.durationSeconds).toBe(7);
  });

  test('is deterministic for the same script', async () => {
    const a = await new FixtureVideoRenderer().render(SCRIPT);
    const b = await new FixtureVideoRenderer().render(SCRIPT);

    expect(a.assetUrl).toBe(b.assetUrl);
  });

  test('differs for a different script', async () => {
    const other: VideoScript = {
      ...SCRIPT,
      segments: [{ kind: 'hook', text: 'Something else entirely.', groundedSignalIds: ['s'] }],
    };

    const a = await new FixtureVideoRenderer().render(SCRIPT);
    const b = await new FixtureVideoRenderer().render(other);

    expect(a.assetUrl).not.toBe(b.assetUrl);
  });

  test('records the scripts it was given', async () => {
    const renderer = new FixtureVideoRenderer();
    await renderer.render(SCRIPT);

    expect(renderer.calls).toEqual([SCRIPT]);
  });
});

describe('GenMediaVideoRenderer', () => {
  function client(): GenMediaClient & { prompts: string[] } {
    const prompts: string[] = [];
    return {
      prompts,
      generateVideo: async (options) => {
        prompts.push(String(options.prompt));
        return { toFile: async (path: string) => path };
      },
    };
  }

  test('speaks the script verbatim and adds nothing to it', async () => {
    const genmedia = client();
    const renderer = new GenMediaVideoRenderer({
      client: genmedia,
      publish: async (path) => `https://cdn.test/${path.split('/').pop()}`,
    });

    const rendered = await renderer.render(SCRIPT);

    expect(rendered.renderer).toBe('genmedia');
    expect(rendered.assetUrl).toMatch(/^https:\/\/cdn\.test\//);
    expect(genmedia.prompts[0]).toContain(
      'I saw your question about payouts. We settle in 40 markets. Worth a look?',
    );
  });

  test('passes style direction and aspect ratio through', async () => {
    const genmedia = client();
    let seenAspect: string | undefined;

    const renderer = new GenMediaVideoRenderer({
      client: {
        generateVideo: async (options) => {
          seenAspect = options.aspectRatio;
          genmedia.prompts.push(String(options.prompt));
          return { toFile: async (path: string) => path };
        },
      },
      publish: async (path) => path,
    });

    await renderer.render(SCRIPT, { aspectRatio: '9:16', styleDirection: 'Handheld, daylight.' });

    expect(seenAspect).toBe('9:16');
    expect(genmedia.prompts[0]).toContain('Handheld, daylight.');
  });

  test('wraps an upstream failure', async () => {
    const renderer = new GenMediaVideoRenderer({
      client: {
        generateVideo: async () => {
          throw new Error('quota exhausted');
        },
      },
      publish: async (path) => path,
    });

    expect(renderer.render(SCRIPT)).rejects.toThrow(RenderFailedError);
  });

  test('takes a custom renderer name', async () => {
    const renderer = new GenMediaVideoRenderer({
      client: client(),
      publish: async (path) => path,
      name: 'veo',
    });

    expect((await renderer.render(SCRIPT)).renderer).toBe('veo');
  });
});
