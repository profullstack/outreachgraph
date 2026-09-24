import { afterEach, describe, expect, test } from 'bun:test';
import { queryAll, queryOne, type Client } from '@outreachgraph/db';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import type { IncomingMessage, Mailer, SendResult } from '@outreachgraph/email';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { connectEmailAccount, mailerForSend } from './email-account';
import { receiveReplies } from './receive-email';
import {
  chooseSender,
  evaluateSenderHealth,
  listSenders,
  noteSendFailure,
  pickSender,
  recordSenderBounce,
  updateSender,
} from './sender-pool';
import { runSocialDelivery, scheduleSocialDelivery } from './social-delivery';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = parseSecretKey(generateSecretKey());
const AT = new Date('2026-09-24T12:00:00.000Z');
const TODAY = '2026-09-24T09:00:00.000Z';
const YESTERDAY = '2026-09-23T09:00:00.000Z';

let seq = 0;

async function account(
  db: Client,
  id: string,
  options: {
    network?: 'email' | 'linkedin' | 'x';
    createdAt?: string;
    status?: string;
    dailyCap?: number | null;
    warmupStartedAt?: string | null;
  } = {},
): Promise<void> {
  const network = options.network ?? 'email';
  await db.execute({
    sql: `INSERT OR IGNORE INTO integrations (id, workspace_id, kind, network, status, created_at,
          updated_at) VALUES (?, ?, ?, ?, 'connected', ?, ?)`,
    args: [
      `int_${network}`,
      SEED.workspaceId,
      network === 'email' ? 'smtp' : 'social',
      network,
      TODAY,
      TODAY,
    ],
  });
  // Clear the fixture's unidentified X account so it does not join the pool.
  if (network === 'x') await db.execute(`DELETE FROM integration_accounts WHERE id = 'iac_x'`);
  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, scopes, status, daily_cap,
          warmup_enabled, warmup_started_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'enc', '[]', ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      `int_${network}`,
      SEED.workspaceId,
      network,
      id,
      `${id}@example.com`,
      options.status ?? 'active',
      options.dailyCap ?? null,
      options.warmupStartedAt ? 1 : 0,
      options.warmupStartedAt ?? null,
      options.createdAt ?? '2026-01-01T00:00:00.000Z',
      TODAY,
    ],
  });
}

async function send(
  db: Client,
  accountId: string,
  at: string,
  options: { personId?: string; status?: string; network?: string; kind?: string } = {},
): Promise<string> {
  seq += 1;
  const id = `act_${seq}`;
  await db.execute({
    sql: `INSERT OR IGNORE INTO people (id, display_name, identity_confidence, status,
          outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, 'Someone', 0.9, 'active', 1, 0, ?, ?)`,
    args: [options.personId ?? SEED.personId, at, at],
  });
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, created_at, executed_at, sender_account_id)
          VALUES (?, ?, ?, ?, ?, ?, 'customer_managed', ?, ?, ?, ?)`,
    args: [
      id,
      SEED.workspaceId,
      SEED.recommendationId,
      options.personId ?? SEED.personId,
      options.kind ?? 'send_email',
      options.network ?? 'email',
      options.status ?? 'completed',
      at,
      at,
      accountId,
    ],
  });
  return id;
}

async function status(db: Client, id: string) {
  return queryOne<{ status: string; status_reason: string | null }>(
    db,
    'SELECT status, status_reason FROM integration_accounts WHERE id = ?',
    [id],
  );
}

describe('pickSender', () => {
  test('a pre-pool account is picked exactly as the single mailbox was', async () => {
    seeded = await seedDatabase('pool-legacy');
    const { db } = seeded;
    // What the migration leaves behind: no warm-up, no cap set.
    await account(db, 'ita_legacy');

    for (let i = 0; i < 49; i += 1) await send(db, 'ita_legacy', TODAY, { personId: 'per_x' });
    expect((await pickSender(db, SEED.workspaceId, 'email', SEED.personId, AT))?.id).toBe(
      'ita_legacy',
    );

    // The 50th uses the last of the default allowance; the 51st waits.
    await send(db, 'ita_legacy', TODAY, { personId: 'per_x' });
    expect(await pickSender(db, SEED.workspaceId, 'email', SEED.personId, AT)).toBeUndefined();
  });

  test('keeps the conversation on the account that started it', async () => {
    seeded = await seedDatabase('pool-continuity');
    const { db } = seeded;
    await account(db, 'ita_a');
    await account(db, 'ita_b');

    // B wrote to Jane yesterday and is busier today; A has more room.
    await send(db, 'ita_b', YESTERDAY);
    await send(db, 'ita_b', TODAY, { personId: 'per_other' });
    await send(db, 'ita_b', TODAY, { personId: 'per_other' });

    const selection = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'email',
      personId: SEED.personId,
      at: AT,
    });
    expect(selection.choice).toEqual({ kind: 'picked', id: 'ita_b', reason: 'continuity' });

    // A failed send started no conversation and pins nobody.
    await db.execute(`UPDATE actions SET status = 'failed' WHERE sender_account_id = 'ita_b'`);
    expect((await pickSender(db, SEED.workspaceId, 'email', SEED.personId, AT))?.id).toBe('ita_a');
  });

  test('waits for the continuing account when it is full, instead of switching', async () => {
    seeded = await seedDatabase('pool-continuity-capped');
    const { db } = seeded;
    await account(db, 'ita_a');
    await account(db, 'ita_b', { dailyCap: 1 });
    await send(db, 'ita_b', TODAY);

    const selection = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'email',
      personId: SEED.personId,
      at: AT,
    });
    expect(selection.choice).toMatchObject({ kind: 'deferred', reason: 'continuity_capped' });
    expect(selection.retryAt).toBe('2026-09-25T00:00:00.000Z');
  });

  test('otherwise sends from the account with the most room left', async () => {
    seeded = await seedDatabase('pool-capacity');
    const { db } = seeded;
    await account(db, 'ita_a');
    await account(db, 'ita_b');
    for (let i = 0; i < 3; i += 1) await send(db, 'ita_a', TODAY, { personId: 'per_other' });
    await send(db, 'ita_b', TODAY, { personId: 'per_other' });

    expect((await pickSender(db, SEED.workspaceId, 'email', SEED.personId, AT))?.id).toBe('ita_b');
  });

  test('round-robins between accounts with equal room', async () => {
    seeded = await seedDatabase('pool-round-robin');
    const { db } = seeded;
    await account(db, 'ita_a');
    await account(db, 'ita_b');
    await account(db, 'ita_c');

    const order: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const picked = await pickSender(db, SEED.workspaceId, 'email', `per_${i}`, AT);
      order.push(picked!.id);
      // Seconds apart, so "least recently used" has an order to read.
      await send(db, picked!.id, `2026-09-24T09:00:0${i}.000Z`, { personId: `per_${i}` });
    }
    expect(order).toEqual(['ita_a', 'ita_b', 'ita_c', 'ita_a', 'ita_b', 'ita_c']);
  });

  test('a warming account gets only its ramp for the day', async () => {
    seeded = await seedDatabase('pool-warmup');
    const { db } = seeded;
    await account(db, 'ita_new', { warmupStartedAt: '2026-09-23T15:00:00.000Z' });

    // Day 1 of email warm-up: 5 + 3.
    for (let i = 0; i < 8; i += 1) {
      expect(await pickSender(db, SEED.workspaceId, 'email', `per_${i}`, AT)).toBeDefined();
      await send(db, 'ita_new', TODAY, { personId: `per_${i}` });
    }
    expect(await pickSender(db, SEED.workspaceId, 'email', 'per_9', AT)).toBeUndefined();

    const [view] = await listSenders(db, SEED.workspaceId, AT);
    expect(view).toMatchObject({
      effectiveCapToday: 8,
      sentToday: 8,
      remainingToday: 0,
      configuredCap: 50,
      warmup: { enabled: true, day: 1, rampCapToday: 8, complete: false },
    });
  });

  test('defers when every account is at its cap, and says there is nothing active apart', async () => {
    seeded = await seedDatabase('pool-all-capped');
    const { db } = seeded;

    const none = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'email',
      at: AT,
    });
    expect(none.choice).toEqual({ kind: 'none_active' });

    await account(db, 'ita_a', { dailyCap: 1 });
    await account(db, 'ita_b', { dailyCap: 2 });
    await account(db, 'ita_c', { status: 'paused' });
    await send(db, 'ita_a', TODAY, { personId: 'per_other' });
    await send(db, 'ita_b', TODAY, { personId: 'per_other' });
    await send(db, 'ita_b', TODAY, { personId: 'per_other' });

    const full = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'email',
      personId: SEED.personId,
      at: AT,
    });
    expect(full.choice).toEqual({ kind: 'deferred', reason: 'all_capped' });
    expect(full.retryAt).toBe('2026-09-25T00:00:00.000Z');
    expect(await pickSender(db, SEED.workspaceId, 'email', SEED.personId, AT)).toBeUndefined();

    // Tomorrow the same pool has room again.
    const tomorrow = new Date('2026-09-25T08:00:00.000Z');
    expect(await pickSender(db, SEED.workspaceId, 'email', SEED.personId, tomorrow)).toBeDefined();
  });
});

describe('mailerForSend', () => {
  const platform: Mailer = { send: async (): Promise<SendResult> => ({ id: 'platform' }) };

  test('falls back to the platform sender only when no mailbox is active', async () => {
    seeded = await seedDatabase('pool-mailer-fallback');
    const { db } = seeded;

    const none = await mailerForSend(db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: platform,
      at: AT,
    });
    expect(none).toMatchObject({ kind: 'ready', ownMailbox: false });

    await account(db, 'ita_a', { dailyCap: 1 });
    await send(db, 'ita_a', TODAY, { personId: 'per_other' });

    // A full pool waits; it does not spill onto the platform sender.
    const full = await mailerForSend(db, SEED.workspaceId, {
      encryptionKey: KEY,
      fallback: platform,
      personId: SEED.personId,
      at: AT,
    });
    expect(full).toMatchObject({ kind: 'deferred', code: 'all_capped' });
  });
});

describe('connecting into the pool', () => {
  test('a new login adds a mailbox; the same login updates it and keeps its settings', async () => {
    seeded = await seedDatabase('pool-connect');
    const { db } = seeded;
    const connect = (username: string, password: string) =>
      connectEmailAccount(db, {
        workspaceId: SEED.workspaceId,
        account: {
          host: 'smtp.example.com',
          port: 465,
          secure: true,
          username,
          password,
          fromEmail: username,
        },
        encryptionKey: KEY,
        verify: false,
      });

    const first = await connect('ana@acme.com', 'pw-1');
    const second = await connect('bo@acme.com', 'pw-2');
    expect(first.accountId).not.toBe(second.accountId);

    await updateSender(db, SEED.workspaceId, first.accountId!, { label: 'Ana', dailyCap: 30 });
    const again = await connect('ana@acme.com', 'pw-3');
    expect(again.accountId).toBe(first.accountId);

    const senders = await listSenders(db, SEED.workspaceId, AT);
    const email = senders.filter((sender) => sender.network === 'email');
    expect(email).toHaveLength(2);
    expect(email.find((sender) => sender.id === first.accountId)).toMatchObject({
      label: 'Ana',
      dailyCap: 30,
      handle: 'ana@acme.com',
    });
    // New connections warm up from the day they are added.
    expect(email.every((sender) => sender.warmup.enabled)).toBe(true);
  });
});

describe('account health', () => {
  test('bounces over 5% of recent sends stop the account, once per bounce', async () => {
    seeded = await seedDatabase('pool-bounces');
    const { db } = seeded;
    await account(db, 'ita_a');
    for (let i = 0; i < 20; i += 1) await send(db, 'ita_a', TODAY, { personId: `per_${i}` });

    const first = await recordSenderBounce(db, {
      workspaceId: SEED.workspaceId,
      accountId: 'ita_a',
      externalId: '<b1@mx>',
    });
    expect(first).toEqual({ recorded: true, stopped: false });

    // The same bounce read again on the next poll counts for nothing.
    expect(
      await recordSenderBounce(db, {
        workspaceId: SEED.workspaceId,
        accountId: 'ita_a',
        externalId: '<b1@mx>',
      }),
    ).toEqual({ recorded: false, stopped: false });

    const second = await recordSenderBounce(db, {
      workspaceId: SEED.workspaceId,
      accountId: 'ita_a',
      externalId: '<b2@mx>',
    });
    expect(second.stopped).toBe(true);
    expect(await status(db, 'ita_a')).toMatchObject({ status: 'error' });
    expect((await status(db, 'ita_a'))?.status_reason).toContain('2 bounces');
    expect(await pickSender(db, SEED.workspaceId, 'email', 'per_new', AT)).toBeUndefined();

    // Resuming clears the slate, so the bounces that stopped it do not stop
    // it again on the next one.
    const resumed = await updateSender(db, SEED.workspaceId, 'ita_a', { paused: false });
    expect(resumed.status).toBe('active');
    await recordSenderBounce(db, {
      workspaceId: SEED.workspaceId,
      accountId: 'ita_a',
      externalId: '<b3@mx>',
    });
    expect(await evaluateSenderHealth(db, 'ita_a')).toBe(false);
    expect((await status(db, 'ita_a'))?.status).toBe('active');
  });

  test('bounces read from the mailbox count against it; replies still do not', async () => {
    seeded = await seedDatabase('pool-imap-bounces');
    const { db } = seeded;
    await account(db, 'ita_a');
    await send(db, 'ita_a', TODAY);

    const bounces: IncomingMessage[] = [1, 2, 3].map((n) => ({
      messageId: `<bounce-${n}@mx>`,
      fromAddress: 'mailer-daemon@mx.example.com',
      subject: 'Undelivered Mail Returned to Sender',
      receivedAt: new Date(TODAY),
      automated: 'bounce',
    }));
    const reader = { fetchSince: async () => bounces };

    const firstPoll = await receiveReplies({
      db,
      workspaceId: SEED.workspaceId,
      reader,
      senderAccountId: 'ita_a',
    });
    await receiveReplies({ db, workspaceId: SEED.workspaceId, reader, senderAccountId: 'ita_a' });

    const events = await queryAll<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM sender_events WHERE account_id = 'ita_a' AND kind = 'bounce'`,
      [],
    );
    expect(events[0]?.n).toBe(3);
    expect(firstPoll.recorded).toBe(0);
    // Three bounces against one send is past any threshold.
    expect(firstPoll.senderStopped).toBe(true);
  });

  test('a rejected login stops the account with the provider’s words', async () => {
    seeded = await seedDatabase('pool-auth');
    const { db } = seeded;
    await account(db, 'ita_a');

    const kind = await noteSendFailure(db, {
      workspaceId: SEED.workspaceId,
      accountId: 'ita_a',
      message: 'email send failed (535): 5.7.8 Username and Password not accepted',
    });
    expect(kind).toBe('auth');
    const row = await status(db, 'ita_a');
    expect(row?.status).toBe('error');
    expect(row?.status_reason).toContain('Username and Password not accepted');

    // A timeout says nothing about the account.
    await account(db, 'ita_b');
    expect(
      await noteSendFailure(db, {
        workspaceId: SEED.workspaceId,
        accountId: 'ita_b',
        message: 'connect ETIMEDOUT',
      }),
    ).toBe('other');
    expect((await status(db, 'ita_b'))?.status).toBe('active');
  });

  test('a revoked account cannot be resumed, only reconnected', async () => {
    seeded = await seedDatabase('pool-revoked');
    const { db } = seeded;
    await account(db, 'ita_a', { status: 'revoked' });
    await expect(updateSender(db, SEED.workspaceId, 'ita_a', { paused: false })).rejects.toThrow(
      'reconnect',
    );
  });
});

describe('paced social delivery', () => {
  async function approvedLinkedInAction(db: Client): Promise<string> {
    await db.execute(`UPDATE recommendations SET status = 'approved', network = 'linkedin'`);
    await db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at) VALUES ('act_li', ?, ?, ?, 'reply', 'linkedin',
            'customer_managed', 'queued', ?)`,
      args: [SEED.workspaceId, SEED.recommendationId, SEED.personId, new Date().toISOString()],
    });
    return 'act_li';
  }

  test('a full pool moves the job to tomorrow instead of failing the card', async () => {
    seeded = await seedDatabase('pool-social-defer');
    const { db } = seeded;
    await account(db, 'ita_li', { network: 'linkedin', dailyCap: 0 });
    const actionId = await approvedLinkedInAction(db);

    const result = await runSocialDelivery(
      { db, encryptionKey: KEY },
      {
        workspaceId: SEED.workspaceId,
        payload: { actionId, network: 'linkedin', actor: { actorKind: 'user', actorId: 'u' } },
      },
    );
    expect(result.sent).toBe(false);
    expect(result.deferredUntil).toBeDefined();
    expect(Date.parse(result.deferredUntil!)).toBeGreaterThan(Date.now());

    const action = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM actions WHERE id = ?`,
      [actionId],
    );
    expect(action?.status).toBe('queued');
    const jobs = await queryAll<{ run_after: string }>(
      db,
      `SELECT run_after FROM jobs WHERE kind = 'deliver_social' AND status = 'pending'`,
      [],
    );
    expect(jobs).toHaveLength(1);
  });

  test('the day’s schedule grows with the pool', async () => {
    seeded = await seedDatabase('pool-social-schedule');
    const { db } = seeded;
    await account(db, 'ita_a', { network: 'linkedin', dailyCap: 2 });
    await account(db, 'ita_b', { network: 'linkedin', dailyCap: 1 });

    // Real time: the queue stores `run_after` from the clock, not from `start`.
    const start = Date.now();
    const days: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const scheduled = await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_s${i}`,
          network: 'linkedin',
          actor: { actorKind: 'user', actorId: 'u' },
        },
        start,
      );
      days.push(scheduled.runAt.slice(0, 10));
    }
    // Three a day between the two accounts (2 + 1), never more, and a full
    // day of three — which neither account could schedule alone.
    const perDay = new Map<string, number>();
    for (const day of days) perDay.set(day, (perDay.get(day) ?? 0) + 1);
    expect(Math.max(...perDay.values())).toBe(3);
  });
});

describe('LinkedIn per-kind caps, per account', () => {
  test('each session keeps its own 20 invitations a day, apart from its post budget', async () => {
    seeded = await seedDatabase('pool-li-kinds');
    const { db } = seeded;
    await account(db, 'ita_a', { network: 'linkedin' });
    await account(db, 'ita_b', { network: 'linkedin' });

    // A has spent its day of invitations; B has spent its day of comments.
    for (let i = 0; i < 20; i += 1) {
      await send(db, 'ita_a', TODAY, { network: 'linkedin', kind: 'connect', personId: `p_${i}` });
    }
    for (let i = 0; i < 25; i += 1) {
      await send(db, 'ita_b', TODAY, { network: 'linkedin', kind: 'comment', personId: `q_${i}` });
    }

    const pick = (kind: string) =>
      chooseSender(db, { workspaceId: SEED.workspaceId, network: 'linkedin', kind, at: AT });

    expect((await pick('connect')).account?.id).toBe('ita_b');
    expect((await pick('comment')).account?.id).toBe('ita_a');
    // Visits are a third budget neither has touched.
    expect((await pick('view_profile')).choice.kind).toBe('picked');

    for (let i = 0; i < 20; i += 1) {
      await send(db, 'ita_b', TODAY, { network: 'linkedin', kind: 'connect', personId: `r_${i}` });
    }
    expect((await pick('connect')).choice).toEqual({ kind: 'deferred', reason: 'all_capped' });
  });

  test('a session that has sent 100 invitations this week has no room for another', async () => {
    seeded = await seedDatabase('pool-li-week');
    const { db } = seeded;
    await account(db, 'ita_a', { network: 'linkedin' });
    for (let d = 1; d <= 5; d += 1) {
      const day = `2026-09-${String(24 - d).padStart(2, '0')}T09:00:00.000Z`;
      for (let i = 0; i < 20; i += 1) {
        await send(db, 'ita_a', day, {
          network: 'linkedin',
          kind: 'connect',
          personId: `w${d}_${i}`,
        });
      }
    }
    const selection = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'linkedin',
      kind: 'connect',
      at: AT,
    });
    expect(selection.choice).toEqual({ kind: 'deferred', reason: 'all_capped' });
  });

  test('a warming session is held to its ramp for every kind', async () => {
    seeded = await seedDatabase('pool-li-warm');
    const { db } = seeded;
    await account(db, 'ita_new', { network: 'linkedin', warmupStartedAt: TODAY });
    for (let i = 0; i < 5; i += 1) {
      await send(db, 'ita_new', TODAY, {
        network: 'linkedin',
        kind: 'view_profile',
        personId: `v_${i}`,
      });
    }
    const selection = await chooseSender(db, {
      workspaceId: SEED.workspaceId,
      network: 'linkedin',
      kind: 'view_profile',
      at: AT,
    });
    expect(selection.choice.kind).toBe('deferred');
  });

  test('the invitation schedule grows with the number of sessions', async () => {
    seeded = await seedDatabase('pool-li-schedule');
    const { db } = seeded;
    await account(db, 'ita_a', { network: 'linkedin' });
    await account(db, 'ita_b', { network: 'linkedin' });

    // Real time: the queue stores `run_after` from the clock, not from `start`.
    const start = Date.now();
    const days = new Map<string, number>();
    for (let i = 0; i < 45; i += 1) {
      const scheduled = await scheduleSocialDelivery(
        db,
        {
          workspaceId: SEED.workspaceId,
          actionId: `act_inv_${i}`,
          network: 'linkedin',
          actor: { actorKind: 'user', actorId: 'u' },
          kind: 'connect',
        },
        start,
      );
      const day = scheduled.runAt.slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + 1);
    }
    // Two sessions, twenty each: never more than forty in a day, and more
    // than one session's twenty on at least one of them.
    const counts = [...days.values()];
    expect(Math.max(...counts)).toBeLessThanOrEqual(40);
    expect(Math.max(...counts)).toBeGreaterThan(20);
  });
});
