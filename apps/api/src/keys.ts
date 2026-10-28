/**
 * `/api/v1/keys`: the workspace key seal (seal v2).
 *
 * The browser or CLI derives everything from the owner's passphrase locally.
 * The server receives the seal record (ciphertext, salt, KDF params, key
 * check, public key) once at setup, and on unlock the data key, never the
 * passphrase. The opened private key lives in this process's memory only,
 * with a TTL (default 8h, max 7d); Lock drops it; a restart drops all.
 */

import { Hono } from 'hono';
import {
  loadWorkspaceSeal,
  migrateWorkspaceSecrets,
  saveWorkspaceSeal,
  workspaceLocked,
} from '@outreachgraph/pipeline';
import {
  isSealRecordV2,
  SecretsLockedError,
  verifyDataKeySync,
  WrongKeyError,
  type SecretVault,
} from '@outreachgraph/secrets';
import { ApiError, type AppEnv, type RequestActor } from './context';

export interface KeysRouteDeps {
  readonly vault: SecretVault | undefined;
}

function requireOwner(actor: RequestActor, doing: string): void {
  if (actor.role !== 'owner' && actor.role !== 'admin') throw ApiError.forbidden(doing);
}

async function json(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = (await req.json()) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    throw ApiError.badRequest('body must be JSON');
  }
}

export function keysRoutes(deps: KeysRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  const vault = (): SecretVault => {
    if (!deps.vault) throw ApiError.notFound('route');
    return deps.vault;
  };

  router.get('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const v = vault();
    const seal = await loadWorkspaceSeal(db, actor.workspaceId);
    const status = v.status(actor.workspaceId);
    const locked = await workspaceLocked(db, v, actor.workspaceId);
    return c.json({
      workspace_id: actor.workspaceId,
      has_seal: !!seal,
      seal,
      unlocked: status.unlocked,
      expires_at: status.expiresAt,
      state: !seal ? 'setup_required' : status.unlocked ? 'unlocked' : 'locked',
      autopilot_paused: locked,
      legacy_migration: v.legacyMigrationEnabled ? 'on' : 'off',
    });
  });

  router.post('/setup', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireOwner(actor, 'setting the workspace key passphrase');
    const v = vault();
    const body = await json(c.req.raw);
    if (!isSealRecordV2(body.seal)) throw ApiError.badRequest('invalid seal');
    if (typeof body.dek !== 'string') throw ApiError.badRequest('dek required');
    const dek = Buffer.from(body.dek, 'base64');
    const ok = verifyDataKeySync(dek, body.seal, actor.workspaceId);
    dek.fill(0);
    if (!ok) throw ApiError.badRequest('seal does not match the data key');
    const existing = await loadWorkspaceSeal(db, actor.workspaceId);
    if (existing && body.reset !== true) {
      throw ApiError.conflict(
        'a key passphrase is already set; unlock it, or reset (credentials sealed under the old one are lost)',
      );
    }
    await saveWorkspaceSeal(db, actor.workspaceId, body.seal, actor.userId);
    v.forgetSeal(actor.workspaceId);
    const { expiresAt } = await v.unlock(actor.workspaceId, body.dek, body.ttl_seconds);
    const migration = await migrateWorkspaceSecrets(db, v, actor.workspaceId, body.seal.public_key);
    return c.json({ ok: true, expires_at: expiresAt, migration });
  });

  router.post('/unlock', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireOwner(actor, 'unlocking workspace keys');
    const v = vault();
    const body = await json(c.req.raw);
    try {
      const { expiresAt } = await v.unlock(
        actor.workspaceId,
        String(body.dek ?? ''),
        body.ttl_seconds,
      );
      const seal = await loadWorkspaceSeal(db, actor.workspaceId);
      const migration = seal
        ? await migrateWorkspaceSecrets(db, v, actor.workspaceId, seal.public_key)
        : null;
      return c.json({ ok: true, expires_at: expiresAt, migration });
    } catch (error) {
      if (error instanceof WrongKeyError) throw ApiError.forbidden('wrong key');
      if (error instanceof SecretsLockedError) throw ApiError.conflict(error.message);
      throw error;
    }
  });

  router.post('/lock', (c) => {
    const actor = c.get('actor');
    requireOwner(actor, 'locking workspace keys');
    vault().lock(actor.workspaceId);
    return c.json({ ok: true });
  });

  router.post('/passphrase', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireOwner(actor, 'changing the workspace key passphrase');
    const body = await json(c.req.raw);
    const current = await loadWorkspaceSeal(db, actor.workspaceId);
    if (!current) throw ApiError.conflict('no key passphrase set up');
    if (!isSealRecordV2(body.seal) || typeof body.dek !== 'string') {
      throw ApiError.badRequest('invalid request');
    }
    if (body.seal.public_key !== current.public_key)
      throw ApiError.badRequest('key pair must not change');
    const dek = Buffer.from(body.dek, 'base64');
    const ok =
      verifyDataKeySync(dek, current, actor.workspaceId) &&
      verifyDataKeySync(dek, body.seal, actor.workspaceId);
    dek.fill(0);
    if (!ok) throw ApiError.forbidden('wrong key');
    await saveWorkspaceSeal(db, actor.workspaceId, body.seal, actor.userId);
    vault().forgetSeal(actor.workspaceId);
    return c.json({ ok: true });
  });

  return router;
}
