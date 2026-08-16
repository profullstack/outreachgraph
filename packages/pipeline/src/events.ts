/**
 * What the workflow is doing, while it does it.
 *
 * Until now the pipeline reported itself exclusively through `console.log` in
 * the container. That is fine for debugging and useless as a product: a
 * campaign quietly working and a campaign quietly stuck look identical from the
 * outside, and the honest answer to "is it doing anything?" was to read Railway
 * logs. Every stage now says what it did, and the API streams that.
 *
 * Two design points worth stating, because both are load-bearing:
 *
 *   - **Events are written on the same connection as the work they describe.**
 *     Not a side channel, not an in-process bus. A bus loses everything on
 *     restart and cannot serve a client that reconnects, and this system's
 *     whole job is running unattended across restarts.
 *   - **The cursor is a row id, not a timestamp.** `seq` is monotonic, so
 *     "resume from 4812" is exact. Timestamps collide inside a millisecond and
 *     would either replay or skip events at the boundary.
 *
 * Emitting is best-effort by construction: `emitEvent` swallows its own
 * failures. A progress bar that can abort a crawl is a downgrade, and the
 * pipeline stages call this from inside their happy paths.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

/** The part of the workflow that spoke. Ordered as the work flows. */
export const WORKFLOW_PHASES = [
  'intake',
  'discover',
  'crawl',
  'identity',
  'research',
  'score',
  'draft',
  'send',
  'social',
  'notify',
  'system',
] as const;

export type WorkflowPhase = (typeof WORKFLOW_PHASES)[number];

export const WORKFLOW_LEVELS = ['info', 'success', 'warn', 'error'] as const;
export type WorkflowLevel = (typeof WORKFLOW_LEVELS)[number];

export interface WorkflowEventInput {
  readonly workspaceId: string;
  readonly campaignId?: string | undefined;
  readonly personId?: string | undefined;
  readonly phase: WorkflowPhase;
  readonly level?: WorkflowLevel;
  readonly message: string;
  readonly detail?: Record<string, unknown>;
}

export interface WorkflowEvent {
  readonly seq: number;
  readonly id: string;
  readonly campaignId?: string;
  readonly personId?: string;
  readonly phase: WorkflowPhase;
  readonly level: WorkflowLevel;
  readonly message: string;
  readonly detail: Record<string, unknown>;
  readonly occurredAt: string;
}

/**
 * Records one line of progress.
 *
 * Never throws. A stage that fails to log its own success must still have
 * succeeded, and the alternative — a crawl that completes its work and then
 * dies writing a progress row, leaving the job to retry the entire fetch — is
 * strictly worse than a missing line in a feed.
 */
export async function emitEvent(db: Client, input: WorkflowEventInput): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO workflow_events (id, workspace_id, campaign_id, person_id, phase,
            level, message, detail_json, occurred_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('workflowEvent'),
        input.workspaceId,
        input.campaignId ?? null,
        input.personId ?? null,
        input.phase,
        input.level ?? 'info',
        input.message.slice(0, 500),
        JSON.stringify(input.detail ?? {}),
        now(),
      ],
    });
  } catch {
    // Deliberately silent. See the note above.
  }
}

interface EventRow {
  readonly seq: number;
  readonly id: string;
  readonly campaign_id: string | null;
  readonly person_id: string | null;
  readonly phase: string;
  readonly level: string;
  readonly message: string;
  readonly detail_json: string;
  readonly occurred_at: string;
}

export interface ReadEventsQuery {
  readonly workspaceId: string;
  /** Exclusive. Zero or absent starts from the most recent page. */
  readonly sinceSeq?: number;
  readonly campaignId?: string | undefined;
  readonly limit?: number;
}

/**
 * Events after a cursor, oldest first.
 *
 * With no cursor this returns the *latest* page — reversed after the query, so
 * a client opening the page cold sees recent history rather than the first
 * things that ever happened in the workspace.
 */
export async function readEvents(db: Client, query: ReadEventsQuery): Promise<WorkflowEvent[]> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const conditions = ['workspace_id = ?'];
  const args: (string | number)[] = [query.workspaceId];

  if (query.campaignId) {
    conditions.push('campaign_id = ?');
    args.push(query.campaignId);
  }

  const cursor = query.sinceSeq ?? 0;
  if (cursor > 0) conditions.push('seq > ?');
  if (cursor > 0) args.push(cursor);

  // Ascending from a cursor so a stream delivers in order; descending without
  // one so the newest page is the one that comes back, then reversed.
  const order = cursor > 0 ? 'ASC' : 'DESC';
  args.push(limit);

  const rows = await queryAll<EventRow>(
    db,
    `SELECT seq, id, campaign_id, person_id, phase, level, message, detail_json, occurred_at
       FROM workflow_events
      WHERE ${conditions.join(' AND ')}
      ORDER BY seq ${order}
      LIMIT ?`,
    args,
  );

  const events = rows.map(toEvent);
  return cursor > 0 ? events : events.reverse();
}

function toEvent(row: EventRow): WorkflowEvent {
  let detail: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.detail_json);
    if (parsed && typeof parsed === 'object') detail = parsed as Record<string, unknown>;
  } catch {
    // A row whose detail will not parse is still a real event with a real
    // message; dropping it would hide progress over a formatting problem.
  }

  return {
    seq: row.seq,
    id: row.id,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
    ...(row.person_id ? { personId: row.person_id } : {}),
    phase: row.phase as WorkflowPhase,
    level: row.level as WorkflowLevel,
    message: row.message,
    detail,
    occurredAt: row.occurred_at,
  };
}

// ------------------------------------------------------------------ snapshot

export interface QueueSnapshot {
  readonly pending: number;
  readonly running: number;
  /** Failed permanently, i.e. out of attempts. */
  readonly failed: number;
  readonly doneToday: number;
  /** Pending work by kind, so "stuck on what" is answerable. */
  readonly byKind: Readonly<Record<string, number>>;
  /** When the oldest pending job was queued. Absent when nothing is waiting. */
  readonly oldestPendingAt?: string;
}

export interface SendingSnapshot {
  readonly configured: boolean;
  readonly verified: boolean;
  readonly provider?: string;
  readonly fromEmail?: string;
  readonly sentToday: number;
  readonly failedToday: number;
  readonly dailyCap: number;
}

export interface WorkflowStatus {
  readonly queue: QueueSnapshot;
  readonly sending: SendingSnapshot;
  readonly activeCampaigns: number;
  readonly autopilotCampaigns: number;
  /** True when there is work in flight right now. Drives the "live" indicator. */
  readonly busy: boolean;
  readonly latestSeq: number;
  readonly at: string;
}

/**
 * One read of everything the status panel shows.
 *
 * Assembled here rather than in the API so the same numbers can back the SSE
 * stream's periodic snapshot and the server-rendered first paint — two sources
 * for the same figure is how a UI ends up disagreeing with itself.
 */
export async function workflowStatus(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<WorkflowStatus> {
  const dayStart = `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;

  const [jobs, kinds, oldest, campaigns, sends, account, settings, head] = await Promise.all([
    queryOne<{ pending: number; running: number; failed: number; done_today: number }>(
      db,
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'done' AND finished_at >= ? THEN 1 ELSE 0 END) AS done_today
       FROM jobs WHERE workspace_id = ?`,
      [dayStart, workspaceId],
    ),
    queryAll<{ kind: string; n: number }>(
      db,
      `SELECT kind, COUNT(*) AS n FROM jobs
        WHERE workspace_id = ? AND status IN ('pending', 'running')
        GROUP BY kind`,
      [workspaceId],
    ),
    queryOne<{ created_at: string }>(
      db,
      `SELECT created_at FROM jobs
        WHERE workspace_id = ? AND status = 'pending'
        ORDER BY created_at LIMIT 1`,
      [workspaceId],
    ),
    queryOne<{ active: number; autopilot: number }>(
      db,
      `SELECT
         SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN status = 'active' AND approval_mode = 'trusted_automation'
                  THEN 1 ELSE 0 END) AS autopilot
       FROM campaigns WHERE workspace_id = ?`,
      [workspaceId],
    ),
    queryOne<{ sent: number; failed: number }>(
      db,
      `SELECT
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM actions WHERE workspace_id = ? AND created_at >= ?`,
      [workspaceId, dayStart],
    ),
    // The workspace's own mailbox, read from the same pair the policy engine
    // reads. A connected row here is already a verified one — `connectEmailAccount`
    // authenticates against the real server before it writes anything — so
    // "configured but not working" is a state this table cannot hold.
    queryOne<{ kind: string; config_json: string; status: string }>(
      db,
      `SELECT i.kind, i.config_json, ia.status
         FROM integrations i
         JOIN integration_accounts ia ON ia.integration_id = i.id
        WHERE i.workspace_id = ? AND i.kind = 'smtp' AND i.network = 'email'
        LIMIT 1`,
      [workspaceId],
    ),
    queryOne<{ autopilot_daily_cap: number }>(
      db,
      `SELECT autopilot_daily_cap FROM workspace_settings WHERE workspace_id = ?`,
      [workspaceId],
    ),
    queryOne<{ seq: number }>(
      db,
      `SELECT MAX(seq) AS seq FROM workflow_events WHERE workspace_id = ?`,
      [workspaceId],
    ),
  ]);

  const byKind: Record<string, number> = {};
  for (const row of kinds) byKind[row.kind] = row.n;

  // The sending address lives inside the integration's config blob rather than
  // its own column, and a blob that will not parse is reported as no address
  // rather than as a broken panel.
  const accountFrom = ((): string | undefined => {
    if (!account?.config_json) return undefined;
    try {
      const parsed: unknown = JSON.parse(account.config_json);
      const from = (parsed as { fromEmail?: unknown }).fromEmail;
      return typeof from === 'string' && from.length > 0 ? from : undefined;
    } catch {
      return undefined;
    }
  })();

  const pending = jobs?.pending ?? 0;
  const running = jobs?.running ?? 0;

  return {
    queue: {
      pending,
      running,
      failed: jobs?.failed ?? 0,
      doneToday: jobs?.done_today ?? 0,
      byKind,
      ...(oldest?.created_at ? { oldestPendingAt: oldest.created_at } : {}),
    },
    sending: {
      configured: account !== undefined && account !== null,
      verified: account?.status === 'active',
      ...(account?.kind ? { provider: account.kind } : {}),
      ...(accountFrom ? { fromEmail: accountFrom } : {}),
      sentToday: sends?.sent ?? 0,
      failedToday: sends?.failed ?? 0,
      dailyCap: settings?.autopilot_daily_cap ?? 25,
    },
    activeCampaigns: campaigns?.active ?? 0,
    autopilotCampaigns: campaigns?.autopilot ?? 0,
    busy: pending + running > 0,
    latestSeq: head?.seq ?? 0,
    at: at.toISOString(),
  };
}

/**
 * Removes progress rows past their usefulness.
 *
 * These accumulate at roughly one row per prospect per stage, which for a busy
 * workspace is thousands a day, and nothing reads a fortnight-old progress
 * line. The audit log — which does have to be kept — is a different table
 * precisely so this sweep can be aggressive without touching it.
 */
export async function pruneWorkflowEvents(db: Client, keepDays = 14): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000).toISOString();
  const result = await db.execute({
    sql: `DELETE FROM workflow_events WHERE occurred_at < ?`,
    args: [cutoff],
  });
  return result.rowsAffected;
}
