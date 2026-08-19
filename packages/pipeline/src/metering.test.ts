/**
 * The meter, and the gate it finally populates.
 *
 * `budget_exhausted` has been implemented in the policy engine since the first
 * version and nothing ever set it, so it protected nothing. These tests are
 * mostly about the counting being right, because a meter that is wrong in the
 * permissive direction is invisible until an invoice or a blocklist arrives.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  newId,
  checkGridQuota,
  checkProspectQuota,
  periodStart,
  planById,
} from '@outreachgraph/domain';
import { now, type Client } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { budgetStatus, planFor, recordResearchUsage, usageFor } from './metering';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const AT = new Date('2026-08-18T12:00:00.000Z');

async function contacted(
  db: Client,
  personId: string,
  at: string = AT.toISOString(),
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
          state, occurred_at, recorded_at)
          VALUES (?, ?, ?, 'email', 'outbound', 'contacted', ?, ?)`,
    args: [newId('interaction'), SEED.workspaceId, personId, at, now()],
  });
}

async function person(db: Client, id: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO people (id, display_name, status, identity_confidence, created_at, updated_at)
          VALUES (?, ?, 'qualified', 0.9, ?, ?)`,
    args: [id, `Person ${id}`, now(), now()],
  });
}

async function onPlan(db: Client, plan: string, status = 'active'): Promise<void> {
  await db.execute({
    sql: `INSERT INTO billing_accounts (id, organization_id, plan, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [newId('usageEvent'), SEED.organizationId, plan, status, now(), now()],
  });
}

async function staff(db: Client, userId: string): Promise<void> {
  await db.execute({ sql: `UPDATE users SET is_admin = 1 WHERE id = ?`, args: [userId] });
}

describe('periodStart', () => {
  test('is the first instant of the calendar month, in UTC', () => {
    expect(periodStart(AT).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('usageFor', () => {
  test('counts a prospect once however often they were contacted', async () => {
    // This is what makes a cadence's later steps free, and stops the meter
    // punishing the follow-up that actually works.
    seeded = await seedDatabase('meter-distinct');
    const { db } = seeded;

    await contacted(db, SEED.personId);
    await contacted(db, SEED.personId);
    await contacted(db, SEED.personId);

    expect((await usageFor(db, SEED.workspaceId, AT)).prospectsContacted).toBe(1);
  });

  test('counts distinct prospects', async () => {
    seeded = await seedDatabase('meter-several');
    const { db } = seeded;

    await person(db, 'per_two');
    await contacted(db, SEED.personId);
    await contacted(db, 'per_two');

    expect((await usageFor(db, SEED.workspaceId, AT)).prospectsContacted).toBe(2);
  });

  test('ignores last month', async () => {
    seeded = await seedDatabase('meter-lastmonth');
    const { db } = seeded;

    await contacted(db, SEED.personId, '2026-07-30T12:00:00.000Z');

    expect((await usageFor(db, SEED.workspaceId, AT)).prospectsContacted).toBe(0);
  });

  test('ignores inbound interactions', async () => {
    // A reply is not something we spent an allowance on.
    seeded = await seedDatabase('meter-inbound');
    const { db } = seeded;

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
            state, occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, AT.toISOString(), now()],
    });

    expect((await usageFor(db, SEED.workspaceId, AT)).prospectsContacted).toBe(0);
  });

  test('does not count another workspace', async () => {
    seeded = await seedDatabase('meter-isolation');
    await contacted(seeded.db, SEED.personId);

    expect((await usageFor(seeded.db, 'wsp_other', AT)).prospectsContacted).toBe(0);
  });

  test('counts research cells separately from prospects', async () => {
    seeded = await seedDatabase('meter-cells');
    const { db } = seeded;

    await recordResearchUsage(db, {
      workspaceId: SEED.workspaceId,
      cells: 12,
      at: AT.toISOString(),
    });
    await recordResearchUsage(db, {
      workspaceId: SEED.workspaceId,
      cells: 8,
      at: AT.toISOString(),
    });

    const usage = await usageFor(db, SEED.workspaceId, AT);
    expect(usage.gridCells).toBe(20);
    expect(usage.prospectsContacted).toBe(0);
  });

  test('records nothing for a zero-cell run', async () => {
    seeded = await seedDatabase('meter-zerocells');
    await recordResearchUsage(seeded.db, { workspaceId: SEED.workspaceId, cells: 0 });

    expect((await usageFor(seeded.db, SEED.workspaceId, AT)).gridCells).toBe(0);
  });
});

describe('planFor', () => {
  test('treats a workspace with no billing account as free', async () => {
    // Not unlimited. A workspace that predates billing must not be the one
    // that can send without limit.
    seeded = await seedDatabase('meter-noplan');

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('free');
  });

  test('reads the plan from the organization', async () => {
    seeded = await seedDatabase('meter-plan');
    await onPlan(seeded.db, 'pro');

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('pro');
  });

  test('degrades a past-due account to free rather than cutting it off', async () => {
    seeded = await seedDatabase('meter-pastdue');
    await onPlan(seeded.db, 'pro', 'past_due');

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('free');
  });

  test('treats an unrecognised plan as free', async () => {
    seeded = await seedDatabase('meter-typo');
    await onPlan(seeded.db, 'enterprise-plus-ultra');

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('free');
  });

  test('never resolves a billing row into the admin plan', async () => {
    // The reason 'admin' is not in PLAN_IDS. A customer row whose plan column
    // said 'admin' — a typo, a bad import, someone reaching the database —
    // must be free rather than unlimited.
    seeded = await seedDatabase('meter-plan-admin');
    await onPlan(seeded.db, 'admin');

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('free');
  });

  test('exempts an organization owned by platform staff', async () => {
    seeded = await seedDatabase('meter-staff');
    await staff(seeded.db, SEED.userId);

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('admin');
  });

  test('staff ownership outranks the billing row', async () => {
    // Our own organizations do carry a billing row; the flag has to win, or
    // the exemption depends on us remembering not to bill ourselves.
    seeded = await seedDatabase('meter-staff-billed');
    await onPlan(seeded.db, 'free');
    await staff(seeded.db, SEED.userId);

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('admin');
  });

  test('a staff account merely invited to a customer org exempts nothing', async () => {
    // The exemption exists so we do not meter ourselves. It must not leak onto
    // whichever customer we last helped debug something.
    seeded = await seedDatabase('meter-staff-guest');
    const guest = newId('user');
    await seeded.db.execute({
      sql: `INSERT INTO users (id, email, name, is_admin, created_at, updated_at)
            VALUES (?, 'staff@outreachgraph.com', 'Support', 1, ?, ?)`,
      args: [guest, now(), now()],
    });
    await seeded.db.execute({
      sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
            VALUES (?, ?, 'member', ?)`,
      args: [SEED.organizationId, guest, now()],
    });

    expect((await planFor(seeded.db, SEED.workspaceId)).id).toBe('free');
  });
});

describe('budgetStatus', () => {
  test('is not exhausted below the allowance', async () => {
    seeded = await seedDatabase('meter-ok');
    await contacted(seeded.db, SEED.personId);

    expect((await budgetStatus(seeded.db, SEED.workspaceId, AT)).exhausted).toBe(false);
  });

  test('is exhausted at the allowance, and says why', async () => {
    seeded = await seedDatabase('meter-exhausted');
    const { db } = seeded;

    const free = planById('free');
    for (let index = 0; index < free.prospectsPerMonth; index += 1) {
      const id = `per_bulk_${index}`;
      await person(db, id);
      await contacted(db, id);
    }

    const status = await budgetStatus(db, SEED.workspaceId, AT);

    expect(status.exhausted).toBe(true);
    expect(status.reason).toContain('25');
  });

  test('is never exhausted for platform staff, past any ceiling', async () => {
    // The reported symptom: an owner watching their own approvals queue refuse
    // every card with "The campaign budget is exhausted."
    seeded = await seedDatabase('meter-staff-budget');
    const { db } = seeded;

    const free = planById('free');
    for (let index = 0; index < free.prospectsPerMonth + 5; index += 1) {
      const id = `per_staff_${index}`;
      await person(db, id);
      await contacted(db, id);
    }

    expect((await budgetStatus(db, SEED.workspaceId, AT)).exhausted).toBe(true);

    await staff(db, SEED.userId);
    const status = await budgetStatus(db, SEED.workspaceId, AT);

    expect(status.exhausted).toBe(false);
    expect(status.reason).toBeUndefined();
    // The usage is still counted. An exempt account is one that is not
    // refused, not one that stops being measured.
    expect(status.usage.prospectsContacted).toBe(free.prospectsPerMonth + 5);
  });
});

describe('quota arithmetic', () => {
  test('a prospect quota reports what is left', () => {
    const verdict = checkProspectQuota(planById('solo'), { prospectsContacted: 10, gridCells: 0 });

    expect(verdict.exhausted).toBe(false);
    expect(verdict.allowed).toBe(250);
  });

  test('a grid quota accounts for the cells about to be spent', () => {
    // The refusal has to arrive before the spend, not partway through it.
    const plan = planById('free');
    const verdict = checkGridQuota(plan, { prospectsContacted: 0, gridCells: 45 }, 20);

    expect(verdict.exhausted).toBe(true);
    expect(verdict.reason).toContain('20');
  });

  test('a grid that fits is permitted', () => {
    const verdict = checkGridQuota(planById('free'), { prospectsContacted: 0, gridCells: 10 }, 20);

    expect(verdict.exhausted).toBe(false);
  });
});
