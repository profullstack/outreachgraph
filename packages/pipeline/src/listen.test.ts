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

/**
 * Gives the campaign something to listen for, and somewhere to listen.
 *
 * Both halves are per-campaign, so a test that sets only the terms is testing
 * a campaign that has not opted in and will correctly do nothing.
 */
async function setTerms(
  db: Client,
  keywords: string[],
  targets: { sources?: string[]; subreddits?: string[]; feeds?: string[] } = {},
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, titles, seniorities, industries,
          technologies, keywords, exclusions, listen_sources, listen_subreddits,
          listen_feeds, updated_at)
          VALUES (?, '[]', '[]', '[]', '[]', ?, '[]', ?, ?, ?, ?)
          ON CONFLICT(campaign_id) DO UPDATE SET
            keywords          = excluded.keywords,
            listen_sources    = excluded.listen_sources,
            listen_subreddits = excluded.listen_subreddits,
            listen_feeds      = excluded.listen_feeds`,
    args: [
      SEED.campaignId,
      JSON.stringify(keywords),
      JSON.stringify(targets.sources ?? ['reddit']),
      JSON.stringify(targets.subreddits ?? []),
      JSON.stringify(targets.feeds ?? []),
      '2026-08-10T00:00:00.000Z',
    ],
  });
}

describe('runListening', () => {
  test('turns a public post into a person and a signal', async () => {
    seeded = await seedDatabase('listen-basic');
    const { db } = seeded;
    await setTerms(db, ['scheduling software']);

    const result = await runListening(
      { db, resolveSources: () => [source([post()])] },
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
      { db, resolveSources: () => [source([post()])] },
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
      { db, resolveSources: () => [source([post()])] },
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

    const deps = { db, resolveSources: () => [source([post()])] };
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
        resolveSources: () => [
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
      { db, resolveSources: () => [source([post()])] },
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
      {
        db,
        resolveSources: () => [
          source([post({ text: 'We are migrating off Fieldwire next month' })]),
        ],
      },
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
      { db, resolveSources: () => [failing('nostr'), source([post()])] },
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
      { db, resolveSources: () => [watcher] },
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
      { db, resolveSources: () => [source([post()])] },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    expect(result.terms).toEqual([]);
    expect(result.kept).toBe(0);
  });

  test('a campaign that has chosen no source listens to nothing', async () => {
    seeded = await seedDatabase('listen-not-opted-in');
    const { db } = seeded;
    await setTerms(db, ['scheduling software'], { sources: [] });

    let built = false;
    const result = await runListening(
      {
        db,
        resolveSources: () => {
          built = true;
          return [source([post()])];
        },
      },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    // Having keywords is not opting in. Listening polls networks on a
    // schedule and writes people, so it starts only when someone says where.
    expect(built).toBe(false);
    expect(result.kept).toBe(0);
  });

  test('the campaign chooses its own communities, not the deployment', async () => {
    seeded = await seedDatabase('listen-own-targets');
    const { db } = seeded;
    await setTerms(db, ['scheduling software'], {
      sources: ['reddit'],
      subreddits: ['plumbing', 'HVAC'],
    });

    let saw: readonly string[] = [];
    const result = await runListening(
      {
        db,
        resolveSources: (targets) => {
          saw = targets.subreddits;
          return [source([post()])];
        },
      },
      { workspaceId: SEED.workspaceId, campaignId: SEED.campaignId },
    );

    // The whole point of migration 0012: two workspaces on one container must
    // be able to listen in different places.
    expect(saw).toEqual(['plumbing', 'HVAC']);
    expect(result.targets.sources).toEqual(['reddit']);
  });
});
