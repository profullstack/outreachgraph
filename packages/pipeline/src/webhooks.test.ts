/**
 * The outbound bus, end to end against a real migrated database: emitting
 * queues rather than sends, only matching endpoints hear, the worker's
 * delivery signs what it sends and retries what failed, and the CRM sync
 * pushes the right person.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac, randomBytes } from 'node:crypto';
import { verifySignature } from '@profullstack/webhooks';
import type { OutboundEvent } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  verifyWebhookSignature,
  type CrmClient,
  type CrmContactInput,
  CrmError,
} from '@outreachgraph/providers';
import { encryptSecret, generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  createWebhookEndpoint,
  createWebhookHub,
  emitWebhookEvent,
  listWebhookEndpoints,
  rotateWebhookSecret,
  sendTestEvent,
  WebhookError,
} from './webhooks';
import { connectCrm, crmStatus, runCrmSync } from './crm-sync';
import { recordLinkClick, trackLinksInBody } from './engagement';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const KEY = parseSecretKey(generateSecretKey());
const PUBLIC = async () => ['93.184.216.34'];

async function endpoint(
  db: Client,
  options: { url?: string; kind?: 'generic' | 'slack'; events?: string[] } = {},
) {
  return createWebhookEndpoint(db, {
    workspaceId: SEED.workspaceId,
    url: options.url ?? 'https://hooks.example.com/og',
    kind: options.kind ?? 'generic',
    events: (options.events ?? []) as never,
    encryptionKey: KEY,
    lookup: PUBLIC,
  });
}

async function jobs(db: Client, kind: string) {
  return queryAll<{ id: string; payload_json: string; max_attempts: number }>(
    db,
    'SELECT id, payload_json, max_attempts FROM jobs WHERE kind = ? ORDER BY created_at',
    [kind],
  );
}

function jobFor(row: { payload_json: string; max_attempts: number }, attempts = 1) {
  return {
    workspaceId: SEED.workspaceId,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    attempts,
    maxAttempts: Number(row.max_attempts),
  };
}

async function withEmail(db: Client): Promise<void> {
  await db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, confidence, source_type,
          verified_by, first_seen_at)
          VALUES ('sid_jane_mail', ?, 'email', 'Jane@Acme.com', 0.95, 'official_api', '[]', ?)`,
    args: [SEED.personId, now()],
  });
}

describe('endpoints', () => {
  test('store the URL and secret encrypted and show only a hint', async () => {
    seeded = await seedDatabase('wh-create');
    const created = await endpoint(seeded.db, {
      url: 'https://hooks.example.com/catch/12345/abcd',
    });

    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.endpoint.urlHint).toBe('https://hooks.example.com/…abcd');

    const row = await queryOne<{ url_enc: string; secret_enc: string }>(
      seeded.db,
      'SELECT url_enc, secret_enc FROM webhook_endpoints WHERE id = ?',
      [created.endpoint.id],
    );
    expect(row?.url_enc).not.toContain('hooks.example.com');
    expect(row?.secret_enc).not.toContain(created.secret);

    const listed = await listWebhookEndpoints(seeded.db, SEED.workspaceId);
    expect(JSON.stringify(listed)).not.toContain(created.secret);
    expect(JSON.stringify(listed)).not.toContain('12345');
  });

  test('refuse a private URL, a non-Slack Slack URL, and a missing key', async () => {
    seeded = await seedDatabase('wh-refuse');
    const db = seeded.db;

    await expect(endpoint(db, { url: 'https://169.254.169.254/latest' })).rejects.toThrow(
      WebhookError,
    );
    await expect(
      createWebhookEndpoint(db, {
        workspaceId: SEED.workspaceId,
        url: 'https://internal.example/',
        kind: 'generic',
        events: [],
        encryptionKey: KEY,
        lookup: async () => ['10.0.0.2'],
      }),
    ).rejects.toThrow('private');
    await expect(endpoint(db, { kind: 'slack' })).rejects.toThrow('hooks.slack.com');
    await expect(
      createWebhookEndpoint(db, {
        workspaceId: SEED.workspaceId,
        url: 'https://hooks.example.com/',
        kind: 'generic',
        events: [],
        encryptionKey: undefined,
        lookup: PUBLIC,
      }),
    ).rejects.toThrow('SECRET_ENCRYPTION_KEY');
  });
});

/** Every row the hub's outbox holds, oldest first. */
async function deliveryRows(db: Client) {
  return queryAll<{
    id: string;
    endpoint_id: string;
    payload_json: string;
    status: string;
    attempt: number;
    status_code: number | null;
    error: string | null;
    next_at: number;
    delivered_at: string | null;
  }>(
    db,
    `SELECT id, endpoint_id, payload_json, status, attempt, status_code, error, next_at,
            delivered_at FROM webhook_deliveries ORDER BY created_at, id`,
  );
}

interface Captured {
  url: string;
  body: string;
  headers: Record<string, string>;
}

/** A hub whose network is a recorder answering `status`. */
function hubWith(db: Client, status = 200, options: { lookup?: () => Promise<string[]> } = {}) {
  const sent: Captured[] = [];
  const hub = createWebhookHub(db, {
    encryptionKey: KEY,
    lookup: options.lookup ?? PUBLIC,
    clock: () => Math.floor(Date.now() / 1000),
    fetchImpl: async (url, init) => {
      sent.push({
        url: String(url),
        body: String(init?.body),
        headers: init?.headers as Record<string, string>,
      });
      return new Response('ok', { status });
    },
  });
  return { hub, sent };
}

/**
 * A receiver written against the old docs (docs/webhooks.md before the move),
 * and never changed: it checks X-OutreachGraph-Signature as
 * HMAC-SHA256(secret as UTF-8, "<t>.<raw body>") in hex, then reads the old
 * envelope fields. Deliberately not `verifyWebhookSignature`, so this proves
 * the bytes on the wire rather than our own helper agreeing with itself.
 */
function oldStyleReceiver(secret: string, body: string, headers: Record<string, string>) {
  const header = headers['X-OutreachGraph-Signature'] ?? '';
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=', 2) as [string, string]),
  );
  const t = Number(parts.t);
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const fresh = Math.abs(Date.now() / 1000 - t) <= 300;
  const event = JSON.parse(body) as {
    id: string;
    type: string;
    createdAt: string;
    workspaceId: string;
    data: { person?: { name: string } };
  };
  return { verified: fresh && parts.v1 === expected, event };
}

describe('emitWebhookEvent', () => {
  test('with nobody listening, writes nothing', async () => {
    seeded = await seedDatabase('wh-silent');
    const result = await emitWebhookEvent(seeded.db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
    });
    expect(result).toEqual({ deliveries: 0, crmSyncs: 0 });
    expect(await deliveryRows(seeded.db)).toHaveLength(0);
  });

  test('queues one delivery per matching endpoint, and never sends inline', async () => {
    seeded = await seedDatabase('wh-filter');
    const db = seeded.db;
    const all = await endpoint(db);
    const replies = await endpoint(db, { events: ['reply.received'] });
    await endpoint(db, { events: ['link.clicked'] });

    const result = await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
      subject: 'Re: hello',
    });

    expect(result.deliveries).toBe(2);
    const deliveries = await deliveryRows(db);
    expect(deliveries.map((d) => d.endpoint_id).sort()).toEqual(
      [all.endpoint.id, replies.endpoint.id].sort(),
    );
    expect(deliveries.every((d) => d.status === 'pending')).toBe(true);

    // A CloudEvent that still carries every field of the old envelope.
    const payload = JSON.parse(deliveries[0]!.payload_json) as OutboundEvent & {
      specversion: string;
      source: string;
      subject: string;
    };
    expect(payload.specversion).toBe('1.0');
    expect(payload.source).toBe('https://outreachgraph.com');
    expect(payload.subject).toBe(`person:${SEED.personId}`);
    expect(payload.type).toBe('reply.received');
    expect(payload.id.startsWith('evt_')).toBe(true);
    expect(payload.workspaceId).toBe(SEED.workspaceId);
    expect(Date.parse(payload.createdAt)).toBeGreaterThan(0);
    expect(payload.data.person).toMatchObject({
      id: SEED.personId,
      name: 'Jane Smith',
      company: 'Acme',
    });
  });

  test('a test reaches only the endpoint being tested, at once', async () => {
    seeded = await seedDatabase('wh-ping');
    const db = seeded.db;
    const target = await endpoint(db);
    await endpoint(db);

    const sent: string[] = [];
    const result = await sendTestEvent(db, SEED.workspaceId, target.endpoint.id, {
      encryptionKey: KEY,
      lookup: PUBLIC,
      fetchImpl: async (url) => {
        sent.push(String(url));
        return new Response('ok');
      },
    });
    expect(result).toMatchObject({ ok: true, statusCode: 200 });
    expect(sent).toEqual(['https://hooks.example.com/og']);
    expect(await sendTestEvent(db, 'wsp_other', target.endpoint.id, { encryptionKey: KEY })).toBe(
      undefined,
    );
  });

  test('a human link click is announced; a scanner is not', async () => {
    seeded = await seedDatabase('wh-click');
    const db = seeded.db;
    await endpoint(db, { events: ['link.clicked'] });

    await trackLinksInBody(db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      campaignId: SEED.campaignId,
      body: 'See https://acme.example/pricing',
      origin: 'https://app.test',
    });
    const link = await queryOne<{ id: string }>(db, 'SELECT id FROM tracked_links');

    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mimecast Link Protection',
      at: new Date(Date.now() + 3_600_000),
    });
    expect(await deliveryRows(db)).toHaveLength(0);

    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mozilla/5.0 Chrome/140',
      at: new Date(Date.now() + 3_600_000),
    });
    expect(await deliveryRows(db)).toHaveLength(1);
  });
});

describe('delivery through the hub', () => {
  test('an old-style receiver still verifies, and so does a Standard Webhooks one', async () => {
    seeded = await seedDatabase('wh-deliver');
    const db = seeded.db;
    const created = await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'action.sent', { personId: SEED.personId });

    const { hub, sent } = hubWith(db);
    expect(await hub.drain()).toBe(1);
    const [request] = sent;

    const old = oldStyleReceiver(created.secret, request!.body, request!.headers);
    expect(old.verified).toBe(true);
    expect(old.event.type).toBe('action.sent');
    expect(old.event.workspaceId).toBe(SEED.workspaceId);
    expect(old.event.data.person?.name).toBe('Jane Smith');
    expect(request!.headers['X-OutreachGraph-Event']).toBe('action.sent');
    expect(request!.headers['X-OutreachGraph-Delivery']).toBe(old.event.id);
    expect(request!.headers['content-type']).toBe('application/json');
    expect(
      verifyWebhookSignature(
        created.secret,
        request!.body,
        request!.headers['X-OutreachGraph-Signature'],
      ),
    ).toBe(true);

    const standard = verifySignature({
      headers: request!.headers,
      body: request!.body,
      secret: created.secret,
    });
    expect(standard.ok).toBe(true);

    const [row] = await deliveryRows(db);
    expect(row).toMatchObject({ status: 'delivered', status_code: 200, attempt: 1 });
    expect(row?.delivered_at).toBeTruthy();
  });

  test('an endpoint and a delivery from before the move are sent and verify', async () => {
    seeded = await seedDatabase('wh-legacy');
    const db = seeded.db;
    // Exactly what the old sender stored: base64url secret, old envelope, a
    // delivery left 'retrying' that migration 0079 made 'pending' and due.
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const stamp = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO webhook_endpoints (id, workspace_id, kind, url_enc, url_hint, secret_enc,
            events_json, description, active, created_at, updated_at)
            VALUES ('whk_old', ?, 'generic', ?, 'https://old.example.com/…hook', ?, '[]', NULL, 1, ?, ?)`,
      args: [
        SEED.workspaceId,
        encryptSecret('https://old.example.com/hook', KEY),
        encryptSecret(secret, KEY),
        stamp,
        stamp,
      ],
    });
    const envelope = JSON.stringify({
      id: 'evt_old1',
      type: 'reply.received',
      createdAt: stamp,
      workspaceId: SEED.workspaceId,
      data: { personId: SEED.personId },
    });
    await db.execute({
      sql: `INSERT INTO webhook_deliveries (id, endpoint_id, workspace_id, event_id, event_type,
            payload_json, status, attempt, created_at, updated_at)
            VALUES ('whd_old', 'whk_old', ?, 'evt_old1', 'reply.received', ?, 'pending', 2, ?, ?)`,
      args: [SEED.workspaceId, envelope, stamp, stamp],
    });

    const { hub, sent } = hubWith(db);
    expect(await hub.drain()).toBe(1);
    expect(sent[0]?.url).toBe('https://old.example.com/hook');
    expect(sent[0]?.body).toBe(envelope);
    expect(oldStyleReceiver(secret, sent[0]!.body, sent[0]!.headers).verified).toBe(true);
    expect(sent[0]?.headers['webhook-id']).toBe('evt_old1');

    // A new event to the same endpoint reaches it too.
    await emitWebhookEvent(db, SEED.workspaceId, 'link.clicked', { personId: SEED.personId });
    await hub.drain();
    expect(sent).toHaveLength(2);
    expect(oldStyleReceiver(secret, sent[1]!.body, sent[1]!.headers).verified).toBe(true);
  });

  test('a Slack endpoint gets a message, not the envelope', async () => {
    seeded = await seedDatabase('wh-slack');
    const db = seeded.db;
    await endpoint(db, { kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/xyz' });
    await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
      subject: 'Sounds good',
    });

    const { hub, sent } = hubWith(db);
    await hub.drain();

    const parsed = JSON.parse(sent[0]!.body) as { text: string };
    expect(Object.keys(parsed)).toEqual(['text']);
    expect(parsed.text).toContain('Jane Smith');
    expect(parsed.text).toContain('Sounds good');
  });

  test('a failure stays pending with a later due time', async () => {
    seeded = await seedDatabase('wh-retry');
    const db = seeded.db;
    await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });

    const { hub } = hubWith(db, 503);
    const before = Date.now();
    await hub.drain();
    const [row] = await deliveryRows(db);
    expect(row).toMatchObject({ status: 'pending', attempt: 1, status_code: 503 });
    expect(Number(row?.next_at)).toBeGreaterThanOrEqual(before + 30_000);
  });

  test('refuses at delivery time a URL that now resolves privately', async () => {
    seeded = await seedDatabase('wh-rebind');
    const db = seeded.db;
    await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });

    const { hub, sent } = hubWith(db, 200, { lookup: async () => ['127.0.0.1'] });
    await hub.drain();
    expect(sent).toHaveLength(0);
    const [row] = await deliveryRows(db);
    expect(row?.status).not.toBe('delivered');
    expect(row?.error).toBeTruthy();
  });

  test('410 Gone disables the endpoint', async () => {
    seeded = await seedDatabase('wh-gone');
    const db = seeded.db;
    const created = await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });

    const { hub } = hubWith(db, 410);
    await hub.drain();
    const listed = await listWebhookEndpoints(db, SEED.workspaceId);
    const gone = listed.find((e) => e.id === created.endpoint.id);
    expect(gone?.active).toBe(false);
    expect(gone?.disabledReason).toContain('410');
    expect((await deliveryRows(db))[0]?.status).toBe('failed');
  });

  test('rotating replaces the secret the next delivery is signed with', async () => {
    seeded = await seedDatabase('wh-rotate');
    const db = seeded.db;
    const created = await endpoint(db);
    const { secret } = await rotateWebhookSecret(db, SEED.workspaceId, created.endpoint.id, {
      encryptionKey: KEY,
    });
    expect(secret).not.toBe(created.secret);

    await emitWebhookEvent(db, SEED.workspaceId, 'action.sent', { personId: SEED.personId });
    const { hub, sent } = hubWith(db);
    await hub.drain();
    expect(oldStyleReceiver(secret, sent[0]!.body, sent[0]!.headers).verified).toBe(true);
    expect(oldStyleReceiver(created.secret, sent[0]!.body, sent[0]!.headers).verified).toBe(false);
  });
});

describe('CRM sync', () => {
  function recorder(options: { fail?: CrmError } = {}) {
    const contacts: CrmContactInput[] = [];
    const notes: { contactId: string; body: string }[] = [];
    const client: CrmClient = {
      verify: async () => undefined,
      ensureContact: async (input) => {
        if (options.fail) throw options.fail;
        contacts.push(input);
        return { id: 'c_1', created: true };
      },
      addNote: async (contactId, body) => {
        notes.push({ contactId, body });
        return { id: 'n_1' };
      },
    };
    return { client, contacts, notes, clientFor: () => client };
  }

  test('a reply is queued for every connected CRM and pushed with a note', async () => {
    seeded = await seedDatabase('crm-reply');
    const db = seeded.db;
    await withEmail(db);
    await connectCrm(db, {
      workspaceId: SEED.workspaceId,
      provider: 'hubspot',
      token: 'pat-secret-token',
      encryptionKey: KEY,
      verify: false,
    });

    const emitted = await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
      subject: 'Re: pricing',
    });
    expect(emitted.crmSyncs).toBe(1);

    // Not a CRM event: nothing queued.
    await emitWebhookEvent(db, SEED.workspaceId, 'link.clicked', { personId: SEED.personId });
    const [job, extra] = await jobs(db, 'sync_crm');
    expect(extra).toBeUndefined();

    const fake = recorder();
    const result = await runCrmSync(
      { db, encryptionKey: KEY, clientFor: fake.clientFor },
      jobFor(job!),
    );

    expect(result.outcome).toBe('synced');
    expect(fake.contacts[0]).toMatchObject({
      email: 'jane@acme.com',
      firstName: 'Jane',
      lastName: 'Smith',
      title: 'VP Engineering',
      company: 'Acme',
      website: 'https://acme.com',
    });
    expect(fake.notes[0]?.body).toContain('Re: pricing');

    const [status] = await crmStatus(db, SEED.workspaceId);
    expect(status).toMatchObject({ provider: 'hubspot', connected: true });
    expect(status?.lastSyncAt).toBeTruthy();
    expect(JSON.stringify(await crmStatus(db, SEED.workspaceId))).not.toContain('pat-secret');
  });

  test('a person with no personal address is skipped, not failed', async () => {
    seeded = await seedDatabase('crm-noemail');
    const db = seeded.db;
    await connectCrm(db, {
      workspaceId: SEED.workspaceId,
      provider: 'pipedrive',
      token: 'pd-token-1234',
      encryptionKey: KEY,
      verify: false,
    });
    await emitWebhookEvent(db, SEED.workspaceId, 'recommendation.approved', {
      personId: SEED.personId,
      outbound: true,
    });
    const [job] = await jobs(db, 'sync_crm');
    const fake = recorder();

    const result = await runCrmSync(
      { db, encryptionKey: KEY, clientFor: fake.clientFor },
      jobFor(job!),
    );
    expect(result.outcome).toBe('no_email');
    expect(fake.contacts).toHaveLength(0);
  });

  test('a refused token revokes the connection instead of retrying', async () => {
    seeded = await seedDatabase('crm-revoked');
    const db = seeded.db;
    await withEmail(db);
    await connectCrm(db, {
      workspaceId: SEED.workspaceId,
      provider: 'hubspot',
      token: 'pat-secret-token',
      encryptionKey: KEY,
      verify: false,
    });
    await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', { personId: SEED.personId });
    const [job] = await jobs(db, 'sync_crm');

    const fake = recorder({ fail: new CrmError('HubSpot: the token was refused', 401, false) });
    const result = await runCrmSync(
      { db, encryptionKey: KEY, clientFor: fake.clientFor },
      jobFor(job!),
    );
    expect(result.outcome).toBe('failed');

    const [status] = await crmStatus(db, SEED.workspaceId);
    expect(status).toMatchObject({ connected: false, status: 'revoked' });
    expect(status?.lastError).toContain('refused');

    // And the next reply no longer queues anything for it.
    const next = await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
    });
    expect(next.crmSyncs).toBe(0);
  });

  test('a retryable failure is thrown back to the queue', async () => {
    seeded = await seedDatabase('crm-retry');
    const db = seeded.db;
    await withEmail(db);
    await connectCrm(db, {
      workspaceId: SEED.workspaceId,
      provider: 'hubspot',
      token: 'pat-secret-token',
      encryptionKey: KEY,
      verify: false,
    });
    await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', { personId: SEED.personId });
    const [job] = await jobs(db, 'sync_crm');

    const fake = recorder({ fail: new CrmError('HubSpot: HTTP 503', 503, true) });
    await expect(
      runCrmSync({ db, encryptionKey: KEY, clientFor: fake.clientFor }, jobFor(job!)),
    ).rejects.toThrow('503');
  });

  test('connecting verifies the token first and stores nothing when it fails', async () => {
    seeded = await seedDatabase('crm-verify');
    const db = seeded.db;
    await expect(
      connectCrm(db, {
        workspaceId: SEED.workspaceId,
        provider: 'hubspot',
        token: 'bad-token-123',
        encryptionKey: KEY,
        fetchImpl: async () => new Response('{}', { status: 401 }),
      }),
    ).rejects.toThrow('refused');
    expect((await crmStatus(db, SEED.workspaceId)).every((s) => !s.connected)).toBe(true);
  });
});
