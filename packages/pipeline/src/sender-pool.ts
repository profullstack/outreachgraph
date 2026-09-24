/**
 * The sender pool: which of a workspace's connected accounts sends next, how
 * much each may send today, and when one should stop.
 *
 * The decisions themselves are pure functions in `@outreachgraph/domain`
 * (`sender-pool.ts`). This module is their I/O: it reads the accounts and the
 * counts those functions need, and writes back the few facts they produce —
 * which account an action went out from, and an account stopped for its own
 * protection.
 *
 * Three rules shape everything here:
 *
 *   - **One conversation, one account.** Whoever wrote to a person first
 *     writes to them again. `actions.sender_account_id` is the memory of that,
 *     and the reason it is written *before* a send, not after: a send that
 *     fails still counts as having chosen, and a retry must choose the same.
 *   - **Full is not failed.** When every account is at its cap the action
 *     waits for tomorrow; it is never marked failed and never falls back to a
 *     different sender. A cap is a promise to the provider, and routing around
 *     it would break the promise while hiding that we had.
 *   - **A pool of one behaves exactly as the single account did.** Every
 *     workspace that existed before pools has one account per network, no
 *     warm-up and a cap no lower than its old limits, so for them `pickSender`
 *     always answers with the account they already had.
 */

import {
  choosePoolSender,
  configuredCap,
  capGroupFor,
  effectiveDailyCap,
  groupDailyCap,
  groupWeeklyCap,
  isAuthFailure,
  isRecipientBounce,
  newId,
  bounceRateExceeded,
  BOUNCE_WINDOW,
  DEFAULT_DAILY_CAP,
  nextUtcDay,
  warmupCap,
  warmupComplete,
  warmupDay,
  type CapGroup,
  type PoolChoice,
  type SenderNetwork,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

export interface SenderAccount {
  readonly id: string;
  readonly workspaceId: string;
  readonly integrationId: string;
  readonly network: SenderNetwork;
  readonly handle: string | null;
  readonly label: string | null;
  readonly status: string;
  readonly statusReason: string | null;
  readonly dailyCap: number | null;
  readonly warmupEnabled: boolean;
  readonly warmupStartedAt: string | null;
  readonly createdAt: string;
}

interface AccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly integration_id: string;
  readonly network: string;
  readonly handle: string | null;
  readonly label: string | null;
  readonly status: string;
  readonly status_reason: string | null;
  readonly daily_cap: number | null;
  readonly warmup_enabled: number;
  readonly warmup_started_at: string | null;
  readonly created_at: string;
}

const ACCOUNT_COLUMNS = `id, workspace_id, integration_id, network, handle, label, status,
  status_reason, daily_cap, warmup_enabled, warmup_started_at, created_at`;

function toAccount(row: AccountRow): SenderAccount {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    integrationId: row.integration_id,
    network: row.network as SenderNetwork,
    handle: row.handle,
    label: row.label,
    status: row.status,
    statusReason: row.status_reason,
    dailyCap: row.daily_cap === null ? null : Number(row.daily_cap),
    warmupEnabled: Number(row.warmup_enabled) === 1,
    warmupStartedAt: row.warmup_started_at,
    createdAt: row.created_at,
  };
}

function capInput(account: SenderAccount) {
  return {
    network: account.network,
    status: account.status,
    dailyCap: account.dailyCap,
    warmupEnabled: account.warmupEnabled,
    warmupStartedAt: account.warmupStartedAt,
  };
}

/** Every account a workspace has on one network, oldest first. */
export async function loadPool(
  db: Client,
  workspaceId: string,
  network: SenderNetwork,
): Promise<SenderAccount[]> {
  const rows = await queryAll<AccountRow>(
    db,
    `SELECT ${ACCOUNT_COLUMNS} FROM integration_accounts
      WHERE workspace_id = ? AND network = ?
      ORDER BY created_at ASC, id ASC`,
    [workspaceId, network],
  );
  return rows.map(toAccount);
}

export async function loadSender(
  db: Client,
  workspaceId: string,
  accountId: string,
): Promise<SenderAccount | undefined> {
  const row = await queryOne<AccountRow>(
    db,
    `SELECT ${ACCOUNT_COLUMNS} FROM integration_accounts WHERE id = ? AND workspace_id = ?`,
    [accountId, workspaceId],
  );
  return row ? toAccount(row) : undefined;
}

function dayBounds(at: Date): [string, string] {
  const start = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return [new Date(start).toISOString(), new Date(start + 86_400_000).toISOString()];
}

/**
 * What each account has sent on the UTC day `at` falls in.
 *
 * Counted from `actions`, not from a counter, so it cannot drift from what
 * actually happened. Failed actions do not count — the provider refused them,
 * so they cost the account nothing — but queued ones do: an action with a
 * sender assigned is one that account has promised to send.
 */
async function sentOn(
  db: Client,
  accountIds: readonly string[],
  at: Date,
  scope: KindScope = { network: 'email', group: 'post' },
): Promise<Map<string, number>> {
  const [start, end] = dayBounds(at);
  return sentBetween(db, accountIds, start, end, scope);
}

/** Which of an account's actions count against one cap group. */
interface KindScope {
  readonly network: SenderNetwork;
  readonly group: CapGroup;
}

const PERSON_KINDS = ['connect', 'view_profile', 'follow', 'send_dm'] as const;

/**
 * The SQL that narrows actions to one cap group.
 *
 * Only LinkedIn has groups. Its posts are everything that is not one of the
 * person-directed kinds, so a comment and a reply share the post budget as
 * they always did, and an invitation never eats into it.
 */
function kindFilter(scope: KindScope): { sql: string; args: string[] } {
  if (scope.network !== 'linkedin') return { sql: '', args: [] };
  if (scope.group === 'post') {
    return {
      sql: `AND kind NOT IN (${PERSON_KINDS.map(() => '?').join(', ')})`,
      args: [...PERSON_KINDS],
    };
  }
  return { sql: 'AND kind = ?', args: [scope.group] };
}

async function sentBetween(
  db: Client,
  accountIds: readonly string[],
  start: string,
  end: string,
  scope: KindScope,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (accountIds.length === 0) return counts;
  const filter = kindFilter(scope);

  const rows = await queryAll<{ sender_account_id: string; n: number }>(
    db,
    `SELECT sender_account_id, COUNT(*) AS n FROM actions
      WHERE sender_account_id IN (${accountIds.map(() => '?').join(', ')})
        AND status != 'failed'
        AND COALESCE(executed_at, created_at) >= ? AND COALESCE(executed_at, created_at) < ?
        ${filter.sql}
      GROUP BY sender_account_id`,
    [...accountIds, start, end, ...filter.args],
  );
  for (const row of rows) counts.set(row.sender_account_id, Number(row.n));
  return counts;
}

async function lastUsed(db: Client, accountIds: readonly string[]): Promise<Map<string, string>> {
  const used = new Map<string, string>();
  if (accountIds.length === 0) return used;

  const rows = await queryAll<{ sender_account_id: string; last_at: string | null }>(
    db,
    `SELECT sender_account_id, MAX(COALESCE(executed_at, created_at)) AS last_at FROM actions
      WHERE sender_account_id IN (${accountIds.map(() => '?').join(', ')})
      GROUP BY sender_account_id`,
    [...accountIds],
  );
  for (const row of rows) if (row.last_at) used.set(row.sender_account_id, row.last_at);
  return used;
}

/**
 * The account that last wrote to this person on this network, if any did.
 *
 * Failed sends are skipped: a message that never arrived started no
 * conversation, and pinning the person to the account that could not reach
 * them would only repeat the failure.
 */
export async function lastSenderFor(
  db: Client,
  workspaceId: string,
  network: SenderNetwork,
  personId: string,
): Promise<string | undefined> {
  const row = await queryOne<{ sender_account_id: string }>(
    db,
    `SELECT sender_account_id FROM actions
      WHERE workspace_id = ? AND person_id = ? AND network = ?
        AND sender_account_id IS NOT NULL AND status != 'failed'
      ORDER BY COALESCE(executed_at, created_at) DESC LIMIT 1`,
    [workspaceId, personId, network],
  );
  return row?.sender_account_id ?? undefined;
}

export interface SenderSelection {
  readonly choice: PoolChoice;
  /** The chosen account, when `choice.kind === 'picked'`. */
  readonly account?: SenderAccount;
  /** When a deferred action is worth trying again. */
  readonly retryAt?: string;
}

/**
 * The full answer: which account, or why none, or when to come back.
 *
 * `pickSender` below is the short form most callers want; this one is for
 * the callers that must tell "nothing connected" (keep the old behaviour)
 * apart from "everything full" (wait).
 */
export async function chooseSender(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly network: SenderNetwork;
    readonly personId?: string | undefined;
    readonly at?: Date;
    /**
     * The action kind, for networks with per-kind caps (LinkedIn). Each
     * account is judged on its own budget for that kind — its twenty
     * invitations a day, its hundred a week — as well as its warm-up.
     */
    readonly kind?: string | undefined;
  },
): Promise<SenderSelection> {
  const at = input.at ?? new Date();
  const pool = await loadPool(db, input.workspaceId, input.network);
  const ids = pool.map((account) => account.id);
  const scope: KindScope = { network: input.network, group: capGroupFor(input.kind) };
  const perWeek = groupWeeklyCap(input.network, scope.group);

  const [sent, week, used, sticky] = await Promise.all([
    sentOn(db, ids, at, scope),
    perWeek === undefined
      ? Promise.resolve(undefined)
      : sentBetween(
          db,
          ids,
          new Date(at.getTime() - 7 * 86_400_000).toISOString(),
          new Date(at.getTime() + 1).toISOString(),
          scope,
        ),
    lastUsed(db, ids),
    input.personId
      ? lastSenderFor(db, input.workspaceId, input.network, input.personId)
      : Promise.resolve(undefined),
  ]);

  const choice = choosePoolSender(
    pool.map((account) => {
      const effectiveCap = groupDailyCap(capInput(account), scope.group, at);
      const sentToday = sent.get(account.id) ?? 0;
      // A spent week reads as a full day: the account has no room for this
      // kind until old invitations age out of the window.
      const weekFull = perWeek !== undefined && (week?.get(account.id) ?? 0) >= perWeek;
      return {
        id: account.id,
        status: account.status,
        effectiveCap,
        sentToday: weekFull ? Math.max(sentToday, effectiveCap) : sentToday,
        lastUsedAt: used.get(account.id) ?? null,
      };
    }),
    sticky,
  );

  if (choice.kind === 'picked') {
    return { choice, account: pool.find((account) => account.id === choice.id)! };
  }
  if (choice.kind === 'deferred') {
    return { choice, retryAt: nextUtcDay(at).toISOString() };
  }
  return { choice };
}

/**
 * The account one action to this person should go out from, or `undefined`
 * when none may send it now.
 *
 * Undefined covers both "no active account" and "every account is at today's
 * cap"; callers that need to tell those apart use `chooseSender`.
 */
export async function pickSender(
  db: Client,
  workspaceId: string,
  network: SenderNetwork,
  personId?: string,
  at?: Date,
): Promise<SenderAccount | undefined> {
  const selection = await chooseSender(db, {
    workspaceId,
    network,
    ...(personId ? { personId } : {}),
    ...(at ? { at } : {}),
  });
  return selection.account;
}

/** A human-readable reason for a deferral, for holds and job logs. */
export function describeDeferral(choice: PoolChoice): string {
  if (choice.kind !== 'deferred') return '';
  if (choice.reason === 'continuity_capped') {
    return "the account already talking to this person has reached today's cap";
  }
  if (choice.reason === 'continuity_paused') {
    return 'the account already talking to this person is paused';
  }
  return "every sending account has reached today's cap";
}

/** Records which account an action goes out from. Written before the send. */
export async function assignSender(db: Client, actionId: string, accountId: string): Promise<void> {
  await db.execute({
    sql: `UPDATE actions SET sender_account_id = ? WHERE id = ?`,
    args: [accountId, actionId],
  });
}

/**
 * What a network's active accounts can send on the day `at` falls in, in total.
 *
 * The social scheduler spaces approved posts by this. `accounts` is zero when
 * nothing is connected, which the scheduler reads as "keep the old
 * single-account pacing" — the job will report that nothing is connected when
 * it runs, exactly as it always has.
 */
export async function poolCapacity(
  db: Client,
  workspaceId: string,
  network: SenderNetwork,
  at: Date,
  /** The action kind; its per-kind cap applies to each account in the pool. */
  kind?: string,
): Promise<{ accounts: number; capacity: number; weeklyCapacity?: number }> {
  const pool = (await loadPool(db, workspaceId, network)).filter(
    (account) => account.status === 'active',
  );
  const group = capGroupFor(kind);
  const perWeek = groupWeeklyCap(network, group);
  return {
    accounts: pool.length,
    capacity: pool.reduce((sum, account) => sum + groupDailyCap(capInput(account), group, at), 0),
    ...(perWeek === undefined ? {} : { weeklyCapacity: perWeek * pool.length }),
  };
}

// ------------------------------------------------------------------ listing

export interface SenderView {
  readonly id: string;
  readonly network: SenderNetwork;
  readonly label: string | null;
  readonly handle: string | null;
  readonly status: string;
  readonly statusReason: string | null;
  /** The cap as set, or null when it is the network default. */
  readonly dailyCap: number | null;
  /** The cap actually being worked towards. */
  readonly configuredCap: number;
  /** Today's cap after warm-up and status. Zero when not active. */
  readonly effectiveCapToday: number;
  readonly sentToday: number;
  readonly remainingToday: number;
  readonly warmup: {
    readonly enabled: boolean;
    readonly startedAt: string | null;
    /** Day of warm-up, 0 on the day it started. Null when off. */
    readonly day: number | null;
    /** The ramp's allowance today, before the configured cap. */
    readonly rampCapToday: number | null;
    readonly complete: boolean;
  };
  readonly lastUsedAt: string | null;
  readonly connectedAt: string;
}

/** Every sending account in the workspace, with today's numbers. */
export async function listSenders(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<SenderView[]> {
  const rows = await queryAll<AccountRow>(
    db,
    `SELECT ${ACCOUNT_COLUMNS} FROM integration_accounts
      WHERE workspace_id = ? AND network IN ('email', 'linkedin', 'x')
      ORDER BY network ASC, created_at ASC, id ASC`,
    [workspaceId],
  );
  const accounts = rows.map(toAccount);
  const ids = accounts.map((account) => account.id);
  const [sent, used] = await Promise.all([sentOn(db, ids, at), lastUsed(db, ids)]);

  return accounts.map((account) => toView(account, at, sent, used));
}

function toView(
  account: SenderAccount,
  at: Date,
  sent: Map<string, number>,
  used: Map<string, string>,
): SenderView {
  const input = capInput(account);
  const effective = effectiveDailyCap(input, at);
  const sentToday = sent.get(account.id) ?? 0;
  const warming = account.warmupEnabled && account.warmupStartedAt !== null;
  const day = warming ? warmupDay(account.warmupStartedAt!, at) : null;

  return {
    id: account.id,
    network: account.network,
    label: account.label,
    handle: account.handle,
    status: account.status,
    statusReason: account.statusReason,
    dailyCap: account.dailyCap,
    configuredCap: configuredCap(input),
    effectiveCapToday: effective,
    sentToday,
    remainingToday: Math.max(0, effective - sentToday),
    warmup: {
      enabled: account.warmupEnabled,
      startedAt: account.warmupStartedAt,
      day,
      rampCapToday: day === null ? null : warmupCap(account.network, day),
      complete: warmupComplete(input, at),
    },
    lastUsedAt: used.get(account.id) ?? null,
    connectedAt: account.createdAt,
  };
}

export async function senderView(
  db: Client,
  workspaceId: string,
  accountId: string,
  at: Date = new Date(),
): Promise<SenderView | undefined> {
  const account = await loadSender(db, workspaceId, accountId);
  if (!account) return undefined;
  const [sent, used] = await Promise.all([
    sentOn(db, [account.id], at),
    lastUsed(db, [account.id]),
  ]);
  return toView(account, at, sent, used);
}

// ------------------------------------------------------------------ editing

export class SenderPoolError extends Error {
  readonly code: 'not_found' | 'invalid' | 'needs_reconnect';
  constructor(code: SenderPoolError['code'], message: string) {
    super(message);
    this.name = 'SenderPoolError';
    this.code = code;
  }
}

export interface SenderPatch {
  readonly label?: string | null;
  /** Null restores the network default. */
  readonly dailyCap?: number | null;
  /** True pauses, false resumes. */
  readonly paused?: boolean;
  readonly warmup?: boolean;
}

/**
 * Changes what a human may change about an account.
 *
 * Resuming clears the account's health as well as its status: the bounces
 * that stopped it are the reason it stopped, and counting them again on the
 * next bounce would stop it straight back. A revoked account cannot be
 * resumed — its credential is dead, and only connecting it again fixes that.
 *
 * Switching warm-up on starts the ramp from today. Switching it back on after
 * a gap restarts rather than resumes, which errs towards the slow side: an
 * account that has been idle for weeks has lost the reputation it built.
 */
export async function updateSender(
  db: Client,
  workspaceId: string,
  accountId: string,
  patch: SenderPatch,
): Promise<SenderView> {
  const account = await loadSender(db, workspaceId, accountId);
  if (!account) throw new SenderPoolError('not_found', 'no such sending account');

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const stamp = now();

  if (patch.label !== undefined) {
    const label = patch.label === null ? null : patch.label.trim().slice(0, 80) || null;
    sets.push('label = ?');
    args.push(label);
  }

  if (patch.dailyCap !== undefined) {
    if (
      patch.dailyCap !== null &&
      (!Number.isInteger(patch.dailyCap) || patch.dailyCap < 0 || patch.dailyCap > 10_000)
    ) {
      throw new SenderPoolError('invalid', 'a daily cap is a whole number from 0 to 10000');
    }
    sets.push('daily_cap = ?');
    args.push(patch.dailyCap);
  }

  if (patch.paused === true && account.status !== 'paused') {
    if (account.status === 'revoked') {
      throw new SenderPoolError('needs_reconnect', 'this account was signed out; reconnect it');
    }
    sets.push("status = 'paused'", 'status_reason = ?');
    args.push('paused by hand');
  }

  if (patch.paused === false && account.status !== 'active') {
    if (account.status === 'revoked') {
      throw new SenderPoolError('needs_reconnect', 'this account was signed out; reconnect it');
    }
    sets.push("status = 'active'", 'status_reason = NULL', 'health_reset_at = ?');
    args.push(stamp);
  }

  if (patch.warmup === true && !account.warmupEnabled) {
    sets.push('warmup_enabled = 1', 'warmup_started_at = ?');
    args.push(stamp);
  }
  if (patch.warmup === false && account.warmupEnabled) {
    sets.push('warmup_enabled = 0');
  }

  if (sets.length > 0) {
    await db.execute({
      sql: `UPDATE integration_accounts SET ${sets.join(', ')}, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
      args: [...args, stamp, accountId, workspaceId],
    });
  }

  return (await senderView(db, workspaceId, accountId))!;
}

/**
 * Removes one account from the pool.
 *
 * Its credential goes with it, as a disconnect always has. Actions it sent
 * keep their `sender_account_id`, which now points nowhere: continuity reads
 * that as "gone for good" and moves those people to another account.
 */
export async function removeSender(
  db: Client,
  workspaceId: string,
  accountId: string,
): Promise<boolean> {
  const account = await loadSender(db, workspaceId, accountId);
  if (!account) return false;

  await db.execute({
    sql: `DELETE FROM integration_accounts WHERE id = ? AND workspace_id = ?`,
    args: [accountId, workspaceId],
  });

  const remaining = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM integration_accounts WHERE integration_id = ?`,
    [account.integrationId],
  );
  if (Number(remaining?.n ?? 0) === 0) {
    await db.execute({
      sql: `UPDATE integrations SET status = 'disconnected', updated_at = ? WHERE id = ?`,
      args: [now(), account.integrationId],
    });
  }
  return true;
}

// ------------------------------------------------------------------ connecting

export interface PoolAccountInput {
  readonly workspaceId: string;
  readonly integrationId: string;
  readonly network: SenderNetwork;
  /**
   * What makes two connections the same account: the mailbox login, the X
   * user id, the LinkedIn member URN. Empty when it could not be learned
   * (verification skipped), which matches the one other account that also
   * could not be identified — the pre-pool behaviour of replacing it.
   */
  readonly identity: string;
  readonly handle: string | null;
  readonly accessTokenEnc: string;
  readonly refreshTokenEnc?: string | null;
  readonly scopes: string;
  readonly expiresAt?: string | null;
  readonly configJson?: string | null;
}

/**
 * Adds an account to the pool, or refreshes the one with the same identity.
 *
 * Connecting used to delete whatever was there and insert the new one, which
 * made "connect a second mailbox" silently mean "replace the first". Now a
 * different identity is a new account and the same identity is a reconnect:
 * its credential, handle and configuration are replaced (so a revoked
 * password is not kept readable) while its label, cap, warm-up and sending
 * history stay, because it is still the same account to the provider.
 *
 * A new account starts warming up the moment it is connected.
 */
export async function upsertPoolAccount(
  db: Client,
  input: PoolAccountInput,
): Promise<{ id: string; created: boolean }> {
  const stamp = now();
  const unidentified = `SELECT id FROM integration_accounts
      WHERE workspace_id = ? AND network = ?
        AND (external_account_id IS NULL OR external_account_id = '')
      ORDER BY created_at ASC LIMIT 1`;

  // An account whose identity was never learned cannot be told apart from
  // this one, so it is treated as this one — which is exactly what connecting
  // did before pools, and keeps a half-configured account from lingering in
  // the pool beside the real one.
  const existing =
    (input.identity
      ? await queryOne<{ id: string }>(
          db,
          `SELECT id FROM integration_accounts
            WHERE workspace_id = ? AND network = ? AND external_account_id = ?
            ORDER BY created_at ASC LIMIT 1`,
          [input.workspaceId, input.network, input.identity],
        )
      : undefined) ??
    (await queryOne<{ id: string }>(db, unidentified, [input.workspaceId, input.network]));

  if (existing) {
    await db.execute({
      sql: `UPDATE integration_accounts
               SET integration_id = ?, external_account_id = ?, handle = ?, access_token_enc = ?,
                   refresh_token_enc = ?, scopes = ?, expires_at = ?, config_json = ?,
                   status = 'active', status_reason = NULL, updated_at = ?
             WHERE id = ?`,
      args: [
        input.integrationId,
        input.identity || null,
        input.handle,
        input.accessTokenEnc,
        input.refreshTokenEnc ?? null,
        input.scopes,
        input.expiresAt ?? null,
        input.configJson ?? null,
        stamp,
        existing.id,
      ],
    });
    return { id: existing.id, created: false };
  }

  const id = newId('integrationAccount');
  await db.execute({
    sql: `INSERT INTO integration_accounts (id, integration_id, workspace_id, network,
          external_account_id, handle, access_token_enc, refresh_token_enc, scopes, expires_at,
          config_json, status, warmup_enabled, warmup_started_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
    args: [
      id,
      input.integrationId,
      input.workspaceId,
      input.network,
      input.identity || null,
      input.handle,
      input.accessTokenEnc,
      input.refreshTokenEnc ?? null,
      input.scopes,
      input.expiresAt ?? null,
      input.configJson ?? null,
      stamp,
      stamp,
      stamp,
    ],
  });
  return { id, created: true };
}

// ------------------------------------------------------------------ health

/**
 * Stops an account the product has decided is unsafe to keep using.
 *
 * `error` rather than `paused`, so it reads as something to look at rather
 * than a choice somebody made, and the reason is kept in words — the
 * provider's own rejection, or the bounce rate — so the human looking has
 * something to act on.
 */
export async function markSenderError(
  db: Client,
  accountId: string,
  reason: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE integration_accounts SET status = 'error', status_reason = ?, updated_at = ?
           WHERE id = ? AND status = 'active'`,
    args: [reason.slice(0, 500), now(), accountId],
  });
}

async function insertEvent(
  db: Client,
  input: {
    workspaceId: string;
    accountId: string;
    kind: 'bounce' | 'auth_error';
    externalId?: string | undefined;
    detail?: string | undefined;
    at: string;
  },
): Promise<boolean> {
  try {
    await db.execute({
      sql: `INSERT INTO sender_events (id, workspace_id, account_id, kind, external_id, detail,
            occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('senderEvent'),
        input.workspaceId,
        input.accountId,
        input.kind,
        input.externalId ?? null,
        input.detail?.slice(0, 500) ?? null,
        input.at,
      ],
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('UNIQUE constraint failed')) return false;
    throw error;
  }
}

/**
 * Records one bounce against the account that sent it, and stops the account
 * when bounces have passed the threshold over its recent sends.
 *
 * Idempotent on `externalId`: the reply poller reads a week of mail every
 * time, and the same bounce must not count once per poll.
 */
export async function recordSenderBounce(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly externalId?: string | undefined;
    readonly detail?: string | undefined;
    readonly at?: string;
  },
): Promise<{ recorded: boolean; stopped: boolean }> {
  const recorded = await insertEvent(db, {
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    kind: 'bounce',
    externalId: input.externalId,
    detail: input.detail,
    at: input.at ?? now(),
  });
  if (!recorded) return { recorded, stopped: false };
  return { recorded, stopped: await evaluateSenderHealth(db, input.accountId) };
}

/**
 * Applies the bounce rule to an account's recent history. True when this call
 * stopped it.
 *
 * The window is the account's last `BOUNCE_WINDOW` completed sends since a
 * human last cleared its health, and the bounces counted are the ones that
 * arrived over the same stretch.
 */
export async function evaluateSenderHealth(db: Client, accountId: string): Promise<boolean> {
  const account = await queryOne<{ status: string; health_reset_at: string | null }>(
    db,
    `SELECT status, health_reset_at FROM integration_accounts WHERE id = ?`,
    [accountId],
  );
  if (!account || account.status !== 'active') return false;
  const since = account.health_reset_at ?? '';

  const window = await queryOne<{ n: number; oldest: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM (
       SELECT COALESCE(executed_at, created_at) AS sent_at FROM actions
        WHERE sender_account_id = ? AND status = 'completed'
          AND COALESCE(executed_at, created_at) > ?
        ORDER BY sent_at DESC LIMIT ?
     )`,
    [accountId, since, BOUNCE_WINDOW],
  );
  const sends = Number(window?.n ?? 0);
  // A full window starts at its oldest send; a partial one covers everything
  // since the reset, including bounces that beat their send's bookkeeping.
  const from = sends >= BOUNCE_WINDOW && window?.oldest ? window.oldest : since;

  const bounced = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM sender_events
      WHERE account_id = ? AND kind = 'bounce' AND occurred_at > ? AND occurred_at >= ?`,
    [accountId, since, from],
  );
  const bounces = Number(bounced?.n ?? 0);

  if (!bounceRateExceeded(sends, bounces)) return false;

  await markSenderError(
    db,
    accountId,
    `stopped automatically: ${bounces} bounce${bounces === 1 ? '' : 's'} across the last ` +
      `${sends} send${sends === 1 ? '' : 's'} is over the 5% limit. Clean the list, then resume.`,
  );
  return true;
}

/**
 * What a failed send says about the account it went out from.
 *
 * A rejected login stops the account at once. A refused recipient counts as
 * a bounce. Anything else — a timeout, a greylist — is the message's problem
 * rather than the account's and changes nothing here.
 */
export async function noteSendFailure(
  db: Client,
  input: { readonly workspaceId: string; readonly accountId: string; readonly message: string },
): Promise<'auth' | 'bounce' | 'other'> {
  if (isAuthFailure(input.message)) {
    await insertEvent(db, {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      kind: 'auth_error',
      detail: input.message,
      at: now(),
    });
    await markSenderError(
      db,
      input.accountId,
      `the provider rejected this account's login: ${input.message}`,
    );
    return 'auth';
  }
  if (isRecipientBounce(input.message)) {
    await recordSenderBounce(db, {
      workspaceId: input.workspaceId,
      accountId: input.accountId,
      detail: input.message,
    });
    return 'bounce';
  }
  return 'other';
}

export { DEFAULT_DAILY_CAP };
