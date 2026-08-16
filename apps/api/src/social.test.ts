/**
 * Prefilled social posts, and the trace they leave.
 *
 * The behaviour that matters is that a post made by hand reaches the same
 * funnel as an automated send, without borrowing any of the vocabulary the
 * policy engine reasons over.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import { confirmShare, recordShare, shareLinksFor, SocialError } from './social';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

describe('shareLinksFor', () => {
  test('offers composers built from the draft', async () => {
    seeded = await seedDatabase('share-links');
    const view = await shareLinksFor(seeded.db, SEED.workspaceId, SEED.recommendationId);

    expect(view.personName).toBeTruthy();
    expect(view.links.length).toBeGreaterThan(5);
    expect(view.links.map((link) => link.network)).toContain('bluesky');
  });

  test('uses the prospect’s own site as the link', async () => {
    // Without a URL, Facebook and Hacker News cannot open at all — and a post
    // about a company that does not link to it is not actionable anyway.
    seeded = await seedDatabase('share-url');
    const view = await shareLinksFor(seeded.db, SEED.workspaceId, SEED.recommendationId);

    expect(view.links.map((link) => link.network)).toContain('facebook');
  });

  test('refuses when there is nothing written yet', async () => {
    seeded = await seedDatabase('share-nodraft');
    await seeded.db.execute(`UPDATE drafts SET body = ''`);

    await expect(shareLinksFor(seeded.db, SEED.workspaceId, SEED.recommendationId)).rejects.toThrow(
      SocialError,
    );
  });

  test('does not leak another workspace’s recommendation', async () => {
    seeded = await seedDatabase('share-tenant');

    await expect(
      shareLinksFor(seeded.db, 'wsp_someone_else', SEED.recommendationId),
    ).rejects.toThrow(SocialError);
  });
});

describe('recordShare', () => {
  const input = {
    recommendationId: SEED.recommendationId,
    network: 'bluesky' as const,
    shareUrl: 'https://bsky.app/intent/compose?text=hi',
    text: 'hi',
  };

  test('stores the post and marks the recommendation executed', async () => {
    seeded = await seedDatabase('share-record');
    const recorded = await recordShare(seeded.db, SEED.workspaceId, input);

    expect(recorded.socialPostId).toStartWith('spo_');

    const row = await queryOne<{ network: string; share_url: string; confirmed_at: string | null }>(
      seeded.db,
      `SELECT network, share_url, confirmed_at FROM social_posts WHERE id = ?`,
      [recorded.socialPostId],
    );

    expect(row?.network).toBe('bluesky');
    expect(row?.confirmed_at).toBeNull();

    const recommendation = await queryOne<{ status: string }>(
      seeded.db,
      `SELECT status FROM recommendations WHERE id = ?`,
      [SEED.recommendationId],
    );
    expect(recommendation?.status).toBe('executed');
  });

  test('moves the lead through the funnel like a send does', async () => {
    seeded = await seedDatabase('share-funnel');
    await recordShare(seeded.db, SEED.workspaceId, input);

    const events = await queryAll<{ to_status: string; stage: string }>(
      seeded.db,
      `SELECT to_status, stage FROM lead_stage_events WHERE person_id = ? ORDER BY occurred_at DESC`,
      [SEED.personId],
    );

    // A lead contacted by hand on Bluesky has been contacted.
    expect(events[0]?.to_status).toBe('executed');
    expect(events[0]?.stage).toBe('contacted');
  });

  test('writes no action row, so it cannot spend the autopilot budget', async () => {
    // `actions` is what the daily cap counts, and its `kind`/`network` columns
    // are the vocabulary the policy engine reads. Neither `post` nor a network
    // like `nextdoor` belongs in there.
    seeded = await seedDatabase('share-noaction');
    const before = await queryOne<{ n: number }>(seeded.db, `SELECT COUNT(*) AS n FROM actions`);

    await recordShare(seeded.db, SEED.workspaceId, input);

    const after = await queryOne<{ n: number }>(seeded.db, `SELECT COUNT(*) AS n FROM actions`);
    expect(after?.n).toBe(before?.n ?? 0);
  });

  test('leaves a workflow event so the post shows up in the live feed', async () => {
    seeded = await seedDatabase('share-event');
    await recordShare(seeded.db, SEED.workspaceId, input);

    const event = await queryOne<{ phase: string; message: string }>(
      seeded.db,
      `SELECT phase, message FROM workflow_events WHERE phase = 'social'`,
    );

    expect(event?.phase).toBe('social');
    expect(event?.message).toContain('bluesky');
  });
});

describe('confirmShare', () => {
  test('records the user saying they went through with it, once', async () => {
    seeded = await seedDatabase('share-confirm');
    const recorded = await recordShare(seeded.db, SEED.workspaceId, {
      recommendationId: SEED.recommendationId,
      network: 'x',
      shareUrl: 'https://x.com/intent/post?text=hi',
      text: 'hi',
    });

    expect(await confirmShare(seeded.db, SEED.workspaceId, recorded.socialPostId)).toBe(true);
    expect(await confirmShare(seeded.db, SEED.workspaceId, recorded.socialPostId)).toBe(false);
  });
});
