/**
 * The abuse throttles, through the real app.
 *
 * What has to hold, from the b1dz incident: a script rotating its claimed
 * X-Forwarded-For cannot buy a fresh window while nginx's X-Real-IP stays the
 * same; a reset mail to one stranger is capped however many addresses ask for
 * it; the quoted User-Agent the bot carried is refused outright; every refusal
 * is a 4xx with Retry-After so ThreatCrush can ban it; and the job-post routes
 * that spend search credits are capped per workspace.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { WebSearcher } from '@outreachgraph/providers';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import { clientIp, isQuotedUserAgent } from './throttle';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const searcher: WebSearcher = { search: async () => [] };

async function harness(label: string): Promise<Hono<AppEnv>> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return createApp({
    db: seeded.db,
    authenticate: async () => OWNER,
    jobSearcher: searcher,
    throttles: {
      register: { max: 2, windowMs: 60_000 },
      forgotByIp: { max: 3, windowMs: 60_000 },
      forgotByEmail: { max: 2, windowMs: 60_000 },
      jobSearch: { max: 2, windowMs: 60_000 },
    },
  });
}

function post(app: Hono<AppEnv>, path: string, body: unknown, headers: Record<string, string>) {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0', ...headers },
    body: JSON.stringify(body),
  });
}

describe('public auth routes', () => {
  test('a rotating X-Forwarded-For does not reset the window X-Real-IP keys', async () => {
    const app = await harness('throttle-register');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post(
        app,
        '/auth/register',
        { email: `bot${i}@example.com`, password: 'correct-horse-battery-9', name: 'Bot' },
        { 'x-real-ip': '203.0.113.7', 'x-forwarded-for': `198.51.100.${i}, 203.0.113.7` },
      );
      statuses.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
      }
    }
    expect(statuses).toEqual([201, 201, 429]);

    // A different real address has its own window.
    const other = await post(
      app,
      '/auth/register',
      { email: 'person@example.com', password: 'correct-horse-battery-9', name: 'Person' },
      { 'x-real-ip': '192.0.2.44' },
    );
    expect(other.status).toBe(201);
  });

  test('reset mail to one address is capped across caller addresses', async () => {
    const app = await harness('throttle-forgot');
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const response = await post(
        app,
        '/auth/password/forgot',
        { email: 'Stranger@Example.com' },
        { 'x-real-ip': `203.0.113.${i + 1}` },
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test('the quoted User-Agent the b1dz bot carried is refused', async () => {
    const app = await harness('throttle-quoted-ua');
    const response = await post(
      app,
      '/auth/password/forgot',
      { email: 'someone@example.com' },
      { 'x-real-ip': '203.0.113.9', 'user-agent': '"Mozilla/5.0 (Windows NT 10.0)"' },
    );
    expect(response.status).toBe(403);
  });
});

test('job search is capped per workspace', async () => {
  const app = await harness('throttle-job-search');
  const statuses: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const response = await post(app, '/job-posts/search', { keyword: 'engineer' }, {});
    statuses.push(response.status);
  }
  expect(statuses).toEqual([200, 200, 429]);
});

test('clientIp trusts nginx, not the client', () => {
  const request = (headers: Record<string, string>) =>
    new Request('http://localhost/', { headers });
  expect(clientIp(request({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }))).toBe(
    '203.0.113.7',
  );
  expect(clientIp(request({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  expect(clientIp(request({}))).toBeNull();
  expect(isQuotedUserAgent(request({ 'user-agent': '"Mozilla/5.0"' }))).toBe(true);
  expect(isQuotedUserAgent(request({ 'user-agent': 'Mozilla/5.0' }))).toBe(false);
});
