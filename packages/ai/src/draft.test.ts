import { afterEach, describe, expect, test } from 'bun:test';
import { StubModel } from '@outreachgraph/ai';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { draftForRecommendation } from './draft';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

/**
 * The seed fixture already ships a draft for its recommendation, which would
 * short-circuit the idempotence guard — remove it so each test composes.
 */
async function fixture(label: string): Promise<SeededDatabase> {
  active = await seedDatabase(`draft-${label}`);
  await active.db.execute({ sql: 'DELETE FROM drafts WHERE id = ?', args: [SEED.draftId] });
  await active.db.execute({
    sql: 'UPDATE recommendations SET draft_id = NULL WHERE id = ?',
    args: [SEED.recommendationId],
  });
  return active;
}

const GOOD = 'Cross-border payouts and settlement delays were our pain too.';

describe('composing from stored evidence', () => {
  test('writes a draft and links it to the recommendation', async () => {
    const { db } = await fixture('happy');

    const result = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);

    expect(result.ok).toBe(true);
    expect(result.draftId).toMatch(/^drf_/);

    const draft = await db.execute({
      sql: 'SELECT body, grounded_signal_ids, similarity_hash, model FROM drafts WHERE id = ?',
      args: [result.draftId!],
    });

    expect(draft.rows[0]?.body).toBe(GOOD);
    expect(JSON.parse(String(draft.rows[0]?.grounded_signal_ids))).toEqual([SEED.signalId]);
    expect(draft.rows[0]?.similarity_hash).toBeTruthy();

    const rec = await db.execute({
      sql: 'SELECT draft_id FROM recommendations WHERE id = ?',
      args: [SEED.recommendationId],
    });
    expect(rec.rows[0]?.draft_id).toBe(result.draftId!);
  });

  test('stores the quality report alongside the body', async () => {
    const { db } = await fixture('report');
    const result = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);

    const draft = await db.execute({
      sql: 'SELECT checks_json FROM drafts WHERE id = ?',
      args: [result.draftId!],
    });

    const checks = JSON.parse(String(draft.rows[0]?.checks_json));
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c: { passed: boolean }) => c.passed)).toBe(true);
  });

  test('is idempotent — a second run reuses the existing draft', async () => {
    const { db } = await fixture('idempotent');

    const first = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);
    const model = new StubModel(GOOD);
    const second = await draftForRecommendation(db, model, SEED.recommendationId);

    expect(second.draftId).toBe(first.draftId!);
    // No tokens spent rewriting a message that may already be approved.
    expect(model.calls).toHaveLength(0);
  });
});

describe('withholding rather than fabricating', () => {
  test('writes no draft when the model invents a product', async () => {
    const { db } = await fixture('hallucination');

    const result = await draftForRecommendation(
      db,
      new StubModel([
        'Your payouts note — we fixed it with Fluxwire.',
        'On settlement delays, Fluxwire handled it.',
      ]),
      SEED.recommendationId,
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('failed_checks');
    expect(result.unsupported).toContain('Fluxwire');

    const drafts = await db.execute('SELECT count(*) AS n FROM drafts');
    expect(Number(drafts.rows[0]?.n)).toBe(0);
  });

  test('writes no draft when the signal has no verbatim evidence', async () => {
    const { db } = await fixture('noevidence');
    await db.execute({
      sql: 'UPDATE signals SET evidence = NULL WHERE id = ?',
      args: [SEED.signalId],
    });

    const model = new StubModel(GOOD);
    const result = await draftForRecommendation(db, model, SEED.recommendationId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_evidence');
    // The model is never called — there is nothing it could ground on.
    expect(model.calls).toHaveLength(0);
  });

  test('writes no draft when the recommendation has no trigger', async () => {
    const { db } = await fixture('notrigger');
    await db.execute({
      sql: 'UPDATE recommendations SET trigger_signal_id = NULL WHERE id = ?',
      args: [SEED.recommendationId],
    });

    const result = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no_trigger_signal');
  });

  test('writes no draft for a prospect below the identity threshold', async () => {
    const { db } = await fixture('lowconf');
    await db.execute({
      sql: 'UPDATE people SET identity_confidence = 0.4 WHERE id = ?',
      args: [SEED.personId],
    });

    const result = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);
    expect(result.ok).toBe(false);
  });
});

describe('cross-prospect duplicate suppression (PRD §18)', () => {
  test('refuses a second copy of a message already drafted', async () => {
    const { db } = await fixture('duplicate');
    const stamp = new Date().toISOString();

    // A second prospect and recommendation in the same workspace.
    await db.batch([
      {
        sql: `INSERT INTO people (id, display_name, first_name, identity_confidence, status,
              outreach_eligible, believed_minor, created_at, updated_at)
              VALUES ('per_two', 'Alex Chen', 'Alex', 0.97, 'active', 1, 0, ?, ?)`,
        args: [stamp, stamp],
      },
      {
        sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, summary,
              evidence, source_timestamp, observed_at, confidence, relevance, sentiment)
              VALUES ('sig_two', ?, 'per_two', 'x', 'recommendation_request',
              'Asked about cross-border payouts',
              'Does anyone have a good alternative for cross-border payouts? Settlement takes days.',
              ?, ?, 0.9, 0.9, 'neutral')`,
        args: [SEED.workspaceId, stamp, stamp],
      },
      {
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
              network, priority, reason, trigger_signal_id, policy_status, policy_version,
              expected_goal, status, created_at)
              VALUES ('rec_two', ?, ?, 'per_two', 'reply', 'x', 80, 'same ask',
              'sig_two', 'allow_with_approval', '2026-08-11', 'start_conversation', 'pending', ?)`,
        args: [SEED.workspaceId, SEED.campaignId, stamp],
      },
    ]);

    const first = await draftForRecommendation(db, new StubModel(GOOD), SEED.recommendationId);
    expect(first.ok).toBe(true);

    // The same wording for a different person is the mail-merge case.
    const second = await draftForRecommendation(db, new StubModel([GOOD, GOOD]), 'rec_two');

    expect(second.ok).toBe(false);
    expect(second.reason).toBe('failed_checks');
  });
});
