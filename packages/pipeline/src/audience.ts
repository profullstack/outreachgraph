/**
 * Watching the workspace's own audience.
 *
 * The loop is short because almost none of it is new. A reader returns who
 * engaged; `intakeSocialPeople` opens each of them exactly as a social client
 * hand-off does; the engagement becomes an `audience_engagement` signal with
 * the post as evidence; `runRules` gets a `signal_received` event, which is
 * the existing way a signal turns into an enrolment on a plan. Everything
 * after that — the policy engine, the capability matrix, human approval —
 * behaves as it does for anybody else.
 *
 * That is the whole design argument. A liker is a warmer stranger, not a
 * different kind of record, so the honest way to add them is a new source
 * feeding the machine the product already has rather than a second path
 * around it. In particular a like does not raise identity confidence: a handle
 * that clicked a heart is still a handle, so outbound stays gated until
 * something else works out who they are.
 *
 * What this module owns is the part that is genuinely new: idempotence across
 * re-reads, and what to do when a network refuses.
 */

import {
  engagementKey,
  engagementSummary,
  isAudienceKind,
  isAudienceMode,
  isAudienceNetwork,
  isDue,
  newId,
  relevanceFor,
  AUDIENCE_KINDS,
  AUDIENCE_SIGNAL_CONFIDENCE,
  type AudienceKind,
  type AudienceMode,
  type AudienceNetwork,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { AudienceEngagement, AudienceReader } from '@outreachgraph/providers';
import { intakeSocialPeople } from './social-intake';
import { runRules, signalEvent } from './rules';
import { emitEvent } from './events';

export interface AudienceWatch {
  readonly id: string;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly network: AudienceNetwork;
  readonly account: string;
  readonly mode: AudienceMode;
  readonly kinds: readonly AudienceKind[];
  readonly pollMinutes: number;
  readonly lookbackPosts: number;
  readonly perRunCap: number;
  readonly enabled: boolean;
  readonly lastPolledAt?: string | undefined;
  readonly lastError?: string | undefined;
}

interface WatchRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  network: string;
  account: string;
  mode: string;
  kinds_json: string;
  poll_minutes: number;
  lookback_posts: number;
  per_run_cap: number;
  enabled: number;
  last_polled_at: string | null;
  last_error: string | null;
}

const SELECT_WATCH = `SELECT id, workspace_id, campaign_id, network, account, mode, kinds_json,
                             poll_minutes, lookback_posts, per_run_cap, enabled,
                             last_polled_at, last_error
                        FROM audience_watches`;

function watchFrom(row: WatchRow): AudienceWatch {
  const kinds = parseKinds(row.kinds_json);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    // A row can only hold what `parseAudienceWatch` accepted, but the column is
    // text: a hand-edited database must not crash the sweep for every workspace.
    network: isAudienceNetwork(row.network) ? row.network : 'bluesky',
    account: row.account,
    mode: isAudienceMode(row.mode) ? row.mode : 'poll',
    kinds,
    pollMinutes: row.poll_minutes,
    lookbackPosts: row.lookback_posts,
    perRunCap: row.per_run_cap,
    enabled: row.enabled === 1,
    ...(row.last_polled_at ? { lastPolledAt: row.last_polled_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function parseKinds(json: string): readonly AudienceKind[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const kinds = (Array.isArray(parsed) ? parsed : [])
      .map((value) => String(value))
      .filter((value): value is AudienceKind => isAudienceKind(value));
    return kinds.length > 0 ? kinds : AUDIENCE_KINDS;
  } catch {
    return AUDIENCE_KINDS;
  }
}

// ------------------------------------------------------------------- storage

export interface SaveWatchInput {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly network: AudienceNetwork;
  readonly account: string;
  readonly mode: AudienceMode;
  readonly kinds: readonly AudienceKind[];
  readonly pollMinutes: number;
  readonly lookbackPosts: number;
  readonly perRunCap: number;
  readonly enabled: boolean;
}

/**
 * Creates or updates one watch, keyed on the account rather than an id.
 *
 * Watching an account that is already watched is somebody changing their mind
 * about which kinds to read, not an error and not a second watch — and it
 * keeps `last_polled_at`, so editing a watch does not re-ingest the window.
 */
export async function saveAudienceWatch(db: Client, input: SaveWatchInput): Promise<AudienceWatch> {
  const stamp = now();
  const existing = await queryOne<WatchRow>(
    db,
    `${SELECT_WATCH} WHERE workspace_id = ? AND campaign_id = ? AND network = ? AND account = ?`,
    [input.workspaceId, input.campaignId, input.network, input.account],
  );

  const id = existing?.id ?? newId('audienceWatch');
  const kinds = JSON.stringify([...input.kinds]);

  if (existing) {
    await db.execute({
      sql: `UPDATE audience_watches
               SET mode = ?, kinds_json = ?, poll_minutes = ?, lookback_posts = ?,
                   per_run_cap = ?, enabled = ?, updated_at = ?,
                   last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END
             WHERE id = ?`,
      args: [
        input.mode,
        kinds,
        input.pollMinutes,
        input.lookbackPosts,
        input.perRunCap,
        input.enabled ? 1 : 0,
        stamp,
        // Re-enabling clears the refusal that disabled it, so the next sweep
        // actually tries again instead of reading a stale reason.
        input.enabled ? 1 : 0,
        id,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO audience_watches (id, workspace_id, campaign_id, network, account, mode,
                                          kinds_json, poll_minutes, lookback_posts, per_run_cap,
                                          enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.workspaceId,
        input.campaignId,
        input.network,
        input.account,
        input.mode,
        kinds,
        input.pollMinutes,
        input.lookbackPosts,
        input.perRunCap,
        input.enabled ? 1 : 0,
        stamp,
        stamp,
      ],
    });
  }

  const row = await queryOne<WatchRow>(db, `${SELECT_WATCH} WHERE id = ?`, [id]);
  if (!row) throw new Error('audience watch vanished immediately after saving');
  return watchFrom(row);
}

export async function listAudienceWatches(
  db: Client,
  workspaceId: string,
  options: { readonly campaignId?: string } = {},
): Promise<readonly AudienceWatch[]> {
  const rows = await queryAll<WatchRow>(
    db,
    `${SELECT_WATCH} WHERE workspace_id = ?${options.campaignId ? ' AND campaign_id = ?' : ''}
      ORDER BY created_at ASC`,
    options.campaignId ? [workspaceId, options.campaignId] : [workspaceId],
  );
  return rows.map(watchFrom);
}

export async function getAudienceWatch(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<AudienceWatch | undefined> {
  const row = await queryOne<WatchRow>(db, `${SELECT_WATCH} WHERE workspace_id = ? AND id = ?`, [
    workspaceId,
    id,
  ]);
  return row ? watchFrom(row) : undefined;
}

export async function deleteAudienceWatch(
  db: Client,
  workspaceId: string,
  id: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM audience_watches WHERE workspace_id = ? AND id = ?`,
    args: [workspaceId, id],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

/** Watches whose poll interval has elapsed, oldest first. */
export async function dueAudienceWatches(
  db: Client,
  workspaceId: string,
  at: Date = new Date(),
): Promise<readonly AudienceWatch[]> {
  const rows = await queryAll<WatchRow>(
    db,
    `${SELECT_WATCH} WHERE workspace_id = ? AND enabled = 1 AND mode = 'poll'
      ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC`,
    [workspaceId],
  );

  return rows.map(watchFrom).filter((watch) => isDue(watch, watch.lastPolledAt, at));
}

// ----------------------------------------------------------------- recording

export interface RecordDeps {
  readonly db: Client;
  readonly now?: Date;
}

export interface RecordResult {
  /** Engagements the network reported, before dedupe. */
  readonly read: number;
  /** Engagements not seen before, which became signals. */
  readonly recorded: number;
  readonly peopleCreated: number;
  readonly rejected: number;
}

/**
 * Turns a batch of engagements into people, signals and rule firings.
 *
 * Shared by the poller and the hand-off route so a LinkedIn reaction somebody
 * pasted and a Bluesky like the watcher read produce identical rows. The only
 * difference is `source`, which is recorded.
 */
export async function recordEngagements(
  deps: RecordDeps,
  input: {
    readonly watch: AudienceWatch;
    readonly engagements: readonly AudienceEngagement[];
    readonly source: string;
  },
): Promise<RecordResult> {
  const { db } = deps;
  const watch = input.watch;
  const at = deps.now ?? new Date();
  const stamp = at.toISOString();

  let recorded = 0;
  let peopleCreated = 0;
  let rejected = 0;

  for (const engagement of input.engagements) {
    if (!watch.kinds.includes(engagement.kind)) continue;

    const key = engagementKey({
      kind: engagement.kind,
      actor: engagement.actor.handle,
      ...(engagement.subjectId ? { subject: engagement.subjectId } : {}),
    });

    // Claimed before the work, like a rule firing: the act is what we dedupe
    // on, so a crash between opening the person and writing the signal costs
    // one signal rather than producing a second one on the next tick.
    if (await alreadySeen(db, watch.id, key)) continue;

    const intake = await intakeSocialPeople(
      { db, now: at },
      {
        workspaceId: watch.workspaceId,
        campaignId: watch.campaignId,
        source: input.source,
        people: [
          {
            network: watch.network,
            handle: engagement.actor.handle,
            ...(engagement.actor.platformUserId
              ? { platformUserId: engagement.actor.platformUserId }
              : {}),
            ...(engagement.actor.displayName ? { displayName: engagement.actor.displayName } : {}),
            ...(engagement.actor.bio ? { bio: engagement.actor.bio } : {}),
            ...(engagement.actor.avatarUrl ? { avatarUrl: engagement.actor.avatarUrl } : {}),
            ...(engagement.actor.profileUrl ? { profileUrl: engagement.actor.profileUrl } : {}),
            ...(typeof engagement.actor.followers === 'number'
              ? { followers: engagement.actor.followers }
              : {}),
            via: engagement.kind,
          },
        ],
      },
    );

    const person = intake.people[0];
    if (!person) {
      rejected += 1;
      continue;
    }
    if (person.created) peopleCreated += 1;

    const summary = engagementSummary({
      kind: engagement.kind,
      actor: engagement.actor.handle,
      account: watch.account,
      ...(engagement.subjectText ? { subjectText: engagement.subjectText } : {}),
    });

    const signalId = newId('signal');
    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
                                 summary, evidence, source_url, source_timestamp, observed_at,
                                 confidence, relevance, sentiment)
            VALUES (?, ?, ?, ?, 'audience_engagement', ?, ?, ?, ?, ?, ?, ?, ?, 'positive')`,
      args: [
        signalId,
        watch.workspaceId,
        person.id,
        watch.network,
        engagement.kind,
        summary,
        // The post's own words. Without them a drafting model has nothing it
        // may quote, and an ungrounded draft is withheld rather than invented.
        engagement.subjectText ?? summary,
        engagement.subjectUrl ?? `${watch.network}:${watch.account}`,
        engagement.at ?? stamp,
        stamp,
        AUDIENCE_SIGNAL_CONFIDENCE,
        relevanceFor(engagement.kind),
      ],
    });

    await db.execute({
      sql: `INSERT OR IGNORE INTO audience_engagements
              (id, watch_id, workspace_id, person_id, signal_id, network, kind, actor_handle,
               engagement_key, subject_id, subject_url, occurred_at, observed_at, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('audienceEngagement'),
        watch.id,
        watch.workspaceId,
        person.id,
        signalId,
        watch.network,
        engagement.kind,
        engagement.actor.handle,
        key,
        engagement.subjectId ?? null,
        engagement.subjectUrl ?? null,
        engagement.at ?? null,
        stamp,
        input.source,
        stamp,
      ],
    });

    recorded += 1;

    // The rule engine is what turns a signal into an enrolment, and it is the
    // only thing that may: a rule can queue work but cannot send. Failure is
    // contained so one badly configured rule does not cost the rest of the
    // batch the people it just found.
    try {
      await runRules(
        db,
        watch.workspaceId,
        signalEvent({
          personId: person.id,
          campaignId: watch.campaignId,
          signalId,
          signalType: 'audience_engagement',
          summary,
          relevance: relevanceFor(engagement.kind),
          confidence: AUDIENCE_SIGNAL_CONFIDENCE,
        }),
      );
    } catch {
      // `runRules` records what it can itself; never fatal here.
    }
  }

  return { read: input.engagements.length, recorded, peopleCreated, rejected };
}

async function alreadySeen(db: Client, watchId: string, key: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM audience_engagements WHERE watch_id = ? AND engagement_key = ? LIMIT 1`,
    [watchId, key],
  );
  return row !== undefined;
}

// ------------------------------------------------------------------- running

export interface RunWatchDeps extends RecordDeps {
  /**
   * The reader for one watch, or undefined when the workspace has no usable
   * connection for that network.
   *
   * A factory rather than a fixed reader because the credentials belong to the
   * workspace: X needs its connected account's bearer, and Bluesky needs
   * nothing at all.
   */
  readonly resolveReader: (watch: AudienceWatch) => Promise<AudienceReader | undefined>;
}

export type RunWatchOutcome = 'ok' | 'unreadable' | 'disabled' | 'no_reader';

export interface RunWatchResult extends RecordResult {
  readonly watchId: string;
  readonly outcome: RunWatchOutcome;
  readonly detail?: string | undefined;
}

const EMPTY: RecordResult = { read: 0, recorded: 0, peopleCreated: 0, rejected: 0 };

/**
 * Reads one watch and records what it finds.
 *
 * The refusal handling is the point. A retryable failure (a rate limit, a 500)
 * leaves the watch enabled and stamps the reason, because the same call works
 * later. One that is not retryable — an unpaid API tier, a revoked grant —
 * disables the watch and tells the workspace, because retrying it every half
 * hour for a month produces nothing except a quota bill and a `last_error`
 * nobody reads.
 */
export async function runAudienceWatch(
  deps: RunWatchDeps,
  watch: AudienceWatch,
): Promise<RunWatchResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();

  const reader = await deps.resolveReader(watch);
  if (!reader) {
    const detail = `no connected ${watch.network} account to read the audience with`;
    await stampRun(db, watch.id, at, detail, { disable: false });
    return { ...EMPTY, watchId: watch.id, outcome: 'no_reader', detail };
  }

  const result = await reader.read({
    account: watch.account,
    kinds: watch.kinds,
    lookbackPosts: watch.lookbackPosts,
    limit: watch.perRunCap,
  });

  if (!result.ok) {
    await stampRun(db, watch.id, at, result.reason, { disable: !result.retryable });

    if (!result.retryable) {
      await emitEvent(db, {
        workspaceId: watch.workspaceId,
        phase: 'system',
        level: 'error',
        message: `Audience watch on @${watch.account} stopped: ${result.reason}`,
        detail: { watchId: watch.id, network: watch.network },
      });
    }

    return {
      ...EMPTY,
      watchId: watch.id,
      outcome: result.retryable ? 'unreadable' : 'disabled',
      detail: result.reason,
    };
  }

  const recorded = await recordEngagements(
    { db, now: at },
    { watch, engagements: result.engagements, source: `audience:${watch.network}` },
  );

  await stampRun(db, watch.id, at, null, { disable: false });

  if (recorded.recorded > 0) {
    await emitEvent(db, {
      workspaceId: watch.workspaceId,
      phase: 'discover',
      level: 'info',
      message:
        `${recorded.recorded} new engagement${recorded.recorded === 1 ? '' : 's'} with @${watch.account}` +
        `${recorded.peopleCreated > 0 ? `, ${recorded.peopleCreated} new person${recorded.peopleCreated === 1 ? '' : 's'}` : ''}`,
      detail: { watchId: watch.id, network: watch.network, campaignId: watch.campaignId },
    });
  }

  return { ...recorded, watchId: watch.id, outcome: 'ok' };
}

async function stampRun(
  db: Client,
  watchId: string,
  at: Date,
  error: string | null,
  options: { readonly disable: boolean },
): Promise<void> {
  await db.execute({
    sql: `UPDATE audience_watches
             SET last_polled_at = ?, last_error = ?, updated_at = ?
                 ${options.disable ? ', enabled = 0' : ''}
           WHERE id = ?`,
    args: [at.toISOString(), error, at.toISOString(), watchId],
  });
}

export interface AudienceSweepResult {
  readonly ran: number;
  readonly recorded: number;
  readonly peopleCreated: number;
  readonly stopped: number;
}

/**
 * Watches one sweep may read before leaving the rest to the next tick.
 *
 * One watch is not one request. A Bluesky watch reading likes, reposts and
 * replies over ten posts is around thirty round trips, so a workspace with
 * twenty watches all falling due together is six hundred sequential calls
 * inside a tick that is supposed to take a minute — the queue drain and the
 * send sweep sit behind it. Bounding the sweep keeps a tick a tick; the
 * watches that do not get a turn are still due on the next one, and
 * `dueAudienceWatches` returns the longest-waiting first, so nothing starves.
 */
const WATCHES_PER_SWEEP = 5;

/**
 * Runs the due watches in one workspace, oldest first, up to the cap.
 *
 * Sequential on purpose. These are reads against two rate-limited APIs on
 * behalf of one account, and the thing an audience watcher must never do is
 * look like a scraper to the network whose account it is protecting.
 */
export async function sweepAudienceWatches(
  deps: RunWatchDeps,
  input: { readonly workspaceId: string; readonly limit?: number },
): Promise<AudienceSweepResult> {
  const at = deps.now ?? new Date();
  const due = (await dueAudienceWatches(deps.db, input.workspaceId, at)).slice(
    0,
    input.limit ?? WATCHES_PER_SWEEP,
  );

  let ran = 0;
  let recorded = 0;
  let peopleCreated = 0;
  let stopped = 0;

  for (const watch of due) {
    try {
      const result = await runAudienceWatch(deps, watch);
      ran += 1;
      recorded += result.recorded;
      peopleCreated += result.peopleCreated;
      if (result.outcome === 'disabled') stopped += 1;
    } catch (error) {
      // One watch on a broken account must not cost the others their turn.
      await stampRun(
        deps.db,
        watch.id,
        at,
        error instanceof Error ? error.message : 'audience read failed',
        { disable: false },
      );
    }
  }

  return { ran, recorded, peopleCreated, stopped };
}

/** Workspaces holding at least one enabled polling watch. */
export async function workspacesWithAudienceWatches(db: Client): Promise<readonly string[]> {
  const rows = await queryAll<{ workspace_id: string }>(
    db,
    `SELECT DISTINCT workspace_id FROM audience_watches WHERE enabled = 1 AND mode = 'poll'`,
  );
  return rows.map((row) => row.workspace_id);
}
