/**
 * Unattended sending (PRD §7.6 `trusted_automation`, §16, §27).
 *
 * Everything upstream of this already worked: a URL became a company, people,
 * signals, a score, a recommendation and a drafted message. Then it stopped,
 * because the only way a message could leave the product was a human copying
 * it into their own mail client. `POST /actions/:id/execute` did not send
 * anything — it recorded that a send had happened elsewhere.
 *
 * This is the unattended executor. It is no longer the only way outreach
 * reaches the wire: approving a card in the queue now sends too, through the
 * same `outreach-email` mechanics, because a product that drafts a message and
 * then tells a human to go and paste it somewhere has not finished the job.
 * What is still unique here is the *lack* of a human — and that is what these
 * two rules exist for:
 *
 *   - **Policy is re-checked here, from live state.** The decision stored on
 *     the recommendation is a snapshot from generation time and is never
 *     trusted. Suppression, deletion, rate limits and identity confidence are
 *     all re-read; a campaign switched off autopilot ten seconds ago does not
 *     send.
 *   - **Autopilot is opt-in per campaign and gated per capability.** The
 *     policy engine only skips approval for `trusted_automation` *and* a
 *     capability the matrix marks `official_api` or `customer_managed`. Email
 *     is customer-managed. Nothing else currently qualifies, which is why this
 *     sends email and nothing else.
 *
 * A failed send is recorded on the action and the recommendation is left where
 * it was, so the next tick retries rather than silently dropping a lead.
 */

import { INTERNAL_ACTION_KINDS, newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { evaluatePolicy, isExecutable } from '@outreachgraph/policy';
import type { Mailer } from '@outreachgraph/email';
import { draftForRecommendation, type TextModel } from '@outreachgraph/ai';
import { mailerForWorkspace } from './email-account';
import { emitEvent } from './events';
import {
  defaultEmailSubject,
  loadOutreachSettings,
  pickEmailRecipient,
  recordEmailFailure,
  recordEmailSent,
  AUTOPILOT_ACTOR,
} from './outreach-email';
import { trackLinksInBody } from './engagement';
import { budgetStatus } from './metering';

export interface AutopilotDeps {
  readonly db: Client;
  /**
   * The platform sender, used by any workspace that has not connected its own
   * mailbox. Omit it and a workspace without a mailbox sends nothing — the
   * queue still runs and still reports why.
   */
  readonly mailer?: Mailer;
  /**
   * Unlocks a workspace's stored SMTP password. Without it, connected
   * mailboxes are unreadable and every workspace falls back to `mailer`.
   */
  readonly encryptionKey?: Buffer | undefined;
  /**
   * Origin tracked links resolve from, for workspaces that opted in.
   *
   * Absent means links are sent untouched however the setting is configured.
   * Autopilot sends unattended, so a rewritten link pointing at an origin that
   * does not serve `/t/:token` would break every message in a run before
   * anyone noticed.
   */
  readonly appUrl?: string | undefined;
  /** Reply-to for outbound mail. Falls back to the workspace owner. */
  readonly replyTo?: string;
  /**
   * Writes a message for a recommendation that has none.
   *
   * Drafting happens once, when the recommendation is created, and nothing
   * ever retried it — so a composer that was briefly unavailable, or a run
   * that hit a grounding check, left the lead permanently undraftable. The
   * send sweep then found it every tick, logged "no drafted message" and moved
   * on: one prospect in production accumulated 98 identical warnings while
   * nothing tried to fix the thing being warned about.
   *
   * Omit it to keep the old behaviour of reporting and skipping.
   */
  readonly model?: TextModel;
  readonly now?: Date;
}

export interface SentOutreach {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly personId: string;
  readonly personName: string;
  readonly recommendationId: string;
  readonly actionId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly companyName?: string;
  /** True when the address is a shared company inbox rather than the person's. */
  readonly toSharedInbox: boolean;
}

export interface SkippedOutreach {
  readonly recommendationId: string;
  readonly personName: string;
  readonly reason: string;
}

export interface AutopilotResult {
  readonly sent: readonly SentOutreach[];
  readonly skipped: readonly SkippedOutreach[];
  readonly failed: number;
}

interface Candidate {
  readonly recommendation_id: string;
  readonly campaign_id: string;
  readonly person_id: string;
  readonly action: string;
  readonly network: string;
  readonly approval_mode: string;
  readonly budget_json: string;
  readonly display_name: string;
  readonly person_status: string;
  readonly believed_minor: number;
  readonly outreach_eligible: number;
  readonly identity_confidence: number;
  readonly min_outreach_confidence: number;
  readonly draft_id: string | null;
  readonly subject: string | null;
  readonly body: string | null;
  readonly checks_json: string | null;
  readonly company_name: string | null;
  readonly company_contact_email: string | null;
  readonly person_email: string | null;
  readonly failed_attempts: number;
}

/** Attempts before a recommendation is left alone for a human to look at. */
const MAX_SEND_ATTEMPTS = 3;

/**
 * Sends everything due for one workspace.
 *
 * Ordered by priority so a daily cap spends itself on the best leads rather
 * than on whichever rows the planner happened to return first.
 */
export async function runAutopilot(
  deps: AutopilotDeps,
  workspaceId: string,
): Promise<AutopilotResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();

  const sent: SentOutreach[] = [];
  const skipped: SkippedOutreach[] = [];
  let failed = 0;

  const settings = await loadOutreachSettings(db, workspaceId);
  const cap = settings.autopilot_daily_cap;

  // The workspace's own mailbox when it has connected one, the platform sender
  // otherwise. Resolved once per run rather than per message so a workspace
  // with a hundred queued leads opens one SMTP connection, not a hundred.
  const sender = await mailerForWorkspace(db, workspaceId, {
    encryptionKey: deps.encryptionKey,
    fallback: deps.mailer,
  });

  let today = await countActionsToday(db, workspaceId, at);
  if (today >= cap) {
    return { sent, skipped, failed };
  }

  const candidates = await queryAll<Candidate>(
    db,
    `SELECT r.id AS recommendation_id, r.campaign_id, r.person_id, r.action, r.network,
            c.approval_mode, c.budget_json,
            p.display_name, p.status AS person_status, p.believed_minor,
            p.outreach_eligible, p.identity_confidence,
            w.min_outreach_confidence,
            d.id AS draft_id, d.subject, d.body, d.checks_json,
            co.name AS company_name, co.contact_email AS company_contact_email,
            (SELECT si.handle FROM social_identities si
              WHERE si.person_id = p.id AND si.network = 'email'
              ORDER BY si.confidence DESC LIMIT 1) AS person_email,
            (SELECT COUNT(*) FROM actions a
              WHERE a.recommendation_id = r.id AND a.status = 'failed') AS failed_attempts
       FROM recommendations r
       JOIN campaigns c ON c.id = r.campaign_id
       JOIN people p ON p.id = r.person_id
       JOIN workspaces w ON w.id = r.workspace_id
       LEFT JOIN drafts d ON d.recommendation_id = r.id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE r.workspace_id = ?
        AND r.status = 'pending'
        AND c.approval_mode = 'trusted_automation'
        AND c.status != 'archived'
        AND r.action = 'send_email'
        AND r.network = 'email'
        AND p.status = 'active'
      ORDER BY r.priority DESC, r.created_at ASC
      LIMIT ?`,
    [workspaceId, Math.max(cap - today, 0)],
  );

  for (const row of candidates) {
    if (today >= cap) break;

    // Skips are reported, not swallowed.
    //
    // "No address published for this person" and "still requires human
    // approval" are the two reasons a campaign sits at a stage looking broken,
    // and neither is an error anywhere else in the system — so if they are not
    // surfaced here they are not surfaced at all.
    const note = async (reason: string): Promise<void> => {
      skipped.push({
        recommendationId: row.recommendation_id,
        personName: row.display_name,
        reason,
      });

      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'warn',
        message: `Held back ${row.display_name}: ${reason}`,
        detail: { reason, recommendationId: row.recommendation_id },
      });
    };

    // Give up after enough failed attempts.
    //
    // A failed send leaves the recommendation pending so the next tick retries,
    // which is right for a rate limit or a blip and wrong for anything
    // permanent. An invalid API key produced three attempts per recommendation
    // within a minute of testing and would have produced thousands a day —
    // each one a row, and each one a request to a provider that has already
    // said no. The lead stays pending for a human rather than being deleted.
    if (row.failed_attempts >= MAX_SEND_ATTEMPTS) {
      await note(`giving up after ${row.failed_attempts} failed sends`);
      continue;
    }

    // A recommendation with no draft has nothing to send — but "the composer
    // declined to write one" and "nobody ever tried" are different states, and
    // until now they produced the same warning on every tick forever. Drafting
    // happened once, at creation; nothing retried it. One prospect in
    // production collected 98 identical "no drafted message" warnings while
    // nothing attempted the thing being warned about.
    let body = row.body;
    let checks = row.checks_json;

    if (!body || !body.trim()) {
      const written = deps.model
        ? await draftForRecommendation(db, deps.model, row.recommendation_id).catch(() => undefined)
        : undefined;

      const drafted = written?.ok
        ? await queryOne<{ body: string; checks_json: string | null }>(
            db,
            `SELECT body, checks_json FROM drafts WHERE recommendation_id = ?
          ORDER BY created_at DESC LIMIT 1`,
            [row.recommendation_id],
          )
        : undefined;

      if (!drafted?.body?.trim()) {
        // A composer that refuses to ground a claim is a legitimate outcome
        // and stays a no-send. Saying *why* is the difference between a queue
        // that looks broken and one visibly waiting for a human.
        await note(
          written && !written.ok
            ? `no drafted message (${written.reason ?? 'the composer declined'})`
            : 'no drafted message',
        );
        continue;
      }

      body = drafted.body;
      checks = drafted.checks_json;

      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'draft',
        level: 'info',
        message: `Wrote the missing message for ${row.display_name}`,
        detail: { recommendationId: row.recommendation_id },
      });
    }

    // Narrowing for the compiler as much as for safety: every path above
    // either set a non-empty body or skipped this candidate.
    if (!body || !body.trim()) {
      await note('no drafted message');
      continue;
    }

    // The quality gates already ran when the draft was written. A draft that
    // failed one is never shown to a human, so it must never be sent by a
    // machine either.
    if (hasFailingCheck(checks)) {
      await note('the draft did not pass its quality checks');
      continue;
    }

    const recipient = pickEmailRecipient(row);
    if (!recipient) {
      await note('no address published for this person or their company');
      continue;
    }

    // ------------------------------------------------------------- policy
    //
    // Re-evaluated from live rows, never from the stored snapshot.
    const counts = await actionCounts(db, workspaceId, row.person_id, at);

    // Counted against the mailbox as well as the person.
    //
    // Both limits are needed and neither substitutes for the other. The
    // per-person limit answers "how often do we contact this human"; this one
    // answers "how much mail does this mailbox get", and a prospect with no
    // personal address falls back to their employer's shared inbox — so N
    // colleagues are N separate people, each comfortably inside its own weekly
    // limit, while one `support@` receives N messages.
    //
    // The policy engine grew these gates in #34, but only the human approval
    // route in `app.ts` ever filled them in. They are optional inputs, so
    // omitting them does not fail loudly — it silently disables them, and this
    // is the unattended path that sends at volume. In production the manual
    // route was protected and autopilot was not, which is how an address that
    // had already been written to that afternoon was written to again hours
    // after the fix shipped.
    const addressUsage = await addressCounts(db, workspaceId, recipient.address, at);
    const budget = safeJson(row.budget_json);

    // Read inside the loop rather than once per run: a workspace can cross its
    // monthly allowance partway through a sweep, and a snapshot taken before
    // the first send would let the rest of the batch through on a stale count.
    const budgetState = await budgetStatus(db, workspaceId, at);

    const decision = evaluatePolicy({
      network: row.network as Network,
      action: row.action as ActionKind,
      approvalMode: row.approval_mode as 'trusted_automation',
      hasConnectedAccount: sender !== undefined,
      personSuppressed: row.person_status === 'suppressed' || row.outreach_eligible === 0,
      personBelievedMinor: row.believed_minor === 1,
      personDeleted: row.person_status === 'deleted',
      identityConfidence: row.identity_confidence,
      minIdentityConfidence: row.min_outreach_confidence,
      actionsToday: today,
      maxActionsPerDay: Math.min(numberOr(budget.maxActionsPerDay, 50), cap),
      actionsToThisProspectThisWeek: counts.thisProspect,
      maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
      ...(counts.hoursSinceLast !== undefined
        ? { hoursSinceLastActionToProspect: counts.hoursSinceLast }
        : {}),
      actionsToThisAddressThisWeek: addressUsage.thisWeek,
      maxActionsPerAddressPerWeek: numberOr(budget.maxActionsPerAddressPerWeek, 1),
      addressShared: recipient.shared,
      ...(addressUsage.hoursSinceLast !== undefined
        ? { hoursSinceLastActionToAddress: addressUsage.hoursSinceLast }
        : {}),
      budgetExhausted: budgetState.exhausted,
    });

    // `approved: false` is the whole point. Autopilot holds no approval, so
    // only a decision of plain `allow` gets through — `allow_with_approval`
    // means a human still has to look at it, and reaching here with that would
    // mean the capability matrix no longer marks email customer-managed.
    // Sending anyway would be exactly what the approval default prevents.
    if (!isExecutable(decision.decision, false)) {
      await note(
        decision.decision === 'allow_with_approval'
          ? 'this action still requires human approval'
          : decision.reason,
      );
      continue;
    }

    if (!sender) {
      await note('no mailbox is connected, so nothing can be sent');
      continue;
    }

    // --------------------------------------------------------------- send
    const actionId = newId('action');
    const stamp = now();
    const subject = row.subject?.trim() || defaultEmailSubject(row.company_name);

    await db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, body, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'queued', ?, ?)`,
      args: [actionId, workspaceId, row.recommendation_id, row.person_id, row.body, stamp],
    });

    // The workspace's own reply-to wins over the platform default, because a
    // customer who connected their own mailbox meant replies to reach it.
    const replyTo = deps.replyTo ?? sender.replyTo ?? settings.reply_to_email ?? undefined;

    // Same rule as the approval path: rewrite after the body is settled, so
    // what the gates checked and what the reviewer would read back is the
    // approved wording, and only the link destinations differ on the wire.
    const trackingOrigin = settings.track_links
      ? (settings.tracking_origin ?? deps.appUrl ?? undefined)
      : undefined;

    const outgoing = trackingOrigin
      ? await trackLinksInBody(db, {
          workspaceId,
          personId: row.person_id,
          campaignId: row.campaign_id,
          actionId,
          body,
          origin: trackingOrigin,
        })
      : { body, tracked: 0 };

    try {
      const result = await sender.mailer.send({
        to: recipient.address,
        subject,
        text: outgoing.body,
        ...(replyTo ? { replyTo } : {}),
      });

      await recordEmailSent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        actionId,
        recommendationId: row.recommendation_id,
        to: recipient.address,
        sharedInbox: recipient.shared,
        body,
        externalId: result.id,
        actor: AUTOPILOT_ACTOR,
        policyVersion: decision.policyVersion,
      });

      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'success',
        message:
          `Emailed ${row.display_name}` +
          `${row.company_name ? ` at ${row.company_name}` : ''} — ${recipient.address}`,
        detail: {
          to: recipient.address,
          subject,
          sharedInbox: recipient.shared,
          via: sender.ownMailbox ? 'workspace' : 'platform',
        },
      });

      sent.push({
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        personName: row.display_name,
        recommendationId: row.recommendation_id,
        actionId,
        to: recipient.address,
        subject,
        body,
        ...(row.company_name ? { companyName: row.company_name } : {}),
        toSharedInbox: recipient.shared,
      });

      today += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed += 1;

      // Left as `failed` with the reason attached, and the recommendation left
      // pending. A bounced domain or a rate-limited provider is worth another
      // attempt on a later tick; losing the lead over it is not.
      await recordEmailFailure(db, {
        workspaceId,
        actionId,
        to: recipient.address,
        error: message,
        actor: AUTOPILOT_ACTOR,
      });

      // The most important line this whole system produces. A send that fails
      // silently is indistinguishable from one that never had a reason to
      // happen, and telling those apart used to require reading container logs.
      await emitEvent(db, {
        workspaceId,
        campaignId: row.campaign_id,
        personId: row.person_id,
        phase: 'send',
        level: 'error',
        message: `Could not email ${row.display_name}: ${message.slice(0, 200)}`,
        detail: {
          to: recipient.address,
          error: message.slice(0, 500),
          attempt: row.failed_attempts + 1,
          via: sender.ownMailbox ? 'workspace' : 'platform',
        },
      });
    }
  }

  return { sent, skipped, failed };
}

/** True when any recorded quality gate failed. Unparseable checks fail closed. */
function hasFailingCheck(checksJson: string | null): boolean {
  if (!checksJson) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(checksJson);
  } catch {
    return true;
  }

  if (!Array.isArray(parsed)) return false;
  return parsed.some((check) => {
    if (!check || typeof check !== 'object') return false;
    const entry = check as { passed?: unknown; ok?: unknown };
    if (entry.passed === false) return true;
    return entry.ok === false;
  });
}

function dayStart(at: Date): string {
  return `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/**
 * Actions the rate limits are about, and only those.
 *
 * The policy engine waives every rate limit for an internal action, so an
 * internal action must not consume one either. Counting them did both: a
 * research sweep over twenty thousand people put the workspace 200x over a
 * fifty-a-day outreach cap, and because this count gates the whole tick
 * (`today >= cap` returns before any candidate is read) autopilot stopped
 * sending anything at all.
 */
const COUNTABLE_KINDS = `kind NOT IN (${INTERNAL_ACTION_KINDS.map(() => '?').join(', ')})`;

async function countActionsToday(db: Client, workspaceId: string, at: Date): Promise<number> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM actions
      WHERE workspace_id = ? AND created_at >= ? AND status != 'failed'
        AND ${COUNTABLE_KINDS}`,
    [workspaceId, dayStart(at), ...INTERNAL_ACTION_KINDS],
  );
  return row?.n ?? 0;
}

async function actionCounts(
  db: Client,
  workspaceId: string,
  personId: string,
  at: Date,
): Promise<{ thisProspect: number; hoursSinceLast?: number }> {
  const weekAgo = new Date(at.getTime() - 7 * 24 * 3_600_000).toISOString();

  const row = await queryOne<{ n: number; last_at: string | null }>(
    db,
    `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM actions
      WHERE workspace_id = ? AND person_id = ? AND created_at >= ? AND status != 'failed'
        AND ${COUNTABLE_KINDS}`,
    [workspaceId, personId, weekAgo, ...INTERNAL_ACTION_KINDS],
  );

  const thisProspect = row?.n ?? 0;
  if (!row?.last_at) return { thisProspect };

  const stamp = Date.parse(row.last_at);
  if (Number.isNaN(stamp)) return { thisProspect };

  return { thisProspect, hoursSinceLast: (at.getTime() - stamp) / 3_600_000 };
}

/**
 * The same two limits, counted against the mailbox rather than the person.
 *
 * Read from `interactions.contact_address` — the address a message actually
 * reached — rather than from `actions`, which records who it was addressed to.
 * For a shared inbox those are different questions, and only the first one can
 * see fourteen colleagues arriving at one `support@`.
 *
 * Counting outbound interactions also means a message sent by hand from the
 * approval queue counts against the automated path, and vice versa. A mailbox
 * does not care which half of the product wrote to it.
 */
async function addressCounts(
  db: Client,
  workspaceId: string,
  address: string,
  at: Date,
): Promise<{ thisWeek: number; hoursSinceLast?: number }> {
  const weekAgo = new Date(at.getTime() - 7 * 24 * 3_600_000).toISOString();

  const row = await queryOne<{ n: number; last_at: string | null }>(
    db,
    `SELECT COUNT(*) AS n,
            (SELECT MAX(occurred_at) FROM interactions
              WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound') AS last_at
       FROM interactions
      WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound'
        AND occurred_at >= ?`,
    [workspaceId, address, workspaceId, address, weekAgo],
  );

  const thisWeek = row?.n ?? 0;
  if (!row?.last_at) return { thisWeek };

  const stamp = Date.parse(row.last_at);
  if (Number.isNaN(stamp)) return { thisWeek };

  return { thisWeek, hoursSinceLast: (at.getTime() - stamp) / 3_600_000 };
}

function safeJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
