import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { FeedPost, FeedSource } from '@outreachgraph/providers';
import { FeedRateLimitError } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { runListening } from './listen';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function post(overrides: Partial<FeedPost> = {}): FeedPost {
  return {
    network: 'reddit',
    externalId: 'abc123',
    authorHandle: 'plumber_pete',
    authorUrl: 'https://www.reddit.com/user/plumber_pete',
    url: 'https://www.reddit.com/r/plumbing/comments/abc123/x/',
    title: 'Can anyone recommend job scheduling software?',
    text: 'Can anyone recommend job scheduling software? Running 6 vans by hand.',
    postedAt: '2026-08-10T09:00:00.000Z',
    container: 'r/plumbing',
    ...overrides,
  };
}

function source(posts: readonly FeedPost[], slug = 'reddit'): FeedSource {
  return {
    network: 'reddit',
    slug,
    displayName: slug,
    search: async () => posts,
  };
}

function failing(slug: string): FeedSource {
  return {
    network: 'reddit',
    slug,
    displayName: slug,
    search: async () => {
      throw new FeedRateLimitError(slug);
    },
  };
}

/** Gives the campaign something to listen for. */
async function setTerms(db: Client, keywords: string[]): Promise<void> {
  await db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, titles, seniorities, industries,
          technologies, keywords, exclusions, updated_at)
          VALUES (?, '[]', '[]', '[]', '[]', ?, '[]', ?)
          ON CONFLICT(campaign_id) DO UPDATE SET keywords = excluded.keywords`,
    args: [SEED.campaignId, JSON.stringify(keywords), '2026-08-10T00:00:00.000Z'],
  });
}

describe('runListening', () => {
  test('turns a public post into a person and a signal', async () => {
    seeded = await seedDatabase('listen-basic');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    const result = await runListening(
      { db, sources: [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(result.kept).toBe(1);
    expect(result.peopleCreated).toBe(1);

    const signal = await queryOne<{
      signal_type: string;
      evidence: string;
      source_url: string;
      network: string;
    }>(
      db,
      `SELECT signal_type, evidence, source_url, network FROM signals
        WHERE workspace_id = ? AND network = 'reddit'`,
      [SEED.workspaceId],
    );

    expect(signal?.signal_type).toBe('recommendation_request');
    expect(signal?.source_url).toBe('https://www.reddit.com/r/plumbing/comments/abc123/x/');
    // The verbatim post: without it the composer has nothing it may quote, and
    // a draft with no grounding is withheld rather than invented.
    expect(signal?.evidence).toContain('Running 6 vans by hand');
  });

  test('the person is recorded by their handle on that network', async () => {
    seeded = await seedDatabase('listen-identity');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    await runListening(
      { db, sources: [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    const identity = await queryOne<{ handle: string; network: string; person_id: string }>(
      db,
      `SELECT handle, network, person_id FROM social_identities WHERE network = 'reddit'`,
      [],
    );

    expect(identity?.handle).toBe('plumber_pete');
  });

  test('a handle alone is not enough identity to contact anyone', async () => {
    seeded = await seedDatabase('listen-confidence');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    await runListening(
      { db, sources: [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    const person = await queryOne<{ identity_confidence: number }>(
      db,
      `SELECT p.identity_confidence FROM people p
         JOIN social_identities s ON s.person_id = p.id
        WHERE s.network = 'reddit'`,
      [],
    );

    const workspace = await queryOne<{ min_outreach_confidence: number }>(
      db,
      'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
      [SEED.workspaceId],
    );

    // A Reddit username is not a name, a company or an address. Sitting below
    // the workspace floor is what stops the policy engine permitting outbound
    // against a stranger found by a keyword search.
    expect(person?.identity_confidence).toBeLessThan(workspace?.min_outreach_confidence ?? 0.85);
  });

  test('the same post seen twice is one signal', async () => {
    seeded = await seedDatabase('listen-dedupe');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    const deps = { db, sources: [source([post()])] };
    const input = { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId };

    await runListening(deps, input);
    const second = await runListening(deps, input);

    expect(second.kept).toBe(0);

    const signals = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM signals WHERE workspace_id = ? AND network = 'reddit'`,
      [SEED.workspaceId],
    );
    expect(signals).toHaveLength(1);
  });

  test('a second post from the same author reuses the person', async () => {
    seeded = await seedDatabase('listen-same-author');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    const result = await runListening(
      {
        db,
        sources: [
          source([
            post(),
            post({
              externalId: 'def456',
              url: 'https://www.reddit.com/r/plumbing/comments/def456/y/',
              text: 'Following up — still looking for a scheduling software option.',
            }),
          ]),
        ],
      },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(result.kept).toBe(2);
    expect(result.peopleCreated).toBe(1);
  });

  test('the prospect joins the campaign funnel', async () => {
    seeded = await seedDatabase('listen-funnel');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    await runListening(
      { db, sources: [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    const row = await queryOne<{ status: string }>(
      db,
      `SELECT cp.status FROM campaign_people cp
         JOIN social_identities s ON s.person_id = cp.person_id
        WHERE s.network = 'reddit' AND cp.campaign_id = ?`,
      [SEED.campaignId],
    );

    expect(row?.status).toBe('discovered');
  });

  test('competitor names are listened for too', async () => {
    seeded = await seedDatabase('listen-competitors');
    const { db } = seeded;
    await setTerms(db, []);

    await db.execute({
      sql: 'UPDATE offerings SET competitors = ? WHERE id = ?',
      args: [JSON.stringify(['Fieldwire']), SEED.offeringId],
    });

    const result = await runListening(
      { db, sources: [source([post({ text: 'We are migrating off Fieldwire next month' })])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    // Someone complaining about a competitor by name is the strongest
    // listening signal there is, and it is already written down during setup.
    expect(result.terms).toContain('Fieldwire');
    expect(result.kept).toBe(1);
  });

  test('a failing source costs that source, not the run', async () => {
    seeded = await seedDatabase('listen-failure');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    const result = await runListening(
      { db, sources: [failing('nostr'), source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(result.kept).toBe(1);
    // "found nothing" and "could not look" are different problems.
    expect(result.failures).toEqual([{ slug: 'nostr', reason: 'rate limited' }]);
  });

  test('no terms means no requests', async () => {
    seeded = await seedDatabase('listen-no-terms');
    const { db } = seeded;
    await setTerms(db, []);

    await db.execute({
      sql: 'UPDATE offerings SET competitors = ? WHERE id = ?',
      args: ['[]', SEED.offeringId],
    });

    let searched = false;
    const watcher: FeedSource = {
      network: 'reddit',
      slug: 'reddit',
      displayName: 'reddit',
      search: async () => {
        searched = true;
        return [];
      },
    };

    const result = await runListening(
      { db, sources: [watcher] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(searched).toBe(false);
    expect(result.kept).toBe(0);
  });

  test('an archived campaign listens for nothing', async () => {
    seeded = await seedDatabase('listen-archived');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    await db.execute({
      sql: `UPDATE campaigns SET status = 'archived' WHERE id = ?`,
      args: [SEED.campaignId],
    });

    const result = await runListening(
      { db, sources: [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(result.terms).toEqual([]);
    expect(result.kept).toBe(0);
  });
});
