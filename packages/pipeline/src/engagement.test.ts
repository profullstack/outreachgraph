/**
 * Engagement, and the two things it must not do.
 *
 * A tracked link must never send a browser anywhere except the exact URL that
 * was stored for it, and a hit that a machine made must never be counted as a
 * person. Both failures are quiet: the first publishes an open redirect on our
 * own sending domain, and the second tells a user a prospect is interested
 * when nobody has read the message.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  engagementFor,
  recordLinkClick,
  relationshipInputFrom,
  trackLinksInBody,
} from './engagement';
import { rescoreProspect } from './jobs';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ORIGIN = 'https://app.test';

async function track(db: Client, body: string) {
  return trackLinksInBody(db, {
    workspaceId: SEED.workspaceId,
    personId: SEED.personId,
    campaignId: SEED.campaignId,
    body,
    origin: ORIGIN,
  });
}

async function inbound(db: Client, state: string): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound' AND state = ?`,
    [SEED.workspaceId, SEED.personId, state],
  );
  return Number(row?.n ?? 0);
}

/** Records an inbound reply the way `receive-email` does. */
async function replied(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
          state, occurred_at, recorded_at)
          VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?)`,
    args: [newId('interaction'), SEED.workspaceId, SEED.personId, now(), now()],
  });
}

describe('trackLinksInBody', () => {
  test('rewrites a link and stores where it pointed', async () => {
    seeded = await seedDatabase('engagement-rewrite');
    const { db } = seeded;

    const result = await track(db, 'the docs are at https://example.com/docs');

    expect(result.tracked).toBe(1);
    expect(result.body).not.toContain('example.com');
    expect(result.body).toContain(`${ORIGIN}/t/tlk_`);

    const links = await queryAll<{ target_url: string }>(
      db,
      'SELECT target_url FROM tracked_links',
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.target_url).toBe('https://example.com/docs');
  });

  test('leaves a body with no links exactly as approved', async () => {
    seeded = await seedDatabase('engagement-nolinks');
    const { db } = seeded;

    const body = 'Saw your post about settlement fees. Worth a quick chat?';
    const result = await track(db, body);

    expect(result.body).toBe(body);
    expect(result.tracked).toBe(0);
  });

  test('does not re-track a body that already carries our own links', async () => {
    seeded = await seedDatabase('engagement-nonest');
    const { db } = seeded;

    const once = await track(db, 'see https://example.com/a');
    const twice = await track(db, once.body);

    expect(twice.tracked).toBe(0);
    expect(twice.body).toBe(once.body);
  });

  test('tracks each distinct link separately', async () => {
    seeded = await seedDatabase('engagement-multi');
    const { db } = seeded;

    const result = await track(db, 'https://a.dev/one and https://b.dev/two');

    expect(result.tracked).toBe(2);
    const links = await queryAll<{ target_url: string }>(
      db,
      'SELECT target_url FROM tracked_links ORDER BY target_url',
    );
    expect(links.map((l) => l.target_url)).toEqual(['https://a.dev/one', 'https://b.dev/two']);
  });
});

describe('recordLinkClick', () => {
  test('redirects only to the stored destination', async () => {
    seeded = await seedDatabase('engagement-redirect');
    const { db } = seeded;

    await track(db, 'https://example.com/pricing');
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');

    const click = await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mozilla/5.0 Chrome/140',
      at: new Date(Date.now() + 60_000),
    });

    expect(click?.targetUrl).toBe('https://example.com/pricing');
    expect(click?.personId).toBe(SEED.personId);
    expect(click?.automated).toBeUndefined();
    expect(click?.firstClick).toBe(true);
  });

  test('returns nothing for an unknown token', async () => {
    seeded = await seedDatabase('engagement-unknown');

    expect(await recordLinkClick(seeded.db, { token: 'tlk_nope' })).toBeUndefined();
  });

  test('records a scanner prefetch without counting it as a click', async () => {
    seeded = await seedDatabase('engagement-prefetch');
    const { db } = seeded;

    await track(db, 'https://example.com/x');
    const link = await queryOne<{ id: string; created_at: string }>(
      db,
      'SELECT id, created_at FROM tracked_links',
    );

    const click = await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mozilla/5.0 Chrome/140',
      at: new Date(new Date(link!.created_at).getTime() + 1000),
    });

    expect(click?.automated).toBe('prefetch');
    expect(click?.firstClick).toBe(false);

    // The hit is still stored — a workspace whose mail is scanned deserves to
    // see why its click count is lower than its server logs.
    const hits = await queryAll<{ automated: string | null }>(
      db,
      'SELECT automated FROM link_clicks',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.automated).toBe('prefetch');
    expect(await inbound(db, 'clicked')).toBe(0);
  });

  test('does not count a self-identifying bot', async () => {
    seeded = await seedDatabase('engagement-bot');
    const { db } = seeded;

    await track(db, 'https://example.com/y');
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');

    const click = await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mimecast Link Protection',
      at: new Date(Date.now() + 3_600_000),
    });

    expect(click?.automated).toBe('bot');
    expect(await inbound(db, 'clicked')).toBe(0);
  });

  test('counts one interaction however many times they click', async () => {
    seeded = await seedDatabase('engagement-repeat');
    const { db } = seeded;

    await track(db, 'https://example.com/z');
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');
    const later = new Date(Date.now() + 60_000);

    const first = await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Chrome/140',
      at: later,
    });
    const second = await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Chrome/140',
      at: new Date(later.getTime() + 60_000),
    });

    expect(first?.firstClick).toBe(true);
    expect(second?.firstClick).toBe(false);

    // Both raw hits are kept; only one says "this person engaged".
    expect(await queryAll(db, 'SELECT id FROM link_clicks')).toHaveLength(2);
    expect(await inbound(db, 'clicked')).toBe(1);
  });
});

describe('engagementFor', () => {
  test('reports nothing for a prospect who has never answered', async () => {
    seeded = await seedDatabase('engagement-cold');

    const facts = await engagementFor(seeded.db, SEED.workspaceId, SEED.personId);

    expect(facts.previouslyReplied).toBe(false);
    expect(facts.clickedLink).toBe(false);
    expect(relationshipInputFrom(facts)).toEqual({});
  });

  test('reports a reply', async () => {
    seeded = await seedDatabase('engagement-replied');
    await replied(seeded.db);

    const facts = await engagementFor(seeded.db, SEED.workspaceId, SEED.personId);

    expect(facts.previouslyReplied).toBe(true);
    expect(relationshipInputFrom(facts)).toEqual({ previouslyReplied: true });
  });

  test('reports a click', async () => {
    seeded = await seedDatabase('engagement-clicked');
    const { db } = seeded;

    await track(db, 'https://example.com/q');
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');
    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Chrome/140',
      at: new Date(Date.now() + 60_000),
    });

    const facts = await engagementFor(db, SEED.workspaceId, SEED.personId);

    expect(facts.clickedLink).toBe(true);
    expect(relationshipInputFrom(facts)).toEqual({ clickedLink: true });
  });

  test('does not leak another workspace’s engagement', async () => {
    seeded = await seedDatabase('engagement-isolation');
    await replied(seeded.db);

    const facts = await engagementFor(seeded.db, 'wsp_someone_else', SEED.personId);

    expect(facts.previouslyReplied).toBe(false);
  });
});

describe('rescoreProspect', () => {
  async function relationshipScore(db: Client): Promise<number> {
    await rescoreProspect(db, SEED.campaignId, SEED.personId);
    const row = await queryOne<{ relationship: number; opportunity: number }>(
      db,
      'SELECT relationship, opportunity FROM scores WHERE campaign_id = ? AND person_id = ?',
      [SEED.campaignId, SEED.personId],
    );
    return Number(row?.relationship ?? -1);
  }

  test('scores a cold prospect at zero relationship', async () => {
    seeded = await seedDatabase('engagement-score-cold');

    expect(await relationshipScore(seeded.db)).toBe(0);
  });

  test('a reply raises the relationship score', async () => {
    // The regression this whole module exists for: `relationship` was a
    // hardcoded 0, so this number never moved no matter what a prospect did.
    seeded = await seedDatabase('engagement-score-replied');
    const before = await relationshipScore(seeded.db);

    await replied(seeded.db);
    const after = await relationshipScore(seeded.db);

    expect(before).toBe(0);
    expect(after).toBeGreaterThan(before);
  });

  test('a click raises it by less than a reply does', async () => {
    seeded = await seedDatabase('engagement-score-clicked');
    const { db } = seeded;

    await track(db, 'https://example.com/pricing');
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');
    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Chrome/140',
      at: new Date(Date.now() + 60_000),
    });

    const clicked = await relationshipScore(db);
    await replied(db);
    const alsoReplied = await relationshipScore(db);

    expect(clicked).toBeGreaterThan(0);
    expect(alsoReplied).toBeGreaterThan(clicked);
  });

  test('a scanner prefetch leaves the score where it was', async () => {
    seeded = await seedDatabase('engagement-score-prefetch');
    const { db } = seeded;

    await track(db, 'https://example.com/x');
    const link = await queryOne<{ id: string; created_at: string }>(
      db,
      'SELECT id, created_at FROM tracked_links',
    );
    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Chrome/140',
      at: new Date(new Date(link!.created_at).getTime() + 1000),
    });

    expect(await relationshipScore(db)).toBe(0);
  });
});
