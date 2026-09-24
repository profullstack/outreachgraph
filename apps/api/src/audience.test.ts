/**
 * `/api/v1/audience` through the real app and a real temp database.
 *
 * What matters here: a watch is approver-only because it decides targeting; a
 * handle is accepted in whatever form it was pasted; LinkedIn cannot be
 * polled, only handed over; running a watch reports the network's own refusal
 * rather than a 500; and a hand-off produces the same rows a poll does.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

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

const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

const PROFILE = { did: 'did:plc:acme', handle: 'acme.bsky.social', displayName: 'Acme' };

async function harness(
  label: string,
  options: { actor?: RequestActor; bluesky?: Record<string, unknown> } = {},
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const routes = options.bluesky ?? {
    'app.bsky.actor.getProfile': PROFILE,
    'app.bsky.graph.getFollowers': {
      followers: [{ did: 'did:plc:dana', handle: 'dana.bsky.social', description: 'CTO' }],
    },
  };

  const app = createApp({
    db: seeded.db,
    authenticate: async () => options.actor ?? OWNER,
    blueskyFetch: async (input) => {
      const method = new URL(String(input)).pathname.replace('/xrpc/', '');
      const body = routes[method];
      return body === undefined
        ? new Response('{}', { status: 404 })
        : new Response(JSON.stringify(body), { status: 200 });
    },
  });

  return { app, seeded };
}

function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const WATCH = {
  network: 'bluesky',
  account: 'https://bsky.app/profile/acme.bsky.social',
  campaignId: SEED.campaignId,
  kinds: ['follow', 'like'],
};

describe('creating watches', () => {
  test('an owner can watch an account, however the handle was pasted', async () => {
    const { app } = await harness('audience-api-create');

    const response = await send(app, 'POST', '/audience', WATCH);
    expect(response.status).toBe(201);

    const { watch } = (await response.json()) as { watch: { account: string; kinds: string[] } };
    expect(watch.account).toBe('acme.bsky.social');
    expect(watch.kinds).toEqual(['follow', 'like']);

    const listed = await send(app, 'GET', '/audience');
    const body = (await listed.json()) as { watches: unknown[]; kinds: string[] };
    expect(body.watches).toHaveLength(1);
    expect(body.kinds).toContain('repost');
  });

  test('a viewer cannot, because a watch is a targeting decision', async () => {
    const { app } = await harness('audience-api-viewer', { actor: VIEWER });

    expect((await send(app, 'POST', '/audience', WATCH)).status).toBe(403);
    expect((await send(app, 'GET', '/audience')).status).toBe(403);
  });

  test('a campaign in another workspace is not found', async () => {
    const { app } = await harness('audience-api-campaign');

    const response = await send(app, 'POST', '/audience', {
      ...WATCH,
      campaignId: 'cmp_elsewhere',
    });
    expect(response.status).toBe(404);
  });

  test('nonsense is refused with a reason', async () => {
    const { app } = await harness('audience-api-bad');

    const response = await send(app, 'POST', '/audience', { ...WATCH, account: 'two words' });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('not a handle');
  });

  test('LinkedIn cannot be polled', async () => {
    const { app } = await harness('audience-api-linkedin');

    const response = await send(app, 'POST', '/audience', {
      ...WATCH,
      network: 'linkedin',
      account: 'acme-co',
      mode: 'poll',
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain('handoff');
  });
});

describe('running a watch', () => {
  test('reads the network and records what it found', async () => {
    const { app, seeded } = await harness('audience-api-run');

    const created = await send(app, 'POST', '/audience', WATCH);
    const { watch } = (await created.json()) as { watch: { id: string } };

    const response = await send(app, 'POST', `/audience/${watch.id}/run`);
    expect(response.status).toBe(200);

    const { result } = (await response.json()) as {
      result: { outcome: string; recorded: number };
    };
    expect(result.outcome).toBe('ok');
    expect(result.recorded).toBe(1);

    const signal = await queryOne<{ summary: string }>(
      seeded.db,
      `SELECT summary FROM signals WHERE signal_type = 'audience_engagement'`,
    );
    expect(signal?.summary).toContain('@dana.bsky.social followed @acme.bsky.social');
  });

  test('a network refusal is reported, not a 500', async () => {
    const { app } = await harness('audience-api-refusal', { bluesky: {} });

    const created = await send(app, 'POST', '/audience', WATCH);
    const { watch } = (await created.json()) as { watch: { id: string } };

    const response = await send(app, 'POST', `/audience/${watch.id}/run`);
    expect(response.status).toBe(202);

    const { result } = (await response.json()) as { result: { outcome: string; detail: string } };
    expect(result.outcome).toBe('unreadable');
    expect(result.detail).toContain('no bluesky account');
  });

  test('a hand-off watch cannot be run', async () => {
    const { app } = await harness('audience-api-run-handoff');

    const created = await send(app, 'POST', '/audience', {
      ...WATCH,
      network: 'linkedin',
      account: 'acme-co',
    });
    const { watch } = (await created.json()) as { watch: { id: string } };

    const response = await send(app, 'POST', `/audience/${watch.id}/run`);
    expect(response.status).toBe(400);
  });
});

describe('handing engagements over', () => {
  test('a posted reaction produces the same rows a poll would', async () => {
    const { app, seeded } = await harness('audience-api-handoff');

    const created = await send(app, 'POST', '/audience', {
      ...WATCH,
      network: 'linkedin',
      account: 'acme-co',
      kinds: ['reply'],
    });
    const { watch } = (await created.json()) as { watch: { id: string } };

    const response = await send(app, 'POST', '/audience/engagements', {
      watchId: watch.id,
      engagements: [
        {
          kind: 'reply',
          handle: 'dana-lee',
          displayName: 'Dana Lee',
          postId: 'urn:li:activity:1',
          postUrl: 'https://www.linkedin.com/feed/update/urn:li:activity:1/',
          postText: 'This is exactly the problem we have with our current vendor.',
        },
      ],
    });

    expect(response.status).toBe(201);
    const { result } = (await response.json()) as { result: { recorded: number } };
    expect(result.recorded).toBe(1);

    const signal = await queryOne<{ evidence: string; network: string }>(
      seeded.db,
      `SELECT evidence, network FROM signals WHERE signal_type = 'audience_engagement'`,
    );
    expect(signal?.network).toBe('linkedin');
    expect(signal?.evidence).toContain('current vendor');
  });

  test('an unknown watch is not found', async () => {
    const { app } = await harness('audience-api-handoff-missing');

    const response = await send(app, 'POST', '/audience/engagements', {
      watchId: 'awt_nope',
      engagements: [{ kind: 'like', handle: 'dana' }],
    });

    expect(response.status).toBe(404);
  });
});

describe('deleting a watch', () => {
  test('removes it, and a second delete is a 404', async () => {
    const { app } = await harness('audience-api-delete');

    const created = await send(app, 'POST', '/audience', WATCH);
    const { watch } = (await created.json()) as { watch: { id: string } };

    expect((await send(app, 'DELETE', `/audience/${watch.id}`)).status).toBe(200);
    expect((await send(app, 'DELETE', `/audience/${watch.id}`)).status).toBe(404);
  });
});
