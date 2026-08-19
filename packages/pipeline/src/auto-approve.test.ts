/**
 * Approving what never needed a person.
 *
 * The tests worth reading are the restraints. Automating approval is only safe
 * because it is confined to actions that reach nobody and because the policy
 * gates above the rate limits still run — so the cases that must keep failing
 * matter more here than the case that now passes.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { autoApproveInternal, workspacesWithInternalBacklog } from './auto-approve';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

/** A pending card of the given action, against the seeded person. */
async function card(db: Client, action: string, id = newId('recommendation')): Promise<string> {
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'website', 50, 'because', 'allow_with_approval', '2026-08-11',
          'qualify', 'pending', ?)`,
    args: [id, SEED.workspaceId, SEED.campaignId, SEED.personId, action, now()],
  });

  return id;
}

/** Gives the seeded person a company with a domain, so a crawl can be queued. */
async function withDomain(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, created_at, updated_at)
          VALUES ('co_auto', 'Loopwright', 'loopwright.io', ?, ?)`,
    args: [now(), now()],
  });
  await db.execute({
    sql: `UPDATE people SET current_company_id = 'co_auto' WHERE id = ?`,
    args: [SEED.personId],
  });
}

describe('autoApproveInternal', () => {
  test('clears a research card without a person', async () => {
    seeded = await seedDatabase('auto-research');
    const id = await card(seeded.db, 'refresh_research');

    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.approved).toBe(1);

    const rec = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [id],
    );
    expect(rec?.status).toBe('approved');
  });

  test('leaves the same trail a click would', async () => {
    // An automated decision that writes no approval and no audit row is a
    // decision nobody can reconstruct later.
    seeded = await seedDatabase('auto-trail');
    const id = await card(seeded.db, 'refresh_research');

    await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    const approval = await queryOne<{ decided_by: string; decision: string }>(
      seeded.db,
      'SELECT decided_by, decision FROM approvals WHERE recommendation_id = ?',
      [id],
    );
    const action = await queryOne<{ kind: string }>(
      seeded.db,
      'SELECT kind FROM actions WHERE recommendation_id = ?',
      [id],
    );
    const audit = await queryOne<{ actor_kind: string }>(
      seeded.db,
      `SELECT actor_kind FROM audit_events WHERE entity_id = ?
        AND event_type = 'recommendation.auto_approved'`,
      [id],
    );

    expect(approval?.decision).toBe('approve');
    // Credited to the system, not to whoever last signed in.
    expect(approval?.decided_by).toBe('usr_auto_approve');
    expect(action?.kind).toBe('refresh_research');
    expect(audit?.actor_kind).toBe('system');
  });

  test('approving research actually queues the crawl', async () => {
    // Without this the card closes and nothing re-reads the site, which is the
    // state that regenerated the same card on the next tick.
    seeded = await seedDatabase('auto-crawl');
    await withDomain(seeded.db);
    await card(seeded.db, 'refresh_research');

    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.queuedCrawls).toBe(1);

    const job = await queryOne<{ kind: string }>(
      seeded.db,
      `SELECT kind FROM jobs WHERE kind = 'crawl_site' LIMIT 1`,
    );
    expect(job?.kind).toBe('crawl_site');
  });

  test('never touches an outbound card', async () => {
    // The whole safety argument. An email must still wait for a human or for
    // autopilot, which is a separate campaign-level decision.
    seeded = await seedDatabase('auto-outbound');
    const id = await card(seeded.db, 'send_email');

    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.considered).toBe(0);
    expect(result.approved).toBe(0);

    const rec = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [id],
    );
    expect(rec?.status).toBe('pending');
  });

  test('leaves manual_review for a human, as the name says', async () => {
    seeded = await seedDatabase('auto-manual');
    await card(seeded.db, 'manual_review');

    expect((await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).approved).toBe(
      0,
    );
  });

  test('still refuses a suppressed person', async () => {
    // Internal actions skip the rate limits, not the gates above them.
    seeded = await seedDatabase('auto-suppressed');
    await card(seeded.db, 'refresh_research');
    await seeded.db.execute({
      sql: `UPDATE people SET status = 'suppressed' WHERE id = ?`,
      args: [SEED.personId],
    });

    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.approved).toBe(0);
    expect(result.refused).toBe(1);
  });

  test('still refuses a person believed to be a minor', async () => {
    seeded = await seedDatabase('auto-minor');
    await card(seeded.db, 'refresh_research');
    await seeded.db.execute({
      sql: `UPDATE people SET believed_minor = 1 WHERE id = ?`,
      args: [SEED.personId],
    });

    expect((await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).refused).toBe(
      1,
    );
  });

  test('does nothing when the workspace has turned it off', async () => {
    seeded = await seedDatabase('auto-off');
    await card(seeded.db, 'refresh_research');
    await seeded.db.execute({
      sql: `UPDATE workspaces SET auto_approve_internal = 0 WHERE id = ?`,
      args: [SEED.workspaceId],
    });

    expect((await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).approved).toBe(
      0,
    );
  });

  test('is idempotent — a second pass finds nothing left', async () => {
    seeded = await seedDatabase('auto-twice');
    await card(seeded.db, 'refresh_research');

    expect((await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).approved).toBe(
      1,
    );
    expect((await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).approved).toBe(
      0,
    );
  });

  test('honours the limit so one workspace cannot hold the tick', async () => {
    seeded = await seedDatabase('auto-limit');
    for (let index = 0; index < 5; index += 1) await card(seeded.db, 'refresh_research');

    const result = await autoApproveInternal(seeded.db, {
      workspaceId: SEED.workspaceId,
      limit: 2,
    });

    expect(result.approved).toBe(2);
  });
});

describe('workspacesWithInternalBacklog', () => {
  test('lists a workspace with internal cards waiting', async () => {
    seeded = await seedDatabase('auto-backlog');
    await card(seeded.db, 'refresh_research');

    expect(await workspacesWithInternalBacklog(seeded.db)).toContain(SEED.workspaceId);
  });

  test('skips one that has switched it off', async () => {
    seeded = await seedDatabase('auto-backlog-off');
    await card(seeded.db, 'refresh_research');
    await seeded.db.execute({
      sql: `UPDATE workspaces SET auto_approve_internal = 0 WHERE id = ?`,
      args: [SEED.workspaceId],
    });

    expect(await workspacesWithInternalBacklog(seeded.db)).not.toContain(SEED.workspaceId);
  });

  test('skips one whose only pending card is outbound', async () => {
    seeded = await seedDatabase('auto-backlog-outbound');
    await card(seeded.db, 'send_email');

    expect(await workspacesWithInternalBacklog(seeded.db)).not.toContain(SEED.workspaceId);
  });
});
