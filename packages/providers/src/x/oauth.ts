/**
 * Connecting an X account over OAuth 2.1.
 *
 * Authorization code with PKCE (S256, never `plain`), a confidential client
 * authenticating to the token endpoint with HTTP Basic, and refresh tokens
 * that rotate: X invalidates a refresh token the moment it is used, so the
 * pair returned by `refreshXToken` must replace the stored pair before
 * anything else happens, or the account is disconnected on the next refresh.
 *
 * `offline.access` is what makes X issue a refresh token at all. Without it
 * the bearer dies after two hours and every card after that is held again.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { FetchLike } from '../site/fetch';
import { X_API, XAuthError } from './client';

export const X_AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN_URL = `${X_API}/2/oauth2/token`;

/** Exactly what the senders need: read who we are, post, like, follow. */
export const X_SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'like.write',
  'follows.write',
  'offline.access',
] as const;

export interface XOAuthClient {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match the callback registered on the X app, byte for byte. */
  readonly redirectUri: string;
}

export interface XTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO timestamp. */
  readonly expiresAt: string;
  readonly scopes: readonly string[];
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh verifier and its S256 challenge. 32 random bytes is 43 characters. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function newOAuthState(): string {
  return base64url(randomBytes(24));
}

export function xAuthorizeUrl(client: XOAuthClient, state: string, challenge: string): string {
  const url = new URL(X_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', client.redirectUri);
  url.searchParams.set('scope', X_SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeXCode(
  client: XOAuthClient,
  code: string,
  verifier: string,
  fetchImpl: FetchLike = fetch,
): Promise<XTokens> {
  return tokenRequest(
    client,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: client.redirectUri,
      code_verifier: verifier,
    },
    fetchImpl,
  );
}

export async function refreshXToken(
  client: XOAuthClient,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<XTokens> {
  return tokenRequest(
    client,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    fetchImpl,
  );
}

async function tokenRequest(
  client: XOAuthClient,
  form: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<XTokens> {
  const basic = Buffer.from(
    `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`,
  ).toString('base64');

  const response = await fetchImpl(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  });

  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !body.access_token) {
    throw new XAuthError(
      `x token endpoint ${response.status}: ${body.error_description ?? body.error ?? 'no token'}`,
    );
  }

  if (!body.refresh_token) {
    // Only possible if `offline.access` was not granted. Refusing here beats
    // a connection that silently dies in two hours.
    throw new XAuthError('x issued no refresh token; offline.access was not granted');
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 7200) * 1000).toISOString(),
    scopes: (body.scope ?? '').split(' ').filter(Boolean),
  };
}
