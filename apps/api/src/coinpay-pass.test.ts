import { afterEach, describe, expect, test } from 'bun:test';
import { passFromUserinfo } from '@profullstack/coinpay-onboard/pass';
import { creditsFor } from '@outreachgraph/pipeline';
import { CREDIT_PACKS } from '@outreachgraph/domain';
import { applyCoinpayPass, grantCoinpayPass, passPaymentId, PASS_CREDITS } from './coinpay-pass';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const DAY = 86_400_000;
const inDays = (d: number) => new Date(Date.now() + d * DAY).toISOString();
const claim = (pass: unknown) => passFromUserinfo({ pass });

describe('Profullstack Pass', () => {
  test('grants the smallest pack', () => {
    expect(PASS_CREDITS).toBe(Math.min(...CREDIT_PACKS.map((p) => p.credits)));
    expect(PASS_CREDITS).toBe(100);
  });

  test('only an active, unexpired pass has a key', () => {
    const end = inDays(30);
    expect(passPaymentId('sub1', claim({ active: true, expires_at: end }))).toBe(
      `coinpay-pass:sub1:${new Date(end).toISOString()}`,
    );
    expect(passPaymentId('sub1', claim({ active: false, expires_at: end }))).toBeNull();
    expect(passPaymentId('sub1', claim({ active: true, expires_at: 'x' }))).toBeNull();
    expect(passPaymentId('sub1', claim({ active: true, expires_at: inDays(-1) }))).toBeNull();
    expect(passPaymentId('', claim({ active: true, expires_at: end }))).toBeNull();
  });

  test('credits the home organization once per pass', async () => {
    const seeded = await seedDatabase('coinpay-pass');
    active = seeded;
    const before = (await creditsFor(seeded.db, SEED.organizationId)).remaining;
    const pass = claim({ active: true, expires_at: inDays(30) });

    const first = await grantCoinpayPass(seeded.db, SEED.userId, 'sub-pass', pass);
    expect(first).toEqual({
      granted: true,
      organizationId: SEED.organizationId,
      credits: PASS_CREDITS,
    });
    const again = await applyCoinpayPass(seeded.db, SEED.userId, { sub: 'sub-pass', pass });
    expect(again).toEqual({ granted: false, reason: 'already_granted' });
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(
      before + PASS_CREDITS,
    );

    const next = claim({ active: true, expires_at: inDays(60) });
    expect((await grantCoinpayPass(seeded.db, SEED.userId, 'sub-pass', next)).granted).toBe(true);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(
      before + 2 * PASS_CREDITS,
    );
  });

  test('no pass, or no organization, grants nothing', async () => {
    const seeded = await seedDatabase('coinpay-pass-none');
    active = seeded;
    expect(await applyCoinpayPass(seeded.db, SEED.userId, { sub: 's' })).toBeNull();
    const pass = claim({ active: true, expires_at: inDays(30) });
    expect(await grantCoinpayPass(seeded.db, 'usr_nobody', 's', pass)).toEqual({
      granted: false,
      reason: 'no_organization',
    });
  });
});
