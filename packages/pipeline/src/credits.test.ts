/**
 * The credit ledger.
 *
 * The tests that matter here are the duplicate ones. A meter that is wrong in
 * the permissive direction is invisible until an invoice arrives; a *ledger*
 * that is wrong in the permissive direction is somebody getting outreach they
 * did not pay for, twice, because a webhook was retried.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { creditBalance, creditPeriod, newId } from '@outreachgraph/domain';
import { now, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import {
  creditsFor,
  grantCredits,
  organizationFor,
  settleProspectCredits,
  spendProspectCredit,
} from './credits';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const AT = new Date('2026-08-18T12:00:00.000Z');
const PERIOD_START = '2026-08-01T00:00:00.000Z';

async function person(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO people (id, display_name, status, identity_confidence, created_at, updated_at)
          VALUES (?, ?, 'qualified', 0.9, ?, ?)`,
    args: [id, `Person ${id}`, now(), now()],
  });
}

async function contacted(db: Client, personId: string, at: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
          state, occurred_at, recorded_at)
          VALUES (?, ?, ?, 'email', 'outbound', 'contacted', ?, ?)`,
    args: [newId('interaction'), SEED.workspaceId, personId, at, now()],
  });
}

describe('creditBalance', () => {
  test('splits signed deltas into granted and spent', () => {
    expect(creditBalance([500, -1, -1, 100])).toEqual({
      granted: 600,
      spent: 2,
      remaining: 598,
    });
  });

  test('never reports a negative balance', () => {
    // Two sends racing past the last credit both succeed; the customer is not
    // shown that they owe us one prospect.
    expect(creditBalance([1, -1, -1, -1]).remaining).toBe(0);
  });
});

describe('creditPeriod', () => {
  test('is the UTC calendar month, zero padded', () => {
    expect(creditPeriod(new Date('2026-01-31T23:59:59.000Z'))).toBe('2026-01');
    expect(creditPeriod(AT)).toBe('2026-08');
  });
});

describe('grantCredits', () => {
  test('credits a confirmed payment', async () => {
    seeded = await seedDatabase('credit-grant');

    expect(
      await grantCredits(seeded.db, {
        organizationId: SEED.organizationId,
        credits: 500,
        paymentId: 'pay_abc',
      }),
    ).toBe(true);

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(500);
  });

  test('credits a retried webhook exactly once', async () => {
    // The whole reason the payment id carries a unique index.
    seeded = await seedDatabase('credit-grant-twice');

    await grantCredits(seeded.db, {
      organizationId: SEED.organizationId,
      credits: 500,
      paymentId: 'pay_abc',
    });
    const second = await grantCredits(seeded.db, {
      organizationId: SEED.organizationId,
      credits: 500,
      paymentId: 'pay_abc',
    });

    expect(second).toBe(false);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(500);
  });

  test('ignores a zero or negative grant', async () => {
    seeded = await seedDatabase('credit-grant-zero');

    expect(
      await grantCredits(seeded.db, {
        organizationId: SEED.organizationId,
        credits: 0,
        paymentId: 'pay_zero',
      }),
    ).toBe(false);
  });
});

describe('spendProspectCredit', () => {
  test('charges once per person per month', async () => {
    // Every follow-up in a cadence hits this path; only the first pays.
    seeded = await seedDatabase('credit-spend-once');
    await grantCredits(seeded.db, {
      organizationId: SEED.organizationId,
      credits: 10,
      paymentId: 'pay_spend',
    });

    const first = await spendProspectCredit(seeded.db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      at: AT,
    });
    const second = await spendProspectCredit(seeded.db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      at: AT,
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(9);
  });

  test('charges the same person again in a new month', async () => {
    seeded = await seedDatabase('credit-spend-month');
    await grantCredits(seeded.db, {
      organizationId: SEED.organizationId,
      credits: 10,
      paymentId: 'pay_month',
    });

    await spendProspectCredit(seeded.db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      at: AT,
    });
    await spendProspectCredit(seeded.db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      at: new Date('2026-09-02T00:00:00.000Z'),
    });

    expect((await creditsFor(seeded.db, SEED.organizationId)).remaining).toBe(8);
  });
});

describe('organizationFor', () => {
  test('resolves a workspace to its billing organization', async () => {
    seeded = await seedDatabase('credit-org');

    expect(await organizationFor(seeded.db, SEED.workspaceId)).toBe(SEED.organizationId);
  });

  test('is undefined for a workspace that does not exist', async () => {
    seeded = await seedDatabase('credit-org-missing');

    expect(await organizationFor(seeded.db, 'wsp_nope')).toBeUndefined();
  });
});

describe('settleProspectCredits', () => {
  test('charges nobody while the allowance covers everyone', async () => {
    seeded = await seedDatabase('credit-settle-under');
    const { db } = seeded;

    for (let index = 0; index < 5; index += 1) {
      const id = `per_u_${index}`;
      await person(db, id);
      await contacted(db, id, AT.toISOString());
    }

    const taken = await settleProspectCredits(db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      allowance: 25,
      periodStartIso: PERIOD_START,
      at: AT,
    });

    expect(taken).toBe(0);
  });

  test('charges exactly the prospects beyond the allowance', async () => {
    seeded = await seedDatabase('credit-settle-over');
    const { db } = seeded;

    // Contacted in a known order, one minute apart, so "first three are free"
    // is a statement about time rather than about row order.
    for (let index = 0; index < 8; index += 1) {
      const id = `per_o_${index}`;
      await person(db, id);
      await contacted(db, id, new Date(AT.getTime() + index * 60_000).toISOString());
    }

    const taken = await settleProspectCredits(db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      allowance: 3,
      periodStartIso: PERIOD_START,
      at: AT,
    });

    expect(taken).toBe(5);
  });

  test('is idempotent — settling twice charges once', async () => {
    // `budgetStatus` calls this on every policy check while an account is in
    // overage, so this running twice is the normal case, not the edge one.
    seeded = await seedDatabase('credit-settle-twice');
    const { db } = seeded;

    for (let index = 0; index < 6; index += 1) {
      const id = `per_t_${index}`;
      await person(db, id);
      await contacted(db, id, new Date(AT.getTime() + index * 60_000).toISOString());
    }

    const input = {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      allowance: 2,
      periodStartIso: PERIOD_START,
      at: AT,
    };

    expect(await settleProspectCredits(db, input)).toBe(4);
    expect(await settleProspectCredits(db, input)).toBe(0);
    expect((await creditsFor(db, SEED.organizationId)).spent).toBe(4);
  });

  test('charges a prospect once however often they were contacted', async () => {
    seeded = await seedDatabase('credit-settle-repeat');
    const { db } = seeded;

    for (let index = 0; index < 4; index += 1) {
      const id = `per_r_${index}`;
      await person(db, id);
      // Three touches each — a cadence, not three prospects.
      await contacted(db, id, new Date(AT.getTime() + index * 60_000).toISOString());
      await contacted(db, id, new Date(AT.getTime() + index * 60_000 + 1000).toISOString());
      await contacted(db, id, new Date(AT.getTime() + index * 60_000 + 2000).toISOString());
    }

    const taken = await settleProspectCredits(db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      allowance: 1,
      periodStartIso: PERIOD_START,
      at: AT,
    });

    expect(taken).toBe(3);
  });

  test('ignores inbound interactions', async () => {
    // A reply is not a contact, and billing for one would charge a customer
    // for their own success.
    seeded = await seedDatabase('credit-settle-inbound');
    const { db } = seeded;

    await person(db, 'per_in_1');
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
            state, occurred_at, recorded_at)
            VALUES (?, ?, 'per_in_1', 'email', 'inbound', 'replied', ?, ?)`,
      args: [newId('interaction'), SEED.workspaceId, AT.toISOString(), now()],
    });

    const taken = await settleProspectCredits(db, {
      organizationId: SEED.organizationId,
      workspaceId: SEED.workspaceId,
      allowance: 0,
      periodStartIso: PERIOD_START,
      at: AT,
    });

    expect(taken).toBe(0);
  });
});
