/**
 * A campaign's exclusions keep a person off every card path: an excluded title
 * is set aside with the reason, a waiting card is skipped, and asking the
 * engine again writes nothing. A title the exclusions do not name is carded as
 * before, and someone already written to keeps their place.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { regenerateFor } from './pipeline';
import { setAsideIfExcluded, targetingExclusion } from './targeting-exclusion';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  const client = seeded.db;
  await client.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, exclusions, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(campaign_id) DO UPDATE SET exclusions = excluded.exclusions`,
    args: [SEED.campaignId, JSON.stringify(['nurse', 'lcsw']), now()],
  });
  return client;
}

/** A member at the seed company with an address and a pending email card. */
async function member(client: Client, name: string, title: string | null): Promise<string> {
  const stamp = now();
  const personId = `per_${name.toLowerCase()}`;
  await client.execute({
    sql: `INSERT INTO people (id, display_name, current_company_id, current_title, status,
          believed_minor, outreach_eligible, identity_confidence, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'active', 0, 1, 0.95, ?, ?)`,
    args: [personId, name, SEED.companyId, title, stamp, stamp],
  });
  await client.execute({
    sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
          interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'awaiting_approval', 'never_contacted', ?, ?)`,
    args: [SEED.campaignId, personId, SEED.workspaceId, stamp, stamp],
  });
  await client.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, status, created_at)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 50, 'test',
                  'allow', '2026-01-01', 'pending', ?)`,
    args: [`rec_${name.toLowerCase()}`, SEED.workspaceId, SEED.campaignId, personId, stamp],
  });
  return personId;
}

async function membership(client: Client, personId: string) {
  return queryOne<{ status: string; status_reason: string | null }>(
    client,
    'SELECT status, status_reason FROM campaign_people WHERE campaign_id = ? AND person_id = ?',
    [SEED.campaignId, personId],
  );
}

async function liveCards(client: Client, personId: string) {
  return queryAll<{ id: string }>(
    client,
    `SELECT id FROM recommendations WHERE campaign_id = ? AND person_id = ?
        AND status IN ('pending', 'approved')`,
    [SEED.campaignId, personId],
  );
}

describe('targeting exclusions', () => {
  test('an excluded title is set aside, its card skipped, and never carded again', async () => {
    const client = await db('targeting-exclusion');
    const nurse = await member(client, 'Lisa', 'Adult-Gerontology Primary Care Nurse Practitioner');

    expect(await targetingExclusion(client, SEED.campaignId, nurse)).toBe('excluded by "nurse"');

    const id = await regenerateFor(
      { db: client, workspaceId: SEED.workspaceId, campaignId: SEED.campaignId, providers: [] },
      nurse,
    );
    expect(id).toBeUndefined();
    expect(await membership(client, nurse)).toEqual({
      status: 'unqualified',
      status_reason: 'excluded by "nurse"',
    });
    expect(await liveCards(client, nurse)).toEqual([]);
  });

  test('a title the exclusions do not name is left alone', async () => {
    const client = await db('targeting-exclusion-kept');
    const ceo = await member(client, 'Rachel', 'CEO & Founder');

    expect(await targetingExclusion(client, SEED.campaignId, ceo)).toBeUndefined();
    expect(
      await setAsideIfExcluded(client, SEED.workspaceId, SEED.campaignId, ceo),
    ).toBeUndefined();
    expect((await membership(client, ceo))?.status).toBe('awaiting_approval');
    expect(await liveCards(client, ceo)).toHaveLength(1);
  });

  test('someone already written to keeps their place', async () => {
    const client = await db('targeting-exclusion-contacted');
    const therapist = await member(client, 'Gabby', 'LCSW');
    await client.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at)
            VALUES ('act_gabby', ?, 'rec_gabby', ?, 'send_email', 'email', 'auto', 'completed', ?)`,
      args: [SEED.workspaceId, therapist, now()],
    });

    expect(
      await setAsideIfExcluded(client, SEED.workspaceId, SEED.campaignId, therapist),
    ).toBeUndefined();
    expect((await membership(client, therapist))?.status).toBe('awaiting_approval');
  });

  test('no exclusions, no gate', async () => {
    const client = await db('targeting-exclusion-none');
    await client.execute({
      sql: `UPDATE campaign_filters SET exclusions = '[]' WHERE campaign_id = ?`,
      args: [SEED.campaignId],
    });
    const nurse = await member(client, 'Nia', 'Nurse');
    expect(await targetingExclusion(client, SEED.campaignId, nurse)).toBeUndefined();
  });
});
