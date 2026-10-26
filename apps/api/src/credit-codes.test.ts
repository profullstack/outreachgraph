import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { Message } from '@outreachgraph/email';
import { createTestDatabase, openRawHandle, queryAll, queryOne } from '@outreachgraph/db';
import { creditsFor } from '@outreachgraph/pipeline';
import { createApp } from './app';
import type { AppEnv } from './context';
import { SESSION_COOKIE } from './auth';
import {
  codeServicesFor,
  memoryCodeServices,
  mintCreditCode,
  redeemCreditCode,
  type CodeServices,
} from './credit-codes';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  active?.cleanup();
  active = undefined;
  for (const close of closers.splice(0)) await close();
});

const SERVICE_TOKEN = 'a'.repeat(64);

function harness(seeded: SeededDatabase, codes: CodeServices) {
  const sent: Message[] = [];
  const app = createApp({
    db: seeded.db,
    secureCookies: false,
    codes,
    serviceToken: SERVICE_TOKEN,
    appUrl: 'https://og.test',
    mailer: {
      send: async (message) => {
        sent.push(message);
        return {};
      },
    },
  });
  return { app, sent };
}

function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** A session for the seeded, verified owner of org_test. */
async function seededSession(seeded: SeededDatabase): Promise<string> {
  const { login, hashPassword } = await import('./auth');
  await seeded.db.execute({
    sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
    args: [await hashPassword('correct horse battery staple'), SEED.userId],
  });
  const session = await login(seeded.db, 'test@example.com', 'correct horse battery staple');
  return `${SESSION_COOKIE}=${session.token}`;
}

const service = {
  authorization: `Bearer ${SERVICE_TOKEN}`,
  'x-workspace-id': SEED.workspaceId,
  'x-organization-id': SEED.organizationId,
};

describe('credit codes', () => {
  test('a minted code grants prospect credits into credit_ledger, once', async () => {
    const seeded = await seedDatabase('codes-redeem');
    active = seeded;
    const { app } = harness(seeded, memoryCodeServices());

    const minted = await call(
      app,
      'POST',
      '/admin/credit-codes',
      { prospects: 100, label: 'Ada' },
      service,
    );
    expect(minted.status).toBe(201);
    const { code } = (await minted.json()) as { code: string };
    expect(code).toMatch(/^OG-/);

    const cookie = await seededSession(seeded);
    const first = await call(
      app,
      'POST',
      '/credits/redeem',
      { code: code.toLowerCase() },
      { cookie },
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, prospects: 100, remaining: 100 });

    const again = await call(app, 'POST', '/credits/redeem', { code }, { cookie });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
      'already_redeemed',
    );

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(100);
    const rows = await queryAll<{ payment_id: string; kind: string }>(
      seeded.db,
      'SELECT payment_id, kind FROM credit_ledger WHERE organization_id = ?',
      [SEED.organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payment_id).toMatch(new RegExp(`^code:.+:${SEED.userId}$`));

    // /billing reads the same ledger.
    const billing = await call(app, 'GET', '/billing', undefined, { cookie });
    expect(((await billing.json()) as { credits: { remaining: number } }).credits.remaining).toBe(
      100,
    );
  });

  test('unknown, used-up and revoked codes are refused with a reason', async () => {
    const seeded = await seedDatabase('codes-refused');
    active = seeded;
    const codes = memoryCodeServices();
    const { app } = harness(seeded, codes);
    const cookie = await seededSession(seeded);

    const unknown = await call(
      app,
      'POST',
      '/credits/redeem',
      { code: 'OG-AAAA-BBBB-CCCC-DDDD' },
      { cookie },
    );
    expect(unknown.status).toBe(404);

    const revoked = await mintCreditCode(codes, { prospects: 5, label: 'x' });
    const r = await call(app, 'POST', `/admin/credit-codes/${revoked.id}/revoke`, {}, service);
    expect(r.status).toBe(200);
    const refused = await call(app, 'POST', '/credits/redeem', { code: revoked.code }, { cookie });
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('revoked');
  });

  test('only the service token mints; a session cannot', async () => {
    const seeded = await seedDatabase('codes-mint-guard');
    active = seeded;
    const { app } = harness(seeded, memoryCodeServices());
    const cookie = await seededSession(seeded);
    const response = await call(app, 'POST', '/admin/credit-codes', { prospects: 100 }, { cookie });
    expect(response.status).toBe(403);
  });

  test('a lost ledger write is repaired on the next attempt', async () => {
    const seeded = await seedDatabase('codes-repair');
    active = seeded;
    const codes = memoryCodeServices();
    const minted = await mintCreditCode(codes, { prospects: 40, label: 'x' });
    // The package records the redemption, then the ledger write "fails".
    await codes.credits.redeem(minted.code, SEED.userId);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);

    const retry = await redeemCreditCode(seeded.db, codes, {
      userId: SEED.userId,
      organizationId: SEED.organizationId,
      code: minted.code,
    });
    expect(retry.ok).toBe(false);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(40);
  });

  test('the real stores work on this database (SQLite file or Postgres)', async () => {
    const db = await createTestDatabase('codes-stores', { dir: import.meta.dir });
    const handle = openRawHandle({ url: db.url });
    closers.push(() => handle.close(), db.cleanup);
    const codes = codeServicesFor(handle);

    const minted = await mintCreditCode(codes, { prospects: 3, label: 'store' });
    expect((await codes.credits.redeem(minted.code, 'usr_a')).ok).toBe(true);
    expect(await codes.credits.redeem(minted.code, 'usr_a')).toMatchObject({
      ok: false,
      reason: 'already_redeemed',
    });
    const invite = await codes.affiliates.createInvite('usr_a');
    expect((await codes.affiliates.redeemInvite(invite.code, 'usr_b')).ok).toBe(true);
    expect(await codes.affiliates.invitedBy('usr_b')).toBe('usr_a');

    // The app's own credit_ledger is untouched by the package's tables.
    const tables = await queryOne<{ n: number }>(
      db.client,
      'SELECT count(*) AS n FROM credit_ledger',
    );
    expect(Number(tables?.n)).toBe(0);
  });
});

describe('invites', () => {
  async function inviteFromSeed(app: Hono<AppEnv>, cookie: string): Promise<string> {
    const created = await call(app, 'POST', '/invites', { note: 'for Sam' }, { cookie });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { code: string; url: string };
    expect(body.url).toBe(`https://og.test/i/${body.code}`);
    return body.code;
  }

  function tokenFrom(sent: Message[], to: string): string {
    const mail = sent.filter((m) => m.to === to).at(-1);
    return mail?.text.match(/token=([a-f0-9]+)/)?.[1] ?? '';
  }

  test('an accepted invite pays both sides once the address is confirmed, once', async () => {
    const seeded = await seedDatabase('invites-bonus');
    active = seeded;
    const codes = memoryCodeServices({ inviteBonus: 25, inviterMinAgeHours: 0 });
    const { app, sent } = harness(seeded, codes);
    const cookie = await seededSession(seeded);
    const code = await inviteFromSeed(app, cookie);

    // The invite rides in the /i/<code> cookie; verification happens elsewhere.
    const register = await call(
      app,
      'POST',
      '/auth/register',
      {
        email: 'sam@example.org',
        password: 'correct horse battery staple',
        first_name: 'Sam',
        last_name: 'Lee',
      },
      { cookie: `og_invite=${code}` },
    );
    expect(register.status).toBe(201);
    const { userId } = (await register.json()) as { userId: string };
    expect(await codes.affiliates.invitedBy(userId)).toBe(SEED.userId);

    // Not confirmed yet: nothing paid.
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);

    const token = tokenFrom(sent, 'sam@example.org');
    expect((await call(app, 'POST', '/auth/verify', { token })).status).toBe(200);

    const inviteeOrg = await queryOne<{ organization_id: string }>(
      seeded.db,
      'SELECT organization_id FROM organization_members WHERE user_id = ?',
      [userId],
    );
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(25);
    expect((await creditsFor(seeded.db, inviteeOrg!.organization_id)).remaining).toBe(25);

    // A replayed verification pays nothing more.
    await call(app, 'POST', '/auth/verify', { token });
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(25);

    // The invite is spent.
    const other = await call(app, 'POST', '/auth/register', {
      email: 'kim@example.org',
      password: 'correct horse battery staple',
      first_name: 'Kim',
      last_name: 'Park',
      invite: code,
    });
    const kim = (await other.json()) as { userId: string };
    expect(await codes.affiliates.invitedBy(kim.userId)).toBeNull();

    const summary = await call(app, 'GET', '/invites', undefined, { cookie });
    expect(await summary.json()).toMatchObject({
      quota: { total: 3, used: 1, left: 2 },
      invitedCount: 1,
      bonusProspects: 25,
    });
  });

  test('no bonus for the same mailbox, a throwaway domain, or a brand-new inviter', async () => {
    const cases: [string, string, number, string][] = [
      ['same', 'Test+alt@Example.com', 0, 'same_mailbox'],
      ['throwaway', 'sam@mailinator.com', 0, 'disposable_domain'],
      ['young', 'sam@example.org', 24, 'inviter_too_new'],
    ];
    for (const [label, email, minAge, status] of cases) {
      const seeded = await seedDatabase(`invites-${label}`);
      active = seeded;
      const codes = memoryCodeServices({ inviteBonus: 25, inviterMinAgeHours: minAge });
      const { app, sent } = harness(seeded, codes);
      const cookie = await seededSession(seeded);
      const code = await inviteFromSeed(app, cookie);

      await call(app, 'POST', '/auth/register', {
        email,
        password: 'correct horse battery staple',
        first_name: 'Sam',
        last_name: 'Lee',
        invite: code,
      });
      await call(app, 'POST', '/auth/verify', { token: tokenFrom(sent, email) });

      const row = await queryOne<{ status: string }>(
        seeded.db,
        'SELECT status FROM invite_bonuses',
      );
      expect(row?.status).toBe(status);
      expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(0);
      seeded.cleanup();
      active = undefined;
    }
  });

  test('the quota is three, then 409', async () => {
    const seeded = await seedDatabase('invites-quota');
    active = seeded;
    const { app } = harness(seeded, memoryCodeServices());
    const cookie = await seededSession(seeded);
    for (let i = 0; i < 3; i++) {
      expect((await call(app, 'POST', '/invites', {}, { cookie })).status).toBe(201);
    }
    expect((await call(app, 'POST', '/invites', {}, { cookie })).status).toBe(409);
  });

  test('a ?ref= code is recorded first-touch at signup', async () => {
    const seeded = await seedDatabase('invites-ref');
    active = seeded;
    const codes = memoryCodeServices();
    const { app } = harness(seeded, codes);
    const ref = await codes.affiliates.affiliateCode(SEED.userId);

    const register = await call(
      app,
      'POST',
      '/auth/register',
      {
        email: 'y@example.org',
        password: 'correct horse battery staple',
        first_name: 'Y',
        last_name: 'Z',
      },
      { cookie: `referral_code=${ref}` },
    );
    const { userId } = (await register.json()) as { userId: string };
    expect(await codes.affiliates.affiliateOf(userId)).toBe(SEED.userId);
  });
});
