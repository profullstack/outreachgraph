/**
 * Expansion caching, which is a cost control before it is a feature.
 *
 * The listening loop runs constantly over the same handful of terms. Expanding
 * on every pass would multiply model spend by the crawl frequency to answer a
 * question that changes about as often as the campaign does.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import { queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { expandCampaignTerms, EXPANSION_TTL_DAYS } from './term-expansion';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const EXPANSIONS = JSON.stringify({
  expansions: ['our Stripe fees are killing us', 'looking for a Stripe alternative'],
});

const TERMS = ['payments provider'];

describe('expandCampaignTerms', () => {
  test('is the identity function with no model', async () => {
    // The repository's standing rule: the whole pipeline runs on an empty
    // `.env`. No key makes matching literal, never broken.
    seeded = await seedDatabase('expand-nomodel');

    expect(await expandCampaignTerms({ db: seeded.db }, SEED.workspaceId, TERMS)).toEqual(TERMS);
  });

  test('widens the search and keeps the original term', async () => {
    seeded = await seedDatabase('expand-widen');
    const model = new StubModel(EXPANSIONS);

    const terms = await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS);

    expect(terms[0]).toBe('payments provider');
    expect(terms).toContain('our Stripe fees are killing us');
  });

  test('asks the model once, then reads the cache', async () => {
    seeded = await seedDatabase('expand-cache');
    const model = new StubModel(EXPANSIONS);

    await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS);
    await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS);
    await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS);

    expect(model.calls).toHaveLength(1);
  });

  test('re-asks once the expansion has gone stale', async () => {
    seeded = await seedDatabase('expand-stale');
    const model = new StubModel(EXPANSIONS);
    const first = new Date('2026-01-01T00:00:00.000Z');

    await expandCampaignTerms({ db: seeded.db, model, now: first }, SEED.workspaceId, TERMS);

    const later = new Date(first.getTime() + (EXPANSION_TTL_DAYS + 1) * 86_400_000);
    await expandCampaignTerms({ db: seeded.db, model, now: later }, SEED.workspaceId, TERMS);

    expect(model.calls).toHaveLength(2);
  });

  test('never overwrites an expansion a human wrote', async () => {
    seeded = await seedDatabase('expand-manual');
    const { db } = seeded;

    await db.execute({
      sql: `INSERT INTO term_expansions (id, workspace_id, term, expansions, source,
            created_at, refreshed_at)
            VALUES ('tex_manual', ?, 'payments provider', ?, 'manual',
            '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
      args: [SEED.workspaceId, JSON.stringify(['the phrase we actually hear'])],
    });

    // Stale by any measure, so the model is asked — but the stored row stands.
    const model = new StubModel(EXPANSIONS);
    const terms = await expandCampaignTerms({ db, model }, SEED.workspaceId, TERMS);

    const row = await queryOne<{ expansions: string; source: string }>(
      db,
      `SELECT expansions, source FROM term_expansions WHERE term = 'payments provider'`,
    );

    expect(row?.source).toBe('manual');
    expect(JSON.parse(row!.expansions)).toEqual(['the phrase we actually hear']);
    expect(terms).toContain('the phrase we actually hear');
  });

  test('keeps crawling when the model throws', async () => {
    seeded = await seedDatabase('expand-modelfails');
    const model = {
      generate: async () => {
        throw new Error('model is down');
      },
    };

    // Literal matching rather than a failed crawl.
    expect(await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS)).toEqual(
      TERMS,
    );
  });

  test('does not read another workspace’s expansions', async () => {
    seeded = await seedDatabase('expand-isolation');
    const model = new StubModel(EXPANSIONS);

    await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, TERMS);

    // A different workspace starts from nothing, whatever this one cached.
    const other = await expandCampaignTerms({ db: seeded.db }, 'wsp_someone_else', TERMS);
    expect(other).toEqual(TERMS);
  });

  test('returns an empty term list untouched', async () => {
    seeded = await seedDatabase('expand-empty');
    const model = new StubModel(EXPANSIONS);

    expect(await expandCampaignTerms({ db: seeded.db, model }, SEED.workspaceId, [])).toEqual([]);
    expect(model.calls).toHaveLength(0);
  });
});
