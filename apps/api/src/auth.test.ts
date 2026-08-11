import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv } from './context';
import { hashToken, passwordProblem, readCookie, SESSION_COOKIE } from './auth';
import { seedDatabase, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(`auth-${label}`);
  active = seeded;
  // No injected authenticate: exercise the real session path.
  return { app: createApp({ db: seeded.db, secureCookies: false }), seeded };
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const CREDENTIALS = { email: 'Jane@Example.com', password: 'correct horse battery staple' };

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const value = readCookie(header.split(';')[0] ?? '', SESSION_COOKIE);
  return `${SESSION_COOKIE}=${value}`;
}

describe('password policy', () => {
  test('rejects short passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least 12/);
  });

  test('accepts a long passphrase without punctuation rules', () => {
    expect(passwordProblem('correct horse battery staple')).toBeUndefined();
  });

  test('rejects absurdly long input rather than hashing it', () => {
    expect(passwordProblem('x'.repeat(5000))).toMatch(/at most/);
  });
});

describe('registration', () => {
  test('creates a user, organization and workspace, and logs in', async () => {
    const { app, seeded } = await harness('register');
    const response = await post(app, '/auth/register', CREDENTIALS);

    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);

    const body = await response.json();
    expect(body.userId).toMatch(/^usr_/);
    expect(body.workspaceId).toMatch(/^wsp_/);

    const membership = await seeded.db.execute({
      sql: 'SELECT role FROM organization_members WHERE user_id = ?',
      args: [body.userId],
    });
    expect(membership.rows[0]?.role).toBe('owner');
  });

  test('never stores the password itself', async () => {
    const { app, seeded } = await harness('nostore');
    await post(app, '/auth/register', CREDENTIALS);

    const user = await seeded.db.execute({
      sql: 'SELECT password_hash FROM users WHERE email = ?',
      args: ['jane@example.com'],
    });

    const hash = String(user.rows[0]?.password_hash);
    expect(hash).not.toContain(CREDENTIALS.password);
    expect(hash).toMatch(/^\$argon2/);
  });

  test('normalises the email so case cannot create a duplicate', async () => {
    const { app } = await harness('normalise');
    expect((await post(app, '/auth/register', CREDENTIALS)).status).toBe(201);

    const dup = await post(app, '/auth/register', {
      ...CREDENTIALS,
      email: 'JANE@EXAMPLE.COM',
    });
    expect(dup.status).toBe(409);
  });

  test('rejects a weak password', async () => {
    const { app } = await harness('weak');
    const response = await post(app, '/auth/register', { ...CREDENTIALS, password: 'hunter2' });
    expect(response.status).toBe(400);
  });

  test('rejects a malformed email', async () => {
    const { app } = await harness('bademail');
    const response = await post(app, '/auth/register', { ...CREDENTIALS, email: 'not-an-email' });
    expect(response.status).toBe(400);
  });
});

describe('login', () => {
  test('issues a session cookie', async () => {
    const { app } = await harness('login');
    await post(app, '/auth/register', CREDENTIALS);

    const response = await post(app, '/auth/login', CREDENTIALS);
    expect(response.status).toBe(200);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  test('stores only a hash of the cookie value', async () => {
    const { app, seeded } = await harness('hashed');
    const registered = await post(app, '/auth/register', CREDENTIALS);

    const raw = cookieFrom(registered).split('=')[1]!;
    const stored = await seeded.db.execute('SELECT token_hash FROM sessions LIMIT 1');

    expect(String(stored.rows[0]?.token_hash)).not.toBe(raw);
    expect(String(stored.rows[0]?.token_hash)).toBe(await hashToken(raw));
  });

  test('gives the same answer for a wrong password and an unknown user', async () => {
    const { app } = await harness('enumeration');
    await post(app, '/auth/register', CREDENTIALS);

    const wrongPassword = await post(app, '/auth/login', {
      ...CREDENTIALS,
      password: 'wrong password entirely',
    });
    const unknownUser = await post(app, '/auth/login', {
      email: 'nobody@example.com',
      password: 'wrong password entirely',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknownUser.json());
  });

  test('locks the account after repeated failures', async () => {
    const { app } = await harness('lockout');
    await post(app, '/auth/register', CREDENTIALS);

    for (let i = 0; i < 8; i += 1) {
      await post(app, '/auth/login', { ...CREDENTIALS, password: `guess-${i}` });
    }

    // Even the correct password is refused while locked.
    const locked = await post(app, '/auth/login', CREDENTIALS);
    expect(locked.status).toBe(429);
  });

  test('clears the failure count after a successful login', async () => {
    const { app, seeded } = await harness('reset-count');
    await post(app, '/auth/register', CREDENTIALS);

    await post(app, '/auth/login', { ...CREDENTIALS, password: 'wrong' });
    await post(app, '/auth/login', CREDENTIALS);

    const user = await seeded.db.execute({
      sql: 'SELECT failed_login_count FROM users WHERE email = ?',
      args: ['jane@example.com'],
    });
    expect(Number(user.rows[0]?.failed_login_count)).toBe(0);
  });
});

describe('sessions', () => {
  test('a session cookie authenticates subsequent requests', async () => {
    const { app } = await harness('session');
    const registered = await post(app, '/auth/register', CREDENTIALS);
    const cookie = cookieFrom(registered);

    const response = await app.request('/api/v1/recommendations', { headers: { cookie } });
    expect(response.status).toBe(200);
  });

  test('no cookie means 401', async () => {
    const { app } = await harness('nocookie');
    const response = await app.request('/api/v1/recommendations');
    expect(response.status).toBe(401);
  });

  test('a forged cookie is rejected', async () => {
    const { app } = await harness('forged');
    await post(app, '/auth/register', CREDENTIALS);

    const response = await app.request('/api/v1/recommendations', {
      headers: { cookie: `${SESSION_COOKIE}=deadbeefdeadbeef` },
    });
    expect(response.status).toBe(401);
  });

  test('an expired session is rejected and deleted', async () => {
    const { app, seeded } = await harness('expired');
    const registered = await post(app, '/auth/register', CREDENTIALS);
    const cookie = cookieFrom(registered);

    await seeded.db.execute({
      sql: 'UPDATE sessions SET expires_at = ?',
      args: [new Date(Date.now() - 1000).toISOString()],
    });

    const response = await app.request('/api/v1/recommendations', { headers: { cookie } });
    expect(response.status).toBe(401);

    const remaining = await seeded.db.execute('SELECT count(*) AS n FROM sessions');
    expect(Number(remaining.rows[0]?.n)).toBe(0);
  });

  test('logout invalidates the session', async () => {
    const { app } = await harness('logout');
    const registered = await post(app, '/auth/register', CREDENTIALS);
    const cookie = cookieFrom(registered);

    expect((await post(app, '/auth/logout', {}, cookie)).status).toBe(200);
    expect((await app.request('/api/v1/recommendations', { headers: { cookie } })).status).toBe(
      401,
    );
  });

  test('/auth/me returns the caller and their workspaces', async () => {
    const { app } = await harness('me');
    const registered = await post(app, '/auth/register', CREDENTIALS);
    const cookie = cookieFrom(registered);

    const response = await app.request('/api/v1/auth/me', { headers: { cookie } });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.user.email).toBe('jane@example.com');
    expect(body.role).toBe('owner');
    expect(body.workspaces.length).toBeGreaterThan(0);
  });

  test('a session only reaches its own workspace', async () => {
    const { app, seeded } = await harness('isolation');
    const registered = await post(app, '/auth/register', CREDENTIALS);
    const cookie = cookieFrom(registered);

    // The seeded fixture's recommendation belongs to a different workspace.
    const response = await app.request('/api/v1/recommendations', { headers: { cookie } });
    const body = await response.json();

    expect(body.recommendations).toHaveLength(0);

    const seededRows = await seeded.db.execute('SELECT count(*) AS n FROM recommendations');
    expect(Number(seededRows.rows[0]?.n)).toBeGreaterThan(0);
  });
});

describe('service token', () => {
  test('authenticates a machine caller with explicit scope', async () => {
    const seeded = await seedDatabase('auth-service');
    active = seeded;
    const app = createApp({ db: seeded.db, serviceToken: 'service-secret', secureCookies: false });

    const response = await app.request('/api/v1/recommendations', {
      headers: {
        authorization: 'Bearer service-secret',
        'x-workspace-id': 'wsp_test',
        'x-organization-id': 'org_test',
      },
    });

    expect(response.status).toBe(200);
  });

  test('is refused without scope headers', async () => {
    const seeded = await seedDatabase('auth-service-noscope');
    active = seeded;
    const app = createApp({ db: seeded.db, serviceToken: 'service-secret', secureCookies: false });

    const response = await app.request('/api/v1/recommendations', {
      headers: { authorization: 'Bearer service-secret' },
    });

    expect(response.status).toBe(401);
  });

  test('a wrong token is refused', async () => {
    const seeded = await seedDatabase('auth-service-wrong');
    active = seeded;
    const app = createApp({ db: seeded.db, serviceToken: 'service-secret', secureCookies: false });

    const response = await app.request('/api/v1/recommendations', {
      headers: {
        authorization: 'Bearer not-the-secret',
        'x-workspace-id': 'wsp_test',
        'x-organization-id': 'org_test',
      },
    });

    expect(response.status).toBe(401);
  });

  test('no service token configured means the bearer path is closed', async () => {
    const seeded = await seedDatabase('auth-no-service');
    active = seeded;
    const app = createApp({ db: seeded.db, secureCookies: false });

    const response = await app.request('/api/v1/recommendations', {
      headers: {
        authorization: 'Bearer anything',
        'x-workspace-id': 'wsp_test',
        'x-organization-id': 'org_test',
      },
    });

    expect(response.status).toBe(401);
  });
});
