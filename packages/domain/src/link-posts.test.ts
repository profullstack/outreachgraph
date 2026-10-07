import { describe, expect, test } from 'bun:test';
import {
  LINK_POST_NETWORKS,
  linkPostBodyFromText,
  linkPostCard,
  linkPostLength,
  linkPostPasteText,
} from './link-posts';

const URL = 'https://example.com/blog/launch';

describe('link post cards', () => {
  test('LinkedIn: the link follows the post, and Open prefills the composer', () => {
    const card = linkPostCard({ network: 'linkedin', url: URL, body: 'We shipped it.' });
    expect(card.text).toBe(`We shipped it.\n\n${URL}`);
    expect(card.openUrl).toStartWith('https://www.linkedin.com/feed/?shareActive=true&text=');
    expect(decodeURIComponent(card.openUrl!)).toContain(URL);
    expect(card.openLabel).toBe('Open LinkedIn');
    expect(card.limit).toBe(3000);
    expect(card.overLimit).toBe(false);
    expect(card.steps.at(-1)).toBe('Press Mark done.');
  });

  test('X counts any link as 23 characters', () => {
    const body = 'a'.repeat(256);
    expect(linkPostLength('x', linkPostPasteText('x', body, URL))).toBe(256 + 2 + 23);
    const card = linkPostCard({ network: 'x', url: URL, body });
    expect(card.chars).toBe(281);
    expect(card.overLimit).toBe(true);
    expect(card.openUrl).toContain('x.com/intent/post');
  });

  test('Reddit: the title is the post, the subreddit is cleaned, the text is a first comment', () => {
    const card = linkPostCard({
      network: 'reddit',
      url: URL,
      body: 'I built this; feedback welcome.',
      title: 'An open-source tool for X',
      subreddit: 'r/SideProject',
    });
    expect(card.subreddit).toBe('SideProject');
    expect(card.text).toBe('I built this; feedback welcome.');
    expect(card.openUrl).toStartWith('https://www.reddit.com/r/SideProject/submit?title=');
    expect(card.chars).toBe('An open-source tool for X'.length);
    expect(card.steps.join(' ')).toContain('first comment');
  });

  test('Hacker News: an 80-character title limit, and no first-comment step when there is none', () => {
    const card = linkPostCard({ network: 'hackernews', url: URL, body: '', title: 'x'.repeat(90) });
    expect(card.limit).toBe(80);
    expect(card.overLimit).toBe(true);
    expect(card.openUrl).toContain('news.ycombinator.com/submitlink');
    expect(card.steps.join(' ')).not.toContain('first comment');
  });

  test('Facebook: Copy comes first because its composer takes only the link', () => {
    const card = linkPostCard({ network: 'facebook', url: URL, body: 'Worth a read.' });
    expect(card.text).toBe('Worth a read.');
    expect(card.openUrl).toContain('facebook.com/sharer');
    expect(card.steps[0]).toBe('Press Copy.');
  });

  test('every network builds a card with an Open link', () => {
    for (const network of LINK_POST_NETWORKS) {
      const card = linkPostCard({ network, url: URL, body: 'Hello', title: 'Hello' });
      expect(card.openUrl).toBeDefined();
      expect(card.steps.length).toBeGreaterThan(1);
    }
  });

  test('an edited text loses the link the card added, so it is not added twice', () => {
    expect(linkPostBodyFromText('linkedin', `Edited.\n\n${URL}`, URL)).toBe('Edited.');
    expect(linkPostBodyFromText('reddit', `Edited. ${URL}`, URL)).toBe(`Edited. ${URL}`);
    expect(linkPostPasteText('linkedin', `Already has ${URL}`, URL)).toBe(`Already has ${URL}`);
  });
});
