/**
 * The /checkout page's form against the JSON route it sits beside.
 *
 * The point of this file is one claim: for every pack, the form opens exactly
 * the CoinPay session the JSON route opens (amount, description, buyer,
 * account, metadata, return URLs). Everything after the session (the row, the
 * webhook, the grant) is the same code, so it is the session that must match.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { Order } from '@profullstack/checkout';
import { CREDIT_PACKS } from '@outreachgraph/domain';
import { CoinPayClient } from '@outreachgraph/payments';
import { queryAll, queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import {
  CHECKOUT_FORM_ACTION,
  NO_RECEIPT_EMAIL,
  createCreditCheckout,
  creditCheckoutPay,
  creditPackOptions,
} from './billing-checkout';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

type SessionBody = Record<string, unknown>;

/** A client whose `createCheckoutSession` records the body and reaches no network. */
function recordingClient(bodies: SessionBody[]): CoinPayClient {
  const stub = new CoinPayClient({ apiKey: 'key', businessId: 'biz', webhookSecret: 'whsec' });

  // Its own counter: a session id is unique per purchase, whatever the caller
  // does with the recorded bodies.
  let opened = 0;

  stub.createCheckoutSession = async (input) => {
    bodies.push(stub.checkoutSessionBody(input));
    opened += 1;
    const sessionId = `cs_test_${opened}`;
    return {
      sessionId,
      url: `https://coinpayportal.com/checkout/${sessionId}`,
      status: 'open',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  };

  return stub;
}

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
  credential: 'session',
};

function harness(
  db: SeededDatabase['db'],
  bodies: SessionBody[],
  /** null is a signed-out caller. */
  actor: RequestActor | null = OWNER,
  coinpay: CoinPayClient | undefined = recordingClient(bodies),
): Hono<AppEnv> {
  return createApp({
    db,
    secureCookies: false,
    appUrl: 'https://outreachgraph.com',
    authenticate: async () => actor ?? undefined,
    ...(coinpay ? { coinpay } : {}),
  });
}

const ORIGIN = 'https://outreachgraph.com';

function postForm(
  app: Hono<AppEnv>,
  fields: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.request(CHECKOUT_FORM_ACTION, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: ORIGIN,
      referer: `${ORIGIN}/checkout`,
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

function postJson(app: Hono<AppEnv>, packId: string) {
  return app.request('/api/v1/billing/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packId }),
  });
}

/** The purchase id is minted per purchase; everything else must be equal. */
function withoutPurchaseId(body: SessionBody): SessionBody {
  const metadata = { ...(body.metadata as Record<string, unknown>) };
  const purchaseId = String(metadata.purchase_id);
  expect(purchaseId.length).toBeGreaterThan(0);
  expect(body.success_url).toBe(`https://outreachgraph.com/billing?purchase=${purchaseId}`);
  delete metadata.purchase_id;
  return { ...body, metadata, success_url: '<success>' };
}

async function purchaseRows(db: SeededDatabase['db']) {
  return queryAll<{
    organization_id: string;
    workspace_id: string;
    user_id: string;
    pack_id: string;
    credits: number;
    amount_usd: number;
    blockchain: string;
    status: string;
  }>(
    db,
    `SELECT organization_id, workspace_id, user_id, pack_id, credits, amount_usd, blockchain, status
       FROM credit_purchases ORDER BY created_at, id`,
  );
}

describe('the option table', () => {
  test('is the credit packs: same ids, same prices, in the same order', () => {
    expect(creditPackOptions().map((o) => [o.id, o.name, o.price])).toEqual([
      ['pack_100', '100 prospects', 15],
      ['pack_500', '500 prospects', 59],
      ['pack_2000', '2,000 prospects', 199],
    ]);
    expect(creditPackOptions().map((o) => [o.id, o.price])).toEqual(
      CREDIT_PACKS.map((p) => [p.id, p.priceUsd]),
    );
  });

  test('prices each option at the pack price in cents, with no code, seats or typed amount', async () => {
    seeded = await seedDatabase('checkout-options');
    const checkout = createCreditCheckout({
      db: seeded.db,
      coinpay: recordingClient([]),
      appUrl: 'https://outreachgraph.com',
      resolveActor: async () => OWNER,
    });

    for (const pack of CREDIT_PACKS) {
      const priced = await checkout.quote({ option: pack.id, quantity: '7', code: 'FREE' });
      // A code is refused outright: this purchase has none.
      expect(priced).toEqual({ ok: false, error: 'invalid_code' });

      const plain = await checkout.quote({ option: pack.id, quantity: '7' });
      if (!plain.ok || !('quote' in plain)) throw new Error('expected a quote');
      expect(plain.quote.totalCents).toBe(pack.priceUsd * 100);
    }

    const view = checkout.view({ query: {} }) as { hasDiscount: boolean; custom: unknown };
    expect(view.hasDiscount).toBe(false);
    expect(view.custom).toBeNull();
    expect(await checkout.quote({ option: 'custom', amount: '1' })).toEqual({
      ok: false,
      error: 'invalid_option',
    });
  });
});

describe('POST /api/v1/billing/checkout/form', () => {
  test('opens the same CoinPay session as the JSON route, for every pack', async () => {
    seeded = await seedDatabase('checkout-parity');
    const bodies: SessionBody[] = [];
    const app = harness(seeded.db, bodies);

    for (const pack of CREDIT_PACKS) {
      bodies.length = 0;

      const json = await postJson(app, pack.id);
      expect(json.status).toBe(201);

      const form = await postForm(app, { option: pack.id, source: 'billing' });
      expect(form.status).toBe(303);
      expect(form.headers.get('location')).toMatch(
        /^https:\/\/coinpayportal\.com\/checkout\/cs_test_\d+$/,
      );

      expect(bodies).toHaveLength(2);
      const [fromJson, fromForm] = bodies as [SessionBody, SessionBody];
      expect(fromForm.amount).toBe(pack.priceUsd);
      expect(fromForm.description).toBe(`OutreachGraph: ${pack.name}`);
      expect(fromForm.account_id).toBe(SEED.userId);
      expect(fromForm.cancel_url).toBe('https://outreachgraph.com/billing');
      expect(withoutPurchaseId(fromForm)).toEqual(withoutPurchaseId(fromJson));
    }

    // And the same rows: two per pack, identical but for their ids.
    const rows = await purchaseRows(seeded.db);
    expect(rows).toHaveLength(CREDIT_PACKS.length * 2);
    for (const pack of CREDIT_PACKS) {
      const mine = rows.filter((r) => r.pack_id === pack.id);
      expect(mine).toHaveLength(2);
      expect(mine[0]).toEqual(mine[1]!);
      expect(Number(mine[0]!.amount_usd)).toBe(pack.priceUsd);
      expect(Number(mine[0]!.credits)).toBe(pack.credits);
      expect(mine[0]!.status).toBe('pending');
    }

    const audits = await queryOne<{ n: number }>(
      seeded.db,
      `SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'billing.checkout_started'`,
    );
    expect(Number(audits?.n)).toBe(CREDIT_PACKS.length * 2);
  });

  test('takes the buyer from the session, never from the form', async () => {
    seeded = await seedDatabase('checkout-account');
    const bodies: SessionBody[] = [];
    const app = harness(seeded.db, bodies);

    const response = await postForm(app, {
      option: 'pack_100',
      email: 'someone-else@example.com',
      account_id: 'usr_other',
      organization_id: 'org_other',
      amount: '1',
      quantity: '50',
    });

    expect(response.status).toBe(303);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.amount).toBe(15);
    expect(bodies[0]!.account_id).toBe(SEED.userId);
    expect(bodies[0]!.customer_email).toBe('test@example.com');
    expect((bodies[0]!.metadata as Record<string, string>).organization_id).toBe(
      SEED.organizationId,
    );
  });

  test('sends a signed-out browser to sign in and back, and opens nothing', async () => {
    seeded = await seedDatabase('checkout-signedout');
    const bodies: SessionBody[] = [];
    const app = harness(seeded.db, bodies, null);

    const response = await postForm(app, { option: 'pack_500', source: 'billing' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `/login?next=${encodeURIComponent('/checkout?option=pack_500&source=billing')}`,
    );
    expect(bodies).toHaveLength(0);
    expect(await purchaseRows(seeded.db)).toHaveLength(0);
  });

  test('refuses a form posted from another site', async () => {
    seeded = await seedDatabase('checkout-origin');
    const bodies: SessionBody[] = [];
    const app = harness(seeded.db, bodies);

    const response = await postForm(
      app,
      { option: 'pack_500' },
      { origin: 'https://evil.example', referer: 'https://evil.example/x' },
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=bad_origin');
    expect(bodies).toHaveLength(0);

    const asJson = await postForm(
      app,
      { option: 'pack_500' },
      { origin: 'https://evil.example', accept: 'application/json' },
    );
    expect(asJson.status).toBe(403);
    expect(bodies).toHaveLength(0);
    expect(await purchaseRows(seeded.db)).toHaveLength(0);
  });

  test('refuses a pack that is not on sale', async () => {
    seeded = await seedDatabase('checkout-badpack');
    const bodies: SessionBody[] = [];
    const app = harness(seeded.db, bodies);

    const response = await postForm(app, { option: 'pack_free_please' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=invalid_option');
    expect(bodies).toHaveLength(0);
  });

  test('only an owner or admin can buy, as on the JSON route', async () => {
    seeded = await seedDatabase('checkout-role');
    const bodies: SessionBody[] = [];

    for (const role of ['member', 'viewer'] as const) {
      const app = harness(seeded.db, bodies, { ...OWNER, role });
      const response = await postForm(app, { option: 'pack_100' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(
        '/checkout?option=pack_100&error=owner_or_admin',
      );
      expect((await postJson(app, 'pack_100')).status).toBe(403);
    }
    expect(bodies).toHaveLength(0);

    const admin = harness(seeded.db, bodies, { ...OWNER, role: 'admin' });
    expect((await postForm(admin, { option: 'pack_100' })).status).toBe(303);
    expect(bodies).toHaveLength(1);
  });

  test('says so when the deployment cannot take payments', async () => {
    seeded = await seedDatabase('checkout-unconfigured');
    const app = createApp({
      db: seeded.db,
      secureCookies: false,
      authenticate: async () => OWNER,
    });

    const response = await postForm(app, { option: 'pack_100' });
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=payments_unconfigured');
  });
});

describe('creditCheckoutPay', () => {
  function order(over: Partial<Order> = {}): Order {
    return {
      site: 'OutreachGraph',
      option: { id: 'pack_500', name: '500 prospects', kind: 'once', months: 0 },
      audience: '',
      quantity: 1,
      code: '',
      source: '',
      currency: 'USD',
      unitCents: 5900,
      subtotalCents: 5900,
      discountCents: 0,
      totalCents: 5900,
      amount: 59,
      account: { id: SEED.userId, email: '', actor: OWNER },
      description: 'OutreachGraph: 500 prospects',
      ...over,
    };
  }

  test('refuses when the order total is not the pack price, before opening anything', async () => {
    seeded = await seedDatabase('checkout-mismatch');
    const bodies: SessionBody[] = [];
    const pay = creditCheckoutPay({
      db: seeded.db,
      coinpay: recordingClient(bodies),
      appUrl: 'https://outreachgraph.com',
      resolveActor: async () => OWNER,
    });

    await expect(pay(order({ totalCents: 100 }))).rejects.toThrow(/does not match pack_500/);
    await expect(pay(order({ totalCents: 5899 }))).rejects.toThrow(/does not match/);
    await expect(pay(order({ quantity: 2, totalCents: 11800 }))).rejects.toThrow(/does not match/);
    await expect(pay(order({ account: { id: SEED.userId, email: '' } }))).rejects.toThrow(
      /no signed-in actor/,
    );
    expect(bodies).toHaveLength(0);
    expect(await purchaseRows(seeded.db)).toHaveLength(0);

    const opened = await pay(order());
    expect(opened.url).toBe('https://coinpayportal.com/checkout/cs_test_1');
    expect(bodies[0]!.amount).toBe(59);
  });

  test('names the missing receipt email rather than a generic failure', async () => {
    seeded = await seedDatabase('checkout-noemail');
    await seeded.db.execute({
      sql: `UPDATE users SET email = '' WHERE id = ?`,
      args: [SEED.userId],
    });
    const pay = creditCheckoutPay({
      db: seeded.db,
      coinpay: recordingClient([]),
      appUrl: 'https://outreachgraph.com',
      resolveActor: async () => OWNER,
    });

    await expect(pay(order())).rejects.toMatchObject({
      code: 'no_receipt_email',
      message: NO_RECEIPT_EMAIL,
    });
  });
});

describe('GET /api/v1/billing/checkout/view', () => {
  test('is the packs with the linked one selected, for the signed-in buyer', async () => {
    seeded = await seedDatabase('checkout-view');
    const app = harness(seeded.db, []);

    const response = await app.request(
      '/api/v1/billing/checkout/view?option=pack_2000&email=x@example.com',
    );
    expect(response.status).toBe(200);

    const { view } = (await response.json()) as {
      view: {
        action: string;
        selected: string;
        total: string;
        closed: string;
        needsSignIn: boolean;
        account: { email: string };
        email: string;
        notes: string[];
        options: { id: string; chargeCents: number }[];
      };
    };

    expect(view.action).toBe(CHECKOUT_FORM_ACTION);
    expect(view.selected).toBe('pack_2000');
    expect(view.total).toBe('USD 199.00');
    expect(view.closed).toBe('');
    expect(view.needsSignIn).toBe(false);
    expect(view.account.email).toBe('test@example.com');
    expect(view.email).toBe('');
    expect(view.notes).toEqual(['Credits: 0']);
    expect(view.options.map((o) => [o.id, o.chargeCents])).toEqual([
      ['pack_100', 1500],
      ['pack_500', 5900],
      ['pack_2000', 19900],
    ]);
  });

  test('is closed to a member, and where nothing is for sale', async () => {
    seeded = await seedDatabase('checkout-view-closed');

    const member = harness(seeded.db, [], { ...OWNER, role: 'member' });
    const asMember = (await (await member.request('/api/v1/billing/checkout/view')).json()) as {
      view: { closed: string };
    };
    expect(asMember.view.closed).toBe('Only an owner or admin can buy credits.');

    const unconfigured = createApp({
      db: seeded.db,
      secureCookies: false,
      authenticate: async () => OWNER,
    });
    const none = (await (await unconfigured.request('/api/v1/billing/checkout/view')).json()) as {
      view: { closed: string };
    };
    expect(none.view.closed).toContain('credits are not for sale here');
  });

  test('needs a session', async () => {
    seeded = await seedDatabase('checkout-view-auth');
    const app = harness(seeded.db, [], null);
    expect((await app.request('/api/v1/billing/checkout/view')).status).toBe(401);
  });
});
