/**
 * Invitations, profile visits, follows and messages through the LinkedIn
 * session; the per-kind caps in front of them; and the acceptance check that
 * turns a pending invitation into a `connection_accepted`.
 *
 * No network: every Voyager call goes to a fake that answers with the shapes
 * captured from the web client, and records what it was asked.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { newId } from '@outreachgraph/domain';
import { LinkedInSession } from '@outreachgraph/providers';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { connectLinkedInSession } from './linkedin-account';
import { deliverLinkedInAction } from './outreach-linkedin';
import { checkLinkedInAcceptances, recordInvitationSent } from './linkedin-connections';
import { runSocialDelivery, LINKEDIN_ACTION_CAPS, scheduleSocialDelivery } from './social-delivery';
import { createRule } from './rules';
import { createCadence } from './cadence';

let seeded: SeededDatabase | undefined;
afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = randomBytes(32);
const COOKIE = 'AQEDAtestcookievalue1234567890';
const ACTOR = { actorKind: 'user' as const, actorId: SEED.userId };
const THEM = 'urn:li:fsd_profile:ACoAAAjane00000000000000000000000000000';
const PROFILE_URL = 'https://www.linkedin.com/in/jane-doe/';

type Relationship = 'none' | 'pending' | 'connected';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function topCard(relationship: Relationship): unknown {
  const union =
    relationship === 'connected'
      ? { connection: 'urn:li:fsd_connection:1' }
      : {
          noConnection: {
            memberDistance: 'DISTANCE_2',
            invitationUnion:
              relationship === 'pending'
                ? { invitation: 'urn:li:fsd_invitation:1' }
                : { noInvitation: { targetInvitee: THEM } },
          },
        };
  return {
    data: { '*elements': [THEM] },
    included: [
      { entityUrn: THEM, publicIdentifier: 'jane-doe' },
      {
        entityUrn: `urn:li:fsd_memberRelationship:${THEM.split(':').at(-1)}`,
        memberRelationshipUnion: union,
      },
    ],
  };
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body?: Record<string, unknown>;
}

/** A LinkedIn that answers every read with `relationship` and accepts every write. */
function fakeLinkedIn(relationship: () => Relationship): {
  session: LinkedInSession;
  calls: Call[];
} {
  const calls: Call[] = [];
  const session = new LinkedInSession(COOKIE, {
    fetchImpl: async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as Record<string, unknown> } : {}),
      });
      if (url.endsWith('/me')) {
        return json(200, {
          miniProfile: {
            publicIdentifier: 'sam',
            entityUrn: 'urn:li:fs_miniProfile:ACoAAAsam',
          },
        });
      }
      if (method === 'GET') return json(200, topCard(relationship()));
      if (url.includes('verifyQuotaAndCreateV2')) {
        return json(200, { data: { value: { '*invitation': 'urn:li:fsd_invitation:9' } } });
      }
      if (url.includes('createMessage')) {
        return json(201, { data: { value: { entityUrn: 'urn:li:msg_message:9' } } });
      }
      return new Response('', { status: 200 });
    },
  });
  return { session, calls };
}

async function seedLinkedInIdentity(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, profile_url, confidence,
          source_type, first_seen_at)
          VALUES (?, ?, 'linkedin', 'jane-doe', ?, 0.95, 'public_web', ?)`,
    args: [newId('socialIdentity'), SEED.personId, PROFILE_URL, now()],
  });
}

async function seedAction(db: Client, kind: string, body?: string): Promise<string> {
  const recommendationId = newId('recommendation');
  const actionId = newId('action');
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, policy_status, policy_version, expected_goal, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'linkedin', 80, 'cadence step', 'allow_with_approval', 'test',
          'start_conversation', 'approved', ?)`,
    args: [recommendationId, SEED.workspaceId, SEED.campaignId, SEED.personId, kind, now()],
  });
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, body, created_at)
          VALUES (?, ?, ?, ?, ?, 'linkedin', 'customer_managed', 'queued', ?, ?)`,
    args: [actionId, SEED.workspaceId, recommendationId, SEED.personId, kind, body ?? null, now()],
  });
  return actionId;
}

async function setup(name: string): Promise<Client> {
  seeded = await seedDatabase(name);
  const { db } = seeded;
  await connectLinkedInSession(db, {
    workspaceId: SEED.workspaceId,
    liAt: COOKIE,
    encryptionKey: KEY,
    verify: false,
  });
  await seedLinkedInIdentity(db);
  return db;
}

async function actionState(db: Client, id: string) {
  return queryOne<{ status: string; error: string | null; external_url: string | null }>(
    db,
    'SELECT status, error, external_url FROM actions WHERE id = ?',
    [id],
  );
}

async function connection(db: Client) {
  return queryOne<{ status: string; invited_at: string | null; next_check_at: string | null }>(
    db,
    'SELECT status, invited_at, next_check_at FROM linkedin_connections WHERE person_id = ?',
    [SEED.personId],
  );
}

describe('connect', () => {
  test('invites with the drafted note and records a pending invitation', async () => {
    const db = await setup('li-connect');
    const actionId = await seedAction(db, 'connect', 'Enjoyed your post on settlement fees.');
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result).toEqual({ sent: true, url: PROFILE_URL });
    const invite = calls.find((c) => c.url.includes('verifyQuotaAndCreateV2'))!;
    expect(invite.body).toEqual({
      invitee: { inviteeUnion: { memberProfile: THEM } },
      customMessage: 'Enjoyed your post on settlement fees.',
    });

    expect((await actionState(db, actionId))?.status).toBe('completed');
    const row = await connection(db);
    expect(row?.status).toBe('pending');
    expect(row?.invited_at).not.toBeNull();
    expect(row?.next_check_at).not.toBeNull();
  });

  test('refuses someone already connected without sending an invitation', async () => {
    const db = await setup('li-connect-already');
    const actionId = await seedAction(db, 'connect');
    const { session, calls } = fakeLinkedIn(() => 'connected');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );

    expect(result).toEqual({ sent: false, reason: 'they are already a LinkedIn connection' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    expect((await actionState(db, actionId))?.status).toBe('failed');
    // What the lookup saw is kept: a later "if connected" step can use it.
    expect((await connection(db))?.status).toBe('connected');
  });

  test('refuses a second invitation while one is pending', async () => {
    const db = await setup('li-connect-pending');
    const actionId = await seedAction(db, 'connect');
    const { session, calls } = fakeLinkedIn(() => 'pending');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({ sent: false, reason: 'an invitation to them is already pending' });
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('refuses a note over 300 characters before touching LinkedIn', async () => {
    const db = await setup('li-connect-long');
    const actionId = await seedAction(db, 'connect', 'x'.repeat(301));
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result.sent).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('a person with no LinkedIn identity fails with a reason, not a guess', async () => {
    seeded = await seedDatabase('li-connect-noone');
    const { db } = seeded;
    const actionId = await seedAction(db, 'connect');
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({
      sent: false,
      reason: 'we have no LinkedIn profile for this person',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('send_dm', () => {
  test('messages a connection from our own mailbox', async () => {
    const db = await setup('li-dm');
    const actionId = await seedAction(db, 'send_dm', 'Thanks for connecting, Jane.');
    const { session, calls } = fakeLinkedIn(() => 'connected');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result.sent).toBe(true);

    const message = calls.find((c) => c.url.includes('createMessage'))!;
    expect(message.body).toMatchObject({
      mailboxUrn: 'urn:li:fsd_profile:ACoAAAsam',
      hostRecipientUrns: [THEM],
    });

    const contacted = await queryAll(
      db,
      `SELECT id FROM interactions WHERE person_id = ? AND state = 'contacted'`,
      [SEED.personId],
    );
    expect(contacted).toHaveLength(1);
  });

  test('refuses anyone who is not a connection', async () => {
    const db = await setup('li-dm-stranger');
    const actionId = await seedAction(db, 'send_dm', 'Hello');
    const { session, calls } = fakeLinkedIn(() => 'pending');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({
      sent: false,
      reason: 'they are not a LinkedIn connection, so a message cannot reach them',
    });
    expect(calls.some((c) => c.url.includes('createMessage'))).toBe(false);
  });
});

describe('view_profile and follow', () => {
  test('a visit completes the card without counting as contact', async () => {
    const db = await setup('li-view');
    const actionId = await seedAction(db, 'view_profile');
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({ sent: true, url: PROFILE_URL });
    expect(calls).toHaveLength(1);
    expect((await actionState(db, actionId))?.status).toBe('completed');

    const contacted = await queryAll(
      db,
      `SELECT id FROM interactions WHERE person_id = ? AND state = 'contacted'`,
      [SEED.personId],
    );
    expect(contacted).toHaveLength(0);
  });

  test('a follow patches their following state', async () => {
    const db = await setup('li-follow');
    const actionId = await seedAction(db, 'follow');
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result.sent).toBe(true);
    const patch = calls.find((c) => c.method === 'POST')!;
    expect(decodeURIComponent(patch.url)).toContain(`urn:li:fsd_followingState:${THEM}`);
    expect(patch.body).toEqual({ patch: { $set: { following: true } } });
  });

  test('a like is still a hand-off', async () => {
    const db = await setup('li-like');
    const actionId = await seedAction(db, 'like');
    const { session, calls } = fakeLinkedIn(() => 'none');

    const result = await deliverLinkedInAction(
      { db, session },
      { workspaceId: SEED.workspaceId, actionId, actor: ACTOR },
    );
    expect(result).toEqual({ sent: false, reason: 'like on LinkedIn stays a hand-off' });
    expect(calls).toHaveLength(0);
  });
});

describe('without the opt-in', () => {
  test('no connected session means nothing is sent and the card says why', async () => {
    seeded = await seedDatabase('li-no-session');
    const { db } = seeded;
    await seedLinkedInIdentity(db);
    const actionId = await seedAction(db, 'connect');

    const result = await runSocialDelivery(
      { db, encryptionKey: KEY },
      {
        workspaceId: SEED.workspaceId,
        payload: { actionId, network: 'linkedin', actor: ACTOR },
      },
    );

    expect(result).toEqual({ sent: false, reason: 'no LinkedIn session is connected' });
    expect((await actionState(db, actionId))?.status).toBe('failed');
  });
});

describe('per-kind caps', () => {
  test('invitations stop at 20 a day even with the post budget untouched', async () => {
    seeded = await seedDatabase('li-cap-day');
    const { db } = seeded;
    const start = Date.now();
    const days = new Map<string, number>();

    for (let i = 0; i < LINKEDIN_ACTION_CAPS.connect.perDay + 3; i += 1) {
      const scheduled = await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_connect_${i}`,
          network: 'linkedin',
          actor: ACTOR,
          kind: 'connect',
        },
        start,
      );
      const day = scheduled.runAt.slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + 1);
    }

    for (const count of days.values()) {
      expect(count).toBeLessThanOrEqual(LINKEDIN_ACTION_CAPS.connect.perDay);
    }
    expect(days.size).toBeGreaterThan(1);
  });

  test('invitations stop at 100 in any seven days', async () => {
    seeded = await seedDatabase('li-cap-week');
    const { db } = seeded;
    const start = Date.now();
    const times: number[] = [];

    for (let i = 0; i < LINKEDIN_ACTION_CAPS.connect.perWeek! + 5; i += 1) {
      const scheduled = await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_week_${i}`,
          network: 'linkedin',
          actor: ACTOR,
          kind: 'connect',
        },
        start,
      );
      times.push(Date.parse(scheduled.runAt));
    }

    // Every rolling week ending at one of these holds at most 100.
    for (const end of times) {
      const inWeek = times.filter((t) => t <= end && t > end - 7 * 86_400_000).length;
      expect(inWeek).toBeLessThanOrEqual(LINKEDIN_ACTION_CAPS.connect.perWeek!);
    }
  });

  test('kinds do not eat each other’s budgets, but share the gap', async () => {
    seeded = await seedDatabase('li-cap-kinds');
    const { db } = seeded;
    const start = Date.now();

    // A full day of invitations...
    for (let i = 0; i < LINKEDIN_ACTION_CAPS.connect.perDay; i += 1) {
      await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_c_${i}`,
          network: 'linkedin',
          actor: ACTOR,
          kind: 'connect',
        },
        start,
      );
    }
    const lastInvite = await queryOne<{ run_after: string }>(
      db,
      `SELECT max(run_after) AS run_after FROM jobs WHERE kind = 'deliver_social'`,
      [],
    );

    // ...leaves a profile visit on the same day it would otherwise have had,
    // a gap after the last invitation.
    const visit = await scheduleSocialDelivery(
      db,
      {
        workspaceId: SEED.workspaceId,
        actionId: 'act_visit',
        network: 'linkedin',
        actor: ACTOR,
        kind: 'view_profile',
      },
      start,
    );
    const gap = Date.parse(visit.runAt) - Date.parse(lastInvite!.run_after);
    expect(gap).toBeGreaterThanOrEqual(4 * 60_000);
    expect(gap).toBeLessThanOrEqual(11 * 60_000 + 1);

    const payload = await queryOne<{ payload_json: string }>(
      db,
      `SELECT payload_json FROM jobs WHERE dedupe_key = 'deliver_social:act_visit'`,
      [],
    );
    expect(JSON.parse(payload!.payload_json)).toMatchObject({ capGroup: 'view_profile' });
  });
});

describe('the acceptance check', () => {
  async function pendingInvite(db: Client, invitedAt: string): Promise<void> {
    await recordInvitationSent(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      campaignId: SEED.campaignId,
      profileRef: PROFILE_URL,
      at: invitedAt,
    });
  }

  test('an acceptance becomes an interaction, an event and a rule firing — once', async () => {
    const db = await setup('li-accept');
    await pendingInvite(db, '2026-09-20T09:00:00.000Z');

    const cadence = await createCadence(db, {
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      name: 'After they accept',
      steps: [
        {
          position: 0,
          network: 'linkedin',
          action: 'send_dm',
          delayHours: 0,
          stopOnReply: true,
          condition: 'if_connected',
        },
      ],
      status: 'active',
    });
    if (!cadence.created) throw new Error('plan refused');
    await createRule(db, {
      workspaceId: SEED.workspaceId,
      name: 'Thank them',
      trigger: 'connection_accepted',
      condition: {},
      action: 'enroll_cadence',
      config: { cadenceId: cadence.cadenceId },
    });

    const { session, calls } = fakeLinkedIn(() => 'connected');
    const at = new Date('2026-09-21T10:00:00.000Z');

    const first = await checkLinkedInAcceptances({ db, session, now: at }, SEED.workspaceId);
    expect(first).toEqual({ checked: 1, accepted: 1 });
    expect(calls).toHaveLength(1);

    expect((await connection(db))?.status).toBe('connected');
    const accepted = await queryAll(
      db,
      `SELECT id FROM interactions WHERE person_id = ? AND state = 'connection_accepted'`,
      [SEED.personId],
    );
    expect(accepted).toHaveLength(1);

    const enrolled = await queryAll(
      db,
      'SELECT id FROM cadence_enrollments WHERE cadence_id = ? AND person_id = ?',
      [cadence.cadenceId, SEED.personId],
    );
    expect(enrolled).toHaveLength(1);

    // A connected person is not checked again.
    const second = await checkLinkedInAcceptances(
      { db, session, now: new Date('2026-09-23T10:00:00.000Z') },
      SEED.workspaceId,
    );
    expect(second.checked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('is paced: at most one profile per call, and none inside the gap', async () => {
    const db = await setup('li-accept-paced');
    await pendingInvite(db, '2026-09-20T09:00:00.000Z');
    const { session, calls } = fakeLinkedIn(() => 'pending');
    const at = new Date('2026-09-21T10:00:00.000Z');

    const first = await checkLinkedInAcceptances({ db, session, now: at }, SEED.workspaceId);
    expect(first).toEqual({ checked: 1, accepted: 0 });

    const soon = await checkLinkedInAcceptances(
      { db, session, now: new Date(at.getTime() + 60_000) },
      SEED.workspaceId,
    );
    expect(soon.paced).toBe(true);
    expect(calls).toHaveLength(1);

    // Still pending: due again tomorrow, not in an hour.
    const row = await connection(db);
    expect(row?.status).toBe('pending');
    expect(Date.parse(row!.next_check_at!)).toBe(at.getTime() + 86_400_000);
  });

  test('not yet due is not checked', async () => {
    const db = await setup('li-accept-not-due');
    await pendingInvite(db, '2026-09-21T09:00:00.000Z');
    const { session, calls } = fakeLinkedIn(() => 'connected');

    const result = await checkLinkedInAcceptances(
      { db, session, now: new Date('2026-09-21T12:00:00.000Z') },
      SEED.workspaceId,
    );
    expect(result.checked).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test('stops asking after a month without an answer', async () => {
    const db = await setup('li-accept-lapse');
    await pendingInvite(db, '2026-08-01T09:00:00.000Z');
    const { session } = fakeLinkedIn(() => 'none');

    await checkLinkedInAcceptances(
      { db, session, now: new Date('2026-09-21T10:00:00.000Z') },
      SEED.workspaceId,
    );
    const row = await connection(db);
    expect(row?.status).toBe('none');
    expect(row?.next_check_at).toBeNull();
  });

  test('a signed-out session revokes itself and stops', async () => {
    const db = await setup('li-accept-revoked');
    await pendingInvite(db, '2026-09-20T09:00:00.000Z');
    const session = new LinkedInSession(COOKIE, {
      fetchImpl: async () => new Response('', { status: 302 }),
    });

    const result = await checkLinkedInAcceptances(
      { db, session, now: new Date('2026-09-21T10:00:00.000Z') },
      SEED.workspaceId,
    );
    expect(result.error).toContain('expired');
    const account = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM integration_accounts WHERE network = 'linkedin'`,
      [],
    );
    expect(account?.status).toBe('revoked');
  });
});
