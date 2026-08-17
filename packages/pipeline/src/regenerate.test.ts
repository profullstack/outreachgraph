/**
 * Re-deciding people whose evidence arrived after their card did.
 *
 * The smoke test that motivated this is worth restating, because the obvious
 * fix does not work. Migration 0015 gave 75 already-crawled people the signal
 * they should have had, but they kept their `refresh_research` cards — and
 * re-crawling their company did not clear them, because `runCrawlJob` only
 * runs the chain for people it finds on the page *this* time. Two of three
 * real companies re-crawled cleanly and their stalled people still held stale
 * cards afterwards.
 *
 * This job closes the loop from the other end: read the evidence already
 * stored, and ask the engine again.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { regenerateRecommendations } from './regenerate';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function setup(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

/** A person with no title, holding a research card — the stalled shape. */
async function stalledPerson(
  db: Client,
  id: string,
  name: string,
  options: { signal?: boolean; inbox?: boolean } = {},
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO people (id, display_name, current_company_id, identity_confidence,
          status, outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, ?, ?, 0.9, 'active', 1, 0, ?, ?)`,
    args: [id, name, options.inbox === false ? null : SEED.companyId, stamp, stamp],
  });

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
          network, priority, reason, policy_status, policy_version, expected_goal,
          status, created_at)
          VALUES (?, ?, ?, ?, 'refresh_research', 'website', 40, 'Nothing to say yet.',
          'allow_with_approval', '2026-08-11', 'gather_context', 'pending', ?)`,
    args: [`rec_${id}`, SEED.workspaceId, SEED.campaignId, id, stamp],
  });

  if (options.signal !== false) {
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
            summary, evidence, source_url, source_timestamp, observed_at, confidence,
            relevance, sentiment)
            VALUES (?, ?, ?, 'website', 'content_topic', 'site_role',
            'Named on the company website.', ?, 'https://acme.test/team', ?, ?, 0.9, 0.35,
            'neutral')`,
      args: [`sig_${id}`, SEED.workspaceId, id, name, stamp, stamp],
    });
  }
}

async function pendingFor(db: Client, personId: string) {
  return queryAll<{ action: string }>(
    db,
    `SELECT action FROM recommendations WHERE person_id = ? AND status = 'pending'`,
    [personId],
  );
}

describe('regenerating stale research cards', () => {
  test('a person whose signal arrived later gets re-decided', async () => {
    const db = await setup('regen-basic');
    await db.execute({
      sql: `UPDATE companies SET contact_email = ? WHERE id = ?`,
      args: ['hello@acme.test', SEED.companyId],
    });
    await stalledPerson(db, 'per_stalled', 'Dana Whitfield');

    const result = await regenerateRecommendations({
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
    });

    expect(result.considered).toBeGreaterThanOrEqual(1);
    expect(result.replaced).toBeGreaterThanOrEqual(1);

    // Exactly one pending card, and it is no longer the research one.
    const pending = await pendingFor(db, 'per_stalled');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action).toBe('send_email');

    const stale = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = ?`,
      ['rec_per_stalled'],
    );
    expect(stale?.status).toBe('superseded');
  });

  test('a person with no signal is left alone', async () => {
    const db = await setup('regen-no-signal');
    await stalledPerson(db, 'per_nosignal', 'Quiet Person', { signal: false });

    const result = await regenerateRecommendations({
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
    });

    // Selected on evidence, not on holding a research card. Without a signal
    // there is nothing new to decide with.
    const pending = await pendingFor(db, 'per_nosignal');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.action).toBe('refresh_research');
    expect(result.considered).toBe(0);
  });

  /**
   * The rule that protects real human work. An outbound card may already carry
   * a drafted message and a half-made decision, and re-deciding it behind the
   * reviewer's back would discard both.
   */
  test('a pending outbound card is never touched', async () => {
    const db = await setup('regen-outbound-safe');

    const before = await queryOne<{ status: string; action: string }>(
      db,
      `SELECT status, action FROM recommendations WHERE id = ?`,
      [SEED.recommendationId],
    );
    expect(before?.status).toBe('pending');

    await regenerateRecommendations({
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
    });

    const after = await queryOne<{ status: string; action: string }>(
      db,
      `SELECT status, action FROM recommendations WHERE id = ?`,
      [SEED.recommendationId],
    );
    expect(after?.status).toBe('pending');
    expect(after?.action).toBe(before?.action);
  });

  test('a suppressed person is excluded by the query, not by a later check', async () => {
    const db = await setup('regen-suppressed');
    await stalledPerson(db, 'per_suppressed', 'Webby Mcweb');
    await db.execute({
      sql: `UPDATE people SET status = 'suppressed', outreach_eligible = 0 WHERE id = ?`,
      args: ['per_suppressed'],
    });

    const result = await regenerateRecommendations({
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
    });

    expect(result.considered).toBe(0);
  });

  test('the limit bounds one run', async () => {
    const db = await setup('regen-limit');
    for (let i = 0; i < 5; i += 1) {
      await stalledPerson(db, `per_many${i}`, `Person Number${String.fromCharCode(65 + i)}`);
    }

    const result = await regenerateRecommendations({
      db,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      limit: 2,
    });

    expect(result.considered).toBe(2);
  });

  test('running it twice does not stack cards', async () => {
    const db = await setup('regen-idempotent');
    await db.execute({
      sql: `UPDATE companies SET contact_email = ? WHERE id = ?`,
      args: ['hello@acme.test', SEED.companyId],
    });
    await stalledPerson(db, 'per_twice', 'Dana Whitfield');

    for (let i = 0; i < 2; i += 1) {
      await regenerateRecommendations({
        db,
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
      });
    }

    const pending = await pendingFor(db, 'per_twice');
    expect(pending).toHaveLength(1);
  });
});
