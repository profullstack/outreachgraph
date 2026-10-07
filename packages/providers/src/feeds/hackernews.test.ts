import { describe, expect, test } from 'bun:test';
import { HackerNewsSource, stripHtml } from './hackernews';

const hits = {
  hits: [
    {
      objectID: '101',
      author: 'alice',
      comment_text: 'We need a <i>SIEM</i> that doesn&#x27;t cost a fortune.<p>Ideas?',
      story_title: 'Ask HN: Security tooling for small teams',
      created_at_i: 1_791_300_000,
      _tags: ['comment', 'author_alice', 'story_99'],
    },
    {
      objectID: '102',
      author: 'bob',
      title: 'Show HN: My SIEM in Rust',
      story_text: '',
      created_at_i: 1_791_300_100,
      _tags: ['story', 'show_hn'],
    },
    {
      // Algolia matched the words separately; the phrase is not there.
      objectID: '103',
      author: 'carol',
      comment_text: 'Threat models and intel agencies.',
      created_at_i: 1_791_300_200,
      _tags: ['comment'],
    },
  ],
};

describe('HackerNewsSource', () => {
  test('one quoted request per term, comments and stories normalised, phrase checked', async () => {
    const urls: string[] = [];
    const source = new HackerNewsSource({
      gapMs: 0,
      fetchImpl: (async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify(hits), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const posts = await source.search({
      terms: ['siem', 'threat intel'],
      since: new Date(1_791_000_000 * 1000),
    });
    expect(urls).toHaveLength(2);
    expect(decodeURIComponent(urls[0]!)).toContain('query="siem"');
    expect(decodeURIComponent(urls[0]!)).toContain('numericFilters=created_at_i>1791000000');
    expect(posts.map((p) => p.externalId)).toEqual(['101', '102']);
    expect(posts[0]).toMatchObject({
      network: 'hackernews',
      authorHandle: 'alice',
      url: 'https://news.ycombinator.com/item?id=101',
      title: 'Ask HN: Security tooling for small teams',
      container: 'HN comment',
    });
    expect(posts[0]!.text).toBe("We need a SIEM that doesn't cost a fortune. Ideas?");
  });

  test('stripHtml', () => {
    expect(stripHtml('a<p>b &amp; <a href="x">c</a>')).toBe('a\n\nb & c');
  });
});
