/**
 * The redirect is the one route a stranger reaches without a session, which
 * makes it the one route where getting the destination wrong publishes an open
 * redirect on the domain our mail is delivered from.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { trackLinksInBody } from '@outreachgraph/pipeline';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(
  label: string,
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({
    db: seeded.db,
    authenticate: async () => actor ?? undefined,
  });

  return { app, seeded };
}

async function tokenFor(seeded: SeededDatabase, body: string): Promise<string> {
  const tracked = await trackLinksInBody(seeded.db, {
    workspaceId: SEED.workspaceId,
    personId: SEED.personId,
    campaignId: SEED.campaignId,
    body,
    origin: 'https://app.test',
  });

  const token = tracked.body.match(/\/t\/(tlk_[a-z0-9]+)/)?.[1];
  if (!token) throw new Error(`no token was written into: ${tracked.body}`);
  return token;
}

describe('GET /t/:token', () => {
  test('redirects to the stored destination', async () => {
    const { app, seeded } = await harness('track-redirect');
    const token = await tokenFor(seeded, 'the pricing page is https://example.com/pricing');

    const response = await app.request(`/t/${token}`, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/pricing');
  });

  test('does not take a destination from the caller', async () => {
    const { app } = await harness('track-no-open-redirect');

    // The shape an attacker would try. Nothing in the query string is read, so
    // this 404s on the unknown token rather than forwarding anyone to evil.test.
    const response = await app.request('/t/tlk_fake?url=https://evil.test', {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' },
    });

    expect(response.status).toBe(404);
    expect(response.headers.get('location')).toBeNull();
  });

  test('ignores a query string on a real token', async () => {
    const { app, seeded } = await harness('track-query-ignored');
    const token = await tokenFor(seeded, 'https://example.com/docs');

    const response = await app.request(`/t/${token}?url=https://evil.test&next=https://evil.test`, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' },
    });

    expect(response.headers.get('location')).toBe('https://example.com/docs');
  });

  test('needs no session', async () => {
    // A prospect reading their mail has no account and never will.
    const { app, seeded } = await harness('track-anonymous', null);
    const token = await tokenFor(seeded, 'https://example.com/docs');

    const response = await app.request(`/t/${token}`, {
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/140' },
    });

    expect(response.status).toBe(302);
  });

  test('404s an unknown token rather than guessing', async () => {
    const { app } = await harness('track-unknown');

    const response = await app.request('/t/tlk_doesnotexist');

    expect(response.status).toBe(404);
  });
});
