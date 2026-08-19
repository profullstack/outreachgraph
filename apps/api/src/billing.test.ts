/**
 * Checkout and the webhook behind it.
 *
 * The signature tests are the point of this file. Everything else here fails
 * loudly when it breaks; a webhook that accepts an unsigned body fails
 * silently, in the direction of giving away the product, and only to somebody
 * who went looking.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { BLOCKCHAINS, CoinPayClient } from '@outreachgraph/payments';
import { creditsFor } from '@outreachgraph/pipeline';
import { queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import {
  billingOverview,
  handleCoinPayWebhook,
  startCreditPurchase,
  BillingError,
} from './billing';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const SECRET = 'whsec_test_secret';

function client(): CoinPayClient {
  return new CoinPayClient({
    apiKey: 'key',
    businessId: 'biz',
    webhookSecret: SECRET,
  });
}

/** Signs a body the way CoinPayPortal does: `t=<unix>,v1=<hex hmac of t.body>`. */
async function sign(body: string, atSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${atSeconds}.${body}`),
  );

  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `t=${atSeconds},v1=${hex}`;
}

function confirmedBody(paymentId: string): string {
  return JSON.stringify({
    id: 'evt_1',
    type: 'payment.confirmed',
    business_id: 'biz',
    created_at: new Date().toISOString(),
    data: { payment_id: paymentId, amount_usd: '59', status: 'confirmed' },
  });
}

/** A client whose `createPayment` does not reach the network. */
function stubbedClient(paymentId = 'pay_stub'): CoinPayClient {
  const stub = client();

  stub.createPayment = async () => ({
    paymentId,
    paymentUrl: `https://coinpayportal.com/pay/${paymentId}`,
    paymentAddress: 'bc1qexample',
    cryptoAmount: '0.0009',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: 'pending',
  });

  return stub;
}

async function purchase(db: SeededDatabase['db'], paymentId = 'pay_stub'): Promise<string> {
  const result = await startCreditPurchase(db, stubbedClient(paymentId), {
    organizationId: SEED.organizationId,
    workspaceId: SEED.workspaceId,
    userId: SEED.userId,
    packId: 'pack_500',
    blockchain: 'BTC',
    appUrl: 'https://outreachgraph.com',
  });

  return result.purchaseId;
}

describe('startCreditPurchase', () => {
  test('records the purchase and returns a checkout url', async () => {
    seeded = await seedDatabase('billing-start');

    const result = await startCreditPurchase(seeded.db, stubbedClient(), {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      userId: SEED.userId,
      packId: 'pack_500',
      blockchain: 'BTC',
      appUrl: 'https://outreachgraph.com',
    });

    expect(result.paymentUrl).toContain('coinpayportal.com/pay/');
    expect(result.pack.credits).toBe(500);

    const row = await queryOne<{ status: string; credits: number }>(
      seeded.db,
      'SELECT status, credits FROM credit_purchases WHERE id = ?',
      [result.purchaseId],
    );

    // Pending, and crucially not yet credited.
    expect(row?.status).toBe('pending');
    expect(row?.credits).toBe(500);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);
  });

  test('refuses a pack that does not exist', async () => {
    seeded = await seedDatabase('billing-badpack');

    await expect(
      startCreditPurchase(seeded.db, stubbedClient(), {
        organizationId: SEED.organizationId,
        workspaceId: SEED.workspaceId,
        userId: SEED.userId,
        packId: 'pack_free_please',
        blockchain: 'BTC',
        appUrl: 'https://outreachgraph.com',
      }),
    ).rejects.toThrow(BillingError);
  });

  test('refuses a chain CoinPayPortal would reject at checkout', async () => {
    seeded = await seedDatabase('billing-badchain');

    await expect(
      startCreditPurchase(seeded.db, stubbedClient(), {
        organizationId: SEED.organizationId,
        workspaceId: SEED.workspaceId,
        userId: SEED.userId,
        packId: 'pack_500',
        blockchain: 'NOT_A_CHAIN',
        appUrl: 'https://outreachgraph.com',
      }),
    ).rejects.toThrow(BillingError);
  });

  test('refuses a chain name where a ticker code is required', async () => {
    // The bug this pins. CoinPayPortal upper-cases and matches, so "bitcoin"
    // becomes "BITCOIN", matches nothing, and is refused *after* the API key
    // has been accepted — a 400 that looks exactly like a credentials fault.
    seeded = await seedDatabase('billing-chainname');

    await expect(
      startCreditPurchase(seeded.db, stubbedClient(), {
        organizationId: SEED.organizationId,
        workspaceId: SEED.workspaceId,
        userId: SEED.userId,
        packId: 'pack_500',
        blockchain: 'bitcoin',
        appUrl: 'https://outreachgraph.com',
      }),
    ).rejects.toThrow(BillingError);
  });

  test('accepts a ticker in either case and sends the canonical form', async () => {
    seeded = await seedDatabase('billing-chaincase');
    let sent: string | undefined;

    const stub = stubbedClient();
    stub.createPayment = async (input) => {
      sent = input.blockchain;
      return {
        paymentId: 'pay_case',
        paymentUrl: 'https://coinpayportal.com/pay/pay_case',
        paymentAddress: 'addr',
        cryptoAmount: '1',
        expiresAt: new Date().toISOString(),
        status: 'pending',
      };
    };

    await startCreditPurchase(seeded.db, stub, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      userId: SEED.userId,
      packId: 'pack_500',
      blockchain: 'usdc_sol',
      appUrl: 'https://outreachgraph.com',
    });

    expect(sent).toBe('USDC_SOL');
  });

  test('does not offer a chain with no wallet behind it', () => {
    // USDC_BASE is a valid code on the portal side. Offering it would produce
    // "No wallet configured for this business" at the worst moment.
    expect(BLOCKCHAINS).not.toContain('USDC_BASE' as never);
    expect(BLOCKCHAINS).toContain('USDC_SOL');
  });
});

describe('handleCoinPayWebhook', () => {
  test('credits a confirmed payment', async () => {
    seeded = await seedDatabase('billing-confirm');
    await purchase(seeded.db);

    const body = confirmedBody('pay_stub');
    const result = await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect(result.credited).toBe(true);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(500);
  });

  test('credits a redelivered confirmation exactly once', async () => {
    seeded = await seedDatabase('billing-redeliver');
    await purchase(seeded.db);

    const body = confirmedBody('pay_stub');

    await handleCoinPayWebhook(seeded.db, client(), { rawBody: body, signature: await sign(body) });
    const second = await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect(second.handled).toBe(true);
    expect(second.credited).toBe(false);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(500);
  });

  test('rejects a forged signature', async () => {
    seeded = await seedDatabase('billing-forged');
    await purchase(seeded.db);

    const body = confirmedBody('pay_stub');

    await expect(
      handleCoinPayWebhook(seeded.db, client(), {
        rawBody: body,
        signature: 't=1,v1=deadbeef',
      }),
    ).rejects.toThrow(BillingError);

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);
  });

  test('rejects an unsigned body', async () => {
    seeded = await seedDatabase('billing-unsigned');
    await purchase(seeded.db);

    await expect(
      handleCoinPayWebhook(seeded.db, client(), {
        rawBody: confirmedBody('pay_stub'),
        signature: null,
      }),
    ).rejects.toThrow(BillingError);
  });

  test('rejects a replay of a genuine payload', async () => {
    // The timestamp is inside the signed material, so an attacker cannot take
    // yesterday's real confirmation and stamp it with a fresh `t`.
    seeded = await seedDatabase('billing-replay');
    await purchase(seeded.db);

    const body = confirmedBody('pay_stub');
    const old = await sign(body, Math.floor(Date.now() / 1000) - 4000);

    await expect(
      handleCoinPayWebhook(seeded.db, client(), { rawBody: body, signature: old }),
    ).rejects.toThrow(BillingError);

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);
  });

  test('does not credit a payment that is only detected', async () => {
    // Detected means visible on chain but not yet buried. Crediting here hands
    // out prospects for a transaction a reorg can still erase.
    seeded = await seedDatabase('billing-detected');
    await purchase(seeded.db);

    const body = JSON.stringify({
      id: 'evt_2',
      type: 'payment.detected',
      business_id: 'biz',
      created_at: new Date().toISOString(),
      data: { payment_id: 'pay_stub', status: 'detected' },
    });

    const result = await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect(result.credited).toBe(false);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);

    const row = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM credit_purchases WHERE payment_id = ?',
      ['pay_stub'],
    );
    expect(row?.status).toBe('detected');
  });

  test('acknowledges a payment it never opened without crediting anyone', async () => {
    // Another product on the same CoinPayPortal business, or noise. Neither is
    // served by us retrying.
    seeded = await seedDatabase('billing-unknown');

    const body = confirmedBody('pay_someone_else');
    const result = await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect(result.handled).toBe(false);
    expect(result.credited).toBe(false);
  });

  test('credits the organization on our row, not the one in the payload', async () => {
    // Metadata arrives from outside. If it decided who got credited, anyone
    // could credit anyone.
    seeded = await seedDatabase('billing-metadata');
    await purchase(seeded.db);

    const body = JSON.stringify({
      id: 'evt_3',
      type: 'payment.confirmed',
      business_id: 'biz',
      created_at: new Date().toISOString(),
      data: {
        payment_id: 'pay_stub',
        status: 'confirmed',
        metadata: { organization_id: 'org_attacker' },
      },
    });

    await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(500);
    expect((await creditsFor(seeded.db, 'org_attacker')).remaining).toBe(0);
  });

  test('acknowledges a test webhook', async () => {
    seeded = await seedDatabase('billing-testhook');

    const body = JSON.stringify({
      id: 'evt_4',
      type: 'test.webhook',
      business_id: 'biz',
      created_at: new Date().toISOString(),
      data: { payment_id: '' },
    });

    const result = await handleCoinPayWebhook(seeded.db, client(), {
      rawBody: body,
      signature: await sign(body),
    });

    expect(result.handled).toBe(true);
    expect(result.credited).toBe(false);
  });
});

describe('billingOverview', () => {
  test('reports the packs, the balance and what was bought', async () => {
    seeded = await seedDatabase('billing-overview');
    await purchase(seeded.db);

    const overview = await billingOverview(seeded.db, { organizationId: SEED.organizationId });

    expect(overview.packs.length).toBeGreaterThan(0);
    expect(overview.credits.remaining).toBe(0);
    expect(overview.purchases).toHaveLength(1);
    expect(overview.purchases[0]?.status).toBe('pending');
  });
});
