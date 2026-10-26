/**
 * At most N people per company: the best-ranked titles for an engineering
 * offer are kept (CTO and engineering leadership, then founders, then
 * managers, then recruiters), the rest are held back as `unqualified` with
 * the reason and their waiting cards skipped. Someone already written to keeps
 * their place. A second pass changes nothing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { engineeringBuyerRank } from '@outreachgraph/domain';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { COMPANY_CAP_REASON, enforceCompanyCap, excludedByCompanyCap } from './company-cap';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

async function db(label: string): Promise<Client> {
  seeded = await seedDatabase(label);
  return seeded.db;
}

/** A colleague of the seed's Jane (VP Engineering) at Acme, with a pending email card. */
async function colleague(client: Client, name: string, title: string | null): Promise<string> {
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
          VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
    args: [SEED.campaignId, personId, SEED.workspaceId, stamp, stamp],
  });
  await client.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, status, created_at)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 50, 'same company',
                  'allow', '2026-01-01', 'pending', ?)`,
    args: [`rec_${name.toLowerCase()}`, SEED.workspaceId, SEED.campaignId, personId, stamp],
  });
  return personId;
}

describe('engineeringBuyerRank', () => {
  test('engineering leadership, founders, managers, recruiters, everyone else, untitled', () => {
    expect(engineeringBuyerRank('CTO & Co-founder')).toBe(0);
    expect(engineeringBuyerRank('VP of Engineering')).toBe(0);
    expect(engineeringBuyerRank('Head of Engineering')).toBe(0);
    expect(engineeringBuyerRank('Founder & CEO')).toBe(1);
    expect(engineeringBuyerRank('Engineering Manager, Payments')).toBe(2);
    expect(engineeringBuyerRank('Technical Recruiter')).toBe(3);
    expect(engineeringBuyerRank('Software Engineer')).toBe(4);
    expect(engineeringBuyerRank(null)).toBe(5);
  });
});

describe('enforceCompanyCap', () => {
  test('keeps the best three at a company and holds the rest back', async () => {
    const client = await db('company-cap');
    // Jane, the seed person, is VP Engineering at Acme.
    await colleague(client, 'Sam', 'Software Engineer');
    await colleague(client, 'Cara', 'CTO');
    await colleague(client, 'Rob', 'Technical Recruiter');
    await colleague(client, 'Una', null);
    await colleague(client, 'Fay', 'Founder');

    const result = await enforceCompanyCap(client, {
      campaignId: SEED.campaignId,
      maxPerCompany: 3,
    });
    expect(result).toMatchObject({ companies: 1, kept: 3, excluded: 3, cardsSkipped: 3 });

    const members = await queryAll<{ person_id: string; status: string; status_reason: string }>(
      client,
      `SELECT person_id, status, status_reason FROM campaign_people WHERE campaign_id = ?
        ORDER BY person_id`,
      [SEED.campaignId],
    );
    const held = members.filter((m) => m.status_reason === COMPANY_CAP_REASON);
    expect(held.map((m) => m.person_id).sort()).toEqual(['per_rob', 'per_sam', 'per_una']);
    expect(held.every((m) => m.status === 'unqualified')).toBe(true);
    expect(await excludedByCompanyCap(client, SEED.campaignId, 'per_sam')).toBe(true);
    expect(await excludedByCompanyCap(client, SEED.campaignId, 'per_cara')).toBe(false);

    const cards = await queryAll<{ id: string; status: string }>(
      client,
      `SELECT id, status FROM recommendations WHERE id IN ('rec_sam', 'rec_cara') ORDER BY id`,
    );
    expect(cards).toEqual([
      { id: 'rec_cara', status: 'pending' },
      { id: 'rec_sam', status: 'skipped' },
    ]);

    // Idempotent.
    const again = await enforceCompanyCap(client, {
      campaignId: SEED.campaignId,
      maxPerCompany: 3,
    });
    expect(again).toMatchObject({ kept: 3, excluded: 3, cardsSkipped: 0 });
  });

  test('someone already written to keeps their place, ahead of rank', async () => {
    const client = await db('company-cap-contacted');
    const sam = await colleague(client, 'Sam', 'Software Engineer');
    await colleague(client, 'Cara', 'CTO');
    await client.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at)
            VALUES ('act_sam', ?, 'rec_sam', ?, 'send_email', 'email', 'customer_managed',
                    'completed', ?)`,
      args: [SEED.workspaceId, sam, now()],
    });

    await enforceCompanyCap(client, { campaignId: SEED.campaignId, maxPerCompany: 1 });
    expect(await excludedByCompanyCap(client, SEED.campaignId, sam)).toBe(false);
    expect(await excludedByCompanyCap(client, SEED.campaignId, 'per_cara')).toBe(true);
  });
});
