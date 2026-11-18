import { afterEach, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { queryOne } from '@outreachgraph/db';
import { bytesToBase64, createSeal, SecretVault } from '@outreachgraph/secrets';
import { createApp } from './app';
import type { RequestActor } from './context';
import { rearmUnattendedKeys, unwrapDataKey, wrapDataKey } from './unattended-keys';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const SERVER_KEY = randomBytes(32).toString('base64');

describe('wrapDataKey', () => {
  test('round-trips, and refuses another workspace or another server key', () => {
    const dek = randomBytes(32).toString('base64');
    const wrapped = wrapDataKey(SERVER_KEY, 'wsp_a', dek);
    expect(wrapped.startsWith('u1:')).toBe(true);
    expect(unwrapDataKey(SERVER_KEY, 'wsp_a', wrapped)).toBe(dek);
    expect(() => unwrapDataKey(SERVER_KEY, 'wsp_b', wrapped)).toThrow();
    expect(() => unwrapDataKey(randomBytes(32).toString('base64'), 'wsp_a', wrapped)).toThrow();
  });
});

describe('unattended unlock', () => {
  test('opt in on unlock; a restart re-unlocks; lock turns it off', async () => {
    seeded = await seedDatabase('unattended-keys');
    const db = seeded.db;
    const created = await createSeal('correct horse battery staple', SEED.workspaceId);
    const dek = bytesToBase64(created.dek);
    const makeVault = () =>
      new SecretVault({
        loadSeal: async (ws) => (ws === SEED.workspaceId ? created.seal : null),
      });

    let vault = makeVault();
    const app = createApp({
      db,
      encryptionKey: vault,
      unattendedKey: SERVER_KEY,
      authenticate: async () => OWNER,
    });
    const call = async (path: string, body?: unknown) => {
      const res = await app.request(`/api/v1/keys${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect((await call('/setup', { seal: created.seal, dek, unattended: true })).status).toBe(200);
    const status = await call('');
    expect(status.body).toMatchObject({ unattended: true, unattended_available: true });
    const row = await queryOne<{ wrapped_dek: string }>(
      db,
      'SELECT wrapped_dek FROM workspace_unattended_keys WHERE workspace_id = ?',
      [SEED.workspaceId],
    );
    expect(row?.wrapped_dek).toBeDefined();
    expect(row?.wrapped_dek).not.toContain(dek);

    // A restart: a fresh vault knows nothing until the sweep re-unlocks it.
    vault = makeVault();
    expect(vault.canOpen(SEED.workspaceId)).toBe(false);
    const rearmed = await rearmUnattendedKeys(db, vault, SERVER_KEY);
    expect(rearmed.unlocked).toEqual([SEED.workspaceId]);
    expect(vault.canOpen(SEED.workspaceId)).toBe(true);
    // Already open: nothing to do.
    expect((await rearmUnattendedKeys(db, vault, SERVER_KEY)).unlocked).toEqual([]);

    // Lock means stop.
    expect((await call('/lock', {})).status).toBe(200);
    expect((await call('')).body.unattended).toBe(false);
    const after = makeVault();
    expect((await rearmUnattendedKeys(db, after, SERVER_KEY)).unlocked).toEqual([]);
    expect(after.canOpen(SEED.workspaceId)).toBe(false);
  });

  test('without a server key the option is refused', async () => {
    seeded = await seedDatabase('unattended-off');
    const db = seeded.db;
    const created = await createSeal('correct horse battery staple', SEED.workspaceId);
    const app = createApp({
      db,
      encryptionKey: new SecretVault({ loadSeal: async () => created.seal }),
      authenticate: async () => OWNER,
    });
    const res = await app.request('/api/v1/keys/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        seal: created.seal,
        dek: bytesToBase64(created.dek),
        unattended: true,
      }),
    });
    expect(res.status).toBe(409);
  });
});
