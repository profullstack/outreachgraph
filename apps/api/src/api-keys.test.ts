import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryOne } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import {
  actorFromApiKey,
  listApiKeys,
  mintApiKey,
  presentedApiKey,
  revokeApiKey,
} from './api-keys';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const SESSION_ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
  credential: 'session',
};

/** The real resolver: no `authenticate` override, so headers decide. */
async function realApp(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return { app: createApp({ db: seeded.db }), seeded };
}

describe('minting and using a key', () => {
  test('the secret is hashed at rest and shown once', async () => {
    const { seeded } = await realApp('key-mint');
    const minted = await mintApiKey(seeded.db, {
      workspaceId: SEED.workspaceId,
      organizationId: SEED.organizationId,
      userId: SEED.userId,
      name: 'agent',
    });

    expect(minted.key.startsWith('og_live_')).toBe(true);
    expect(minted.prefix).toBe(minted.key.slice(0, minted.prefix.length));

    const row = await queryOne<{ key_hash: string; key_prefix: string }>(
      seeded.db,
      'SELECT key_hash, key_prefix FROM api_keys WHERE id = ?',
      [minted.id],
    );
    expect(row?.key_hash).not.toBe(minted.key);
    expect(row?.key_hash).not.toContain(minted.key);

    const listed = await listApiKeys(seeded.db, SEED.workspaceId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(minted.key);
  });

  test('a key authenticates as its owner, with their current role', async () => {
    const { app, seeded } = await realApp('key-auth');
    const minted = await mintApiKey(seeded.db, {
      workspaceId: SEED.workspaceId,
      organizationId: SEED.organizationId,
      userId: SEED.userId,
      name: 'agent',
    });

    const actor = await actorFromApiKey(seeded.db, minted.key);
    expect(actor?.workspaceId).toBe(SEED.workspaceId);
    expect(actor?.role).toBe('owner');
    expect(actor?.credential).toBe('api_key');

    // Through the app, with the header.
    const viaHeader = await app.request('/api/v1/autogtm/projects', {
      headers: { 'x-api-key': minted.key },
    });
    expect(viaHeader.status).toBe(200);

    const viaBearer = await app.request('/api/v1/autogtm/projects', {
      headers: { authorization: `Bearer ${minted.key}` },
    });
    expect(viaBearer.status).toBe(200);

    const none = await app.request('/api/v1/autogtm/projects');
    expect(none.status).toBe(401);

    const wrong = await app.request('/api/v1/autogtm/projects', {
      headers: { 'x-api-key': `${minted.key.slice(0, -4)}zzzz` },
    });
    expect(wrong.status).toBe(401);
  });

  test('a revoked key stops working, and a removed member takes their keys with them', async () => {
    const { app, seeded } = await realApp('key-revoke');
    const minted = await mintApiKey(seeded.db, {
      workspaceId: SEED.workspaceId,
      organizationId: SEED.organizationId,
      userId: SEED.userId,
      name: 'agent',
    });

    expect(await revokeApiKey(seeded.db, SEED.workspaceId, minted.id)).toBe(true);
    expect(await revokeApiKey(seeded.db, SEED.workspaceId, minted.id)).toBe(false);

    const gone = await app.request('/api/v1/autogtm/projects', {
      headers: { 'x-api-key': minted.key },
    });
    expect(gone.status).toBe(401);

    const second = await mintApiKey(seeded.db, {
      workspaceId: SEED.workspaceId,
      organizationId: SEED.organizationId,
      userId: SEED.userId,
      name: 'agent-2',
    });
    await seeded.db.execute({
      sql: 'DELETE FROM organization_members WHERE user_id = ?',
      args: [SEED.userId],
    });
    expect(await actorFromApiKey(seeded.db, second.key)).toBeUndefined();
  });

  test('a key cannot mint keys; a session can', async () => {
    const seeded = await seedDatabase('key-mint-route');
    active = seeded;

    const asKey = createApp({
      db: seeded.db,
      authenticate: async () => ({ ...SESSION_ACTOR, credential: 'api_key' }),
    });
    const refused = await asKey.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nested' }),
    });
    expect(refused.status).toBe(403);

    const asSession = createApp({ db: seeded.db, authenticate: async () => SESSION_ACTOR });
    const created = await asSession.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my agent' }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { key: { id: string; key: string; name: string } };
    expect(body.key.name).toBe('my agent');
    expect(body.key.key.startsWith('og_live_')).toBe(true);

    const listed = await asSession.request('/api/v1/api-keys');
    const list = (await listed.json()) as { keys: { id: string }[] };
    expect(list.keys.map((k) => k.id)).toContain(body.key.id);

    const revoked = await asSession.request(`/api/v1/api-keys/${body.key.id}`, {
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);

    const unnamed = await asSession.request('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(unnamed.status).toBe(400);
  });
});

describe('presentedApiKey', () => {
  test('reads either header and ignores things that are not keys', () => {
    const key = 'og_live_0123456789abcdef0123456789abcdef';
    expect(presentedApiKey(new Request('http://x', { headers: { 'x-api-key': key } }))).toBe(key);
    expect(
      presentedApiKey(new Request('http://x', { headers: { authorization: `Bearer ${key}` } })),
    ).toBe(key);
    expect(
      presentedApiKey(new Request('http://x', { headers: { authorization: 'Bearer svc_token' } })),
    ).toBeUndefined();
    expect(presentedApiKey(new Request('http://x'))).toBeUndefined();
  });
});
