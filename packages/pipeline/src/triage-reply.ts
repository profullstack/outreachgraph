/**
 * What happens after somebody writes back (the `triage_reply` job).
 *
 * Recording a reply stops cold outreach, and until now that was all it did.
 * Every reply then waited for a human to notice it, open a mail client and
 * type — which is the step we-connect-style tools collapse into "the answer is
 * already drafted". This job is that step, in three parts, each deliberately
 * less trusting than the one before:
 *
 *   1. **Label it.** Rules first (`classifyReplyByRules`): headers, subject
 *      lines and fixed phrases, which can be read back and argued with. A
 *      model only labels what no rule could, and says how sure it is. No model
 *      configured means `other`, unclassified — never a guess.
 *   2. **Act on the label, where acting is safe.** A rule-matched "take me off
 *      your list" suppresses through the same path as the one-click link. A
 *      model that *thinks* someone asked to stop gets a card for a human; a
 *      model never writes a tombstone.
 *   3. **Draft an answer** for `interested`, `question` and `referral`, as a
 *      card on the approval queue (copilot). Only when the campaign asked for
 *      autonomous replies *and* `decideAutoReply` finds every condition held
 *      — trusted automation, `interested`/`question`, confidence over the
 *      threshold, a draft that passed its gates, and a plain `allow` from the
 *      policy engine re-evaluated right now — does it send without one.
 *
 * Idempotent per inbound message: a label is not recomputed once stored, and
 * one message gets at most one reply card, so a retried job cannot answer
 * twice.
 */

import {
  classifyReplyByRules,
  DRAFTABLE_REPLY_LABELS,
  isAutoReplyMode,
  isReplyLabel,
  newId,
  type ActionKind,
  type AutoReplyMode,
  type Network,
  type ReplyClassification,
  type ReplyLabelSource,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  classifyReplyWithModel,
  draftReplyForRecommendation,
  type TextModel,
} from '@outreachgraph/ai';
import type { Mailer } from '@outreachgraph/email';
import {
  autonomousRequested,
  decideAutoReply,
  evaluatePolicy,
  POLICY_VERSION,
  type PolicyResult,
} from '@outreachgraph/policy';
import { AUTO_APPROVE_ACTOR } from './auto-approve';
import { actionCounts, addressCounts, countActionsToday } from './autopilot';
import { mailerForWorkspace } from './email-account';
import { emitEvent } from './events';
import { budgetStatus } from './metering';
import { deliverEmailAction, type AuditActor } from './outreach-email';
import { matchKeysForPerson } from './suppression-keys';
import { suppressAddress } from './unsubscribe';

export interface TriageDeps {
  readonly db: Client;
  /** Absent: rules only, and no drafted answers. The fixture path. */
  readonly model?: TextModel | undefined;
  /** The platform sender, for workspaces that have not connected a mailbox. */
  readonly mailer?: Mailer | undefined;
  readonly encryptionKey?: Buffer | undefined;
  readonly appUrl?: string | undefined;
  readonly now?: Date;
}

export interface TriageInput {
  readonly workspaceId: string;
  readonly interactionId: string;
}

export type TriageOutcome =
  /** Not an inbound message, or already gone. */
  | 'skipped'
  /** Labelled; nothing further to do for this label. */
  | 'labelled'
  /** A rule-matched stop request; the person is suppressed. */
  | 'suppressed'
  /** A model thinks they asked to stop; a card waits for a human. */
  | 'held_for_review'
  /** A drafted answer (or an undrafted one) waits on the approval queue. */
  | 'copilot'
  /** Answered unattended. */
  | 'sent';

export interface TriageResult {
  readonly outcome: TriageOutcome;
  readonly label?: ReplyClassification;
  readonly recommendationId?: string;
  /** Why the outcome is what it is, for the log and the activity feed. */
  readonly reason: string;
}

/** Who the audit trail credits for an unattended answer. */
const AUTO_REPLY_ACTOR: AuditActor = { actorKind: 'system', actorId: 'auto_reply' };

interface InboundRow {
  readonly id: string;
  readonly person_id: string;
  readonly campaign_id: string | null;
  readonly network: string;
  readonly direction: string;
  readonly body: string | null;
  readonly subject: string | null;
  readonly contact_address: string | null;
  readonly reply_label: string | null;
  readonly reply_confidence: number | null;
  readonly reply_label_source: string | null;
  readonly reply_label_reason: string | null;
  readonly occurred_at: string;
}

export async function triageReply(deps: TriageDeps, input: TriageInput): Promise<TriageResult> {
  const { db } = deps;

  const row = await queryOne<InboundRow>(
    db,
    `SELECT id, person_id, campaign_id, network, direction, body, subject, contact_address,
            reply_label, reply_confidence, reply_label_source, reply_label_reason, occurred_at
       FROM interactions WHERE id = ? AND workspace_id = ?`,
    [input.interactionId, input.workspaceId],
  );

  if (!row) return { outcome: 'skipped', reason: 'no such interaction' };
  if (row.direction !== 'inbound') {
    return { outcome: 'skipped', reason: `a ${row.direction} message is not triaged` };
  }

  const label = await labelFor(deps, input.workspaceId, row);

  if (label.label === 'unsubscribe_request') {
    return label.source === 'rule'
      ? await honourStop(db, input.workspaceId, row, label)
      : await holdPossibleStop(db, input.workspaceId, row, label);
  }

  if (!DRAFTABLE_REPLY_LABELS.includes(label.label)) {
    return { outcome: 'labelled', label, reason: `labelled ${label.label}; nothing to answer` };
  }

  return answer(deps, input.workspaceId, row, label);
}

// ------------------------------------------------------------------ labels

async function labelFor(
  deps: TriageDeps,
  workspaceId: string,
  row: InboundRow,
): Promise<ReplyClassification> {
  // Stored labels stand. A rule's was set at receive time and a model's is
  // not worth paying for twice; re-running would also let a retried job
  // disagree with the label a human already saw.
  if (
    isReplyLabel(row.reply_label) &&
    (row.reply_label_source === 'rule' || row.reply_label_source === 'model')
  ) {
    return {
      label: row.reply_label,
      confidence: row.reply_confidence ?? 0,
      source: row.reply_label_source as ReplyLabelSource,
      reason: row.reply_label_reason ?? '',
    };
  }

  const ruled = classifyReplyByRules({
    subject: row.subject ?? undefined,
    body: row.body ?? undefined,
  });

  let label: ReplyClassification;
  if (ruled) {
    label = ruled;
  } else if (deps.model && row.body?.trim()) {
    const ours = await queryOne<{ body: string | null }>(
      deps.db,
      `SELECT body FROM interactions
        WHERE workspace_id = ? AND person_id = ? AND direction = 'outbound' AND occurred_at <= ?
        ORDER BY occurred_at DESC LIMIT 1`,
      [workspaceId, row.person_id, row.occurred_at],
    );
    label = await classifyReplyWithModel(deps.model, {
      subject: row.subject ?? undefined,
      body: row.body,
      ...(ours?.body ? { ourLastMessage: ours.body } : {}),
    }).catch((error: unknown): ReplyClassification => ({
      label: 'other',
      confidence: 0,
      source: 'unclassified',
      reason:
        `the model could not be reached: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
    }));
  } else {
    label = {
      label: 'other',
      confidence: 0,
      source: 'unclassified',
      reason: deps.model ? 'the reply has no text' : 'no model is configured, so only rules ran',
    };
  }

  await deps.db.execute({
    sql: `UPDATE interactions SET reply_label = ?, reply_confidence = ?, reply_label_source = ?,
          reply_label_reason = ?, labelled_at = ? WHERE id = ?`,
    args: [label.label, label.confidence, label.source, label.reason, now(), row.id],
  });

  return label;
}

// ------------------------------------------------------------ stop requests

async function honourStop(
  db: Client,
  workspaceId: string,
  row: InboundRow,
  label: ReplyClassification,
): Promise<TriageResult> {
  const address = row.contact_address ?? (await personAddress(db, row.person_id));

  // No mailbox to key the request on still leaves the person, who is
  // suppressed on their own; `suppressAddress` only widens to colleagues
  // behind a shared inbox when there is an inbox to widen from.
  await suppressAddress(db, {
    workspaceId,
    personId: row.person_id,
    address: address ?? '',
    source: 'reply_unsubscribe',
  });

  await emitEvent(db, {
    workspaceId,
    ...(row.campaign_id ? { campaignId: row.campaign_id } : {}),
    personId: row.person_id,
    phase: 'send',
    level: 'info',
    message: `Stopped contacting them: they asked to be removed (${label.reason})`,
    detail: { interactionId: row.id, label: label.label },
  });

  return { outcome: 'suppressed', label, reason: label.reason };
}

/**
 * A model's "they want to stop" is a card, not a tombstone.
 *
 * `manual_review` has no capability rule anywhere, so approving the card is
 * refused by the engine — the card exists for its Do-not-contact button, and
 * for Skip when the model misread a sentence. Cold outreach is already halted
 * by the reply itself, so nothing goes out while it waits.
 */
async function holdPossibleStop(
  db: Client,
  workspaceId: string,
  row: InboundRow,
  label: ReplyClassification,
): Promise<TriageResult> {
  const campaignId = await campaignFor(db, workspaceId, row);
  if (!campaignId) {
    return { outcome: 'labelled', label, reason: 'possible stop request, but no campaign to card' };
  }

  const existing = await replyCardFor(db, row.id);
  if (existing) {
    return { outcome: 'held_for_review', label, recommendationId: existing, reason: label.reason };
  }

  const recommendationId = newId('recommendation');
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at, reply_to_interaction_id)
          VALUES (?, ?, ?, ?, 'manual_review', ?, 100, ?, NULL, 'manual_only', ?,
          'continue_conversation', 'pending', ?, ?)`,
    args: [
      recommendationId,
      workspaceId,
      campaignId,
      row.person_id,
      row.network,
      `They may have asked not to be contacted again: "${snippet(row.body)}". ` +
        'If so, press Do not contact; if not, Skip.',
      POLICY_VERSION,
      now(),
      row.id,
    ],
  });

  return { outcome: 'held_for_review', label, recommendationId, reason: label.reason };
}

// ----------------------------------------------------------------- answers

interface CampaignRow {
  readonly id: string;
  readonly approval_mode: string;
  readonly auto_reply_mode: string | null;
  readonly auto_reply_threshold: number | null;
  readonly budget_json: string | null;
  readonly status: string;
}

async function answer(
  deps: TriageDeps,
  workspaceId: string,
  row: InboundRow,
  label: ReplyClassification,
): Promise<TriageResult> {
  const { db } = deps;

  const campaignId = await campaignFor(db, workspaceId, row);
  if (!campaignId) {
    return { outcome: 'labelled', label, reason: 'no campaign wrote to them, so none answers' };
  }

  const campaign = await queryOne<CampaignRow>(
    db,
    `SELECT id, approval_mode, auto_reply_mode, auto_reply_threshold, budget_json, status
       FROM campaigns WHERE id = ? AND workspace_id = ?`,
    [campaignId, workspaceId],
  );
  if (!campaign) return { outcome: 'labelled', label, reason: 'the campaign is gone' };

  const mode: AutoReplyMode = isAutoReplyMode(campaign.auto_reply_mode)
    ? campaign.auto_reply_mode
    : 'copilot';
  const approvalMode = campaign.approval_mode as
    'research_only' | 'draft_and_approve' | 'trusted_automation';

  if (mode === 'off') {
    return { outcome: 'labelled', label, reason: 'auto-reply is off for this campaign' };
  }

  // Email is the only channel whose replies are recorded and answerable
  // today. A social reply would go through its own paced sender.
  if (row.network !== 'email') {
    return { outcome: 'labelled', label, reason: `${row.network} replies are answered by hand` };
  }

  const recommendationId =
    (await replyCardFor(db, row.id)) ??
    (await createReplyCard(db, workspaceId, campaign.id, row, label));

  const drafted = deps.model
    ? await draftReplyForRecommendation(db, deps.model, recommendationId).catch(
        (error: unknown) => ({
          ok: false as const,
          reason: error instanceof Error ? error.message : String(error),
          passed: false,
        }),
      )
    : undefined;

  const draftPassed = drafted?.ok === true && drafted.passed !== false;

  // Asked only when it could matter: the engine is read-heavy, and a copilot
  // campaign's answer does not depend on it.
  const policy =
    autonomousRequested(mode, approvalMode) && draftPassed
      ? await evaluateNow(deps, workspaceId, campaign, row)
      : undefined;

  const decision = decideAutoReply({
    mode,
    approvalMode,
    label: label.label,
    labelSource: label.source,
    confidence: label.confidence,
    threshold: campaign.auto_reply_threshold ?? 0.85,
    draftPassed,
    policy,
  });

  if (decision.outcome !== 'autonomous') {
    if (mode === 'autonomous') {
      // An autonomous campaign that produced a card says why, once, where the
      // owner looks — or it reads as a setting that does nothing.
      await emitEvent(db, {
        workspaceId,
        campaignId: campaign.id,
        personId: row.person_id,
        phase: 'draft',
        level: 'info',
        message: `Drafted a reply for approval instead of sending it: ${decision.reason}`,
        detail: { recommendationId, interactionId: row.id, label: label.label },
      });
    }
    return {
      outcome: 'copilot',
      label,
      recommendationId,
      reason:
        drafted && !drafted.ok ? `no draft (${drafted.reason ?? 'withheld'})` : decision.reason,
    };
  }

  return sendUnattended(deps, workspaceId, campaign.id, row, label, recommendationId, policy!);
}

async function createReplyCard(
  db: Client,
  workspaceId: string,
  campaignId: string,
  row: InboundRow,
  label: ReplyClassification,
): Promise<string> {
  const recommendationId = newId('recommendation');

  // `send_email` because that is the one email capability the matrix
  // describes; `continue_conversation` and the answered message are what mark
  // it as an answer, and what the approval path's policy recheck reads as a
  // follow-up. Priority 100 so it sorts above cold cards: someone is waiting.
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at, reply_to_interaction_id)
          VALUES (?, ?, ?, ?, 'send_email', 'email', 100, ?, NULL, 'allow_with_approval', ?,
          'continue_conversation', 'pending', ?, ?)`,
    args: [
      recommendationId,
      workspaceId,
      campaignId,
      row.person_id,
      `They replied (${label.label.replace(/_/g, ' ')}): "${snippet(row.body)}"`,
      POLICY_VERSION,
      now(),
      row.id,
    ],
  });

  return recommendationId;
}

/**
 * The policy engine, asked now and from live rows, as the approval path asks.
 *
 * Never trusted from a snapshot: the card was written seconds ago, but "seconds
 * ago" is exactly when a second reply saying "actually, stop" could have
 * landed.
 */
async function evaluateNow(
  deps: TriageDeps,
  workspaceId: string,
  campaign: CampaignRow,
  row: InboundRow,
): Promise<PolicyResult> {
  const { db } = deps;
  const at = deps.now ?? new Date();

  const person = await queryOne<{
    status: string;
    believed_minor: number;
    identity_confidence: number;
    outreach_eligible: number;
  }>(
    db,
    'SELECT status, believed_minor, identity_confidence, outreach_eligible FROM people WHERE id = ?',
    [row.person_id],
  );

  const workspace = await queryOne<{ min_outreach_confidence: number }>(
    db,
    'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
    [workspaceId],
  );

  const keys = await matchKeysForPerson(db, row.person_id);
  if (row.contact_address) keys.push(`email:${row.contact_address.trim().toLowerCase()}`);
  const placeholders = keys.map(() => '?').join(', ');
  const suppression = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${placeholders}) AND (scope = 'global' OR workspace_id = ?)`,
    [...keys, workspaceId],
  );

  const flags = await queryAll<{ key: string; enabled: number }>(
    db,
    'SELECT key, enabled FROM feature_flags WHERE workspace_id IS NULL OR workspace_id = ?',
    [workspaceId],
  );

  const shared = await queryOne<{ shared_inbox: number }>(
    db,
    'SELECT shared_inbox FROM interactions WHERE id = ?',
    [row.id],
  );

  const sender = await mailerForWorkspace(db, workspaceId, {
    encryptionKey: deps.encryptionKey,
    fallback: deps.mailer,
  });

  const [today, counts, usage, budget] = await Promise.all([
    countActionsToday(db, workspaceId, at),
    actionCounts(db, workspaceId, row.person_id, at),
    row.contact_address
      ? addressCounts(db, workspaceId, row.contact_address, at)
      : Promise.resolve(undefined),
    budgetStatus(db, workspaceId, at),
  ]);

  const limits = safeJson(campaign.budget_json);

  return evaluatePolicy({
    network: 'email' satisfies Network,
    action: 'send_email' satisfies ActionKind,
    approvalMode: campaign.approval_mode as 'trusted_automation',
    hasConnectedAccount: sender !== undefined,
    personSuppressed:
      person?.status === 'suppressed' ||
      person?.outreach_eligible === 0 ||
      Number(suppression?.n ?? 0) > 0,
    personBelievedMinor: person?.believed_minor === 1,
    personDeleted: !person || person.status === 'deleted',
    identityConfidence: person?.identity_confidence ?? 0,
    minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
    actionsToday: today,
    maxActionsPerDay: numberOr(limits.maxActionsPerDay, 50),
    actionsToThisProspectThisWeek: counts.thisProspect,
    maxActionsPerProspectPerWeek: numberOr(limits.maxActionsPerProspectPerWeek, 1),
    ...(typeof limits.minHoursBetweenActions === 'number'
      ? { minHoursBetweenActions: limits.minHoursBetweenActions }
      : {}),
    ...(counts.hoursSinceLast === undefined
      ? {}
      : { hoursSinceLastActionToProspect: counts.hoursSinceLast }),
    ...(usage
      ? {
          actionsToThisAddressThisWeek: usage.thisWeek,
          maxActionsPerAddressPerWeek: numberOr(limits.maxActionsPerAddressPerWeek, 1),
          addressShared: shared?.shared_inbox === 1,
          ...(usage.hoursSinceLast === undefined
            ? {}
            : { hoursSinceLastActionToAddress: usage.hoursSinceLast }),
        }
      : {}),
    // They wrote to us: that is what this job is about.
    conversationOpen: true,
    isFollowUp: true,
    autonomousReply: true,
    budgetExhausted: budget.exhausted,
    featureFlags: Object.fromEntries(flags.map((flag) => [flag.key, flag.enabled === 1])),
  });
}

/**
 * Approves as the automation user and sends through the one email path.
 *
 * A failed send puts the card back to pending rather than leaving it
 * "approved": the approval was the machine's, and a message the machine could
 * not deliver is now a human's to look at.
 */
async function sendUnattended(
  deps: TriageDeps,
  workspaceId: string,
  campaignId: string,
  row: InboundRow,
  label: ReplyClassification,
  recommendationId: string,
  policy: PolicyResult,
): Promise<TriageResult> {
  const { db } = deps;

  const sender = await mailerForWorkspace(db, workspaceId, {
    encryptionKey: deps.encryptionKey,
    fallback: deps.mailer,
  });
  if (!sender) {
    return {
      outcome: 'copilot',
      label,
      recommendationId,
      reason: 'no mailbox is connected, so the draft waits for a human',
    };
  }

  const draft = await queryOne<{ body: string }>(
    db,
    'SELECT body FROM drafts WHERE recommendation_id = ? ORDER BY created_at DESC LIMIT 1',
    [recommendationId],
  );
  if (!draft?.body.trim()) {
    return { outcome: 'copilot', label, recommendationId, reason: 'no draft to send' };
  }

  const stamp = now();
  const actionId = newId('action');

  await db.batch([
    {
      sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by,
            decided_at, note) VALUES (?, ?, ?, 'approve', ?, ?, ?)`,
      args: [
        newId('approval'),
        workspaceId,
        recommendationId,
        AUTO_APPROVE_ACTOR,
        stamp,
        `Answered automatically: ${label.label} at ${Math.round(label.confidence * 100)}% confidence`,
      ],
    },
    {
      sql: `UPDATE recommendations SET status = 'approved', policy_status = ?, policy_version = ?
             WHERE id = ?`,
      args: [policy.decision, policy.policyVersion, recommendationId],
    },
    {
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, body, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'queued', ?, ?)`,
      args: [actionId, workspaceId, recommendationId, row.person_id, draft.body, stamp],
    },
  ]);

  const result = await deliverEmailAction(
    {
      db,
      mailer: sender.mailer,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      ...(deps.appUrl ? { appUrl: deps.appUrl } : {}),
    },
    { workspaceId, actionId, actor: AUTO_REPLY_ACTOR, policyVersion: policy.policyVersion },
  );

  if (!result.sent) {
    await db.execute({
      sql: `UPDATE recommendations SET status = 'pending' WHERE id = ?`,
      args: [recommendationId],
    });
    await emitEvent(db, {
      workspaceId,
      campaignId,
      personId: row.person_id,
      phase: 'send',
      level: 'warn',
      message: `Could not send the automatic reply: ${result.reason}`,
      detail: { recommendationId, actionId },
    });
    return { outcome: 'copilot', label, recommendationId, reason: result.reason };
  }

  await emitEvent(db, {
    workspaceId,
    campaignId,
    personId: row.person_id,
    phase: 'send',
    level: 'success',
    message: `Answered their ${label.label.replace(/_/g, ' ')} automatically`,
    detail: { recommendationId, actionId, to: result.to, confidence: label.confidence },
  });

  return {
    outcome: 'sent',
    label,
    recommendationId,
    reason: 'every autonomous-reply condition held',
  };
}

// ------------------------------------------------------------------ helpers

/** The campaign whose settings answer this reply: the one that wrote last. */
async function campaignFor(
  db: Client,
  workspaceId: string,
  row: InboundRow,
): Promise<string | undefined> {
  if (row.campaign_id) return row.campaign_id;

  const outbound = await queryOne<{ campaign_id: string | null }>(
    db,
    `SELECT campaign_id FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'outbound'
        AND campaign_id IS NOT NULL
      ORDER BY occurred_at DESC LIMIT 1`,
    [workspaceId, row.person_id],
  );
  if (outbound?.campaign_id) return outbound.campaign_id;

  const membership = await queryOne<{ campaign_id: string }>(
    db,
    `SELECT campaign_id FROM campaign_people WHERE workspace_id = ? AND person_id = ?
      ORDER BY updated_at DESC LIMIT 1`,
    [workspaceId, row.person_id],
  );
  return membership?.campaign_id;
}

async function replyCardFor(db: Client, interactionId: string): Promise<string | undefined> {
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM recommendations WHERE reply_to_interaction_id = ? LIMIT 1',
    [interactionId],
  );
  return existing?.id;
}

async function personAddress(db: Client, personId: string): Promise<string | undefined> {
  const row = await queryOne<{ handle: string }>(
    db,
    `SELECT handle FROM social_identities WHERE person_id = ? AND network = 'email'
        AND handle IS NOT NULL ORDER BY confidence DESC LIMIT 1`,
    [personId],
  );
  return row?.handle;
}

function snippet(body: string | null): string {
  const text = (body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function safeJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
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
