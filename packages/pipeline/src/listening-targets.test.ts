import { afterEach, describe, expect, test } from 'bun:test';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  loadListeningTargets,
  normaliseFeedUrl,
  normaliseSubreddit,
  normaliseTargets,
  saveListeningTargets,
} from './listening-targets';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

describe('normaliseSubreddit', () => {
  test('accepts what someone actually pastes', () => {
    // All four are how a real person hands over a community.
    expect(normaliseSubreddit('plumbing')).toBe('plumbing');
    expect(normaliseSubreddit('r/plumbing')).toBe('plumbing');
    expect(normaliseSubreddit('/r/plumbing')).toBe('plumbing');
    expect(normaliseSubreddit('https://www.reddit.com/r/plumbing/')).toBe('plumbing');
  });

  test('rejects names Reddit cannot have', () => {
    // An invalid name does not error at search time — it returns an empty
    // listing, which is indistinguishable from a quiet community.
    expect(normaliseSubreddit('a')).toBeUndefined();
    expect(normaliseSubreddit('has spaces')).toBeUndefined();
    expect(normaliseSubreddit('')).toBeUndefined();
  });
});

describe('normaliseFeedUrl', () => {
  test('keeps absolute http(s) URLs and drops the rest', () => {
    expect(normaliseFeedUrl('https://example.com/feed.xml')).toBe('https://example.com/feed.xml');
    expect(normaliseFeedUrl('example.com/feed.xml')).toBeUndefined();
    expect(normaliseFeedUrl('javascript:alert(1)')).toBeUndefined();
  });
});

describe('normaliseTargets', () => {
  test('reports an unknown source rather than dropping it', () => {
    const { targets, unknown } = normaliseTargets({ sources: ['reddit', 'facebook'] });

    // Silently ignoring it would leave the screen reading "listening: on"
    // while nothing polls Facebook, which has no public search to poll.
    expect(targets.sources).toEqual(['reddit']);
    expect(unknown).toEqual(['facebook']);
  });

  test('one community is one entry regardless of case', () => {
    const { targets } = normaliseTargets({ subreddits: ['Plumbing', 'plumbing', 'r/PLUMBING'] });
    expect(targets.subreddits).toEqual(['Plumbing']);
  });

  test('unusable entries are dropped, not stored', () => {
    const { targets } = normaliseTargets({
      subreddits: ['plumbing', 'not a subreddit'],
      feeds: ['https://example.com/feed.xml', 'nonsense'],
    });

    expect(targets.subreddits).toEqual(['plumbing']);
    expect(targets.feeds).toEqual(['https://example.com/feed.xml']);
  });
});

describe('listening targets round-trip', () => {
  test('saves and reloads a campaign’s own targeting', async () => {
    seeded = await seedDatabase('targets-roundtrip');
    const { db } = seeded;

    const saved = await saveListeningTargets(db, SEED.workspaceId, SEED.campaignId, {
      sources: ['reddit', 'rss'],
      subreddits: ['plumbing'],
      feeds: ['https://example.com/feed.xml'],
    });

    expect(saved).toBe(true);

    const loaded = await loadListeningTargets(db, SEED.workspaceId, SEED.campaignId);
    expect(loaded.sources).toEqual(['reddit', 'rss']);
    expect(loaded.subreddits).toEqual(['plumbing']);
    expect(loaded.feeds).toEqual(['https://example.com/feed.xml']);
  });

  test('a campaign in another workspace is not writable', async () => {
    seeded = await seedDatabase('targets-tenancy');
    const { db } = seeded;

    const saved = await saveListeningTargets(db, 'ws_someone_else', SEED.campaignId, {
      sources: ['reddit'],
      subreddits: ['plumbing'],
      feeds: [],
    });

    expect(saved).toBe(false);
    // And nothing leaked the other way either.
    const loaded = await loadListeningTargets(db, 'ws_someone_else', SEED.campaignId);
    expect(loaded.sources).toEqual([]);
  });

  test('targeting can be set before the ICP filters exist', async () => {
    seeded = await seedDatabase('targets-no-filters');
    const { db } = seeded;

    await db.execute({
      sql: 'DELETE FROM campaign_filters WHERE campaign_id = ?',
      args: [SEED.campaignId],
    });

    // Choosing where to listen should not depend on the ICP having been
    // generated first — the row is upserted rather than assumed.
    const saved = await saveListeningTargets(db, SEED.workspaceId, SEED.campaignId, {
      sources: ['reddit'],
      subreddits: ['plumbing'],
      feeds: [],
    });

    expect(saved).toBe(true);
    expect((await loadListeningTargets(db, SEED.workspaceId, SEED.campaignId)).subreddits).toEqual([
      'plumbing',
    ]);
  });
});
