import { describe, expect, test } from 'bun:test';
import { cleanPostText, draftLinkPosts, linkPostPrompt, parseLinkPosts } from './link-post';
import { StubModel } from './model';

const URL = 'https://acme.dev/blog/fast-builds';

describe('link post drafting', () => {
  test("the prompt carries the page, the voice, the notes and each network's norms", () => {
    const prompt = linkPostPrompt({
      page: { url: URL, title: 'Fast builds', text: 'We cut build times by half.' },
      networks: ['linkedin', 'hackernews'],
      voice: { style: 'dry, technical', instructions: 'never say synergy' },
      brand: { name: 'Acme', url: 'https://acme.dev' },
      notes: 'mention the free tier',
    });
    expect(prompt).toContain('Title: Fast builds');
    expect(prompt).toContain('Style: dry, technical');
    expect(prompt).toContain('mention the free tier');
    expect(prompt).toContain('linkedin (LinkedIn):');
    expect(prompt).toContain('hackernews (Hacker News):');
    expect(prompt).toContain('This page is their own');
  });

  test("someone else's page is shared, not pitched", () => {
    const prompt = linkPostPrompt({
      page: { url: 'https://other.org/post' },
      networks: ['x'],
      brand: { name: 'Acme', url: 'https://acme.dev' },
    });
    expect(prompt).toContain("This page is someone else's");
    expect(prompt).toContain('(The page could not be read.)');
  });

  test('cleaning drops dashes, the link and wrapping quotes', () => {
    expect(cleanPostText(`"Builds are fast — really fast. ${URL}"`, URL)).toBe(
      'Builds are fast, really fast.',
    );
    expect(cleanPostText('See acme.dev/blog/fast-builds now', URL)).toBe('See now');
  });

  test('parses one draft per requested network, fits limits, drops the rest', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        posts: [
          { network: 'linkedin', title: null, text: 'Hook line.\n\nBody.', subreddit: null },
          { network: 'X', text: 'y'.repeat(400) },
          {
            network: 'reddit',
            title: 'Fast builds — how',
            text: 'I made it.',
            subreddit: 'r/devops',
          },
          { network: 'hackernews', title: '', text: '' },
          { network: 'myspace', text: 'nope' },
        ],
      }) +
      '\n```';
    const posts = parseLinkPosts(raw, ['linkedin', 'x', 'reddit', 'hackernews'], URL);
    expect(posts.map((p) => p.network)).toEqual(['linkedin', 'x', 'reddit']);
    expect(posts[0]!.text).toBe('Hook line.\n\nBody.');
    // 280 minus the link (23) and the blank line between them.
    expect([...posts[1]!.text].length).toBeLessThanOrEqual(255);
    expect(posts[2]).toEqual({
      network: 'reddit',
      text: 'I made it.',
      title: 'Fast builds, how',
      subreddit: 'devops',
    });
  });

  test('drafts through the model and reports which one answered', async () => {
    const model = new StubModel(JSON.stringify({ posts: [{ network: 'x', text: 'Fast.' }] }));
    const result = await draftLinkPosts(model, { page: { url: URL }, networks: ['x'] });
    expect(result).toEqual({ posts: [{ network: 'x', text: 'Fast.' }], model: 'stub' });
    expect(model.calls[0]!.user).toContain('x (X):');
  });
});
