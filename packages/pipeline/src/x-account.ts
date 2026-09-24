/**
 * Connecting a workspace's X account, over OAuth 2.1.
 *
 * Same tables as Bluesky and email (`integrations` + `integration_accounts`),
 * because the policy engine asks one question of all of them — is there a
 * usable connected account for this network — and a third place to answer it
 * is how the answers drift apart.
 *
 * The flow has two halves in two requests. `startXConnect` runs for the signed
 * in user (from `og connect x` or the web) and parks the PKCE verifier,
 * encrypted, on the integration row under a random `state`. X then sends the
 * browser to the callback with that `state`, and `completeXConnect` finds the
 * row by it. The callback has no session, so `state` is the only thing tying
 * the grant to a workspace: it is 192 random bits, single use, and expires.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import {
  exchangeXCode,
  newOAuthState,
  pkcePair,
  refreshXToken,
  xAuthorizeUrl,
  XAuthError,
  XClient,
  XSession,
  type XPoster,
  type XSessionOptions,
  type FetchLike,
  type XOAuthClient,
  type XTokens,
} from '@outreachgraph/providers';
import { decryptSecret, encryptSecret } from '@outreachgraph/secrets';

const KIND = 'social';
const NETWORK = 'x';

/** How long a started connection may wait for the browser to come back. */
const PENDING_TTL_MS = 15 * 60 * 1000;

/** Refresh this far ahead of expiry, so a send never races the clock. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export class XAccountError extends Error {
  readonly code: 'unknown_state' | 'expired_state' | 'exchange_failed' | 'no_key';
  constructor(code: XAccountError['code'], message: string) {
    super(message);
    this.name = 'XAccountError';
    this.code = code;
  }
}

export interface XAccountSummary {
  readonly connected: boolean;
  readonly username?: string;
  readonly userId?: string;
  readonly connectedAt?: string;
  /** A connection started and not yet finished in the browser. */
  readonly pending?: boolean;
}

interface PendingConnect {
  readonly state: string;
  readonly verifier_enc: string;
  readonly started_at: string;
}

function parseConfig(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function startXConnect(
  db: Client,
  input: { workspaceId: string; oauth: XOAuthClient; encryptionKey: Buffer },
): Promise<{ authorizeUrl: string; state: string; expiresAt: string }> {
  const { verifier, challenge } = pkcePair();
  const state = newOAuthState();
  const stamp = now();

  const existing = await queryOne<{ id: string; config_json: string }>(
    db,
    `SELECT id, config_json FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [input.workspaceId, KIND, NETWORK],
  );

  const pending: PendingConnect = {
    state,
    verifier_enc: encryptSecret(verifier, input.encryptionKey),
    started_at: stamp,
  };

  if (existing) {
    // Only `pending` changes: a reconnect in progress must not mark an
    // already-working account as disconnected before the new grant lands.
    const config = { ...parseConfig(existing.config_json), pending };
    await db.execute({
      sql: `UPDATE integrations SET config_json = ?, updated_at = ? WHERE id = ?`,
      args: [JSON.stringify(config), stamp, existing.id],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, config_json,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, 'disconnected', ?, ?, ?)`,
      args: [
        newId('integration'),
        input.workspaceId,
        KIND,
        NETWORK,
        JSON.stringify({ pending }),
        stamp,
        stamp,
      ],
    });
  }

  return {
    authorizeUrl: xAuthorizeUrl(input.oauth, state, challenge),
    state,
    expiresAt: new Date(Date.parse(stamp) + PENDING_TTL_MS).toISOString(),
  };
}

export async function completeXConnect(
  db: Client,
  input: {
    state: string;
    code: string;
    oauth: XOAuthClient;
    encryptionKey: Buffer;
    fetchImpl?: FetchLike;
  },
): Promise<{ workspaceId: string; username: string }> {
  const row = await queryOne<{ id: string; workspace_id: string; config_json: string }>(
    db,
    `SELECT id, workspace_id, config_json FROM integrations
      WHERE kind = ? AND network = ? AND json_extract(config_json, '$.pending.state') = ?`,
    [KIND, NETWORK, input.state],
  );
  if (!row) throw new XAccountError('unknown_state', 'this X sign-in link is not one we started');

  const config = parseConfig(row.config_json);
  const pending = config.pending as PendingConnect;

  // Single use: cleared before the exchange, so a replayed callback cannot
  // run the grant twice even if the exchange below throws.
  delete config.pending;
  await db.execute({
    sql: `UPDATE integrations SET config_json = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify(config), now(), row.id],
  });

  if (Date.now() - Date.parse(pending.started_at) > PENDING_TTL_MS) {
    throw new XAccountError('expired_state', 'this X sign-in link has expired; start again');
  }

  let tokens: XTokens;
  let username: string;
  let userId: string;
  try {
    const verifier = decryptSecret(pending.verifier_enc, input.encryptionKey);
    tokens = await exchangeXCode(input.oauth, input.code, verifier, input.fetchImpl);
    const me = await new XClient(tokens.accessToken, {
      ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    }).me();
    username = me.username;
    userId = me.id;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new XAccountError('exchange_failed', detail);
  }

  const stamp = now();
  await db.execute({
    sql: `UPDATE integrations SET status = 'connected', config_json = ?, updated_at = ? WHERE id = ?`,
    args: [JSON.stringify({ ...config, username, userId }), stamp, row.id],
  });

  // Replaced rather than updated: a reconnection is a new grant, and keeping
  // the old ciphertext would keep a revoked token readable.
  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [row.workspace_id, NETWORK],
  });

  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, refresh_token_enc, scopes, expires_at,
          status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      row.id,
      row.workspace_id,
      NETWORK,
      userId,
      username,
      encryptSecret(tokens.accessToken, input.encryptionKey),
      encryptSecret(tokens.refreshToken, input.encryptionKey),
      JSON.stringify(tokens.scopes),
      tokens.expiresAt,
      stamp,
      stamp,
    ],
  });

  return { workspaceId: row.workspace_id, username };
}

/**
 * A client holding a live bearer for this workspace, refreshing it first when
 * it is about to expire. Undefined when there is no usable account.
 *
 * X rotates refresh tokens, so the new pair is written back before the client
 * is returned. A refresh X refuses means the grant was revoked on their side;
 * the account is marked so, which turns its cards back into hand-offs rather
 * than a stream of failed sends.
 */
export async function xClientForWorkspace(
  db: Client,
  workspaceId: string,
  deps: {
    oauth?: XOAuthClient;
    encryptionKey?: Buffer;
    fetchImpl?: FetchLike;
    sessionOptions?: XSessionOptions;
  },
): Promise<XPoster | undefined> {
  if (!deps.encryptionKey) return undefined;

  const row = await queryOne<{
    id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    expires_at: string | null;
    scopes: string;
    status: string;
  }>(
    db,
    `SELECT id, access_token_enc, refresh_token_enc, expires_at, scopes, status
       FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );
  if (!row || row.status !== 'active' || !row.access_token_enc) return undefined;

  const clientOptions = deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {};

  // A browser session rather than an API grant: no expiry to refresh, and
  // the stored secret is the cookie pair.
  if (row.scopes.includes('"session"')) {
    try {
      const cookies = JSON.parse(decryptSecret(row.access_token_enc, deps.encryptionKey)) as {
        authToken: string;
        ct0: string;
      };
      return new XSession(cookies, { ...clientOptions, ...deps.sessionOptions });
    } catch {
      return undefined;
    }
  }

  let accessToken: string;
  try {
    accessToken = decryptSecret(row.access_token_enc, deps.encryptionKey);
  } catch {
    return undefined;
  }

  const expiresAt = row.expires_at ? Date.parse(row.expires_at) : 0;
  if (expiresAt - Date.now() > REFRESH_MARGIN_MS) return new XClient(accessToken, clientOptions);

  if (!deps.oauth || !row.refresh_token_enc) return undefined;

  try {
    const refreshToken = decryptSecret(row.refresh_token_enc, deps.encryptionKey);
    const tokens = await refreshXToken(deps.oauth, refreshToken, deps.fetchImpl);
    await db.execute({
      sql: `UPDATE integration_accounts
               SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ?
             WHERE id = ?`,
      args: [
        encryptSecret(tokens.accessToken, deps.encryptionKey),
        encryptSecret(tokens.refreshToken, deps.encryptionKey),
        tokens.expiresAt,
        now(),
        row.id,
      ],
    });
    return new XClient(tokens.accessToken, clientOptions);
  } catch (error) {
    if (error instanceof XAuthError) {
      await db.execute({
        sql: `UPDATE integration_accounts SET status = 'revoked', updated_at = ? WHERE id = ?`,
        args: [now(), row.id],
      });
      return undefined;
    }
    throw error;
  }
}

export async function xAccountSummary(db: Client, workspaceId: string): Promise<XAccountSummary> {
  const integration = await queryOne<{ config_json: string }>(
    db,
    `SELECT config_json FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [workspaceId, KIND, NETWORK],
  );
  const pending = Boolean(parseConfig(integration?.config_json).pending);

  const row = await queryOne<{
    handle: string | null;
    external_account_id: string | null;
    status: string;
    created_at: string;
  }>(
    db,
    `SELECT handle, external_account_id, status, created_at
       FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    [workspaceId, NETWORK],
  );

  if (!row) return { connected: false, ...(pending ? { pending } : {}) };

  return {
    connected: row.status === 'active',
    ...(row.handle ? { username: row.handle } : {}),
    ...(row.external_account_id ? { userId: row.external_account_id } : {}),
    connectedAt: row.created_at,
    ...(pending ? { pending } : {}),
  };
}

export async function disconnectXAccount(db: Client, workspaceId: string): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [workspaceId, NETWORK],
  });
  await db.execute({
    sql: `UPDATE integrations SET status = 'disconnected', updated_at = ?
           WHERE workspace_id = ? AND kind = ? AND network = ?`,
    args: [now(), workspaceId, KIND, NETWORK],
  });
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * Connects X through the member's own browser session: the `auth_token` and
 * `ct0` cookies from a signed-in x.com tab.
 *
 * The free alternative to the paid API (see `providers/src/x/session.ts`).
 * Verified against X before storing, stored encrypted as one secret, and
 * marked `["session"]` in `scopes` so the loader knows which client to build.
 * It replaces any OAuth grant the workspace had: one X account per workspace.
 */
export async function connectXSession(
  db: Client,
  input: {
    workspaceId: string;
    authToken: string;
    ct0: string;
    encryptionKey: Buffer;
    verify?: boolean;
    sessionOptions?: XSessionOptions;
  },
): Promise<XAccountSummary> {
  const cookies = { authToken: input.authToken.trim(), ct0: input.ct0.trim() };
  let username = '';
  let userId = '';

  if (input.verify !== false) {
    try {
      const me = await new XSession(cookies, input.sessionOptions).me();
      username = me.username;
      userId = me.id;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new XAccountError('exchange_failed', `X refused those cookies: ${detail}`);
    }
  }

  const stamp = now();
  const existing = await queryOne<{ id: string; config_json: string }>(
    db,
    `SELECT id, config_json FROM integrations WHERE workspace_id = ? AND kind = ? AND network = ?`,
    [input.workspaceId, KIND, NETWORK],
  );
  const integrationId = existing?.id ?? newId('integration');
  const config = { username, userId, via: 'session', optedInToSessionAutomation: stamp };

  if (existing) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'connected', config_json = ?, updated_at = ? WHERE id = ?`,
      args: [JSON.stringify(config), stamp, integrationId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO integrations (id, workspace_id, kind, network, status, config_json,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, 'connected', ?, ?, ?)`,
      args: [integrationId, input.workspaceId, KIND, NETWORK, JSON.stringify(config), stamp, stamp],
    });
  }

  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE workspace_id = ? AND network = ?`,
    args: [input.workspaceId, NETWORK],
  });
  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, scopes, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, '["session"]', 'active', ?, ?)`,
    args: [
      newId('integrationAccount'),
      integrationId,
      input.workspaceId,
      NETWORK,
      userId || null,
      username || null,
      encryptSecret(JSON.stringify(cookies), input.encryptionKey),
      stamp,
      stamp,
    ],
  });

  return {
    connected: true,
    ...(username ? { username } : {}),
    ...(userId ? { userId } : {}),
    connectedAt: stamp,
  };
}
