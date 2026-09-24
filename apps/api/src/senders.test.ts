/**
 * The sender pool over HTTP: listing accounts with today's numbers, tuning
 * them, and what approving an email does when every mailbox is full.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const KEY = parseSecretKey(generateSecretKey());

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

interface SenderJson {
  id: string;
  network: string;
  label: string | null;
  handle: string | null;
  status: string;
  dailyCap: number | null;
  configuredCap: number;
  effectiveCapToday: number;
  sentToday: number;
  warmup: { enabled: boolean; day: number | null };
}

async function harness(
  label: string,
  options: { role?: RequestActor['role']; mailer?: Mailer } = {},
): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => ({ ...OWNER, role: options.role ?? 'owner' }),
    encryptionKey: KEY,
    ...(options.mailer ? { mailer: options.mailer } : {}),
  });
  return { app, db: seeded.db };
}

async function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function connectMailbox(app: Hono<AppEnv>, username: string): Promise<Response> {
  return call(app, 'PUT', '/integrations/email', {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    username,
    password: 'app-password',
    fromEmail: username,
    skipVerification: true,
  });
}

async function senders(app: Hono<AppEnv>): Promise<SenderJson[]> {
  const response = await call(app, 'GET', '/senders');
  expect(response.status).toBe(200);
  return ((await response.json()) as { senders: SenderJson[] }).senders;
}

describe('GET /senders', () => {
  test('lists every account with its cap and today’s numbers', async () => {
    const { app } = await harness('senders-list');
    expect((await connectMailbox(app, 'ana@acme.com')).status).toBe(200);
    expect((await connectMailbox(app, 'bo@acme.com')).status).toBe(200);
    // Same login again: a reconnect, not a third mailbox.
    expect((await connectMailbox(app, 'ana@acme.com')).status).toBe(200);

    const list = await senders(app);
    const email = list.filter((sender) => sender.network === 'email');
    expect(email.map((sender) => sender.handle).sort()).toEqual(['ana@acme.com', 'bo@acme.com']);

    for (const sender of email) {
      expect(sender).toMatchObject({
        status: 'active',
        configuredCap: 50,
        // Day 0 of warm-up for a mailbox connected today.
        effectiveCapToday: 5,
        sentToday: 0,
        warmup: { enabled: true, day: 0 },
      });
    }

    // The fixture's X account predates pools: no warm-up, the old limit.
    expect(list.find((sender) => sender.network === 'x')).toMatchObject({
      effectiveCapToday: 20,
      warmup: { enabled: false },
    });
  });
});

describe('PATCH /senders/:id', () => {
  test('pauses, resumes, sets the cap and label, and switches warm-up', async () => {
    const { app } = await harness('senders-patch');
    await connectMailbox(app, 'ana@acme.com');
    const [sender] = (await senders(app)).filter((s) => s.network === 'email');

    const paused = await call(app, 'PATCH', `/senders/${sender!.id}`, { paused: true });
    expect(paused.status).toBe(200);
    expect(((await paused.json()) as { sender: SenderJson }).sender).toMatchObject({
      status: 'paused',
      effectiveCapToday: 0,
    });

    const tuned = await call(app, 'PATCH', `/senders/${sender!.id}`, {
      status: 'active',
      dailyCap: 12,
      label: 'Ana',
      warmup: false,
    });
    expect(tuned.status).toBe(200);
    expect(((await tuned.json()) as { sender: SenderJson }).sender).toMatchObject({
      status: 'active',
      label: 'Ana',
      dailyCap: 12,
      configuredCap: 12,
      effectiveCapToday: 12,
      warmup: { enabled: false },
    });

    // Null restores the network default rather than lifting the cap.
    const reset = await call(app, 'PATCH', `/senders/${sender!.id}`, { dailyCap: null });
    expect(((await reset.json()) as { sender: SenderJson }).sender.configuredCap).toBe(50);
  });

  test('refuses nonsense, strangers and viewers', async () => {
    const { app } = await harness('senders-patch-guard');
    await connectMailbox(app, 'ana@acme.com');
    const [sender] = (await senders(app)).filter((s) => s.network === 'email');

    expect((await call(app, 'PATCH', `/senders/${sender!.id}`, { dailyCap: -1 })).status).toBe(400);
    expect((await call(app, 'PATCH', `/senders/${sender!.id}`, { unknown: true })).status).toBe(
      400,
    );
    expect((await call(app, 'PATCH', '/senders/ita_nope', { paused: true })).status).toBe(404);

    active?.cleanup();
    const viewer = await harness('senders-patch-viewer', { role: 'viewer' });
    expect((await call(viewer.app, 'PATCH', '/senders/iac_x', { paused: true })).status).toBe(403);
  });

  test('DELETE removes one account and leaves the rest of the pool', async () => {
    const { app } = await harness('senders-delete');
    await connectMailbox(app, 'ana@acme.com');
    await connectMailbox(app, 'bo@acme.com');
    const email = (await senders(app)).filter((s) => s.network === 'email');

    expect((await call(app, 'DELETE', `/senders/${email[0]!.id}`)).status).toBe(200);
    const after = (await senders(app)).filter((s) => s.network === 'email');
    expect(after.map((s) => s.id)).toEqual([email[1]!.id]);
    expect((await call(app, 'DELETE', `/senders/${email[0]!.id}`)).status).toBe(404);
  });
});

describe('approving an email when every mailbox is full', () => {
  test('queues it for when the caps reset instead of failing it', async () => {
    const sent: Message[] = [];
    const mailer: Mailer = {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: 'msg' };
      },
    };
    const { app, db } = await harness('senders-approve-deferred', { mailer });

    await db.execute({
      sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
      args: [SEED.recommendationId],
    });
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', 'jane@acme.com', 0.9,
            'public_web', '[]', ?)`,
      args: [SEED.personId, now()],
    });

    await connectMailbox(app, 'ana@acme.com');
    const [mailbox] = (await senders(app)).filter((s) => s.network === 'email');
    await call(app, 'PATCH', `/senders/${mailbox!.id}`, { dailyCap: 0 });

    const response = await call(
      app,
      'POST',
      `/recommendations/${SEED.recommendationId}/approve`,
      {},
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      approved: boolean;
      delivery?: { sent: boolean; deferredUntil?: string; reason?: string };
    };
    expect(payload.approved).toBe(true);
    expect(payload.delivery?.sent).toBe(false);
    expect(payload.delivery?.deferredUntil).toBeDefined();
    expect(payload.delivery?.reason).toContain("today's cap");

    // Neither the mailbox nor the platform sender was used.
    expect(sent).toHaveLength(0);

    const action = await queryOne<{ status: string }>(
      db,
      'SELECT status FROM actions WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(action?.status).toBe('queued');
    const jobs = await queryAll<{ kind: string }>(
      db,
      `SELECT kind FROM jobs WHERE kind = 'deliver_email' AND status = 'pending'`,
      [],
    );
    expect(jobs).toHaveLength(1);
  });
});
