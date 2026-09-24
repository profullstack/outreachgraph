/**
 * The outbound bus, end to end against a real migrated database: emitting
 * queues rather than sends, only matching endpoints hear, the worker's
 * delivery signs what it sends and retries what failed, and the CRM sync
 * pushes the right person.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { OutboundEvent } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  verifyWebhookSignature,
  type CrmClient,
  type CrmContactInput,
  CrmError,
} from '@outreachgraph/providers';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  createWebhookEndpoint,
  emitWebhookEvent,
  listWebhookEndpoints,
  runWebhookDelivery,
  sendTestEvent,
  WebhookError,
  WebhookRetryError,
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

describe('emitWebhookEvent', () => {
  test('with nobody listening, writes nothing', async () => {
    seeded = await seedDatabase('wh-silent');
    const result = await emitWebhookEvent(seeded.db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
    });
    expect(result).toEqual({ deliveries: 0, crmSyncs: 0 });
    expect(await jobs(seeded.db, 'deliver_webhook')).toHaveLength(0);
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
    const queued = await jobs(db, 'deliver_webhook');
    expect(queued).toHaveLength(2);

    const deliveries = await queryAll<{
      endpoint_id: string;
      payload_json: string;
      status: string;
    }>(db, 'SELECT endpoint_id, payload_json, status FROM webhook_deliveries');
    expect(deliveries.map((d) => d.endpoint_id).sort()).toEqual(
      [all.endpoint.id, replies.endpoint.id].sort(),
    );
    expect(deliveries.every((d) => d.status === 'pending')).toBe(true);

    const payload = JSON.parse(deliveries[0]!.payload_json) as OutboundEvent;
    expect(payload.type).toBe('reply.received');
    expect(payload.id.startsWith('evt_')).toBe(true);
    expect(payload.data.person).toMatchObject({
      id: SEED.personId,
      name: 'Jane Smith',
      company: 'Acme',
    });
  });

  test('ping reaches only the endpoint being tested', async () => {
    seeded = await seedDatabase('wh-ping');
    const db = seeded.db;
    const target = await endpoint(db);
    await endpoint(db);

    const sent = await sendTestEvent(db, SEED.workspaceId, target.endpoint.id);
    expect(sent).toBeDefined();
    expect(await jobs(db, 'deliver_webhook')).toHaveLength(1);
    expect(await sendTestEvent(db, 'wsp_other', target.endpoint.id)).toBeUndefined();
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
    expect(await jobs(db, 'deliver_webhook')).toHaveLength(0);

    await recordLinkClick(db, {
      token: link!.id,
      userAgent: 'Mozilla/5.0 Chrome/140',
      at: new Date(Date.now() + 3_600_000),
    });
    expect(await jobs(db, 'deliver_webhook')).toHaveLength(1);
  });
});

describe('runWebhookDelivery', () => {
  test('signs the exact body it sends, and marks it delivered', async () => {
    seeded = await seedDatabase('wh-deliver');
    const db = seeded.db;
    const created = await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'action.sent', { personId: SEED.personId });
    const [job] = await jobs(db, 'deliver_webhook');

    let captured: { body: string; headers: Record<string, string> } | undefined;
    const result = await runWebhookDelivery(
      {
        db,
        encryptionKey: KEY,
        lookup: PUBLIC,
        clock: () => 1_800_000_000,
        fetchImpl: async (_url, init) => {
          captured = {
            body: String(init?.body),
            headers: init?.headers as Record<string, string>,
          };
          return new Response('ok');
        },
      },
      jobFor(job!),
    );

    expect(result.status).toBe('delivered');
    expect(captured?.headers['X-OutreachGraph-Event']).toBe('action.sent');
    expect(
      verifyWebhookSignature(
        created.secret,
        captured!.body,
        captured!.headers['X-OutreachGraph-Signature'],
        { now: 1_800_000_000 },
      ),
    ).toBe(true);

    const row = await queryOne<{ status: string; status_code: number; delivered_at: string }>(
      db,
      'SELECT status, status_code, delivered_at FROM webhook_deliveries',
    );
    expect(row).toMatchObject({ status: 'delivered', status_code: 200 });
    expect(row?.delivered_at).toBeTruthy();
  });

  test('a Slack endpoint gets a message, not the envelope', async () => {
    seeded = await seedDatabase('wh-slack');
    const db = seeded.db;
    await endpoint(db, { kind: 'slack', url: 'https://hooks.slack.com/services/T0/B0/xyz' });
    await emitWebhookEvent(db, SEED.workspaceId, 'reply.received', {
      personId: SEED.personId,
      subject: 'Sounds good',
    });
    const [job] = await jobs(db, 'deliver_webhook');

    let body = '';
    await runWebhookDelivery(
      {
        db,
        encryptionKey: KEY,
        lookup: PUBLIC,
        fetchImpl: async (_url, init) => {
          body = String(init?.body);
          return new Response('ok');
        },
      },
      jobFor(job!),
    );

    const parsed = JSON.parse(body) as { text: string };
    expect(Object.keys(parsed)).toEqual(['text']);
    expect(parsed.text).toContain('Jane Smith');
    expect(parsed.text).toContain('Sounds good');
  });

  test('a failure asks the queue to retry, and the last attempt is recorded as failed', async () => {
    seeded = await seedDatabase('wh-retry');
    const db = seeded.db;
    await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });
    const [job] = await jobs(db, 'deliver_webhook');
    const deps = {
      db,
      encryptionKey: KEY,
      lookup: PUBLIC,
      fetchImpl: async () => new Response('down', { status: 503 }),
    };

    await expect(runWebhookDelivery(deps, jobFor(job!, 1))).rejects.toThrow(WebhookRetryError);
    expect(
      (await queryOne<{ status: string }>(db, 'SELECT status FROM webhook_deliveries'))?.status,
    ).toBe('retrying');

    await expect(runWebhookDelivery(deps, jobFor(job!, 8))).rejects.toThrow(WebhookRetryError);
    const row = await queryOne<{ status: string; attempt: number; status_code: number }>(
      db,
      'SELECT status, attempt, status_code FROM webhook_deliveries',
    );
    expect(row).toMatchObject({ status: 'failed', attempt: 8, status_code: 503 });
  });

  test('refuses at delivery time a URL that now resolves privately, without retrying', async () => {
    seeded = await seedDatabase('wh-rebind');
    const db = seeded.db;
    await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });
    const [job] = await jobs(db, 'deliver_webhook');

    let called = false;
    const result = await runWebhookDelivery(
      {
        db,
        encryptionKey: KEY,
        lookup: async () => ['127.0.0.1'],
        fetchImpl: async () => {
          called = true;
          return new Response('ok');
        },
      },
      jobFor(job!),
    );

    expect(called).toBe(false);
    expect(result.status).toBe('failed');
  });

  test('410 Gone disables the endpoint; a deleted endpoint cancels its deliveries', async () => {
    seeded = await seedDatabase('wh-gone');
    const db = seeded.db;
    const created = await endpoint(db);
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });
    await emitWebhookEvent(db, SEED.workspaceId, 'prospect.created', { personId: SEED.personId });
    const [first, second] = await jobs(db, 'deliver_webhook');

    const gone = await runWebhookDelivery(
      {
        db,
        encryptionKey: KEY,
        lookup: PUBLIC,
        fetchImpl: async () => new Response('', { status: 410 }),
      },
      jobFor(first!),
    );
    expect(gone.status).toBe('failed');
    const listed = await listWebhookEndpoints(db, SEED.workspaceId);
    expect(listed.find((e) => e.id === created.endpoint.id)?.active).toBe(false);

    const cancelled = await runWebhookDelivery(
      { db, encryptionKey: KEY, lookup: PUBLIC },
      jobFor(second!),
    );
    expect(cancelled.status).toBe('cancelled');
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
