/**
 * List quality at send time: the verification cache, bounce suppression and
 * the per-campaign bounce gate. The rules themselves are in
 * `@outreachgraph/domain` (`list-quality.ts`); this is where they meet rows.
 *
 * Autopilot is the only unattended email sender, and cadence email steps
 * become recommendations it sends, so gating here covers every automated
 * message without a second copy of the logic.
 */

import {
  bounceGateTripped,
  bounceRate,
  formatRate,
  statusFromEvidence,
  verificationFresh,
  type AddressStatus,
  type AddressVerification,
  type BounceWindow,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { verifyDomainCandidates, type VerifierDeps } from '@outreachgraph/providers';
import { emitEvent } from './events';

export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export async function readVerification(
  db: Client,
  address: string,
): Promise<AddressVerification | undefined> {
  const row = await queryOne<{ status: string; checked_at: string; reason: string | null }>(
    db,
    `SELECT status, checked_at, reason FROM email_verifications WHERE address = ?`,
    [normalizeAddress(address)],
  );
  if (!row) return undefined;
  return { status: row.status as AddressStatus, checkedAt: row.checked_at, reason: row.reason };
}

export async function recordVerification(
  db: Client,
  address: string,
  verdict: { readonly status: AddressStatus; readonly reason: string; readonly mx?: string },
  at: string = now(),
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO email_verifications (address, status, reason, mx, checked_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (address) DO UPDATE SET status = excluded.status,
            reason = excluded.reason, mx = excluded.mx, checked_at = excluded.checked_at`,
    args: [normalizeAddress(address), verdict.status, verdict.reason, verdict.mx ?? null, at],
  });
}

export type VerifyOutcome =
  | {
      readonly kind: 'known';
      readonly verification: AddressVerification;
      readonly checked: boolean;
    }
  /** The check could not be made now (DNS timeout, no budget left this run). */
  | { readonly kind: 'pending'; readonly reason: string };

/**
 * The address's verdict, asking the domain when the cached one is missing,
 * older than 90 days, or older than `notBefore` (a campaign re-verifying
 * after its bounce gate tripped).
 *
 * `allowCheck` false means only the cache may answer — the run's verification
 * budget is spent, and a stale entry is reported as pending, not trusted.
 * A bounced address stays `invalid` regardless of age: the bounce is the
 * strongest evidence there is, and re-probing a server that accepts at RCPT
 * and bounces later would only flip it back.
 */
export async function verifyAddress(
  db: Client,
  address: string,
  options: {
    readonly verifier?: VerifierDeps | undefined;
    readonly at: Date;
    readonly notBefore?: string | null | undefined;
    readonly allowCheck: boolean;
  },
): Promise<VerifyOutcome> {
  const cached = await readVerification(db, address);
  if (cached?.status === 'invalid' && cached.reason?.startsWith('bounced')) {
    return { kind: 'known', verification: cached, checked: false };
  }
  if (cached && verificationFresh(cached.checkedAt, options.at, { notBefore: options.notBefore })) {
    return { kind: 'known', verification: cached, checked: false };
  }
  // No verifier configured (tests, a host with DNS forbidden): the cache is
  // all there is, and an unchecked address is sendable as it always was.
  if (!options.verifier) {
    return cached
      ? { kind: 'known', verification: cached, checked: false }
      : {
          kind: 'known',
          verification: { status: 'unverified', checkedAt: options.at.toISOString() },
          checked: false,
        };
  }
  if (!options.allowCheck) {
    return { kind: 'pending', reason: 'waiting for its address to be verified' };
  }

  const normalized = normalizeAddress(address);
  const domain = normalized.split('@')[1];
  if (!domain) {
    const verdict = { status: 'invalid' as const, reason: 'not an email address' };
    await recordVerification(db, normalized, verdict, options.at.toISOString());
    return {
      kind: 'known',
      verification: { ...verdict, checkedAt: options.at.toISOString() },
      checked: true,
    };
  }

  try {
    const result = await verifyDomainCandidates(domain, [normalized], options.verifier);
    const verdict = statusFromEvidence({
      mx: result.mx,
      smtp: result.smtp,
      catchAll: result.catchAll,
      verdict: result.verdicts.get(normalized) ?? 'unknown',
    });
    const stamp = options.at.toISOString();
    await recordVerification(
      db,
      normalized,
      { ...verdict, ...(result.mx[0] ? { mx: result.mx[0] } : {}) },
      stamp,
    );
    return { kind: 'known', verification: { ...verdict, checkedAt: stamp }, checked: true };
  } catch (error) {
    // A resolver failure is not an answer. Nothing is cached, so the next run
    // asks again.
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'pending',
      reason: `its address could not be checked (${message.slice(0, 80)})`,
    };
  }
}

/**
 * A delivery report named this address: it never gets another message.
 *
 * Also ends every active cadence for the person it belonged to, with the
 * reason on the enrollment. A plan whose next three steps will all bounce is
 * not a plan.
 */
export async function markAddressBounced(
  db: Client,
  input: {
    readonly workspaceId: string;
    readonly address: string;
    readonly personId?: string | undefined;
    readonly detail?: string | undefined;
  },
): Promise<{ stoppedEnrollments: number }> {
  await recordVerification(db, input.address, {
    status: 'invalid',
    reason: `bounced${input.detail ? `: ${input.detail.slice(0, 160)}` : ''}`,
  });
  if (!input.personId) return { stoppedEnrollments: 0 };

  const result = await db.execute({
    sql: `UPDATE cadence_enrollments
             SET status = 'stopped', next_due_at = NULL, stopped_reason = ?, updated_at = ?
           WHERE workspace_id = ? AND person_id = ? AND status = 'active'`,
    args: ['their address bounced', now(), input.workspaceId, input.personId],
  });
  return { stoppedEnrollments: result.rowsAffected ?? 0 };
}

export interface CampaignBounceState {
  readonly campaignId: string;
  readonly windowStart: string;
  readonly window: BounceWindow;
  readonly rate: number;
  /** Set while the campaign is stopped for re-verification. */
  readonly pausedAt: string | null;
}

/** Sends and bounces since the campaign's window opened. */
export async function campaignBounceState(
  db: Client,
  campaignId: string,
): Promise<CampaignBounceState> {
  const health = await queryOne<{ window_start: string; paused_at: string | null }>(
    db,
    `SELECT window_start, paused_at FROM campaign_list_health WHERE campaign_id = ?`,
    [campaignId],
  );
  const windowStart = health?.window_start ?? '';

  const row = await queryOne<{ sends: number; bounces: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM interactions
         WHERE campaign_id = ? AND network = 'email' AND direction = 'outbound'
           AND occurred_at >= ?) AS sends,
       (SELECT COUNT(*) FROM interactions
         WHERE campaign_id = ? AND network = 'email' AND direction = 'automated'
           AND state = 'bounced' AND occurred_at >= ?) AS bounces`,
    [campaignId, windowStart, campaignId, windowStart],
  );
  const window = { sends: Number(row?.sends ?? 0), bounces: Number(row?.bounces ?? 0) };
  return {
    campaignId,
    windowStart,
    window,
    rate: bounceRate(window),
    pausedAt: health?.paused_at ?? null,
  };
}

/**
 * Reads the campaign's gate and trips it when the rate is over the line.
 *
 * Returns the state after any change, so the caller treats a campaign paused
 * by this call the same as one paused an hour ago.
 */
export async function applyCampaignBounceGate(
  db: Client,
  workspaceId: string,
  campaignId: string,
  at: Date,
): Promise<CampaignBounceState> {
  const state = await campaignBounceState(db, campaignId);
  if (state.pausedAt || !bounceGateTripped(state.window)) return state;

  const stamp = at.toISOString();
  await db.execute({
    sql: `INSERT INTO campaign_list_health (campaign_id, workspace_id, window_start, paused_at,
          paused_rate, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (campaign_id) DO UPDATE SET paused_at = excluded.paused_at,
            paused_rate = excluded.paused_rate, updated_at = excluded.updated_at`,
    args: [campaignId, workspaceId, state.windowStart, stamp, state.rate, stamp],
  });

  await emitEvent(db, {
    workspaceId,
    campaignId,
    phase: 'send',
    level: 'warn',
    message:
      `Paused sending: ${formatRate(state.rate)} of the last ${state.window.sends} messages ` +
      `bounced (over 2%). Re-verifying every queued address before it starts again.`,
    detail: { ...state.window, rate: state.rate },
  });

  return { ...state, pausedAt: stamp };
}

/**
 * Starts a paused campaign again on a fresh window.
 *
 * Called once a full autopilot pass found nothing in it still waiting for a
 * re-check. The old bounces stay on record but stop counting, since the list
 * they came from is no longer the list being sent.
 */
export async function resumeCampaign(
  db: Client,
  workspaceId: string,
  campaignId: string,
  at: Date,
  removed: number,
): Promise<void> {
  const stamp = at.toISOString();
  await db.execute({
    sql: `UPDATE campaign_list_health
             SET paused_at = NULL, window_start = ?, resumed_at = ?, updated_at = ?
           WHERE campaign_id = ?`,
    args: [stamp, stamp, stamp, campaignId],
  });
  await emitEvent(db, {
    workspaceId,
    campaignId,
    phase: 'send',
    level: 'success',
    message:
      `Resumed sending: every queued address was re-verified` +
      (removed > 0 ? ` and ${removed} that failed were dropped.` : '.'),
    detail: { removed },
  });
}

export interface ListHealthReport {
  readonly campaignId: string;
  readonly sends: number;
  readonly bounces: number;
  readonly bounceRate: number;
  readonly windowStart: string | null;
  readonly pausedAt: string | null;
  /** Verdicts for the addresses this campaign has sent to, by status. */
  readonly addresses: Readonly<Record<AddressStatus | 'unchecked', number>>;
}

/** What the list-health endpoint, CLI and MCP tool report. */
export async function listHealthReport(db: Client, campaignId: string): Promise<ListHealthReport> {
  const state = await campaignBounceState(db, campaignId);
  const rows = await queryAll<{ status: string | null; n: number }>(
    db,
    `SELECT ev.status AS status, COUNT(*) AS n FROM (
        SELECT DISTINCT contact_address FROM interactions
         WHERE campaign_id = ? AND network = 'email' AND direction = 'outbound'
           AND contact_address IS NOT NULL
      ) sent
      LEFT JOIN email_verifications ev ON ev.address = sent.contact_address
      GROUP BY ev.status`,
    [campaignId],
  );
  const addresses = { valid: 0, catch_all: 0, unverified: 0, invalid: 0, unchecked: 0 };
  for (const row of rows) {
    const key = (row.status ?? 'unchecked') as keyof typeof addresses;
    if (key in addresses) addresses[key] += Number(row.n);
  }
  return {
    campaignId,
    sends: state.window.sends,
    bounces: state.window.bounces,
    bounceRate: state.rate,
    windowStart: state.windowStart || null,
    pausedAt: state.pausedAt,
    addresses,
  };
}
