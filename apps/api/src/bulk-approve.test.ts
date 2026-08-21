/**
 * Approving the whole queue at once.
 *
 * The tests that matter are the ones proving this is *not* a faster path with
 * the checks taken out. A bulk control that skipped the policy engine would be
 * the single most effective way to undo the shared-inbox work: one press and
 * thirty colleagues at one `support@` all get mailed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(
  label: string,
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({ db: seeded.db, authenticate: async () => actor ?? undefined });
  return { app, seeded };
}

async function approveAll(app: Hono<AppEnv>, body: unknown = {}): Promise<Response> {
  return app.request('/api/v1/recommendations/approve-all', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Adds `count` more pending cards, each to its own person. */
async function extraCards(seeded: SeededDatabase, count: number): Promise<void> {
  const stamp = new Date().toISOString();

  for (let index = 0; index < count; index += 1) {
    const personId = `per_bulk_${index}`;
    const recId = `rec_bulk_${index}`;

    await seeded.db.execute({
      sql: `INSERT INTO people (id, display_name, status, identity_confidence, created_at, updated_at)
            VALUES (?, ?, 'qualified', 0.95, ?, ?)`,
      args: [personId, `Bulk ${index}`, stamp, stamp],
    });

    await seeded.db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
            network, priority, reason, policy_status, policy_version, expected_goal, status,
            created_at)
            VALUES (?, ?, ?, ?, 'reply', 'x', 80, 'because', 'allow_with_approval', '2026-08-11',
            'start_conversation', 'pending', ?)`,
      args: [recId, SEED.workspaceId, SEED.campaignId, personId, stamp],
    });
  }
}

describe('approve-all', () => {
  test('approves the pending queue in one request', async () => {
    const { app, seeded } = await harness('bulk-ok');
    await extraCards(seeded, 4);

    const response = await approveAll(app);
    const body = (await response.json()) as { approved: number; attempted: number };

    expect(response.status).toBe(200);
    // The seeded card plus the four added.
    expect(body.attempted).toBe(5);
    expect(body.approved).toBe(5);

    const remaining = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM recommendations WHERE workspace_id = ? AND status = 'pending'`,
      args: [SEED.workspaceId],
    });

    expect(Number(remaining.rows[0]?.n)).toBe(0);
  });

  test('writes a real approval and action row for every card', async () => {
    // Not merely flipping a status column: the bulk path must produce the same
    // trail as clicking, or the audit history has a hole exactly where the
    // bulk button was used.
    const { app, seeded } = await harness('bulk-rows');
    await extraCards(seeded, 3);

    await approveAll(app);

    const approvals = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM approvals WHERE workspace_id = ?`,
      args: [SEED.workspaceId],
    });
    const actions = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM actions WHERE workspace_id = ?`,
      args: [SEED.workspaceId],
    });

    expect(Number(approvals.rows[0]?.n)).toBe(4);
    expect(Number(actions.rows[0]?.n)).toBe(4);
  });

  test('a dry run changes nothing', async () => {
    const { app, seeded } = await harness('bulk-dry');
    await extraCards(seeded, 3);

    const response = await approveAll(app, { dryRun: true });
    const body = (await response.json()) as { approved: number; dryRun: boolean };

    expect(body.dryRun).toBe(true);
    expect(body.approved).toBe(4);

    const pending = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM recommendations WHERE workspace_id = ? AND status = 'pending'`,
      args: [SEED.workspaceId],
    });
    const approvals = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM approvals WHERE workspace_id = ?`,
      args: [SEED.workspaceId],
    });

    // Still pending, and not one approval row written.
    expect(Number(pending.rows[0]?.n)).toBe(4);
    expect(Number(approvals.rows[0]?.n)).toBe(0);
  });

  test('still refuses what the policy engine refuses, and says why', async () => {
    // The whole point. Suppressing the person must hold the card even though
    // the caller asked for everything.
    const { app, seeded } = await harness('bulk-suppressed');

    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const response = await approveAll(app);
    const body = (await response.json()) as {
      approved: number;
      held: number;
      holds: { gate: string; count: number }[];
    };

    expect(body.approved).toBe(0);
    expect(body.held).toBe(1);
    expect(body.holds[0]?.gate).toBe('person_ineligible');

    const rec = await seeded.db.execute({
      sql: 'SELECT status FROM recommendations WHERE id = ?',
      args: [SEED.recommendationId],
    });

    expect(rec.rows[0]?.status).toBe('pending');
  });

  test('one held card does not abort the rest', async () => {
    const { app, seeded } = await harness('bulk-partial');
    await extraCards(seeded, 3);

    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const response = await approveAll(app);
    const body = (await response.json()) as { approved: number; held: number };

    expect(body.held).toBe(1);
    expect(body.approved).toBe(3);
  });

  test('groups holds by gate rather than listing every card', async () => {
    // Two hundred cards behind four inboxes is four facts, not two hundred.
    const { app, seeded } = await harness('bulk-grouped');
    await extraCards(seeded, 5);

    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed'`,
      args: [],
    });

    const response = await approveAll(app);
    const body = (await response.json()) as {
      held: number;
      holds: { gate: string; count: number }[];
    };

    expect(body.held).toBe(6);
    expect(body.holds).toHaveLength(1);
    expect(body.holds[0]?.count).toBe(6);
  });

  test('honours the limit and reports that more remain', async () => {
    const { app, seeded } = await harness('bulk-limit');
    await extraCards(seeded, 5);

    const response = await approveAll(app, { limit: 2 });
    const body = (await response.json()) as { attempted: number; more: boolean };

    expect(body.attempted).toBe(2);
    expect(body.more).toBe(true);
  });

  test('narrows to one channel', async () => {
    // The seeded card is on `x`, which is social. Asking for email should find
    // nothing to do rather than approving the social one.
    const { app } = await harness('bulk-channel');

    const response = await approveAll(app, { channel: 'email' });
    const body = (await response.json()) as { attempted: number; approved: number };

    expect(body.attempted).toBe(0);
    expect(body.approved).toBe(0);
  });

  test('a viewer cannot bulk approve', async () => {
    const { app } = await harness('bulk-viewer', { ...ACTOR, role: 'viewer' });

    expect((await approveAll(app)).status).toBe(403);
  });

  test('an unauthenticated caller cannot bulk approve', async () => {
    const { app } = await harness('bulk-unauth', null);

    expect((await approveAll(app)).status).toBe(401);
  });

  test('an already-approved queue is a no-op rather than a double approval', async () => {
    const { app, seeded } = await harness('bulk-twice');
    await extraCards(seeded, 2);

    await approveAll(app);
    const response = await approveAll(app);
    const body = (await response.json()) as { attempted: number; approved: number };

    expect(body.attempted).toBe(0);
    expect(body.approved).toBe(0);

    const approvals = await seeded.db.execute({
      sql: `SELECT count(*) AS n FROM approvals WHERE workspace_id = ?`,
      args: [SEED.workspaceId],
    });

    expect(Number(approvals.rows[0]?.n)).toBe(3);
  });

  test('a research sweep does not consume the outreach rate limits', async () => {
    // Production jammed exactly here. A campaign researching twenty thousand
    // people wrote one `refresh_research` action per person per sweep, and the
    // rate limiters counted every one of them: "Approve all" reported "daily
    // action limit reached (11068/50)" and a 72h cooldown "since the last
    // contact" for prospects nobody had ever written to. The policy engine
    // waives every rate limit for an internal action, so nothing internal may
    // consume one either.
    const { app, seeded } = await harness('bulk-research-noise');
    const stamp = new Date().toISOString();

    for (let index = 0; index < 200; index += 1) {
      await seeded.db.execute({
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind,
              network, mode, status, created_at)
              VALUES (?, ?, ?, ?, 'refresh_research', 'x', 'auto', 'queued', ?)`,
        args: [`act_noise_${index}`, SEED.workspaceId, SEED.recommendationId, SEED.personId, stamp],
      });
    }

    const response = await approveAll(app);
    const body = (await response.json()) as {
      approved: number;
      held: number;
      holds: { gate: string; count: number }[];
    };

    expect(body.held).toBe(0);
    expect(body.approved).toBe(1);
    expect(body.holds.map((hold) => hold.gate)).not.toContain('rate_limit_daily');
    expect(body.holds.map((hold) => hold.gate)).not.toContain('cooldown');
  });
});
