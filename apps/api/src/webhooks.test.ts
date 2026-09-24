/**
 * `/api/v1/webhooks` and `/api/v1/integrations/crm` through the real app and a
 * real temp database. The properties that matter: approvers only, the signing
 * secret is returned once and never again, a private URL is refused, and a
 * test or a real event queues a delivery rather than sending one inline.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryAll } from '@outreachgraph/db';
import { generateSecretKey, parseSecretKey } from '@outreachgraph/secrets';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const KEY = parseSecretKey(generateSecretKey());

async function harness(
  label: string,
  options: { actor?: RequestActor; key?: boolean; crmStatus?: number } = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase; crmCalls: string[] }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const crmCalls: string[] = [];

  const app = createApp({
    db: seeded.db,
    authenticate: async () => options.actor ?? OWNER,
    ...(options.key === false ? {} : { encryptionKey: KEY }),
    // Every host resolves publicly except the one the SSRF test names.
    webhookLookup: async (host) => (host === 'internal.example' ? ['10.0.0.9'] : ['93.184.216.34']),
    crmFetch: async (input) => {
      crmCalls.push(String(input));
      return new Response('{}', { status: options.crmStatus ?? 200 });
    },
  });

  return { app, seeded, crmCalls };
}

function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('webhooks', () => {
  test('create returns the secret once; the list never does', async () => {
    const { app } = await harness('api-wh-create');

    const created = await send(app, 'POST', '/webhooks', {
      url: 'https://hooks.zapier.com/hooks/catch/123/abcd/',
      events: ['reply.received', 'action.sent'],
      description: 'Zapier: new deal',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      endpoint: { id: string; urlHint: string; events: string[] };
      secret: string;
    };
    expect(body.secret.startsWith('whsec_')).toBe(true);
    expect(body.endpoint.events).toEqual(['reply.received', 'action.sent']);
    expect(body.endpoint.urlHint).toBe('https://hooks.zapier.com/…abcd');

    const listed = await send(app, 'GET', '/webhooks');
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(body.secret);
    expect(text).not.toContain('catch/123');
    expect(JSON.parse(text).events).toContain('person.suppressed');
  });

  test('refuses a private URL, plain http and an unknown event', async () => {
    const { app } = await harness('api-wh-refuse');

    const privateUrl = await send(app, 'POST', '/webhooks', { url: 'https://internal.example/x' });
    expect(privateUrl.status).toBe(400);

    const loopback = await send(app, 'POST', '/webhooks', { url: 'https://127.0.0.1/x' });
    expect(loopback.status).toBe(400);

    const plain = await send(app, 'POST', '/webhooks', { url: 'http://hooks.example.com/x' });
    expect(plain.status).toBe(400);

    const typo = await send(app, 'POST', '/webhooks', {
      url: 'https://hooks.example.com/x',
      events: ['reply.recieved'],
    });
    expect(typo.status).toBe(400);
    expect(JSON.stringify(await typo.json())).toContain('reply.recieved');
  });

  test('without an encryption key, nothing is stored', async () => {
    const { app } = await harness('api-wh-nokey', { key: false });
    const refused = await send(app, 'POST', '/webhooks', { url: 'https://hooks.example.com/' });
    expect(refused.status).toBe(503);
  });

  test('a viewer can neither see nor change webhooks', async () => {
    const { app } = await harness('api-wh-viewer', { actor: { ...OWNER, role: 'viewer' } });

    expect((await send(app, 'GET', '/webhooks')).status).toBe(403);
    expect(
      (await send(app, 'POST', '/webhooks', { url: 'https://hooks.example.com/' })).status,
    ).toBe(403);
    expect((await send(app, 'GET', '/integrations/crm')).status).toBe(403);
  });

  test('test-send queues a ping and the delivery log shows it; delete removes it', async () => {
    const { app, seeded } = await harness('api-wh-test');
    const created = (await (
      await send(app, 'POST', '/webhooks', { url: 'https://hooks.example.com/in' })
    ).json()) as { endpoint: { id: string } };
    const id = created.endpoint.id;

    const tested = await send(app, 'POST', `/webhooks/${id}/test`);
    expect(tested.status).toBe(202);

    const jobs = await queryAll<{ kind: string }>(seeded.db, 'SELECT kind FROM jobs');
    expect(jobs.map((j) => j.kind)).toEqual(['deliver_webhook']);

    const log = (await (await send(app, 'GET', `/webhooks/${id}/deliveries`)).json()) as {
      deliveries: { eventType: string; status: string }[];
    };
    expect(log.deliveries).toEqual([
      expect.objectContaining({ eventType: 'ping', status: 'pending' }),
    ]);

    expect((await send(app, 'POST', '/webhooks/whk_nope/test')).status).toBe(404);
    expect((await send(app, 'DELETE', `/webhooks/${id}`)).status).toBe(200);
    expect((await send(app, 'DELETE', `/webhooks/${id}`)).status).toBe(404);
  });

  test('recording a reply emits reply.received to a subscribed endpoint', async () => {
    const { app, seeded } = await harness('api-wh-reply');
    await send(app, 'POST', '/webhooks', {
      url: 'https://hooks.example.com/in',
      events: ['reply.received'],
    });

    const replied = await send(app, 'POST', `/people/${SEED.personId}/replied`, {
      body: 'Yes, let us talk.',
    });
    expect(replied.status).toBe(200);

    const deliveries = await queryAll<{ event_type: string; payload_json: string }>(
      seeded.db,
      'SELECT event_type, payload_json FROM webhook_deliveries',
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.event_type).toBe('reply.received');
    expect(JSON.parse(deliveries[0]!.payload_json).data.body).toBe('Yes, let us talk.');
  });
});

describe('CRM integrations', () => {
  test('connect verifies against the CRM, reports status, and never returns the token', async () => {
    const { app, crmCalls } = await harness('api-crm-connect');

    const connected = await send(app, 'PUT', '/integrations/crm/hubspot', {
      token: 'pat-na1-secret-token',
    });
    expect(connected.status).toBe(200);
    expect(crmCalls[0]).toContain('api.hubapi.com');

    const status = await send(app, 'GET', '/integrations/crm');
    const text = await status.text();
    expect(text).not.toContain('pat-na1-secret-token');
    const parsed = JSON.parse(text) as { providers: { provider: string; connected: boolean }[] };
    expect(parsed.providers).toEqual([
      expect.objectContaining({ provider: 'hubspot', connected: true }),
      expect.objectContaining({ provider: 'pipedrive', connected: false }),
    ]);

    const dropped = await send(app, 'DELETE', '/integrations/crm/hubspot');
    expect(await dropped.json()).toEqual({ disconnected: true });
  });

  test('a refused token is a 400 and nothing is stored', async () => {
    const { app } = await harness('api-crm-refused', { crmStatus: 401 });

    const refused = await send(app, 'PUT', '/integrations/crm/pipedrive', {
      token: 'bad-token-123',
    });
    expect(refused.status).toBe(400);

    const status = (await (await send(app, 'GET', '/integrations/crm')).json()) as {
      providers: { connected: boolean }[];
    };
    expect(status.providers.every((p) => !p.connected)).toBe(true);
  });

  test('an unknown CRM is refused', async () => {
    const { app } = await harness('api-crm-unknown');
    const response = await send(app, 'PUT', '/integrations/crm/salesforce', {
      token: 'x'.repeat(20),
    });
    expect(response.status).toBe(400);
  });
});
