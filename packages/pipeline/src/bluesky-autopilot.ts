/**
 * Autopilot for Bluesky: the follows and replies a workspace opted into.
 *
 * Email autopilot never touched Bluesky, so every Bluesky card on a
 * trusted-automation campaign waited in Needs you: about 1,500 follows in one
 * workspace. A workspace that turns on `bluesky_autopilot` has them carried
 * out here, and nowhere faster than a person clicking through them would:
 *
 *   - at most one action per tick, and never within `MIN_GAP_MS` of the last
 *     Bluesky action the workspace took, by hand or not;
 *   - a daily cap per kind (`DAILY_CAPS`), counted on completed actions;
 *   - a card that failed twice is left for a human;
 *   - an account Bluesky refuses pauses the workspace until the next UTC day.
 *
 * The policy engine is asked again from live rows, exactly as for email, and
 * only a plain `allow` goes out. Direct messages stay `manual_only` in the
 * capability matrix and are never sent from here.
 */

import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, isExecutable } from '@outreachgraph/policy';
import type { BlueskyAgent } from '@outreachgraph/providers';
import { actionCounts } from './autopilot';
import { agentForWorkspace } from './bluesky-account';
import { emitEvent } from './events';
import { holdReason } from './lead-screen';
import { budgetStatus } from './metering';
import { deliverBlueskyAction } from './outreach-bluesky';
import { AUTOPILOT_ACTOR } from './outreach-email';

/** Completed actions per UTC day, per kind. Well under what Bluesky tolerates from a person. */
export const DAILY_CAPS = { follow: 40, reply: 10 } as const;

/** The least time between two Bluesky actions from one workspace. */
export const MIN_GAP_MS = 6 * 60_000;

/** Failed attempts after which a card is left for a human. */
const MAX_ATTEMPTS = 2;

type AutoKind = keyof typeof DAILY_CAPS;

export interface BlueskyAutopilotDeps {
  readonly db: Client;
  readonly encryptionKey?: Buffer | undefined;
  readonly now?: Date;
  /** Injected in tests; defaults to logging in with the stored app password. */
  readonly agentFor?: (workspaceId: string) => Promise<BlueskyAgent | undefined>;
}

export type BlueskyAutopilotResult =
  | {
      readonly acted: true;
      readonly kind: AutoKind;
      readonly personId: string;
      readonly url: string;
    }
  | { readonly acted: false; readonly reason: string };

/** Workspaces whose account Bluesky refused, and until when they are left alone. */
const pausedUntil = new Map<string, string>();

export function resetBlueskyAutopilotPauses(): void {
  pausedUntil.clear();
}

/** Whether a workspace opted in. */
export async function blueskyAutopilotEnabled(db: Client, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ bluesky_autopilot: number | null }>(
    db,
    'SELECT bluesky_autopilot FROM workspace_settings WHERE workspace_id = ?',
    [workspaceId],
  );
  return Number(row?.bluesky_autopilot ?? 0) === 1;
}

interface Candidate {
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly person_id: string;
  readonly action: AutoKind;
  readonly budget_json: string | null;
  readonly display_name: string;
  readonly person_status: string;
  readonly outreach_eligible: number;
  readonly believed_minor: number;
  readonly identity_confidence: number;
  readonly min_outreach_confidence: number;
  readonly screen_findings: string | null;
  readonly draft_body: string | null;
}

/** One Bluesky action for one workspace, if one is due. */
export async function runBlueskyAutopilot(
  deps: BlueskyAutopilotDeps,
  workspaceId: string,
): Promise<BlueskyAutopilotResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();
  const stamp = at.toISOString();

  if (!(await blueskyAutopilotEnabled(db, workspaceId))) {
    return { acted: false, reason: 'Bluesky autopilot is off' };
  }
  const paused = pausedUntil.get(workspaceId);
  if (paused && paused > stamp) {
    return { acted: false, reason: `paused until ${paused}: the account was refused` };
  }

  // The gap counts every Bluesky action, including a human's, so autopilot
  // never lands on top of someone working the queue by hand.
  const last = await queryOne<{ last_at: string | null }>(
    db,
    `SELECT MAX(COALESCE(executed_at, created_at)) AS last_at FROM actions
      WHERE workspace_id = ? AND network = 'bluesky' AND status != 'failed'`,
    [workspaceId],
  );
  if (last?.last_at && at.getTime() - Date.parse(last.last_at) < MIN_GAP_MS) {
    return { acted: false, reason: 'waiting out the gap since the last Bluesky action' };
  }

  const dayStart = `${stamp.slice(0, 10)}T00:00:00.000Z`;
  const done = await queryOne<{ follows: number; replies: number }>(
    db,
    `SELECT SUM(CASE WHEN kind = 'follow' THEN 1 ELSE 0 END) AS follows,
            SUM(CASE WHEN kind = 'reply' THEN 1 ELSE 0 END) AS replies
       FROM actions
      WHERE workspace_id = ? AND network = 'bluesky' AND status = 'completed'
        AND executed_at >= ?`,
    [workspaceId, dayStart],
  );
  const room: AutoKind[] = [];
  if (Number(done?.follows ?? 0) < DAILY_CAPS.follow) room.push('follow');
  if (Number(done?.replies ?? 0) < DAILY_CAPS.reply) room.push('reply');
  if (room.length === 0) return { acted: false, reason: "today's Bluesky caps are spent" };

  const row = await queryOne<Candidate>(
    db,
    `SELECT r.id AS recommendation_id, r.campaign_id, r.person_id, r.action,
            c.budget_json, p.display_name, p.status AS person_status, p.outreach_eligible,
            p.believed_minor, p.identity_confidence, w.min_outreach_confidence,
            (SELECT ls.findings FROM lead_screens ls
              WHERE ls.workspace_id = r.workspace_id AND ls.person_id = p.id
                AND ls.allowed_at IS NULL) AS screen_findings,
            (SELECT d.body FROM drafts d WHERE d.recommendation_id = r.id
              ORDER BY d.created_at DESC LIMIT 1) AS draft_body
       FROM recommendations r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN people p ON p.id = r.person_id
       JOIN workspaces w ON w.id = r.workspace_id
      WHERE r.workspace_id = ? AND r.status = 'pending' AND r.network = 'bluesky'
        AND r.action IN (${room.map(() => '?').join(', ')})
        AND c.approval_mode = 'trusted_automation' AND c.status != 'archived'
        AND p.status = 'active' AND p.outreach_eligible = 1 AND p.believed_minor = 0
        AND EXISTS (SELECT 1 FROM social_identities si
                     WHERE si.person_id = p.id AND si.network = 'bluesky')
        AND (SELECT COUNT(*) FROM actions a
              WHERE a.recommendation_id = r.id AND a.status = 'failed') < ?
        -- A reply needs something to say.
        AND (r.action = 'follow' OR EXISTS (SELECT 1 FROM drafts d
              WHERE d.recommendation_id = r.id AND trim(d.body) <> ''))
      ORDER BY r.priority DESC, r.created_at ASC
      LIMIT 1`,
    [workspaceId, ...room, MAX_ATTEMPTS],
  );
  if (!row) return { acted: false, reason: 'no Bluesky card is due' };

  const budget = safeJson(row.budget_json);
  const counts = await actionCounts(db, workspaceId, row.person_id, at);
  const decision = evaluatePolicy({
    network: 'bluesky' as Network,
    action: row.action as ActionKind,
    approvalMode: 'trusted_automation',
    hasConnectedAccount: true,
    personSuppressed: row.person_status === 'suppressed' || row.outreach_eligible === 0,
    ...(holdReason(row.screen_findings)
      ? { personScreenedOut: holdReason(row.screen_findings) }
      : {}),
    personBelievedMinor: row.believed_minor === 1,
    personDeleted: row.person_status === 'deleted',
    identityConfidence: row.identity_confidence,
    minIdentityConfidence: row.min_outreach_confidence,
    actionsToday: Number(done?.follows ?? 0) + Number(done?.replies ?? 0),
    maxActionsPerDay: DAILY_CAPS.follow + DAILY_CAPS.reply,
    actionsToThisProspectThisWeek: counts.thisProspect,
    maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
    ...(counts.hoursSinceLast !== undefined
      ? { hoursSinceLastActionToProspect: counts.hoursSinceLast }
      : {}),
    budgetExhausted: (await budgetStatus(db, workspaceId, at)).exhausted,
  });
  if (!isExecutable(decision.decision, false)) {
    return { acted: false, reason: `${row.display_name}: ${decision.reason}` };
  }

  const agent = deps.agentFor
    ? await deps.agentFor(workspaceId)
    : await agentForWorkspace(db, workspaceId, deps.encryptionKey);
  if (!agent) {
    pausedUntil.set(workspaceId, nextUtcDay(at));
    return { acted: false, reason: 'no working Bluesky account is connected' };
  }

  const actionId = newId('action');
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, body, created_at)
          VALUES (?, ?, ?, ?, ?, 'bluesky', 'customer_managed', 'queued', ?, ?)`,
    args: [
      actionId,
      workspaceId,
      row.recommendation_id,
      row.person_id,
      row.action,
      row.action === 'reply' ? row.draft_body : null,
      now(),
    ],
  });

  const result = await deliverBlueskyAction(
    { db, agent },
    {
      workspaceId,
      actionId,
      actor: AUTOPILOT_ACTOR,
      policyVersion: decision.policyVersion,
    },
  );

  if (!result.sent) {
    if (/no longer authorised/i.test(result.reason)) {
      pausedUntil.set(workspaceId, nextUtcDay(at));
    }
    await emitEvent(db, {
      workspaceId,
      campaignId: row.campaign_id,
      personId: row.person_id,
      phase: 'social',
      level: 'error',
      message: `Could not ${row.action} ${row.display_name} on Bluesky: ${result.reason.slice(0, 200)}`,
      detail: { recommendationId: row.recommendation_id, actionId },
    });
    return { acted: false, reason: result.reason };
  }

  await emitEvent(db, {
    workspaceId,
    campaignId: row.campaign_id,
    personId: row.person_id,
    phase: 'social',
    level: 'success',
    message:
      row.action === 'follow'
        ? `Followed ${row.display_name} on Bluesky`
        : `Replied to ${row.display_name} on Bluesky`,
    detail: { recommendationId: row.recommendation_id, actionId, url: result.url },
  });

  return { acted: true, kind: row.action, personId: row.person_id, url: result.url };
}

function nextUtcDay(at: Date): string {
  const next = new Date(at);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
