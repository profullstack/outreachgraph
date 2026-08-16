import { describe, expect, test } from 'bun:test';
import { buildShareLink, buildShareLinks, fitText, SHARE_NETWORKS } from './share-links';

describe('fitText', () => {
  test('leaves a short message alone', () => {
    expect(fitText('hello', 280)).toBe('hello');
  });

  test('breaks on a word rather than mid-word', () => {
    const fitted = fitText('alpha beta gamma delta epsilon', 20);

    expect(fitted.length).toBeLessThanOrEqual(20);
    expect(fitted).toBe('alpha beta gamma…');
  });

  test('hard-cuts when there is no sensible break near the end', () => {
    // One very long token: breaking on the last space would throw away most of
    // the message, so the ellipsis goes where the limit is.
    expect(fitText(`ab ${'x'.repeat(40)}`, 20)).toHaveLength(20);
  });
});

describe('buildShareLink', () => {
  test('puts the message in the X composer', () => {
    const link = buildShareLink('x', { text: 'Hello there', url: 'https://example.com' });

    expect(link?.url).toContain('https://x.com/intent/post?text=Hello%20there');
    expect(link?.url).toContain('url=https%3A%2F%2Fexample.com');
  });

  test('folds the link into Bluesky’s text, which has no url parameter', () => {
    const link = buildShareLink('bluesky', { text: 'Hello', url: 'https://example.com' });

    expect(link?.url).toContain('bsky.app/intent/compose');
    expect(link?.url).toContain(encodeURIComponent('Hello https://example.com'));
  });

  test('shortens to each network’s own limit and says so', () => {
    const long = 'word '.repeat(200);

    expect(buildShareLink('x', { text: long })?.text.length).toBeLessThanOrEqual(280);
    expect(buildShareLink('bluesky', { text: long })?.text.length).toBeLessThanOrEqual(300);
    expect(buildShareLink('x', { text: long })?.note).toContain('280');
  });

  test('offers nothing for a network that cannot open without a link', () => {
    // A Facebook button with no URL opens an error page. Not offering it is
    // the honest outcome.
    expect(buildShareLink('facebook', { text: 'Hello' })).toBeUndefined();
    expect(buildShareLink('hackernews', { text: 'Hello' })).toBeUndefined();

    expect(buildShareLink('facebook', { text: 'Hello', url: 'https://example.com' })).toBeDefined();
  });

  test('warns that Facebook will not carry the message', () => {
    const link = buildShareLink('facebook', { text: 'Hello', url: 'https://example.com' });

    expect(link?.text).toBe('');
    expect(link?.note).toContain('only accepts a link');
  });

  test('submits a Reddit self post when there is no link', () => {
    const link = buildShareLink('reddit', { text: 'Body copy', title: 'A title' });

    expect(link?.url).toContain('selftext=true');
    expect(link?.url).toContain('text=Body%20copy');
  });

  test('submits a Reddit link post when there is one', () => {
    // Reddit drops `text` on a link submission, so sending both silently loses
    // the message.
    const link = buildShareLink('reddit', {
      text: 'Body copy',
      title: 'A title',
      url: 'https://example.com',
    });

    expect(link?.url).toContain('url=https%3A%2F%2Fexample.com');
    expect(link?.url).not.toContain('selftext');
  });

  test('opens LinkedIn’s own composer rather than posting', () => {
    // The no-automation rule permits research and drafts; the human acts in
    // LinkedIn's interface. `shareActive` opens it — it does not submit.
    const link = buildShareLink('linkedin', { text: 'Hello' });

    expect(link?.url).toContain('linkedin.com/feed/?shareActive=true');
  });

  test('accepts a Mastodon instance and ignores a malicious one', () => {
    expect(
      buildShareLink('mastodon', { text: 'Hi', mastodonInstance: 'fosstodon.org' })?.url,
    ).toContain('https://fosstodon.org/share');

    // The instance lands in a URL the user's browser is told to open, so a
    // value with a path or a scheme in it must not be able to redirect them.
    expect(
      buildShareLink('mastodon', { text: 'Hi', mastodonInstance: 'evil.example/@x?a=' })?.url,
    ).toContain('https://evil.example/share');
    expect(
      buildShareLink('mastodon', { text: 'Hi', mastodonInstance: 'not a host' })?.url,
    ).toContain('https://mastodon.social/share');
  });

  test('escapes text that would otherwise break out of the query string', () => {
    const link = buildShareLink('x', { text: 'a&b=c #tag' });

    expect(link?.url).not.toContain('&b=');
    expect(link?.url).toContain('%26b%3Dc%20%23tag');
  });
});

describe('buildShareLinks', () => {
  test('returns every network that works with only text', () => {
    const links = buildShareLinks({ text: 'Hello there' });
    const networks = links.map((link) => link.network);

    expect(networks).toContain('x');
    expect(networks).toContain('bluesky');
    expect(networks).toContain('nextdoor');
    // The two that need a link are absent.
    expect(networks).not.toContain('facebook');
    expect(links).toHaveLength(SHARE_NETWORKS.length - 2);
  });

  test('returns all of them once there is a link', () => {
    expect(buildShareLinks({ text: 'Hello', url: 'https://example.com' })).toHaveLength(
      SHARE_NETWORKS.length,
    );
  });
});
