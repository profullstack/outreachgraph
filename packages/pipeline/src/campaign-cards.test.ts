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
