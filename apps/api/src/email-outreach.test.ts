/**
 * The path a human actually takes: read the card, press Approve, the message
 * goes out.
 *
 * Every one of these was broken in the same way and for the same reason. The
 * policy engine asks `hasConnectedAccount` before permitting an outbound
 * action; the API answered that question by counting rows in
 * `integration_accounts`, a table no code path could write to. So email always
 * evaluated to `manual_only`, approving returned 409 "No connected email
 * account, so this must be done manually.", and the product spent its time
 * drafting messages it had already decided it could never send.
 *
 * Autopilot, meanwhile, asked "is a mailer configured?" and sent the identical
 * message unattended. The two paths disagreed, and the one a person used was
 * the broken one.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryOne, type Client } from '@outreachgraph/db';
import type { Mailer, Message, SendResult } from '@outreachgraph/email';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { connectEmailAccount } from '@outreachgraph/pipeline';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
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

function recordingMailer(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message): Promise<SendResult> => {
        sent.push(message);
        return { id: 'msg_1' };
      },
    },
  };
}

/**
 * The fixture as a reviewer would meet it: a `draft_and_approve` campaign with
 * a pending email recommendation, a draft, and an address to send it to.
 *
 * `draft_and_approve` is the default and the point — autopilot never touches
 * these, so this queue is the only way the message can leave.
 */
async function makeEmailCard(
  db: Client,
  options: { personEmail?: string; subject?: string } = {},
): Promise<void> {
  const stamp = now();

  await db.execute({
    sql: `UPDATE recommendations SET action = 'send_email', network = 'email' WHERE id = ?`,
    args: [SEED.recommendationId],
  });

  if (options.subject) {
    await db.execute({
      sql: 'UPDATE drafts SET subject = ? WHERE id = ?',
      args: [options.subject, SEED.draftId],
    });
  }

  if (options.personEmail !== undefined) {
    await db.execute({
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', ?, ?, 0.9, 'public_web', '[]', ?)`,
      args: [SEED.personId, options.personEmail, options.personEmail, stamp],
    });
  }
}

async function harness(
  label: string,
  options: { mailer?: Mailer; encryptionKey?: Buffer } = {},
): Promise<{ app: Hono<AppEnv>; db: Client }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({
    db: seeded.db,
    authenticate: async () => ACTOR,
    ...(options.mailer ? { mailer: options.mailer } : {}),
    ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {}),
  });

  return { app, db: seeded.db };
}

async function approve(app: Hono<AppEnv>, body: unknown = {}): Promise<Response> {
  return app.request(`/api/v1/recommendations/${SEED.recommendationId}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('approving an email', () => {
  test('sends it, rather than telling the user to do it themselves', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('approve-sends', { mailer });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    const response = await approve(app);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as {
      approved: boolean;
      delivery?: { sent: boolean; to?: string };
    };

    expect(payload.approved).toBe(true);
    expect(payload.delivery?.sent).toBe(true);
    expect(payload.delivery?.to).toBe('jane@acme.com');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('jane@acme.com');
    expect(sent[0]?.text).toContain('cross-border settlement');
  });

  test('the whole trail is recorded, not just the send', async () => {
    const { mailer } = recordingMailer();
    const { app, db } = await harness('approve-records', { mailer });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    await approve(app);

    const action = await queryOne<{ status: string; mode: string; external_id: string | null }>(
      db,
      'SELECT status, mode, external_id FROM actions WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(action?.status).toBe('completed');
    expect(action?.mode).toBe('customer_managed');
    expect(action?.external_id).toBe('msg_1');

    // A message that went out but left the recommendation pending gets sent
    // again on the next pass.
    const recommendation = await queryOne<{ status: string }>(
      db,
      'SELECT status FROM recommendations WHERE id = ?',
      [SEED.recommendationId],
    );
    expect(recommendation?.status).toBe('executed');

    const interaction = await queryOne<{ direction: string; state: string }>(
      db,
      'SELECT direction, state FROM interactions WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(interaction?.direction).toBe('outbound');
    expect(interaction?.state).toBe('contacted');
  });

  test('sends the reviewer’s edit, not the original draft', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('approve-edited', { mailer });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    await approve(app, { editedBody: 'Rewritten by hand before sending.' });

    expect(sent[0]?.text).toBe('Rewritten by hand before sending.');
  });

  test('uses the draft subject, and a plain one when there is none', async () => {
    const first = recordingMailer();
    const withSubject = await harness('approve-subject', { mailer: first.mailer });
    await makeEmailCard(withSubject.db, {
      personEmail: 'jane@acme.com',
      subject: 'About your payouts',
    });
    await approve(withSubject.app);
    expect(first.sent[0]?.subject).toBe('About your payouts');

    active?.cleanup();
    active = undefined;

    const second = recordingMailer();
    const without = await harness('approve-nosubject', { mailer: second.mailer });
    await makeEmailCard(without.db, { personEmail: 'jane@acme.com' });
    await approve(without.app);
    expect(second.sent[0]?.subject).toContain('Acme');
  });

  test('reports a rejection from the mail server instead of claiming success', async () => {
    const mailer: Mailer = {
      send: async (): Promise<SendResult> => {
        throw new Error('535 Username and Password not accepted');
      },
    };

    const { app, db } = await harness('approve-send-fails', { mailer });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    const payload = (await (await approve(app)).json()) as {
      delivery?: { sent: boolean; reason?: string };
    };

    expect(payload.delivery?.sent).toBe(false);
    expect(payload.delivery?.reason).toContain('535');

    // Left retryable, with the reason on the row.
    const action = await queryOne<{ status: string; error: string | null }>(
      db,
      'SELECT status, error FROM actions WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(action?.status).toBe('failed');
    expect(action?.error).toContain('535');
  });

  test('says so plainly when the prospect has no published address', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('approve-no-address', { mailer });
    await makeEmailCard(db);

    const payload = (await (await approve(app)).json()) as {
      delivery?: { sent: boolean; reason?: string };
    };

    // Inventing `firstname@company.com` is how a sending domain gets burned.
    expect(payload.delivery?.sent).toBe(false);
    expect(payload.delivery?.reason).toContain('no address published');
    expect(sent).toHaveLength(0);
  });

  test('still refuses when this deployment genuinely cannot send', async () => {
    // The original message was not wrong in every case — with no mailer and no
    // connected mailbox it is the truth, and it must survive.
    const { app, db } = await harness('approve-no-mailer');
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    const response = await approve(app);
    expect(response.status).toBe(409);

    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain('No connected email account');
  });
});

describe('a workspace that connected its own mailbox', () => {
  test('counts as connected even with no platform sender', async () => {
    const { app, db } = await harness('own-mailbox-policy', { encryptionKey: KEY });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    await connectEmailAccount(db, {
      workspaceId: SEED.workspaceId,
      account: {
        host: 'smtp.company.com',
        port: 587,
        secure: false,
        username: 'user@company.com',
        password: 'app-password',
        fromEmail: 'user@company.com',
      },
      encryptionKey: KEY,
      verify: false,
    });

    // No platform mailer at all: the send is attempted through the customer's
    // own mailbox, which is what `customer_managed` has always meant. It fails
    // here because there is no server at smtp.company.com — the point is that
    // policy let it through rather than answering `manual_only`.
    const response = await approve(app);
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { policy: { decision: string } };
    expect(payload.policy.decision).not.toBe('manual_only');
  });
});

describe('POST /actions/:id/execute', () => {
  test('sends an approved email that has not gone out yet', async () => {
    const { sent, mailer } = recordingMailer();
    const { app, db } = await harness('execute-sends', { mailer });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    // Approve with no sender configured on the first app, so the action is
    // left queued; then execute it explicitly.
    const actionId = await queueAction(db);

    const response = await app.request(`/api/v1/actions/${actionId}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'customer_managed' }),
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('jane@acme.com');
  });

  test('still records a manual action for a channel we cannot send on', async () => {
    // LinkedIn automation is prohibited and always will be. The route's other
    // meaning — "I did this by hand" — has to keep working.
    const { app, db } = await harness('execute-manual');
    const actionId = await queueAction(db, 'linkedin');

    const response = await app.request(`/api/v1/actions/${actionId}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'manual', externalUrl: 'https://linkedin.com/messages/1' }),
    });

    expect(response.status).toBe(200);

    const action = await queryOne<{ status: string; external_url: string | null }>(
      db,
      'SELECT status, external_url FROM actions WHERE id = ?',
      [actionId],
    );
    expect(action?.status).toBe('completed');
    expect(action?.external_url).toBe('https://linkedin.com/messages/1');
  });
});

/** An approved-but-unsent action, as the approve route would have left it. */
async function queueAction(db: Client, network = 'email'): Promise<string> {
  const stamp = now();
  const id = `act_${network}_test`;

  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, body, created_at)
          VALUES (?, ?, ?, ?, 'send_email', ?, 'customer_managed', 'queued', ?, ?)`,
    args: [
      id,
      SEED.workspaceId,
      SEED.recommendationId,
      SEED.personId,
      network,
      'We ran into a similar cross-border settlement issue...',
      stamp,
    ],
  });

  return id;
}

describe('connecting a mailbox over the API', () => {
  test('stores it and never gives the password back', async () => {
    const { app } = await harness('connect-route', { encryptionKey: KEY });

    const response = await app.request('/api/v1/integrations/email', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: 'smtp.fastmail.com',
        port: 465,
        secure: true,
        username: 'user@company.com',
        password: 'app-password-1234',
        fromEmail: 'user@company.com',
        fromName: 'Jane',
        skipVerification: true,
      }),
    });

    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain('app-password-1234');

    const read = await app.request('/api/v1/integrations/email');
    const summary = await read.text();
    expect(summary).toContain('smtp.fastmail.com');
    expect(summary).not.toContain('app-password-1234');
  });

  test('refuses when the deployment has no encryption key', async () => {
    const { app } = await harness('connect-route-nokey');

    const response = await app.request('/api/v1/integrations/email', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        host: 'smtp.fastmail.com',
        port: 465,
        secure: true,
        username: 'user@company.com',
        password: 'app-password',
        fromEmail: 'user@company.com',
        skipVerification: true,
      }),
    });

    // 503 rather than 400: nothing is wrong with the request, the deployment
    // is not configured to hold a secret yet.
    expect(response.status).toBe(503);
  });

  test('disconnecting takes effect on the next policy check', async () => {
    const { app, db } = await harness('disconnect-route', { encryptionKey: KEY });
    await makeEmailCard(db, { personEmail: 'jane@acme.com' });

    await connectEmailAccount(db, {
      workspaceId: SEED.workspaceId,
      account: {
        host: 'smtp.company.com',
        port: 587,
        secure: false,
        username: 'user@company.com',
        password: 'app-password',
        fromEmail: 'user@company.com',
      },
      encryptionKey: KEY,
      verify: false,
    });

    const removed = await app.request('/api/v1/integrations/email', { method: 'DELETE' });
    expect(removed.status).toBe(200);

    const response = await approve(app);
    expect(response.status).toBe(409);
  });
});
