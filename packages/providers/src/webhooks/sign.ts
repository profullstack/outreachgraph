/**
 * Signing what we send, so a receiver can tell it came from us.
 *
 * A webhook URL is not a secret anyone should rely on. It ends up in Zapier's
 * UI, in a teammate's browser history and in the receiver's access logs, and
 * anyone holding it can POST a convincing `reply.received` to it. The
 * signature is what turns "a request arrived" into "OutreachGraph said this".
 *
 * The scheme is Stripe's, deliberately, because every receiver author has
 * already implemented it once:
 *
 *     X-OutreachGraph-Signature: t=1727170000,v1=<hex>
 *     v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
 *
 * The timestamp is inside the MAC so a captured delivery cannot be replayed
 * next week: a receiver that rejects anything older than a few minutes gets
 * replay protection for free. The body is the raw bytes, never a re-serialised
 * object, because two JSON encoders disagree about whitespace and key order
 * and a signature over "the same object" would then fail for no visible reason.
 *
 * `v1` names the scheme so a later one can be sent alongside it during a
 * migration without breaking receivers that only know this one.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-OutreachGraph-Signature';

/** How old a signature a receiver should accept by default. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/** A fresh signing secret. Prefixed so one pasted into the wrong field is recognisable. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

function mac(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex');
}

/** The header value for one delivery. */
export function signWebhook(secret: string, body: string, timestamp: number): string {
  return `t=${timestamp},v1=${mac(secret, timestamp, body)}`;
}

export interface VerifyOptions {
  readonly toleranceSeconds?: number;
  /** Seconds since the epoch; injected by tests. */
  readonly now?: number;
}

/**
 * Checks a signature header against a raw body. This is the receiver's half,
 * kept here so the tests prove the two halves agree and so a customer writing
 * a receiver in TypeScript can copy one function.
 */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  options: VerifyOptions = {},
): boolean {
  if (!header) return false;

  let timestamp: number | undefined;
  const candidates: string[] = [];

  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key === 't' && value && /^\d+$/.test(value)) timestamp = Number(value);
    if (key === 'v1' && value) candidates.push(value);
  }

  if (timestamp === undefined || candidates.length === 0) return false;

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return false;

  const expected = Buffer.from(mac(secret, timestamp, body), 'utf8');
  return candidates.some((candidate) => {
    const given = Buffer.from(candidate, 'utf8');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
