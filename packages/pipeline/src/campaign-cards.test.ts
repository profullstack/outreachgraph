/**
 * Someone the campaign kept who gained an address and holds no card is asked
 * about again, and the engine's answer is a card; someone holding a card, or
 * held back by the company cap, is left alone.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { cardReachableMembers } from './campaign-cards';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function janeWithAddressAndNoCard(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  const db = seeded.db;
  await db.execute({ sql: 'DELETE FROM drafts', args: [] });
  await db.execute({ sql: 'DELETE FROM recommendations', args: [] });
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          confidence, source_type, verified_by, first_seen_at)
          VALUES ('sid_jane_mail', ?, 'email', 'jane@acme.com', NULL, 0.9, 'public_web', '[]', ?)`,
    args: [SEED.personId, now()],
  });
  return db;
}

describe('cardReachableMembers', () => {
  test('cards a kept member who can now be emailed', async () => {
    const db = await janeWithAddressAndNoCard('cards-reachable');
    const result = await cardReachableMembers(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      emailSendingEnabled: true,
    });
    expect(result.checked).toBe(1);
    expect(result.carded).toBe(1);
    const cards = await queryAll<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE person_id = ? AND campaign_id = ?`,
      [SEED.personId, SEED.campaignId],
    );
    expect(cards.map((c) => c.status)).toEqual(['pending']);

    // Holding a card now, so a second pass leaves them alone.
    expect(
      await cardReachableMembers(db, {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        emailSendingEnabled: true,
      }),
    ).toEqual({ checked: 0, carded: 0 });
  });

  test('an outbound card even when today holds many queued, unsent approvals', async () => {
    // Card creation counted every action created in the last day: held and
    // failed sends put the workspace at 1,000 of 1,000 with 247 sent, and the
    // engine wrote research cards instead of email ones (2026-10-26).
    const db = await janeWithAddressAndNoCard('cards-held-approvals');
    await db.execute({
      sql: `UPDATE campaigns SET budget_json = '{"maxActionsPerDay":2}' WHERE id = ?`,
      args: [SEED.campaignId],
    });
    const stamp = now();
    await db.execute({
      sql: `INSERT INTO people (id, display_name, status, believed_minor, outreach_eligible,
            identity_confidence, created_at, updated_at)
            VALUES ('per_other', 'Sam Other', 'active', 0, 1, 0.95, ?, ?)`,
      args: [stamp, stamp],
    });
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, status, created_at)
            VALUES ('rec_held', ?, ?, 'per_other', 'send_email', 'email', 50, 'held',
                    'allow', '2026-01-01', 'approved', ?)`,
      args: [SEED.workspaceId, SEED.campaignId, stamp],
    });
    for (const id of ['act_h1', 'act_h2', 'act_h3']) {
      await db.execute({
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
              mode, status, created_at)
              VALUES (?, ?, 'rec_held', 'per_other', 'send_email', 'email', 'customer_managed',
                      'queued', ?)`,
        args: [id, SEED.workspaceId, now()],
      });
    }
    await cardReachableMembers(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      emailSendingEnabled: true,
    });
    const cards = await queryAll<{ action: string }>(
      db,
      `SELECT action FROM recommendations WHERE person_id = ? AND campaign_id = ?`,
      [SEED.personId, SEED.campaignId],
    );
    // Outbound (the seed's Jane is on X too, so a reply), not research.
    expect(cards.map((c) => c.action)).toEqual(['reply']);
  });

  test('a pending research card is replaced, not counted as a card', async () => {
    const db = await janeWithAddressAndNoCard('cards-over-research');
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, status, created_at)
            VALUES ('rec_research', ?, ?, ?, 'refresh_research', 'website', 10, 'stale',
                    'allow', '2026-01-01', 'pending', ?)`,
      args: [SEED.workspaceId, SEED.campaignId, SEED.personId, now()],
    });
    const result = await cardReachableMembers(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      emailSendingEnabled: true,
    });
    expect(result).toEqual({ checked: 1, carded: 1 });
    const cards = await queryAll<{ action: string; status: string }>(
      db,
      `SELECT action, status FROM recommendations WHERE person_id = ? ORDER BY action`,
      [SEED.personId],
    );
    expect(cards).toEqual([
      { action: 'refresh_research', status: 'superseded' },
      { action: 'reply', status: 'pending' },
    ]);
  });

  test('leaves someone the company cap held back', async () => {
    const db = await janeWithAddressAndNoCard('cards-capped');
    await db.execute({
      sql: `UPDATE campaign_people SET status = 'unqualified', status_reason = 'company cap'`,
      args: [],
    });
    expect(
      await cardReachableMembers(db, {
        workspaceId: SEED.workspaceId,
        campaignId: SEED.campaignId,
        emailSendingEnabled: true,
      }),
    ).toEqual({ checked: 0, carded: 0 });
  });
});
