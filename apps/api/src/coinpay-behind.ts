/**
 * The workspace's CoinPay account: who is behind on paying them, on Today.
 *
 * A workspace that sells through CoinPay pastes a CoinPay API key; Today then
 * shows the customers who owe it money or whose card was declined, grouped by
 * what to do (from coinpayportal `GET /api/payments/behind`). These are
 * existing customers, not prospects, so nothing here creates a person, a
 * campaign or a recommendation: a payment reminder must never go through the
 * cold-outreach policy, its suppression list or its unsubscribe footer. The
 * page drafts the email; a human sends it from their own mail.
 *
 * Stored like the CRM token (`packages/pipeline/src/crm-sync.ts`): an
 * `integrations` row (kind `payments`, network `coinpay`) and the key sealed in
 * `integration_accounts`. Disconnecting deletes the key.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import {
  CoinPayMerchant,
  CoinPayMerchantError,
  type BehindReport,
  type CoinPayMerchantConfig,
} from '@outreachgraph/payments';
import { SecretDecryptError, SecretsLockedError, type SecretVault } from '@outreachgraph/secrets';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

const KIND = 'payments';
const NETWORK = 'coinpay';
const CACHE_MS = 5 * 60_000;

export interface CoinPayRouteDeps {
  readonly secretVault: SecretVault | undefined;
  readonly requireVerifiedEmail: (db: Client, actor: RequestActor) => Promise<void>;
  /** Test seam: builds the client, so no request leaves the process. */
  readonly merchantFor?:
    ((config: CoinPayMerchantConfig) => Pick<CoinPayMerchant, 'behind' | 'portalUrl'>) | undefined;
  readonly baseUrl?: string | undefined;
}

export interface CoinPayConnection {
  readonly connected: boolean;
  readonly connectedAt?: string;
}

const connectSchema = z.object({
  apiKey: z.string().trim().min(8).max(500),
  skipVerification: z.boolean().optional(),
});

function requireApprover(actor: RequestActor, doing: string): void {
  if (!canApprove(actor)) throw ApiError.forbidden(doing);
}

export async function coinpayConnection(
  db: Client,
  workspaceId: string,
): Promise<CoinPayConnection> {
  const row = await queryOne<{ status: string; created_at: string }>(
    db,
    `SELECT ia.status, ia.created_at FROM integration_accounts ia
       JOIN integrations i ON i.id = ia.integration_id
      WHERE ia.workspace_id = ? AND ia.network = ? AND i.kind = ?`,
    [workspaceId, NETWORK, KIND],
  );
  if (!row) return { connected: false };
  return { connected: row.status === 'active', connectedAt: row.created_at };
}

async function storeKey(db: Client, workspaceId: string, sealed: string): Promise<string> {
  const stamp = now();
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?',
    [workspaceId, KIND, NETWORK],
  );
  const integrationId = existing?.id ?? newId('integration');
  if (existing) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'connected', updated_at = ? WHERE id = ?`,
      args: [stamp, integrationId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, config_json,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, 'connected', '{}', ?, ?)`,
      args: [integrationId, workspaceId, KIND, NETWORK, stamp, stamp],
    });
  }
  // Replaced, never updated: a revoked key must not stay readable.
  await db.execute({
    sql: 'DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?',
    args: [workspaceId, NETWORK],
  });
  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          access_token_enc, scopes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '["payments.read"]', 'active', ?, ?)`,
    args: [newId('integrationAccount'), integrationId, workspaceId, NETWORK, sealed, stamp, stamp],
  });
  return stamp;
}

async function loadKey(
  db: Client,
  workspaceId: string,
  vault: SecretVault,
): Promise<string | undefined> {
  const row = await queryOne<{ access_token_enc: string | null; status: string }>(
    db,
    `SELECT ia.access_token_enc, ia.status FROM integration_accounts ia
       JOIN integrations i ON i.id = ia.integration_id
      WHERE ia.workspace_id = ? AND ia.network = ? AND i.kind = ?`,
    [workspaceId, NETWORK, KIND],
  );
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;
  try {
    return vault.open(row.access_token_enc, workspaceId, 'access_token_enc');
  } catch (error) {
    if (error instanceof SecretDecryptError) return undefined;
    throw error;
  }
}

export function coinpayRoutes(deps: CoinPayRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  const cache = new Map<string, { at: number; report: BehindReport; portalUrl: string }>();
  const merchant = (apiKey: string) =>
    (deps.merchantFor ?? ((config) => new CoinPayMerchant(config)))({
      apiKey,
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    });

  router.get('/', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing the CoinPay connection');
    return c.json({
      connection: await coinpayConnection(c.get('db'), actor.workspaceId),
      canConnect: deps.secretVault !== undefined,
    });
  });

  router.put('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'connecting CoinPay');
    await deps.requireVerifiedEmail(db, actor);
    if (!deps.secretVault) {
      throw new ApiError(503, 'not_configured', 'This deployment cannot store credentials.');
    }

    let raw: unknown = {};
    try {
      const text = await c.req.raw.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      throw ApiError.badRequest('request body must be valid JSON');
    }
    const parsed = connectSchema.safeParse(raw);
    if (!parsed.success) throw ApiError.badRequest('apiKey is required');
    const { apiKey, skipVerification } = parsed.data;

    // Verify first: a key that cannot read the report is not a connection.
    let report: BehindReport | undefined;
    let portalUrl = '';
    if (skipVerification !== true) {
      const client = merchant(apiKey);
      try {
        report = await client.behind();
        portalUrl = client.portalUrl;
      } catch (error) {
        if (error instanceof CoinPayMerchantError) throw ApiError.badRequest(error.message);
        throw error;
      }
    }

    const sealed = await deps.secretVault.seal(apiKey, actor.workspaceId, 'access_token_enc');
    const connectedAt = await storeKey(db, actor.workspaceId, sealed);
    if (report) cache.set(actor.workspaceId, { at: Date.now(), report, portalUrl });
    else cache.delete(actor.workspaceId);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'integration.connected',
      entityKind: 'workspace',
      entityId: actor.workspaceId,
      // Which service, never the key.
      detail: { network: NETWORK },
    });

    return c.json({ connection: { connected: true, connectedAt } });
  });

  router.delete('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'disconnecting CoinPay');
    const removed = await db.execute({
      sql: 'DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?',
      args: [actor.workspaceId, NETWORK],
    });
    await db.execute({
      sql: `UPDATE integrations SET status = 'disconnected', updated_at = ?
             WHERE workspace_id = ? AND kind = ? AND network = ?`,
      args: [now(), actor.workspaceId, KIND, NETWORK],
    });
    cache.delete(actor.workspaceId);
    const disconnected = Number(removed.rowsAffected ?? 0) > 0;
    if (disconnected) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'integration.disconnected',
        entityKind: 'workspace',
        entityId: actor.workspaceId,
        detail: { network: NETWORK },
      });
    }
    return c.json({ disconnected });
  });

  /**
   * Who is behind. Always 200 with a `state`, because Today renders every one
   * of them: not connected, locked, CoinPay unreachable, or the report.
   */
  router.get('/behind', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'viewing who is behind on payments');

    if (!deps.secretVault) return c.json({ state: 'not_connected' });
    if (!(await coinpayConnection(db, actor.workspaceId)).connected) {
      return c.json({ state: 'not_connected' });
    }

    const hit = cache.get(actor.workspaceId);
    if (hit && Date.now() - hit.at < CACHE_MS && c.req.query('refresh') !== '1') {
      return c.json({ state: 'ok', portal_url: hit.portalUrl, cached: true, ...hit.report });
    }

    let apiKey: string | undefined;
    try {
      apiKey = await loadKey(db, actor.workspaceId, deps.secretVault);
    } catch (error) {
      if (error instanceof SecretsLockedError) {
        return c.json({ state: 'locked', message: error.message });
      }
      throw error;
    }
    if (!apiKey) return c.json({ state: 'not_connected' });

    const client = merchant(apiKey);
    try {
      const report = await client.behind();
      cache.set(actor.workspaceId, { at: Date.now(), report, portalUrl: client.portalUrl });
      return c.json({ state: 'ok', portal_url: client.portalUrl, ...report });
    } catch (error) {
      if (error instanceof CoinPayMerchantError) {
        return c.json({ state: 'error', message: error.message });
      }
      throw error;
    }
  });

  return router;
}
