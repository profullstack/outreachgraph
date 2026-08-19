/**
 * Prepaid prospect credits.
 *
 * A plan is a rate — so many prospects a month, refilled whether or not you
 * used them. A credit is a quantity: bought once, spent whenever, gone when
 * spent. The two answer different questions, which is why this sits beside
 * `plans.ts` rather than inside it.
 *
 * Credits exist because the monthly allowance is the wrong shape for the way
 * this product is actually used. Outreach arrives in bursts — a launch, a
 * conference, a list somebody finally cleaned — and a customer who needs four
 * hundred prospects in March and sixty in April is badly served by a plan
 * priced for the peak. Without credits their only move is to upgrade for one
 * month and remember to downgrade, which nobody remembers to do.
 *
 * They are deliberately *not* a replacement for plans. Credits never refill,
 * carry no seats, and unlock no features: they buy overage on whatever plan
 * you are already on, and that is all. A product where credits could replace a
 * subscription is one where the subscription is priced wrong.
 */

/** What a credit buys. One unit today; the column exists so it can be two. */
export const CREDIT_UNITS = ['prospect'] as const;
export type CreditUnit = (typeof CREDIT_UNITS)[number];

export interface CreditPack {
  readonly id: string;
  readonly name: string;
  readonly credits: number;
  /** Price in whole US dollars. CoinPayPortal prices the crypto side. */
  readonly priceUsd: number;
}

/**
 * The packs on sale.
 *
 * Priced so the per-credit rate falls as the pack grows, but never below the
 * Pro plan's effective rate (79/1500 ≈ $0.053). Credits undercutting a
 * subscription would make the subscription the worse deal for a heavy user,
 * which is exactly backwards: the recurring revenue is the one worth
 * protecting, and someone buying credits every month should be able to notice
 * they would be better off on a plan.
 */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { id: 'pack_100', name: '100 prospects', credits: 100, priceUsd: 15 },
  { id: 'pack_500', name: '500 prospects', credits: 500, priceUsd: 59 },
  { id: 'pack_2000', name: '2,000 prospects', credits: 2000, priceUsd: 199 },
];

export function creditPackById(id: string): CreditPack | undefined {
  return CREDIT_PACKS.find((pack) => pack.id === id);
}

export interface CreditBalance {
  /** Everything ever bought, in credits. */
  readonly granted: number;
  /** Everything ever spent, as a positive number. */
  readonly spent: number;
  /** What is left. Never negative — see `creditBalance`. */
  readonly remaining: number;
}

/**
 * Folds a ledger's signed deltas into a balance.
 *
 * Clamped at zero on the way out. A negative balance is arithmetically
 * possible — two sends racing past the last credit will both be allowed, since
 * the check and the spend are not one transaction — and the honest response is
 * to eat the overrun rather than to show a customer that they owe us one
 * prospect. The alternative, locking the ledger on every send, costs every
 * send a write conflict to prevent an occasional off-by-one.
 */
export function creditBalance(deltas: readonly number[]): CreditBalance {
  let granted = 0;
  let spent = 0;

  for (const delta of deltas) {
    if (delta >= 0) granted += delta;
    else spent -= delta;
  }

  return { granted, spent, remaining: Math.max(0, granted - spent) };
}

/**
 * The calendar month a credit spend belongs to, as `YYYY-MM`.
 *
 * Matches `periodStart` in `plans.ts` — UTC, calendar months rather than a
 * rolling window — because a credit is charged for exactly the prospects the
 * monthly allowance would not cover, and two different notions of "month"
 * between the two would mean charging for the wrong ones.
 */
export function creditPeriod(at: Date): string {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
