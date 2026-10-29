/**
 * Sign in with CoinPay: bound by the CoinPay `sub` only. A CoinPay login
 * carrying someone's email never gets their account; connecting needs that
 * account's browser session; a forged state or a wrong nonce is refused.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv } from './context';
import { readCookie, SESSION_COOKIE } from './auth';
import { coinpayPlaceholderEmail, COINPAY_PENDING_COOKIE } from './coinpay-signin';
import { seedDatabase, type SeededDatabase } from './test-seed';

const ISSUER = 'https://coinpay.test';
const CLIENT_ID = 'cp_test_client';

let active: SeededDatabase | undefined;
afterEach(() => {
  active?.cleanup();
  active = undefined;
});

/** What the fake CoinPay answers for the next code exchange. */
let next: { sub: string; email: string | null; nonce?: string } = { sub: '', email: null };
let lastNonce = '';
const realFetch = globalThis.fetch;
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== ISSUER) return realFetch(input as Request, init);
    if (url.pathname === '/api/oauth/token') {
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: next.sub,
        nonce: next.nonce ?? lastNonce,
        exp: now + 600,
      };
      return Response.json({
        access_token: 'at',
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: `${b64({ alg: 'RS256' })}.${b64(claims)}.sig`,
      });
    }
    if (url.pathname === '/api/oauth/userinfo') {
      return Response.json({ sub: next.sub, email: next.email, email_verified: false });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(`coinpay-${label}`);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    secureCookies: false,
    coinpaySignIn: {
      clientId: CLIENT_ID,
      clientSecret: 'test-client-secret',
      redirectUri: 'https://outreachgraph.test/api/v1/coinpay/oauth/callback',
      issuer: ISSUER,
    },
  });
  return { app, seeded };
}

const cookieValue = (response: Response, name: string) => {
  for (const line of response.headers.getSetCookie()) {
    const value = readCookie(line.split(';')[0] ?? '', name);
    if (value) return value;
  }
  return '';
};

async function start(app: Hono<AppEnv>, query = '', cookie?: string) {
  const response = await app.request(`/api/v1/coinpay/oauth/start${query}`, {
    headers: cookie ? { cookie } : {},
  });
  const location = new URL(response.headers.get('location') ?? '/', 'https://outreachgraph.test');
  lastNonce = location.searchParams.get('nonce') ?? '';
  return {
    response,
    location,
    state: location.searchParams.get('state') ?? '',
    pending: `${COINPAY_PENDING_COOKIE}=${cookieValue(response, COINPAY_PENDING_COOKIE)}`,
  };
}

function callback(app: Hono<AppEnv>, state: string, cookie: string) {
  return app.request(`/api/v1/coinpay/oauth/callback?code=c1&state=${encodeURIComponent(state)}`, {
    headers: { cookie },
  });
}

async function register(
  app: Hono<AppEnv>,
  email: string,
): Promise<{ userId: string; cookie: string }> {
  const response = await app.request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      first_name: 'A',
      last_name: 'B',
    }),
  });
  const body = (await response.json()) as { userId: string };
  return {
    userId: body.userId,
    cookie: `${SESSION_COOKIE}=${cookieValue(response, SESSION_COOKIE)}`,
  };
}

describe('Sign in with CoinPay', () => {
  test('start sends PKCE S256, state and nonce with the exact redirect', async () => {
    const { app } = await harness('start');
    const { response, location } = await start(app);
    expect(response.status).toBe(302);
    expect(location.origin + location.pathname).toBe(`${ISSUER}/api/oauth/authorize`);
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('state')).toBeTruthy();
    expect(location.searchParams.get('nonce')).toBeTruthy();
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://outreachgraph.test/api/v1/coinpay/oauth/callback',
    );
  });

  test("a CoinPay login carrying a victim's email gets its own account", async () => {
    const { app, seeded } = await harness('collision');
    const victim = await register(app, 'victim@example.com');
    next = { sub: 'attacker-sub', email: 'victim@example.com' };
    const { state, pending } = await start(app, '?next=/inbox');
    const response = await callback(app, state, pending);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/inbox');
    const session = cookieValue(response, SESSION_COOKIE);
    expect(session).toBeTruthy();

    const bound = await queryOne<{ user_id: string }>(
      seeded.db,
      'SELECT user_id FROM coinpay_identities WHERE sub = ?',
      ['attacker-sub'],
    );
    expect(bound?.user_id).toBeTruthy();
    expect(bound?.user_id).not.toBe(victim.userId);
    const user = await queryOne<{ email: string; password_hash: string | null }>(
      seeded.db,
      'SELECT email, password_hash FROM users WHERE id = ?',
      [bound!.user_id],
    );
    expect(user?.email).toBe(coinpayPlaceholderEmail('attacker-sub'));
    expect(user?.password_hash).toBeNull();

    // the session is the new account's, with its own workspace
    const me = await app.request('/api/v1/me/coinpay', {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    expect(await me.json()).toEqual({ enabled: true, linked: true, canDisconnect: false });
  });

  test('a forged state is refused', async () => {
    const { app, seeded } = await harness('forged');
    next = { sub: 'forged-sub', email: 'f@example.com' };
    const { pending } = await start(app);
    const response = await callback(app, 'forged', pending);
    expect(response.status).toBe(400);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
    const row = await queryOne(seeded.db, 'SELECT sub FROM coinpay_identities WHERE sub = ?', [
      'forged-sub',
    ]);
    expect(row).toBeUndefined();
  });

  test('an id_token with the wrong nonce is refused', async () => {
    const { app } = await harness('nonce');
    next = { sub: 'nonce-sub', email: 'n@example.com', nonce: 'not-the-nonce' };
    const { state, pending } = await start(app);
    const response = await callback(app, state, pending);
    expect(response.status).toBe(400);
    expect(cookieValue(response, SESSION_COOKIE)).toBe('');
  });

  test('the pending sign-in is single use', async () => {
    const { app } = await harness('replay');
    next = { sub: 'once-sub', email: null };
    const { state, pending } = await start(app);
    expect((await callback(app, state, pending)).status).toBe(302);
    const replay = await callback(app, state, pending);
    expect(replay.headers.get('location')).toBe('/login?error=coinpay_expired');
  });

  test('connect needs the account session and links only to it; disconnect rules', async () => {
    const { app, seeded } = await harness('connect');
    const owner = await register(app, 'owner@example.com');

    const anon = await start(app, '?mode=connect');
    expect(anon.response.headers.get('location')).toBe('/login?next=/settings');

    next = { sub: 'owner-sub', email: 'someone@example.com' };
    const signedIn = await start(app, '?mode=connect', owner.cookie);
    // the callback arriving without that session is refused
    const without = await callback(app, signedIn.state, signedIn.pending);
    expect(without.headers.get('location')).toBe('/login?error=coinpay_signin_first');

    const again = await start(app, '?mode=connect', owner.cookie);
    const linked = await callback(app, again.state, `${again.pending}; ${owner.cookie}`);
    expect(linked.headers.get('location')).toBe('/settings?coinpay=linked');
    const bound = await queryOne<{ user_id: string }>(
      seeded.db,
      'SELECT user_id FROM coinpay_identities WHERE sub = ?',
      ['owner-sub'],
    );
    expect(bound?.user_id).toBe(owner.userId);

    const status = await app.request('/api/v1/me/coinpay', { headers: { cookie: owner.cookie } });
    expect(await status.json()).toEqual({ enabled: true, linked: true, canDisconnect: true });
    const dropped = await app.request('/api/v1/me/coinpay', {
      method: 'DELETE',
      headers: { cookie: owner.cookie },
    });
    expect(dropped.status).toBe(200);
  });

  test('nobody can register with the placeholder domain', async () => {
    const { app } = await harness('squat');
    const response = await app.request('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: coinpayPlaceholderEmail('someone'),
        password: 'correct horse battery staple',
        first_name: 'A',
        last_name: 'B',
      }),
    });
    expect(response.status).toBe(400);
  });
});
