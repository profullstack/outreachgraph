/**
 * `/api/v1/integrations/coinpay` through the real app and a temp database, with
 * the CoinPay client replaced so nothing leaves the process. What matters:
 * approvers only, the key is verified before it is stored and never returned,
 * Today always gets a renderable `state`, and nothing becomes a person or a
 * recommendation.
 */

import { TestVault, testVault } from '@outreachgraph/secrets/testing';
import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryAll } from '@outreachgraph/db';
import {
  CoinPayMerchantError,
  type BehindReport,
  type CoinPayMerchantConfig,
} from '@outreachgraph/payments';
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

const REPORT: BehindReport = {
  as_of: '2026-11-02T00:00:00.000Z',
  summary: '1 customer is behind on £390.00: 3 declined card payments.',
  totals: [{ currency: 'GBP', amount: 390 }],
  counts: { customers: 1, invoices: 0, card_failures: 3 },
  groups: [
    {
      action: 'retry',
      title: 'Likely to go through on a retry',
      todo: 'Send the payment link again in a few days.',
      customers: [
        {
          key: 'biz|email:ops@northgate.example',
          name: 'Northgate Logistics',
          email: 'ops@northgate.example',
          business_name: 'Acme',
          action: 'retry',
          owed: [{ currency: 'GBP', amount: 390 }],
          items: [
            {
              kind: 'card',
              id: 'txn-1',
              amount: 390,
              currency: 'GBP',
              date: '2026-09-09T00:00:00Z',
              title: 'Card payment declined Sep 9',
              detail: 'Not enough money in the account at the time.',
              href: '/transactions/txn-1',
            },
          ],
          history: { line: 'Paying since Mar 2026 · never missed before', paid_count: 7 },
        },
      ],
    },
  ],
};

async function harness(
  label: string,
  opts: { actor?: RequestActor; vault?: TestVault | false; fail?: number } = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase; keys: string[] }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const keys: string[] = [];
  const app = createApp({
    db: seeded.db,
    authenticate: async () => opts.actor ?? OWNER,
    ...(opts.vault === false ? {} : { encryptionKey: opts.vault ?? testVault() }),
    coinpayMerchantFor: (config: CoinPayMerchantConfig) => ({
      portalUrl: 'https://coinpayportal.com',
      behind: async () => {
        keys.push(config.apiKey);
        if (opts.fail) throw new CoinPayMerchantError('CoinPay refused the API key.', opts.fail);
        return REPORT;
      },
    }),
  });
  return { app, seeded, keys };
}

function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('CoinPay: who is behind', () => {
  test('not connected is a state, not an error', async () => {
    const { app, keys } = await harness('cp-behind-none');
    const res = await send(app, 'GET', '/integrations/coinpay/behind');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: 'not_connected' });
    expect(keys).toEqual([]);
  });

  test('connect verifies the key, stores it sealed, and never returns it', async () => {
    const { app, seeded, keys } = await harness('cp-behind-connect');
    const census = async () =>
      (
        await queryAll<{ p: number; r: number }>(
          seeded.db,
          'SELECT (SELECT count(*) FROM people) AS p, (SELECT count(*) FROM recommendations) AS r',
        )
      )[0];
    const before = await census();

    const connected = await send(app, 'PUT', '/integrations/coinpay', {
      apiKey: 'cp_live_secret_key_1',
    });
    expect(connected.status).toBe(200);
    expect(keys).toEqual(['cp_live_secret_key_1']);

    const status = await (await send(app, 'GET', '/integrations/coinpay')).text();
    expect(status).not.toContain('cp_live_secret_key_1');
    expect(JSON.parse(status).connection.connected).toBe(true);

    const stored = await queryAll<{ access_token_enc: string }>(
      seeded.db,
      `SELECT access_token_enc FROM integration_accounts WHERE network = 'coinpay'`,
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]!.access_token_enc).not.toContain('cp_live_secret_key_1');

    // The verification result is cached, so Today's first load costs nothing.
    const behind = (await (
      await send(app, 'GET', '/integrations/coinpay/behind')
    ).json()) as Record<string, unknown>;
    expect(behind.state).toBe('ok');
    expect(behind.cached).toBe(true);
    expect(behind.summary).toBe(REPORT.summary);
    expect(behind.portal_url).toBe('https://coinpayportal.com');
    expect(keys).toHaveLength(1);

    // A refresh goes back to CoinPay with the decrypted key.
    const fresh = (await (
      await send(app, 'GET', '/integrations/coinpay/behind?refresh=1')
    ).json()) as Record<string, unknown>;
    expect(fresh.cached).toBeUndefined();
    expect(keys).toEqual(['cp_live_secret_key_1', 'cp_live_secret_key_1']);

    // Nothing became a prospect or a card in the outreach queue.
    expect(await census()).toEqual(before);

    const dropped = await send(app, 'DELETE', '/integrations/coinpay');
    expect(await dropped.json()).toEqual({ disconnected: true });
    expect(await (await send(app, 'GET', '/integrations/coinpay/behind')).json()).toEqual({
      state: 'not_connected',
    });
  });

  test('a refused key is a 400 and nothing is stored', async () => {
    const { app, seeded } = await harness('cp-behind-refused', { fail: 401 });
    const res = await send(app, 'PUT', '/integrations/coinpay', { apiKey: 'cp_live_bad_key_99' });
    expect(res.status).toBe(400);
    const rows = await queryAll(
      seeded.db,
      `SELECT id FROM integration_accounts WHERE network = 'coinpay'`,
    );
    expect(rows).toHaveLength(0);
  });

  test('CoinPay failing after connection is a renderable error state', async () => {
    const { app } = await harness('cp-behind-down', { fail: 502 });
    await send(app, 'PUT', '/integrations/coinpay', {
      apiKey: 'cp_live_secret_key_2',
      skipVerification: true,
    });
    const body = (await (await send(app, 'GET', '/integrations/coinpay/behind')).json()) as Record<
      string,
      unknown
    >;
    expect(body.state).toBe('error');
    expect(String(body.message)).toContain('CoinPay');
  });

  test('a locked workspace says so instead of failing', async () => {
    const vault = new TestVault({ autoUnlock: false });
    vault.provision(SEED.workspaceId); // a passphrase exists, but nobody has unlocked it
    const { app } = await harness('cp-behind-locked', { vault });
    const put = await send(app, 'PUT', '/integrations/coinpay', {
      apiKey: 'cp_live_secret_key_3',
      skipVerification: true,
    });
    expect(put.status).toBe(200);
    const body = (await (await send(app, 'GET', '/integrations/coinpay/behind')).json()) as Record<
      string,
      unknown
    >;
    expect(body.state).toBe('locked');
  });

  test('a viewer can neither see the report nor connect', async () => {
    const { app } = await harness('cp-behind-viewer', { actor: { ...OWNER, role: 'viewer' } });
    expect((await send(app, 'GET', '/integrations/coinpay/behind')).status).toBe(403);
    expect(
      (await send(app, 'PUT', '/integrations/coinpay', { apiKey: 'cp_live_secret_key_4' })).status,
    ).toBe(403);
  });

  test('a missing key is a 400', async () => {
    const { app } = await harness('cp-behind-nokey');
    expect((await send(app, 'PUT', '/integrations/coinpay', {})).status).toBe(400);
  });
});
