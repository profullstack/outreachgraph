/**
 * Profullstack Pass on OutreachGraph: a CoinPay user who deposited $99 into
 * their own CoinPay wallet gets a free month on every Profullstack property
 * (https://coinpayportal.com/pass).
 *
 * OutreachGraph sells prospect credits in packs (no plan is purchasable), so
 * the pass grants the smallest pack's credits once per pass into the person's
 * home organization, through `grantCredits` and the `credit_ledger` CoinPay
 * purchases and credit codes already fill. The `payment_id`
 * `coinpay-pass:<coinpay sub>:<expires_at>` is unique, so a repeat sign-in
 * never pays twice. CoinPay reports the pass only in the userinfo `pass` claim
 * at sign-in; the person is the one bound to the CoinPay `sub`
 * (userForCoinpay / linkCoinpay), never one found by email.
 */
import type { CoinpayPass } from '@profullstack/coinpay-onboard/pass';
import { CREDIT_PACKS } from '@outreachgraph/domain';
import type { Client } from '@outreachgraph/db';
import { grantCredits } from '@outreachgraph/pipeline';
import { homeOrganization } from './credit-codes';

export { PASS_URL } from '@profullstack/coinpay-onboard/pass';

/** The smallest pack on sale, in prospect credits. */
export const PASS_CREDITS = Math.min(...CREDIT_PACKS.map((pack) => pack.credits));

/** The once-per-pass key, or null when the claim grants nothing. */
export function passPaymentId(
  sub: string,
  pass: CoinpayPass | null | undefined,
  now = Date.now(),
): string | null {
  if (!sub || !pass?.active || !pass.expiresAt) return null;
  const end = pass.expiresAt.getTime();
  if (!Number.isFinite(end) || end <= now) return null;
  return `coinpay-pass:${sub}:${pass.expiresAt.toISOString()}`;
}

export type PassGrant =
  | { readonly granted: true; readonly organizationId: string; readonly credits: number }
  | { readonly granted: false; readonly reason: 'no_pass' | 'no_organization' | 'already_granted' };

/** Grants PASS_CREDITS to the person's home organization, once per pass. */
export async function grantCoinpayPass(
  db: Client,
  userId: string,
  sub: string,
  pass: CoinpayPass | null | undefined,
  now = Date.now(),
): Promise<PassGrant> {
  const paymentId = passPaymentId(sub, pass, now);
  if (!paymentId) return { granted: false, reason: 'no_pass' };
  const organizationId = await homeOrganization(db, userId);
  if (!organizationId) return { granted: false, reason: 'no_organization' };
  const fresh = await grantCredits(db, {
    organizationId,
    credits: PASS_CREDITS,
    paymentId,
    reason: 'CoinPay Pass',
  });
  return fresh
    ? { granted: true, organizationId, credits: PASS_CREDITS }
    : { granted: false, reason: 'already_granted' };
}

/** The sign-in step: grant the pass if there is one; never blocks or fails the sign-in. */
export async function applyCoinpayPass(
  db: Client,
  userId: string,
  who: { sub: string; pass?: CoinpayPass },
): Promise<PassGrant | null> {
  if (!who.pass?.active) return null;
  try {
    return await grantCoinpayPass(db, userId, who.sub, who.pass);
  } catch (error) {
    console.error('coinpay pass grant failed', error instanceof Error ? error.message : error);
    return null;
  }
}
