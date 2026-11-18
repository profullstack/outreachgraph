import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { RequestActor } from './context';
import { describeInteraction, nextStageFor, syncCrmFromOutreach } from './crm-sync';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

describe('nextStageFor', () => {
  test('moves forward only, and never moves a won deal', () => {
    expect(nextStageFor('lead', { kind: 'advance', stage: 'contacted' })).toBe('contacted');
    expect(nextStageFor('replied', { kind: 'advance', stage: 'contacted' })).toBeNull();
    expect(nextStageFor('won', { kind: 'lost', strong: true })).toBeNull();
    expect(nextStageFor('lost', { kind: 'advance', stage: 'replied' })).toBeNull();
  });

  test('a bounce closes only an untouched deal; a "no" closes any open one', () => {
    expect(nextStageFor('contacted', { kind: 'lost', strong: false })).toBe('lost');
    expect(nextStageFor('meeting', { kind: 'lost', strong: false })).toBeNull();
    expect(nextStageFor('meeting', { kind: 'lost', strong: true })).toBe('lost');
  });
});

describe('describeInteraction', () => {
  test('a click is logged without moving the stage', () => {
    const d = describeInteraction({
      network: 'email',
      direction: 'inbound',
      state: 'clicked',
      subject: 'Hi',
      body: null,
      reply_label: null,
    });
    expect(d.event).toBeNull();
    expect(d.body).toContain('Clicked');
  });
});

async function person(db: SeededDatabase['db'], id: string, name: string) {
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    args: [id, name, stamp, stamp],
  });
}

async function interaction(
  db: SeededDatabase['db'],
  row: {
    id: string;
    person: string;
    direction: string;
    state: string;
    at: string;
    label?: string;
    address?: string;
  },
) {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state, body,
            occurred_at, recorded_at, contact_address, subject, reply_label)
          VALUES (?, ?, ?, 'email', ?, ?, 'body text', ?, ?, ?, 'Quick one', ?)`,
    args: [
      row.id,
      SEED.workspaceId,
      row.person,
      row.direction,
      row.state,
      row.at,
      row.at,
      row.address ?? null,
      row.label ?? null,
    ],
  });
}

describe('syncCrmFromOutreach', () => {
  test('sends, replies, bounces and opt-outs become deals and timeline, once', async () => {
    seeded = await seedDatabase('crm-sync');
    const db = seeded.db;
    await person(db, 'per_ada', 'Ada Lovelace');
    await person(db, 'per_bob', 'Bob Bounce');
    await person(db, 'per_cy', 'Cy Nope');
    await person(db, 'per_di', 'Di Clicker');

    await interaction(db, {
      id: 'int_1',
      person: 'per_ada',
      direction: 'outbound',
      state: 'contacted',
      at: '2026-11-01T10:00:00.000Z',
      address: 'ada@example.org',
    });
    await interaction(db, {
      id: 'int_2',
      person: 'per_ada',
      direction: 'inbound',
      state: 'responded',
      at: '2026-11-02T10:00:00.000Z',
      label: 'interested',
    });
    await interaction(db, {
      id: 'int_3',
      person: 'per_bob',
      direction: 'outbound',
      state: 'contacted',
      at: '2026-11-01T11:00:00.000Z',
      address: 'bob@example.org',
    });
    await interaction(db, {
      id: 'int_4',
      person: 'per_bob',
      direction: 'automated',
      state: 'bounced',
      at: '2026-11-01T11:05:00.000Z',
      label: 'bounce',
    });
    await interaction(db, {
      id: 'int_5',
      person: 'per_cy',
      direction: 'outbound',
      state: 'contacted',
      at: '2026-11-01T12:00:00.000Z',
    });
    await interaction(db, {
      id: 'int_6',
      person: 'per_cy',
      direction: 'inbound',
      state: 'responded',
      at: '2026-11-03T12:00:00.000Z',
      label: 'not_interested',
    });
    await interaction(db, {
      id: 'int_7',
      person: 'per_di',
      direction: 'outbound',
      state: 'contacted',
      at: '2026-11-01T13:00:00.000Z',
    });
    await interaction(db, {
      id: 'int_8',
      person: 'per_di',
      direction: 'inbound',
      state: 'clicked',
      at: '2026-11-01T14:00:00.000Z',
    });

    const first = await syncCrmFromOutreach(db, SEED.workspaceId);
    expect(first.interactions).toBe(8);
    expect(first.dealsCreated).toBe(4);

    const stages = Object.fromEntries(
      (
        await queryAll<{ person_id: string; stage: string }>(
          db,
          'SELECT person_id, stage FROM crm_deals WHERE workspace_id = ?',
          [SEED.workspaceId],
        )
      ).map((r) => [r.person_id, r.stage]),
    );
    expect(stages).toEqual({
      per_ada: 'replied',
      per_bob: 'lost',
      per_cy: 'lost',
      per_di: 'contacted',
    });

    const ada = await queryOne<{ contact_email: string; title: string; source: string }>(
      db,
      "SELECT contact_email, title, source FROM crm_deals WHERE person_id = 'per_ada'",
    );
    expect(ada).toMatchObject({
      contact_email: 'ada@example.org',
      title: 'Ada Lovelace',
      source: 'outreach',
    });

    // Re-running copies nothing twice.
    const again = await syncCrmFromOutreach(db, SEED.workspaceId);
    expect(again).toEqual({ interactions: 0, dealsCreated: 0, suppressions: 0, linked: 0 });
    const count = await queryOne<{ n: number | bigint }>(
      db,
      "SELECT COUNT(*) AS n FROM crm_activities WHERE source_ref LIKE 'int:%'",
    );
    expect(Number(count?.n)).toBe(8);
  });

  test('a hand-made deal is linked by email, and a closed deal is not reopened', async () => {
    seeded = await seedDatabase('crm-sync-link');
    const db = seeded.db;
    let current: RequestActor = OWNER;
    const app = createApp({ db, authenticate: async () => current });
    const call = async (method: string, path: string, body?: unknown) => {
      current = OWNER;
      const res = await app.request(`/api/v1${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };

    await person(db, 'per_eve', 'Eve Known');
    await db.execute({
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, created_at)
            VALUES ('pem_1', ?, 'per_eve', 'eve@example.org', 'eve@example.org', ?)`,
      args: [SEED.workspaceId, now()],
    });
    const made = await call('POST', '/crm/deals', {
      contactEmail: 'eve@example.org',
      stage: 'won',
    });
    expect(made.status).toBe(201);

    await interaction(db, {
      id: 'int_9',
      person: 'per_eve',
      direction: 'automated',
      state: 'bounced',
      at: '2026-11-05T10:00:00.000Z',
      label: 'bounce',
      address: 'eve@example.org',
    });

    const synced = await call('POST', '/crm/sync');
    expect(synced.status).toBe(200);
    expect(synced.body.dealsCreated).toBe(0);

    const deal = await call('GET', `/crm/deals/${made.body.deal.id}`);
    expect(deal.body.deal.personId).toBe('per_eve');
    expect(deal.body.deal.contactName).toBe('Eve Known');
    expect(deal.body.deal.stage).toBe('won');
    expect(deal.body.activities.some((a: { body: string }) => a.body.startsWith('Bounced'))).toBe(
      true,
    );
  });
});
