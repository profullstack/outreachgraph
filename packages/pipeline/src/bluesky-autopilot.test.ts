/**
 * Bluesky autopilot: opt-in, one action per tick, spaced and capped.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { newId } from '@outreachgraph/domain';
import { BlueskyAgent } from '@outreachgraph/providers';
import { now, queryAll, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  DAILY_CAPS,
  MIN_GAP_MS,
  resetBlueskyAutopilotPauses,
  runBlueskyAutopilot,
} from './bluesky-autopilot';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
  resetBlueskyAutopilotPauses();
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function fakeAgent() {
  const records: Array<Record<string, unknown>> = [];
  const agent = new BlueskyAgent({
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.includes('createSession')) {
        return json(200, { did: 'did:plc:me', handle: 'me.bsky.social', accessJwt: 'jwt' });
      }
      if (url.includes('createRecord')) {
        records.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json(200, {
          uri: `at://did:plc:me/app.bsky.graph.follow/${records.length}`,
          cid: 'c',
        });
      }
      return json(404, {});
    },
  });
  await agent.login('me.bsky.social', 'pw');
  return { agent, records };
}

async function setup(label: string, options: { enabled?: boolean } = {}): Promise<Client> {
  seeded = await seedDatabase(label);
  const { db } = seeded;
  const stamp = now();
  await db.execute({
    sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
    args: [SEED.campaignId],
  });
  await db.execute({
    sql: `INSERT INTO workspace_settings (workspace_id, created_at, updated_at, bluesky_autopilot)
          VALUES (?, ?, ?, ?)
          ON CONFLICT (workspace_id) DO UPDATE SET bluesky_autopilot = excluded.bluesky_autopilot`,
    args: [SEED.workspaceId, stamp, stamp, options.enabled === false ? 0 : 1],
  });
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
          profile_url, confidence, source_type, first_seen_at)
          VALUES (?, ?, 'bluesky', 'jane.bsky.social', 'did:plc:jane',
          'https://bsky.app/profile/jane.bsky.social', 0.99, 'official_api', ?)`,
    args: [newId('socialIdentity'), SEED.personId, stamp],
  });
  return db;
}

async function followCard(db: Client, id = newId('recommendation')): Promise<string> {
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, 'follow', 'bluesky', 50, 'warm up', 'manual_only', 'test',
          'build_relationship', 'pending', ?)`,
    args: [id, SEED.workspaceId, SEED.campaignId, SEED.personId, now()],
  });
  return id;
}

describe('runBlueskyAutopilot', () => {
  test('off by default: nothing happens', async () => {
    const db = await setup('bsky-auto-off', { enabled: false });
    await followCard(db);
    const { agent, records } = await fakeAgent();

    const result = await runBlueskyAutopilot({ db, agentFor: async () => agent }, SEED.workspaceId);
    expect(result.acted).toBe(false);
    expect(records).toHaveLength(0);
  });

  test('on: follows the person and closes the card without counting a contact', async () => {
    const db = await setup('bsky-auto-follow');
    const rec = await followCard(db);
    const { agent, records } = await fakeAgent();

    const result = await runBlueskyAutopilot({ db, agentFor: async () => agent }, SEED.workspaceId);
    expect(result).toMatchObject({ acted: true, kind: 'follow' });
    expect(records[0]?.collection).toBe('app.bsky.graph.follow');
    expect((records[0]?.record as { subject?: string }).subject).toBe('did:plc:jane');

    const cards = await queryAll<{ status: string }>(
      db,
      'SELECT status FROM recommendations WHERE id = ?',
      [rec],
    );
    expect(cards[0]?.status).toBe('executed');
    const contacts = await queryAll(
      db,
      `SELECT id FROM interactions WHERE person_id = ? AND network = 'bluesky'`,
      [SEED.personId],
    );
    expect(contacts).toHaveLength(0);
  });

  test('a second action waits out the gap', async () => {
    const db = await setup('bsky-auto-gap');
    await followCard(db);
    await followCard(db);
    const { agent, records } = await fakeAgent();
    const at = new Date();

    await runBlueskyAutopilot({ db, agentFor: async () => agent, now: at }, SEED.workspaceId);
    const soon = await runBlueskyAutopilot(
      { db, agentFor: async () => agent, now: new Date(at.getTime() + 60_000) },
      SEED.workspaceId,
    );
    expect(soon.acted).toBe(false);
    expect(records).toHaveLength(1);
    expect(MIN_GAP_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  test("the day's follow cap stops it", async () => {
    const db = await setup('bsky-auto-cap');
    await followCard(db);
    const done = await followCard(db);
    const earlier = '2026-10-07T12:00:00.000Z';
    for (let i = 0; i < DAILY_CAPS.follow; i += 1) {
      await db.execute({
        sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
              mode, status, created_at, executed_at)
              VALUES (?, ?, ?, ?, 'follow', 'bluesky', 'customer_managed', 'completed', ?, ?)`,
        args: [newId('action'), SEED.workspaceId, done, SEED.personId, earlier, earlier],
      });
    }
    const { agent, records } = await fakeAgent();

    const result = await runBlueskyAutopilot(
      { db, agentFor: async () => agent, now: new Date('2026-10-07T15:00:00.000Z') },
      SEED.workspaceId,
    );
    expect(result.acted).toBe(false);
    expect(records).toHaveLength(0);
  });

  test('no connected account: nothing is created', async () => {
    const db = await setup('bsky-auto-noaccount');
    await followCard(db);

    const result = await runBlueskyAutopilot(
      { db, agentFor: async () => undefined },
      SEED.workspaceId,
    );
    expect(result.acted).toBe(false);
    const actions = await queryAll(db, `SELECT id FROM actions WHERE network = 'bluesky'`);
    expect(actions).toHaveLength(0);
  });
});
