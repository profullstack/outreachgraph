/**
 * Top posts: each source's response becomes ranked posts with their numbers,
 * the archive window ends two days ago, follows read the author feed, and a
 * repost of someone else is not the followed account's post.
 */

import { describe, expect, test } from 'bun:test';
import type { FetchLike } from '../site/fetch';
import { engagementScore, tagFor, TopPostReader } from './top-posts';

const NOW = Math.floor(Date.now() / 1000);
const ISO = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

function fakeFetch(routes: Record<string, unknown>, seen: string[] = []): FetchLike {
  return async (input) => {
    const url = String(input);
    seen.push(url);
    const key = Object.keys(routes).find((prefix) => url.includes(prefix));
    if (!key) return new Response('{}', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('engagementScore and tagFor', () => {
  test('reposts and comments count for more than likes', () => {
    expect(engagementScore({ likes: 10, reposts: 2, comments: 4 })).toBe(20);
  });
  test('hashtags are lowercase letters and digits', () => {
    expect(tagFor('Building in Public!')).toBe('buildinginpublic');
    expect(tagFor('#SaaS')).toBe('saas');
  });
});

describe('TopPostReader', () => {
  test('Hacker News stories rank by points and comments', async () => {
    const seen: string[] = [];
    const reader = new TopPostReader({
      gapMs: 0,
      fetchImpl: fakeFetch(
        {
          'hn.algolia.com': {
            hits: [
              {
                objectID: '1',
                title: 'A habit tracker that forgives missed days',
                author: 'maya',
                points: 12,
                num_comments: 3,
                created_at_i: NOW - 3600,
              },
              {
                objectID: '2',
                title: 'Show HN: My habit tracker',
                author: 'alex',
                points: 140,
                num_comments: 60,
                created_at_i: NOW - 7200,
              },
              { objectID: '3', title: 'Unrelated', points: 999, created_at_i: NOW },
            ],
          },
        },
        seen,
      ),
    });
    const posts = await reader.top('hackernews', { terms: ['habit tracker'] });
    expect(posts.map((p) => p.externalId)).toEqual(['2', '1']);
    expect(posts[0]).toMatchObject({
      source: 'hackernews',
      likes: 140,
      comments: 60,
      container: 'Show HN',
      matched: 'habit tracker',
      url: 'https://news.ycombinator.com/item?id=2',
    });
    expect(seen[0]).toContain('/search?');
    expect(decodeURIComponent(seen[0]!)).toContain('points>2');
  });

  test('Bluesky search asks for top posts and keeps the counts', async () => {
    const seen: string[] = [];
    const reader = new TopPostReader({
      gapMs: 0,
      fetchImpl: fakeFetch(
        {
          searchPosts: {
            posts: [
              {
                uri: 'at://did:plc:a/app.bsky.feed.post/abc',
                author: { handle: 'maya.bsky.social', displayName: 'Maya' },
                record: { text: 'My habit tracker forgives you', createdAt: ISO(2) },
                likeCount: 40,
                repostCount: 5,
                quoteCount: 1,
                replyCount: 8,
              },
              {
                uri: 'at://did:plc:b/app.bsky.feed.post/old',
                author: { handle: 'old.bsky.social' },
                record: { text: 'habit tracker from long ago', createdAt: ISO(90) },
                likeCount: 900,
              },
            ],
          },
        },
        seen,
      ),
    });
    const posts = await reader.top('bluesky', { terms: ['habit tracker'] });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      url: 'https://bsky.app/profile/maya.bsky.social/post/abc',
      likes: 40,
      reposts: 6,
      comments: 8,
      authorName: 'Maya',
    });
    expect(seen[0]).toContain('api.bsky.app');
    expect(seen[0]).toContain('sort=top');
  });

  test('dev.to reads the top articles of each tag', async () => {
    const seen: string[] = [];
    const reader = new TopPostReader({
      gapMs: 0,
      fetchImpl: fakeFetch(
        {
          'dev.to/api/articles': [
            {
              id: 7,
              title: 'I deleted half my onboarding',
              description: 'More people finished it.',
              url: 'https://dev.to/maya/onboarding',
              published_at: ISO(3),
              public_reactions_count: 90,
              comments_count: 12,
              user: { username: 'maya', name: 'Maya' },
            },
          ],
        },
        seen,
      ),
    });
    const posts = await reader.top('devto', { terms: ['onboarding'], tags: ['saas'] });
    expect(posts[0]).toMatchObject({ externalId: 'devto:7', likes: 90, comments: 12 });
    expect(seen.some((u) => u.includes('tag=saas') && u.includes('top='))).toBe(true);
    expect(seen.some((u) => u.includes('tag=onboarding'))).toBe(true);
  });

  test('Mastodon drops posts nobody engaged with', async () => {
    const reader = new TopPostReader({
      gapMs: 0,
      fetchImpl: fakeFetch({
        '/timelines/tag/': [
          {
            id: '1',
            url: 'https://mastodon.social/@a/1',
            content: '<p>Start again, <br>without starting over.</p>',
            created_at: ISO(1),
            favourites_count: 9,
            reblogs_count: 2,
            replies_count: 1,
            account: { acct: 'a' },
          },
          {
            id: '2',
            url: 'https://mastodon.social/@b/2',
            content: '<p>quiet</p>',
            created_at: ISO(1),
            account: { acct: 'b' },
          },
        ],
      }),
    });
    const posts = await reader.top('mastodon', { terms: ['habits'] });
    expect(posts.map((p) => p.externalId)).toEqual(['https://mastodon.social/@a/1']);
    expect(posts[0]!.text).toBe('Start again, without starting over.');
  });

  test('Reddit reads the archive window that ends two days ago', async () => {
    const seen: string[] = [];
    const reader = new TopPostReader({
      gapMs: 0,
      archivePages: 1,
      fetchImpl: fakeFetch(
        {
          'arctic-shift': {
            data: [
              {
                id: 'a1',
                author: 'u1',
                title: 'What helped you restart a habit?',
                selftext: 'Looking for something that sticks',
                permalink: '/r/habits/comments/a1/x/',
                subreddit: 'habits',
                created_utc: NOW - 5 * 86_400,
                score: 120,
                num_comments: 45,
              },
              { id: 'a2', author: 'AutoModerator', title: 'Weekly thread', score: 5 },
            ],
          },
        },
        seen,
      ),
    });
    const posts = await reader.top('reddit', { terms: [], subreddits: ['r/habits'] });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ likes: 120, comments: 45, matched: 'r/habits' });
    const before = Number(new URL(seen[0]!).searchParams.get('before'));
    expect(before).toBeLessThanOrEqual(NOW - 2 * 86_400 + 5);
    expect(new URL(seen[0]!).searchParams.get('subreddit')).toBe('habits');
  });

  test('a followed Bluesky account: own posts only, not its reposts', async () => {
    const reader = new TopPostReader({
      gapMs: 0,
      fetchImpl: fakeFetch({
        getAuthorFeed: {
          feed: [
            {
              post: {
                uri: 'at://did:plc:a/app.bsky.feed.post/own',
                author: { handle: 'rival.app' },
                record: { text: 'We shipped streak freezes', createdAt: ISO(4) },
                likeCount: 30,
              },
            },
            {
              reason: { $type: 'app.bsky.feed.defs#reasonRepost' },
              post: {
                uri: 'at://did:plc:z/app.bsky.feed.post/theirs',
                author: { handle: 'someone.else' },
                record: { text: 'not theirs', createdAt: ISO(1) },
                likeCount: 500,
              },
            },
          ],
        },
      }),
    });
    const posts = await reader.follow('bluesky', '@rival.app');
    expect(posts.map((p) => p.authorHandle)).toEqual(['rival.app']);
    expect(posts[0]!.matched).toBe('@rival.app');
  });
});
