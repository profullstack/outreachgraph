/**
 * Sign in with CoinPay: a confidential OIDC client. Authorization code + PKCE
 * S256 + state + nonce, the client secret on the code exchange, and the
 * id_token checked (issuer, audience, expiry, nonce) with a userinfo `sub` that
 * must match. The protocol half is the house package
 * @profullstack/coinpay-onboard/oauth.
 *
 * Binding (STANDING rule): an account is found by its CoinPay `sub` only, in
 * coinpay_identities. CoinPay never verifies email addresses, so its email is
 * never matched against users.email and never becomes one. A first CoinPay
 * sign-in provisions a new account whose email is an unroutable placeholder;
 * an existing account gets CoinPay only by connecting it from a signed-in
 * session.
 */

import {
  authorizeUrl,
  finishSignIn,
  pkce,
  randomToken,
  sameState,
  SIGN_IN_SCOPES,
} from '@profullstack/coinpay-onboard/oauth';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { COINPAY_PLACEHOLDER_DOMAIN, provisionAccount } from './auth';

export interface CoinpaySignInConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Exactly as registered: https://outreachgraph.com/api/v1/coinpay/oauth/callback */
  readonly redirectUri: string;
  readonly issuer?: string;
}

export const COINPAY_PENDING_COOKIE = 'og_cp';
export const COINPAY_PENDING_TTL_SECONDS = 600;

export function coinpayPlaceholderEmail(sub: string): string {
  return `${sub.toLowerCase().replace(/[^a-z0-9-]/g, '-')}@${COINPAY_PLACEHOLDER_DOMAIN}`;
}

export function isCoinpayPlaceholderEmail(email: string | null | undefined): boolean {
  return (email ?? '').trim().toLowerCase().endsWith(`@${COINPAY_PLACEHOLDER_DOMAIN}`);
}

/** Only same-site paths survive the round trip. */
export function safeNext(raw: string | null | undefined, fallback = '/inbox'): string {
  const s = String(raw ?? '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') && !/[\t\r\n]/.test(s)
    ? s
    : fallback;
}

export type CoinpayMode = 'login' | 'connect';

export interface PendingSignIn {
  readonly state: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly mode: CoinpayMode;
  readonly userId: string | null;
  readonly next: string;
}

/** Stores the pending values server side and returns the CoinPay URL. */
export async function beginCoinpaySignIn(
  db: Client,
  config: CoinpaySignInConfig,
  input: { mode: CoinpayMode; userId?: string | null; next?: string | null },
): Promise<{ id: string; url: string }> {
  const { verifier, challenge } = pkce();
  const id = randomToken(24);
  const state = randomToken(24);
  const nonce = randomToken(24);
  const expiresAt = new Date(Date.now() + COINPAY_PENDING_TTL_SECONDS * 1000).toISOString();
  // Abandoned sign-ins: cleared as new ones start.
  await db.execute({
    sql: 'DELETE FROM coinpay_oauth_pending WHERE expires_at < ?',
    args: [new Date().toISOString()],
  });
  await db.execute({
    sql: `INSERT INTO coinpay_oauth_pending (id, state, verifier, nonce, mode, user_id, next, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      state,
      verifier,
      nonce,
      input.mode,
      input.userId ?? null,
      safeNext(input.next, input.mode === 'connect' ? '/settings' : '/inbox'),
      expiresAt,
    ],
  });
  const url = authorizeUrl({
    base: config.issuer ?? 'https://coinpayportal.com',
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    state,
    challenge,
    nonce,
    scopes: SIGN_IN_SCOPES,
  });
  return { id, url };
}

/** Single use: the row is deleted as it is read; an expired one reads as none. */
export async function takePendingSignIn(db: Client, id: string): Promise<PendingSignIn | null> {
  if (!id) return null;
  const row = await queryOne<{
    state: string;
    verifier: string;
    nonce: string;
    mode: string;
    user_id: string | null;
    next: string;
    expires_at: string;
  }>(
    db,
    `DELETE FROM coinpay_oauth_pending WHERE id = ?
     RETURNING state, verifier, nonce, mode, user_id, next, expires_at`,
    [id],
  );
  if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
  return {
    state: row.state,
    verifier: row.verifier,
    nonce: row.nonce,
    mode: row.mode === 'connect' ? 'connect' : 'login',
    userId: row.user_id,
    next: safeNext(row.next),
  };
}

export const stateMatches = (
  expected: string | null | undefined,
  received: string | null | undefined,
) => sameState(expected, received);

/** Code -> tokens -> checked id_token -> userinfo. Throws on any mismatch. */
export async function finishCoinpaySignIn(
  config: CoinpaySignInConfig,
  input: { code: string; verifier: string; nonce: string },
  doFetch?: typeof fetch,
): Promise<{ sub: string; email: string | null; name: string | null }> {
  const base = config.issuer ?? 'https://coinpayportal.com';
  const done = await finishSignIn({
    code: input.code,
    verifier: input.verifier,
    nonce: input.nonce,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    base,
    ...(doFetch ? { fetch: doFetch } : {}),
  });
  return { sub: done.sub, email: done.email, name: done.name };
}

/** The account bound to this sub, or a new one bound to it. Never by email. */
export async function userForCoinpay(
  db: Client,
  who: { sub: string; email: string | null; name: string | null },
): Promise<{ userId: string; created: boolean }> {
  const bound = await queryOne<{ user_id: string }>(
    db,
    'SELECT user_id FROM coinpay_identities WHERE sub = ?',
    [who.sub],
  );
  if (bound) {
    await db.execute({
      sql: 'UPDATE coinpay_identities SET email = ?, last_login_at = ? WHERE sub = ?',
      args: [who.email, now(), who.sub],
    });
    return { userId: bound.user_id, created: false };
  }
  // No password (password login stays off) and an undeliverable email.
  const made = await provisionAccount(db, {
    email: coinpayPlaceholderEmail(who.sub),
    name: who.name ?? undefined,
    passwordHash: null,
  });
  await db.execute({
    sql: `INSERT INTO coinpay_identities (sub, user_id, email, created_at, last_login_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: [who.sub, made.userId, who.email, now(), now()],
  });
  return { userId: made.userId, created: true };
}

export type LinkOutcome =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'taken' | 'already_linked' };

/** Connect CoinPay to the account the caller is signed in to. */
export async function linkCoinpay(
  db: Client,
  userId: string,
  who: { sub: string; email: string | null },
): Promise<LinkOutcome> {
  const owner = await queryOne<{ user_id: string }>(
    db,
    'SELECT user_id FROM coinpay_identities WHERE sub = ?',
    [who.sub],
  );
  if (owner) return owner.user_id === userId ? { ok: true } : { ok: false, reason: 'taken' };
  const mine = await queryOne<{ sub: string }>(
    db,
    'SELECT sub FROM coinpay_identities WHERE user_id = ?',
    [userId],
  );
  if (mine) return { ok: false, reason: 'already_linked' };
  try {
    await db.execute({
      sql: `INSERT INTO coinpay_identities (sub, user_id, email, created_at) VALUES (?, ?, ?, ?)`,
      args: [who.sub, userId, who.email, now()],
    });
  } catch {
    return { ok: false, reason: 'taken' };
  }
  return { ok: true };
}

export interface CoinpayStatus {
  readonly linked: boolean;
  /** False when CoinPay is the only way into the account. */
  readonly canDisconnect: boolean;
}

export async function coinpayStatus(db: Client, userId: string): Promise<CoinpayStatus> {
  const identity = await queryOne<{ sub: string }>(
    db,
    'SELECT sub FROM coinpay_identities WHERE user_id = ?',
    [userId],
  );
  if (!identity) return { linked: false, canDisconnect: false };
  const user = await queryOne<{ email: string; password_hash: string | null }>(
    db,
    'SELECT email, password_hash FROM users WHERE id = ?',
    [userId],
  );
  const password = Boolean(user?.password_hash) && !isCoinpayPlaceholderEmail(user?.email);
  return { linked: true, canDisconnect: password };
}

export async function unlinkCoinpay(
  db: Client,
  userId: string,
): Promise<{ ok: true } | { ok: false; reason: 'not_linked' | 'only_sign_in' }> {
  const status = await coinpayStatus(db, userId);
  if (!status.linked) return { ok: false, reason: 'not_linked' };
  if (!status.canDisconnect) return { ok: false, reason: 'only_sign_in' };
  await db.execute({ sql: 'DELETE FROM coinpay_identities WHERE user_id = ?', args: [userId] });
  return { ok: true };
}
