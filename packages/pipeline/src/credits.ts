/**
 * Reading and writing the credit ledger.
 *
 * The balance is `sum(delta)`, never a stored number. That is the same choice
 * `metering.ts` makes about usage and for the same reason: a counter that is
 * incremented is a counter that eventually disagrees with the events behind
 * it, and the disagreement is silent because nothing recomputes it.
 *
 * Both writes here are exactly-once by *index*, not by the caller being
 * careful. A grant collides on its CoinPay payment id, a spend on
 * (organization, unit, person, month). Idempotency that lives in a unique
 * index survives a retry, a race and a second process; idempotency that lives
 * in a `SELECT` before an `INSERT` survives none of them.
 */

import {
  creditBalance,
  creditPeriod,
  newId,
  type CreditBalance,
  type CreditUnit,
} from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';

/** True when an insert failed because it would duplicate a unique index. */
function isUniqueViolation(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

/**
 * What this organization has left to spend.
 *
 * Summed in SQL rather than by reading rows, because a busy account
 * accumulates one row per prospect per month and the balance is wanted on
 * every policy check.
 */
export async function creditsFor(
  db: Client,
  organizationId: string,
  unit: CreditUnit = 'prospect',
): Promise<CreditBalance> {
  const row = await queryOne<{ granted: number; spent: number }>(
    db,
    `SELECT coalesce(sum(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS granted,
            coalesce(sum(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS spent
       FROM credit_ledger WHERE organization_id = ? AND unit = ?`,
    [organizationId, unit],
  );

  // Folded through the domain helper rather than subtracted here, so the
  // clamp-at-zero rule lives in one place and is unit-tested without a
  // database.
  return creditBalance([Number(row?.granted ?? 0), -Number(row?.spent ?? 0)]);
}

/**
 * The organization a workspace bills to.
 *
 * Credits are bought and spent by the organization, so every ledger operation
 * starts here. Two workspaces under one organization share a balance for the
 * same reason they share a plan: otherwise a new workspace is a fresh
 * allowance.
 */
export async function organizationFor(
  db: Client,
  workspaceId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ organization_id: string }>(
    db,
    'SELECT organization_id FROM workspaces WHERE id = ?',
    [workspaceId],
  );

  return row?.organization_id;
}

/**
 * Credits a confirmed payment.
 *
 * Returns whether it added anything: `false` means this payment had already
 * been credited, which is the expected outcome of a webhook retry rather than
 * an error worth raising.
 */
export async function grantCredits(
  db: Client,
  input: {
    readonly organizationId: string;
    readonly credits: number;
    readonly paymentId: string;
    readonly reason?: string;
    readonly unit?: CreditUnit;
    readonly at?: string;
  },
): Promise<boolean> {
  if (input.credits <= 0) return false;

  try {
    await db.execute({
      sql: `INSERT INTO credit_ledger (id, organization_id, kind, unit, delta, payment_id,
            reason, occurred_at) VALUES (?, ?, 'grant', ?, ?, ?, ?, ?)`,
      args: [
        newId('creditLedgerEntry'),
        input.organizationId,
        input.unit ?? 'prospect',
        input.credits,
        input.paymentId,
        input.reason ?? null,
        input.at ?? now(),
      ],
    });

    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Charges one credit for contacting a person, if the plan did not already
 * cover them.
 *
 * Called *after* the interaction is recorded, deliberately. Charging before
 * the send means a send that then fails has been paid for, and the refund path
 * for that is a second thing to get wrong; charging after means the ledger
 * only ever contains prospects who were genuinely contacted. The
 * (organization, unit, person, month) index makes the ordering safe — a
 * cadence's fourth follow-up finds the row already there and charges nothing.
 *
 * Returns whether a credit was actually taken.
 */
export async function spendProspectCredit(
  db: Client,
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly personId: string;
    readonly at?: Date;
    readonly reason?: string;
  },
): Promise<boolean> {
  const at = input.at ?? new Date();

  try {
    await db.execute({
      sql: `INSERT INTO credit_ledger (id, organization_id, workspace_id, kind, unit, delta,
            person_id, period, reason, occurred_at)
            VALUES (?, ?, ?, 'spend', 'prospect', -1, ?, ?, ?, ?)`,
      args: [
        newId('creditLedgerEntry'),
        input.organizationId,
        input.workspaceId,
        input.personId,
        creditPeriod(at),
        input.reason ?? null,
        at.toISOString(),
      ],
    });

    return true;
  } catch (error) {
    // Already charged for this person this month. The common case, not a
    // failure: every follow-up in a cadence lands here.
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Charges credits for everyone this month's plan allowance did not cover.
 *
 * This is a *reconciliation*, not a hook on the send path, and that is the
 * whole point. There are three places that record an outbound interaction
 * today and there will be a fourth; a charge attached to each of them is a
 * charge that the fourth one forgets, which is the exact shape of the bug this
 * repository has already fixed once, when autopilot did not feed the address
 * cap that the approval path did. Deriving the charge from `interactions`
 * instead means any path that records a contact is billed for it, including
 * ones not written yet.
 *
 * Who pays is decided by *first contact time*: the allowance covers the first
 * N distinct people of the month, and everyone after them costs a credit.
 * Ordering by when they were first contacted rather than, say, by person id
 * makes the charge reproducible — running this twice cannot pick a different
 * set — and matches the order a customer would tell the story in.
 *
 * Returns how many credits it took. Zero is the overwhelmingly common answer.
 */
export async function settleProspectCredits(
  db: Client,
  input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    /** The plan's monthly allowance. The first this many prospects are free. */
    readonly allowance: number;
    readonly periodStartIso: string;
    readonly at?: Date;
  },
): Promise<number> {
  const at = input.at ?? new Date();
  const period = creditPeriod(at);

  // Everyone past the allowance who has not already been charged this month.
  // `LIMIT -1 OFFSET n` is SQLite's "skip n, take the rest"; the NOT EXISTS
  // keeps a busy account from re-attempting an insert per already-charged
  // person on every policy check.
  const result = await db.execute({
    sql: `WITH contacted AS (
            SELECT person_id, min(occurred_at) AS first_at
              FROM interactions
             WHERE workspace_id = ? AND direction = 'outbound' AND occurred_at >= ?
             GROUP BY person_id
             ORDER BY first_at
             LIMIT -1 OFFSET ?
          )
          SELECT c.person_id AS person_id FROM contacted c
           WHERE NOT EXISTS (
             SELECT 1 FROM credit_ledger l
              WHERE l.kind = 'spend' AND l.unit = 'prospect'
                AND l.organization_id = ? AND l.person_id = c.person_id AND l.period = ?
           )`,
    args: [input.workspaceId, input.periodStartIso, input.allowance, input.organizationId, period],
  });

  let taken = 0;

  for (const row of result.rows) {
    const personId = String((row as unknown as { person_id: string }).person_id);
    const charged = await spendProspectCredit(db, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      personId,
      at,
      reason: 'Beyond the monthly plan allowance',
    });

    if (charged) taken += 1;
  }

  return taken;
}
