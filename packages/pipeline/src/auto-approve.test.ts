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

  test('does not re-research somebody researched today', async () => {
    // The loop this closes. A research card exists because we had nothing to
    // say; approving it re-crawls; if that yields nothing the card returns.
    // Automating the click turned a visible backlog into invisible crawl
    // traffic — one person reached three cards within minutes.
    seeded = await seedDatabase('auto-cooldown');
    await withDomain(seeded.db);
    await card(seeded.db, 'refresh_research');

    const first = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });
    expect(first.approved).toBe(1);
    expect(first.queuedCrawls).toBe(1);

    // The next pass proposes it again, as the pipeline does.
    const again = await card(seeded.db, 'refresh_research');
    const second = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(second.approved).toBe(0);
    expect(second.cooledDown).toBe(1);
    // Crucially: no second crawl. That is what stops the loop.
    expect(second.queuedCrawls).toBe(0);

    const rec = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [again],
    );
    // Closed, not approved — approving would claim we went and looked.
    expect(rec?.status).toBe('skipped');
  });

  test('a cooled-down card leaves an auditable reason', async () => {
    seeded = await seedDatabase('auto-cooldown-audit');
    await withDomain(seeded.db);
    await card(seeded.db, 'refresh_research');
    await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    const id = await card(seeded.db, 'refresh_research');
    await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    const audit = await queryOne<{ event_type: string }>(
      seeded.db,
      `SELECT event_type FROM audit_events WHERE entity_id = ?
        AND event_type = 'recommendation.research_cooldown'`,
      [id],
    );

    expect(audit?.event_type).toBe('recommendation.research_cooldown');
  });

  test('research outside the cooldown runs again', async () => {
    // The cooldown must expire, or a company that genuinely changed is never
    // re-read.
    seeded = await seedDatabase('auto-cooldown-expired');
    await withDomain(seeded.db);
    await card(seeded.db, 'refresh_research');
    await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    // Age the recorded research past the window.
    await seeded.db.execute({
      sql: `UPDATE actions SET created_at = ? WHERE kind = 'refresh_research'`,
      args: [new Date(Date.now() - 48 * 3_600_000).toISOString()],
    });

    await card(seeded.db, 'refresh_research');
    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.approved).toBe(1);
    expect(result.cooledDown).toBe(0);
  });

  test('a human approval also suppresses the automatic re-run', async () => {
    // The cooldown counts actions, not crawl jobs, so it does not matter who
    // approved the card an hour ago.
    seeded = await seedDatabase('auto-cooldown-human');
    await withDomain(seeded.db);

    // Stands in for a card a person clicked an hour ago: the action row is
    // what both paths write, and is what the cooldown counts.
    const clicked = await card(seeded.db, 'refresh_research');
    await seeded.db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at)
            VALUES (?, ?, ?, ?, 'refresh_research', 'website', 'manual', 'queued', ?)`,
      args: [newId('action'), SEED.workspaceId, clicked, SEED.personId, now()],
    });
    await seeded.db.execute({
      sql: `UPDATE recommendations SET status = 'approved' WHERE id = ?`,
      args: [clicked],
    });

    await card(seeded.db, 'refresh_research');
    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    expect(result.cooledDown).toBe(1);
    expect(result.queuedCrawls).toBe(0);
  });

  test('reads one company site once, however many people it names', async () => {
    // The failure that got past the per-person cooldown and into production.
    // A crawl of accenture.com returns 57 people; each becomes a research
    // card; each card queued another crawl of the same page, which returned
    // the same 57. Prod reached 226 pending crawls of one URL and 81 of
    // another before it was stopped. The cooldown could not catch it because
    // every one of those people was new.
    seeded = await seedDatabase('auto-one-crawl');
    await withDomain(seeded.db);

    for (let index = 0; index < 8; index += 1) {
      const personId = `per_same_co_${index}`;
      await seeded.db.execute({
        sql: `INSERT INTO people (id, display_name, status, identity_confidence,
              current_company_id, created_at, updated_at)
              VALUES (?, ?, 'qualified', 0.9, 'co_auto', ?, ?)`,
        args: [personId, `Colleague ${index}`, now(), now()],
      });
      await seeded.db.execute({
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
              network, priority, reason, policy_status, policy_version, expected_goal, status,
              created_at)
              VALUES (?, ?, ?, ?, 'refresh_research', 'website', 50, 'because',
              'allow_with_approval', '2026-08-11', 'qualify', 'pending', ?)`,
        args: [newId('recommendation'), SEED.workspaceId, SEED.campaignId, personId, now()],
      });
    }

    const result = await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId });

    // Every card clears — the queue is the point.
    expect(result.approved).toBeGreaterThanOrEqual(8);

    // But the site is read once. This is the assertion that matters.
    const jobs = await queryOne<{ n: number }>(
      seeded.db,
      `SELECT count(*) AS n FROM jobs WHERE kind = 'crawl_site' AND status = 'pending'`,
    );
    expect(Number(jobs?.n)).toBe(1);
    expect(result.queuedCrawls).toBe(1);
  });

  test('the key frees itself once the crawl finishes', async () => {
    // Suppressing duplicates must not suppress future work: the index covers
    // only pending and running jobs for exactly this reason.
    seeded = await seedDatabase('auto-crawl-key-frees');
    await withDomain(seeded.db);
    await card(seeded.db, 'refresh_research');

    expect(
      (await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).queuedCrawls,
    ).toBe(1);

    await seeded.db.execute({
      sql: `UPDATE jobs SET status = 'done' WHERE kind = 'crawl_site'`,
      args: [],
    });
    // Age the research so the per-person cooldown does not mask the result.
    await seeded.db.execute({
      sql: `UPDATE actions SET created_at = ? WHERE kind = 'refresh_research'`,
      args: [new Date(Date.now() - 48 * 3_600_000).toISOString()],
    });

    await card(seeded.db, 'refresh_research');

    expect(
      (await autoApproveInternal(seeded.db, { workspaceId: SEED.workspaceId })).queuedCrawls,
    ).toBe(1);
  });

  test('honours the limit so one workspace cannot hold the tick', async () => {
    seeded = await seedDatabase('auto-limit');

    // Distinct people, because the cooldown is per person: five cards for one
    // person is one approval and four cooldowns, which is correct and is not
    // what this test is about.
    for (let index = 0; index < 5; index += 1) {
      const personId = `per_limit_${index}`;
      await seeded.db.execute({
        sql: `INSERT INTO people (id, display_name, status, identity_confidence, created_at,
              updated_at) VALUES (?, ?, 'qualified', 0.9, ?, ?)`,
        args: [personId, `Limit ${index}`, now(), now()],
      });
      await seeded.db.execute({
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action,
              network, priority, reason, policy_status, policy_version, expected_goal, status,
              created_at)
              VALUES (?, ?, ?, ?, 'refresh_research', 'website', 50, 'because',
              'allow_with_approval', '2026-08-11', 'qualify', 'pending', ?)`,
        args: [newId('recommendation'), SEED.workspaceId, SEED.campaignId, personId, now()],
      });
    }

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
