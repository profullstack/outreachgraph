/**
 * The callback path itself.
 *
 * Pinned in a test because it is not our configuration: the URL is registered
 * on the CoinPayPortal side, so renaming the route breaks payments that have
 * already been taken, and the failure shows up as credits that silently never
 * arrive rather than as anything red.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { CoinPayClient } from '@outreachgraph/payments';
import { createApp } from './app';
import type { RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const SECRET = 'whsec_test_secret';
const PATH = '/api/v1/coinpay/callback';

async function sign(body: string): Promise<string> {
  const at = Math.floor(Date.now() / 1000);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${at}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  return `t=${at},v1=${hex}`;
}

async function harness(label: string, withCoinpay = true) {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({
    db: seeded.db,
    authenticate: async () => ACTOR,
    ...(withCoinpay
      ? {
          coinpay: new CoinPayClient({
            apiKey: 'cp_test_key',
            businessId: 'biz',
            webhookSecret: SECRET,
          }),
        }
      : {}),
  });

  return { app, seeded };
}

describe('POST /api/v1/coinpay/callback', () => {
  test('is reachable without a session', async () => {
    // The caller is a payment processor. Requiring a cookie would mean no
    // payment is ever confirmed.
    const { app } = await harness('cb-unauth');

    const body = JSON.stringify({
      id: 'evt_1',
      type: 'test.webhook',
      business_id: 'biz',
      created_at: new Date().toISOString(),
      data: { payment_id: '' },
    });

    const response = await app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-signature': await sign(body) },
      body,
    });

    expect(response.status).toBe(200);
    expect((await response.json()) as { handled: boolean }).toMatchObject({ handled: true });
  });

  test('rejects an unsigned call', async () => {
    const { app } = await harness('cb-unsigned');

    const response = await app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'payment.confirmed', data: { payment_id: 'pay_x' } }),
    });

    expect(response.status).toBe(401);
  });

  test('the old path is gone', async () => {
    // If both answered, the registered URL could drift without anyone noticing.
    const { app } = await harness('cb-oldpath');

    const response = await app.request('/api/v1/webhooks/coinpay', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
  });

  test('says so plainly when the deployment has no payment credentials', async () => {
    const { app } = await harness('cb-unconfigured', false);

    const response = await app.request(PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(503);
  });
});
