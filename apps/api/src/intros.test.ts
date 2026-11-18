import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { INTRO_DAILY_REQUEST_LIMIT } from '@outreachgraph/domain';
import { createApp } from './app';
import type { RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const ADA: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

/**
 * A second person in a second organization and workspace.
 *
 * Separate on every axis on purpose: the point of these tests is what crosses
 * a workspace boundary, so the two sides must not share one.
 */
async function addMember(
  db: SeededDatabase['db'],
  key: string,
  options: { verified?: boolean } = {},
): Promise<RequestActor> {
  const stamp = now();
  const actor: RequestActor = {
    userId: `usr_${key}`,
    workspaceId: `wsp_${key}`,
    organizationId: `org_${key}`,
    role: 'owner',
  };

  await db.batch([
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [actor.organizationId, key, key, stamp, stamp],
    },
    {
      sql: `INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        actor.userId,
        `${key}@example.com`,
        key,
        options.verified === false ? null : stamp,
        stamp,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
            VALUES (?, ?, 'owner', ?)`,
      args: [actor.organizationId, actor.userId, stamp],
    },
    {
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, min_outreach_confidence,
            created_at, updated_at) VALUES (?, ?, ?, ?, 0.85, ?, ?)`,
      args: [actor.workspaceId, actor.organizationId, key, key, stamp, stamp],
    },
  ]);

  return actor;
}

interface Reply {
  status: number;
  // The shapes under test are asserted field by field below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

async function harness(label: string) {
  seeded = await seedDatabase(label);
  const db = seeded.db;
  let current: RequestActor = ADA;
  const app = createApp({ db, authenticate: async () => current });

  const call = async (
    actor: RequestActor,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Reply> => {
    current = actor;
    const res = await app.request(`/api/v1/intros${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json() };
  };

  const open = async (actor: RequestActor, card: Record<string, unknown>): Promise<string> => {
    const res = await call(actor, 'PUT', '/card', { open: true, ...card });
    expect(res.status).toBe(200);
    return res.body.card.id as string;
  };

  return { db, call, open };
}

const ADA_CARD = {
  displayName: 'Ada',
  headline: 'Building server monitoring',
  lookingFor: 'Security teams who want a design partner',
  canOffer: 'Open-source monitoring daemon and payments engineering',
  topics: ['Security'],
};

const BOB_CARD = {
  displayName: 'Bob',
  headline: 'Runs infrastructure',
  lookingFor: 'Better monitoring for our fleet',
  canOffer: 'A security team that can be a design partner',
};

describe('intro card', () => {
  test('is closed and empty until written', async () => {
    const { call } = await harness('intros-card-default');
    const res = await call(ADA, 'GET', '/card');

    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ id: null, open: false, lookingFor: '', topics: [] });
  });

  test('saves as a draft without joining the pool, and keeps fields left out', async () => {
    const { call } = await harness('intros-card-draft');

    const draft = await call(ADA, 'PUT', '/card', { displayName: '  Ada  ', topics: ['A', 'a'] });
    expect(draft.body.card).toMatchObject({ open: false, displayName: 'Ada', topics: ['a'] });
    expect(draft.body.card.id).toMatch(/^itp_/);

    const second = await call(ADA, 'PUT', '/card', { headline: 'Monitoring' });
    expect(second.body.card).toMatchObject({ displayName: 'Ada', headline: 'Monitoring' });
    expect(second.body.card.id).toBe(draft.body.card.id);
  });

  test('refuses to open an incomplete card and says what is missing', async () => {
    const { call } = await harness('intros-card-incomplete');
    const res = await call(ADA, 'PUT', '/card', { open: true, displayName: 'Ada' });

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual({ missing: ['lookingFor', 'canOffer'] });
  });

  test('refuses to open for an unverified email: acceptance would share it', async () => {
    const { db, call } = await harness('intros-card-unverified');
    const eve = await addMember(db, 'eve', { verified: false });

    const res = await call(eve, 'PUT', '/card', { open: true, ...BOB_CARD });
    expect(res.status).toBe(409);
    // A draft is still fine.
    expect((await call(eve, 'PUT', '/card', BOB_CARD)).status).toBe(200);
  });

  test('rejects unknown fields', async () => {
    const { call } = await harness('intros-card-strict');
    expect((await call(ADA, 'PUT', '/card', { email: 'x@example.com' })).status).toBe(400);
  });

  test('a principal that is not a person has no card to write', async () => {
    const { call } = await harness('intros-card-service');
    const service: RequestActor = { ...ADA, userId: 'usr_service', credential: 'service' };

    expect((await call(service, 'PUT', '/card', ADA_CARD)).status).toBe(403);
    expect((await call(service, 'GET', '/matches')).status).toBe(403);
  });
});

describe('matches', () => {
  test('cannot be read from outside the pool', async () => {
    const { db, call, open } = await harness('intros-matches-closed');
    await open(await addMember(db, 'bob'), BOB_CARD);

    expect((await call(ADA, 'GET', '/matches')).status).toBe(409);
  });

  test('cross workspaces, explain themselves, and carry no address or user id', async () => {
    const { db, call, open } = await harness('intros-matches');
    const bob = await addMember(db, 'bob');
    await open(ADA, ADA_CARD);
    const bobCard = await open(bob, BOB_CARD);

    const res = await call(ADA, 'GET', '/matches');
    expect(res.status).toBe(200);
    expect(res.body.matches).toHaveLength(1);

    const match = res.body.matches[0];
    expect(match.card).toEqual({
      id: bobCard,
      displayName: 'Bob',
      headline: 'Runs infrastructure',
      lookingFor: 'Better monitoring for our fleet',
      canOffer: 'A security team that can be a design partner',
      topics: [],
    });
    expect(match.theyOffer).toEqual(['security', 'design', 'partner']);
    expect(match.youOffer).toEqual(['monitoring']);

    const wire = JSON.stringify(res.body);
    expect(wire).not.toContain('example.com');
    expect(wire).not.toContain(bob.userId);
  });

  test('leave out a closed card', async () => {
    const { db, call, open } = await harness('intros-matches-closed-card');
    const bob = await addMember(db, 'bob');
    await open(ADA, ADA_CARD);
    await open(bob, BOB_CARD);
    await call(bob, 'PUT', '/card', { open: false });

    expect((await call(ADA, 'GET', '/matches')).body.matches).toEqual([]);
  });
});

describe('requests', () => {
  async function pair(label: string) {
    const h = await harness(label);
    const bob = await addMember(h.db, 'bob');
    const adaCard = await h.open(ADA, ADA_CARD);
    const bobCard = await h.open(bob, BOB_CARD);
    return { ...h, bob, adaCard, bobCard };
  }

  test('asking shows the other side a card and a note, and nobody an address', async () => {
    const { call, bob, bobCard } = await pair('intros-request');

    const sent = await call(ADA, 'POST', '/requests', {
      cardId: bobCard,
      note: ' Design partner? ',
    });
    expect(sent.status).toBe(201);
    expect(sent.body.request).toMatchObject({
      direction: 'outgoing',
      status: 'pending',
      note: 'Design partner?',
    });
    expect(sent.body.request.contact).toBeUndefined();

    const inbox = await call(bob, 'GET', '/requests?box=incoming');
    expect(inbox.body.requests).toHaveLength(1);
    expect(inbox.body.requests[0]).toMatchObject({
      id: sent.body.request.id,
      direction: 'incoming',
      status: 'pending',
      card: { displayName: 'Ada' },
    });
    expect(JSON.stringify(inbox.body)).not.toContain('example.com');
  });

  test('accepting is what shares each address, with each side only', async () => {
    const { db, call, bob, bobCard } = await pair('intros-accept');
    const sent = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });
    const id = sent.body.request.id as string;

    // The asker cannot accept their own request.
    expect((await call(ADA, 'POST', `/requests/${id}/accept`)).status).toBe(409);

    const accepted = await call(bob, 'POST', `/requests/${id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.request).toMatchObject({
      status: 'accepted',
      contact: { email: 'test@example.com' },
    });

    const mine = await call(ADA, 'GET', '/requests?box=outgoing');
    expect(mine.body.requests[0]).toMatchObject({
      status: 'accepted',
      contact: { email: 'bob@example.com' },
    });

    // Made once: neither side can ask again, and they stop being matches.
    expect((await call(bob, 'GET', '/matches')).body.matches).toEqual([]);

    const events = await queryAll<{ event_type: string }>(
      db,
      `SELECT event_type FROM audit_events WHERE event_type LIKE 'intro.%' ORDER BY event_type`,
    );
    expect(events.map((e) => e.event_type)).toEqual([
      'intro.accepted',
      'intro.card_opened',
      'intro.card_opened',
      'intro.requested',
    ]);
  });

  test('a third member can neither see nor answer the request', async () => {
    const { db, call, bobCard } = await pair('intros-third');
    const carol = await addMember(db, 'carol');
    const sent = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });

    expect((await call(carol, 'GET', '/requests')).body.requests).toEqual([]);
    const poke = await call(carol, 'POST', `/requests/${sent.body.request.id}/accept`);
    expect(poke.status).toBe(404);
  });

  test('a decline is final for the pair and is not announced to the asker', async () => {
    const { db, call, bob, adaCard, bobCard } = await pair('intros-decline');
    const sent = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });
    const id = sent.body.request.id as string;

    const declined = await call(bob, 'POST', `/requests/${id}/decline`);
    expect(declined.body.request.status).toBe('declined');
    expect(declined.body.request.contact).toBeUndefined();

    // To the asker it still reads as waiting, exactly like an ignored request.
    const mine = await call(ADA, 'GET', '/requests?box=outgoing');
    expect(mine.body.requests[0]).toMatchObject({ status: 'pending', decidedAt: null });

    // Asking again reads the same as a card that is not there.
    const again = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Please?' });
    const missing = await call(ADA, 'POST', '/requests', { cardId: 'itp_nobody', note: 'Hi' });
    expect(again.status).toBe(404);
    expect(again.body).toEqual(missing.body);

    // Final in both directions, and gone from both lists of matches.
    expect((await call(bob, 'POST', '/requests', { cardId: adaCard, note: 'Hi' })).status).toBe(
      404,
    );
    expect((await call(ADA, 'GET', '/matches')).body.matches).toEqual([]);

    // The audit log keeps the reason the caller was not given.
    const refused = await queryOne<{ detail_json: string }>(
      db,
      `SELECT detail_json FROM audit_events WHERE event_type = 'intro.request_refused'
        ORDER BY occurred_at ASC LIMIT 1`,
    );
    expect(String(refused?.detail_json)).toContain('blocked');

    // Withdrawing it works like withdrawing any waiting request.
    const withdrawn = await call(ADA, 'POST', `/requests/${id}/withdraw`);
    expect(withdrawn.body.request.status).toBe('withdrawn');
  });

  test('accepting re-reads the asker: a closed card cannot be accepted', async () => {
    const { call, bob, bobCard } = await pair('intros-recheck');
    const sent = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });
    await call(ADA, 'PUT', '/card', { open: false });

    const res = await call(bob, 'POST', `/requests/${sent.body.request.id}/accept`);
    expect(res.status).toBe(409);
    expect((await call(bob, 'GET', '/requests')).body.requests[0].contact).toBeUndefined();
  });

  test('an unanswered request expires and can then be asked again', async () => {
    const { db, call, bob, bobCard } = await pair('intros-expiry');
    const sent = await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });
    const id = sent.body.request.id as string;

    await db.execute({
      sql: 'UPDATE intro_requests SET expires_at = ? WHERE id = ?',
      args: ['2020-01-01T00:00:00.000Z', id],
    });

    expect((await call(bob, 'POST', `/requests/${id}/accept`)).status).toBe(409);
    expect((await call(bob, 'GET', '/requests')).body.requests[0].status).toBe('expired');
    expect(
      (await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Still interested' })).status,
    ).toBe(201);
  });

  test('one live request per pair, no self-requests, and a note is required', async () => {
    const { call, bob, adaCard, bobCard } = await pair('intros-rules');

    expect((await call(ADA, 'POST', '/requests', { cardId: adaCard, note: 'Me' })).status).toBe(
      400,
    );
    expect((await call(ADA, 'POST', '/requests', { cardId: bobCard, note: '   ' })).status).toBe(
      400,
    );

    expect((await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Hi' })).status).toBe(
      201,
    );
    expect((await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Hi' })).status).toBe(
      409,
    );
    // The reverse direction is the same pair.
    expect((await call(bob, 'POST', '/requests', { cardId: adaCard, note: 'Hi' })).status).toBe(
      409,
    );
  });

  test('the daily allowance holds, and withdrawing does not return it', async () => {
    const { db, call, open } = await harness('intros-daily');
    await open(ADA, ADA_CARD);

    const cards: string[] = [];
    for (let i = 0; i <= INTRO_DAILY_REQUEST_LIMIT; i += 1) {
      cards.push(await open(await addMember(db, `m${i}`), BOB_CARD));
    }

    let last = '';
    for (let i = 0; i < INTRO_DAILY_REQUEST_LIMIT; i += 1) {
      const res = await call(ADA, 'POST', '/requests', { cardId: cards[i], note: 'Hi' });
      expect(res.status).toBe(201);
      last = res.body.request.id as string;
    }

    await call(ADA, 'POST', `/requests/${last}/withdraw`);
    const over = await call(ADA, 'POST', '/requests', {
      cardId: cards[INTRO_DAILY_REQUEST_LIMIT],
      note: 'Hi',
    });
    expect(over.status).toBe(429);
  });

  test('deleting an account takes its card and its requests with it', async () => {
    const { db, call, bob, bobCard } = await pair('intros-delete');
    await call(ADA, 'POST', '/requests', { cardId: bobCard, note: 'Design partner?' });

    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [bob.userId] });

    expect((await call(ADA, 'GET', '/matches')).body.matches).toEqual([]);
    expect((await call(ADA, 'GET', '/requests')).body.requests).toEqual([]);
  });
});
