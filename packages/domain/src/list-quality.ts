/**
 * List quality: the rules every send list has to meet before a message leaves.
 *
 * These are the standards from Hunter's outreach planner, applied by the
 * machine instead of by a person remembering to:
 *
 *   - **Verify before sending.** An address is checked (MX, then an SMTP RCPT
 *     probe where port 25 allows it) before its first message, and again once
 *     the check is older than `REVERIFY_AFTER_DAYS`: roughly a fifth of B2B
 *     addresses decay every year, so a list verified last spring is not.
 *   - **Under 2% bounce.** A campaign whose bounce rate passes
 *     `MAX_BOUNCE_RATE` over at least `MIN_BOUNCE_SAMPLE` sends stops, re-verifies
 *     everyone still queued in it, and starts again on a fresh window. Nobody
 *     has to notice, pause, re-verify and resume by hand.
 *   - **Accept-all addresses are a separate list.** A catch-all domain says yes
 *     to every recipient, so its addresses bounce more than verified ones. They
 *     are sent only while the campaign has room under the gate
 *     (`CATCH_ALL_MAX_RATE`), so they can never be the thing that trips it.
 *
 * Pure functions. Reading and writing the verification cache is the pipeline's.
 */

export const MAX_BOUNCE_RATE = 0.02;
export const MIN_BOUNCE_SAMPLE = 50;
export const REVERIFY_AFTER_DAYS = 90;
/** Catch-all addresses send only while the campaign bounces at or under this. */
export const CATCH_ALL_MAX_RATE = 0.01;

/**
 * What is known about one address.
 *
 * - `valid` — a server accepted it, on a domain that refuses made-up names.
 * - `catch_all` — the domain accepts every recipient, so the yes proves nothing.
 * - `unverified` — the domain takes mail but no server could be asked (port 25
 *   blocked, greeting refused). Sendable: this is the most a cloud host can learn.
 * - `invalid` — no mail exchanger, a server refused the recipient, or it bounced.
 */
export type AddressStatus = 'valid' | 'catch_all' | 'unverified' | 'invalid';

export interface AddressVerification {
  readonly status: AddressStatus;
  readonly checkedAt: string;
  readonly reason?: string | null;
}

/** True when the check is recent enough to trust without asking again. */
export function verificationFresh(
  checkedAt: string,
  at: Date,
  options: { readonly notBefore?: string | null } = {},
): boolean {
  const stamp = Date.parse(checkedAt);
  if (Number.isNaN(stamp)) return false;
  // A campaign that tripped the bounce gate wants every address re-checked
  // from that moment on, however recent the last check was.
  if (options.notBefore) {
    const floor = Date.parse(options.notBefore);
    if (!Number.isNaN(floor) && stamp < floor) return false;
  }
  return at.getTime() - stamp < REVERIFY_AFTER_DAYS * 86_400_000;
}

/** What the verifier saw, reduced to the fields this decision needs. */
export interface VerifierEvidence {
  /** Mail exchangers found. Empty means the domain takes no mail. */
  readonly mx: readonly string[];
  readonly smtp: 'probed' | 'unavailable' | 'skipped';
  readonly catchAll?: boolean | undefined;
  readonly verdict: 'accepted' | 'rejected' | 'unknown';
}

export function statusFromEvidence(evidence: VerifierEvidence): {
  status: AddressStatus;
  reason: string;
} {
  if (evidence.mx.length === 0) return { status: 'invalid', reason: 'the domain takes no mail' };
  if (evidence.smtp !== 'probed') {
    return { status: 'unverified', reason: 'the domain takes mail; no server could be asked' };
  }
  if (evidence.catchAll === true) {
    return { status: 'catch_all', reason: 'the domain accepts every address' };
  }
  if (evidence.verdict === 'rejected') {
    return { status: 'invalid', reason: 'the mail server refused this address' };
  }
  if (evidence.verdict === 'accepted')
    return { status: 'valid', reason: 'the mail server accepted it' };
  return { status: 'unverified', reason: 'the mail server would not say' };
}

export interface BounceWindow {
  readonly sends: number;
  readonly bounces: number;
}

export function bounceRate(window: BounceWindow): number {
  return window.sends > 0 ? window.bounces / window.sends : 0;
}

/**
 * True when the campaign must stop and re-verify.
 *
 * Below the sample size the rate is noise: one bounce in ten sends is 10%
 * and says nothing. Above it, more than 2% is the planner's stop line.
 */
export function bounceGateTripped(window: BounceWindow): boolean {
  return window.sends >= MIN_BOUNCE_SAMPLE && bounceRate(window) > MAX_BOUNCE_RATE;
}

/** True when a catch-all address may go out without risking the gate. */
export function catchAllAllowed(window: BounceWindow): boolean {
  return bounceRate(window) <= CATCH_ALL_MAX_RATE;
}

/** Percent with one decimal, for messages people read. */
export function formatRate(rate: number): string {
  return `${(Math.round(rate * 1000) / 10).toFixed(1)}%`;
}
