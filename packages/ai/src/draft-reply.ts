/**
 * Turning a reply card into a drafted answer (the composer's reply mode).
 *
 * A reply card is a `send_email` recommendation that carries the inbound
 * message it answers in `reply_to_interaction_id`. It has no trigger signal —
 * what grounds it is the conversation — so it cannot go through
 * `draftForRecommendation`'s signal path, which would only ever answer "no
 * trigger signal". `draftForRecommendation` hands those cards here, so every
 * caller that drafts a card (the approval screen's Draft button, autopilot
 * filling a gap, triage) gets the right composer without knowing there are two.
 */

import {
  isReplyLabel,
  newId,
  replySubject,
  type Network,
  type OutreachStyle,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { composeReply, type ThreadMessage } from './composer';
import type { TextModel } from './model';

export interface ReplyDraftResult {
  readonly ok: boolean;
  readonly draftId?: string;
  readonly reason?: string;
  readonly unsupported?: readonly string[];
  /** Whether the stored draft passed every quality gate. Always true when ok. */
  readonly passed?: boolean;
}

/**
 * Composes and stores the answer to one inbound message.
 *
 * Idempotent like its sibling: a card that already has a draft keeps it, so a
 * retried triage job does not pay for a second answer to the same message.
 *
 * The subject is theirs with one "Re:" — the send threads on it, and a reply
 * that changes the subject line starts a new conversation in most clients.
 */
export async function draftReplyForRecommendation(
  db: Client,
  model: TextModel,
  recommendationId: string,
): Promise<ReplyDraftResult> {
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM drafts WHERE recommendation_id = ? LIMIT 1',
    [recommendationId],
  );
  if (existing) return { ok: true, draftId: existing.id, passed: true };

  const recommendation = await queryOne<{
    id: string;
    workspace_id: string;
    campaign_id: string;
    person_id: string;
    network: string;
    reply_to_interaction_id: string | null;
  }>(
    db,
    `SELECT id, workspace_id, campaign_id, person_id, network, reply_to_interaction_id
       FROM recommendations WHERE id = ?`,
    [recommendationId],
  );
  if (!recommendation?.reply_to_interaction_id) return { ok: false, reason: 'not_a_reply' };

  const inbound = await queryOne<{
    body: string | null;
    subject: string | null;
    reply_label: string | null;
    occurred_at: string;
  }>(
    db,
    `SELECT body, subject, reply_label, occurred_at FROM interactions
      WHERE id = ? AND workspace_id = ?`,
    [recommendation.reply_to_interaction_id, recommendation.workspace_id],
  );
  if (!inbound?.body?.trim()) return { ok: false, reason: 'no_evidence' };

  // The conversation up to the message being answered. Automated rows (an
  // absence notice, a bounce) and click records are not anything anyone said.
  const earlier = await queryAll<{ direction: string; body: string | null }>(
    db,
    `SELECT direction, body FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND occurred_at < ?
        AND direction IN ('inbound', 'outbound') AND state != 'clicked'
        AND body IS NOT NULL AND trim(body) <> ''
      ORDER BY occurred_at ASC`,
    [recommendation.workspace_id, recommendation.person_id, inbound.occurred_at],
  );
  const thread: ThreadMessage[] = earlier.map((row) => ({
    from: row.direction === 'inbound' ? 'them' : 'us',
    body: row.body ?? '',
  }));

  const context = await draftingContext(
    db,
    recommendation.workspace_id,
    recommendation.campaign_id,
    recommendation.person_id,
  );
  if (!context) return { ok: false, reason: 'no_offering' };

  const priorHashes = await queryAll<{ similarity_hash: string }>(
    db,
    `SELECT DISTINCT similarity_hash FROM drafts
      WHERE workspace_id = ? AND similarity_hash IS NOT NULL`,
    [recommendation.workspace_id],
  );

  const result = await composeReply(model, {
    network: recommendation.network as Network,
    offering: context.offering,
    prospect: context.prospect,
    ...(context.voice ? { voice: context.voice } : {}),
    thread,
    inbound: { body: inbound.body, ...(inbound.subject ? { subject: inbound.subject } : {}) },
    label: isReplyLabel(inbound.reply_label) ? inbound.reply_label : 'question',
    minIdentityConfidence: context.minIdentityConfidence,
    priorDraftHashes: priorHashes.map((r) => r.similarity_hash),
  });

  if (!result.ok) {
    return {
      ok: false,
      passed: false,
      reason: result.reason,
      ...(result.report?.unsupported ? { unsupported: result.report.unsupported } : {}),
    };
  }

  // Their subject when the mail had one; otherwise the one we last sent, so
  // the answer still lands in the same thread.
  const lastSubject = inbound.subject
    ? undefined
    : await queryOne<{ subject: string | null }>(
        db,
        `SELECT d.subject FROM interactions i
           JOIN actions a ON a.id = i.action_id
           JOIN drafts d ON d.recommendation_id = a.recommendation_id
          WHERE i.workspace_id = ? AND i.person_id = ? AND i.direction = 'outbound'
          ORDER BY i.occurred_at DESC LIMIT 1`,
        [recommendation.workspace_id, recommendation.person_id],
      );
  const subject = replySubject(inbound.subject ?? lastSubject?.subject);

  const draftId = newId('draft');
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
            grounded_signal_ids, checks_json, similarity_hash, model, edited_by_user,
            created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, '[]', ?, ?, ?, 0, ?, ?)`,
      args: [
        draftId,
        recommendation.workspace_id,
        recommendation.id,
        subject,
        result.body,
        JSON.stringify(result.report.results),
        result.report.similarityHash,
        result.model,
        stamp,
        stamp,
      ],
    },
    {
      sql: 'UPDATE recommendations SET draft_id = ? WHERE id = ?',
      args: [draftId, recommendation.id],
    },
  ]);

  return { ok: true, draftId, passed: true };
}

/** The offering, voice and person an answer is written with. */
async function draftingContext(
  db: Client,
  workspaceId: string,
  campaignId: string,
  personId: string,
) {
  const person = await queryOne<{
    kind: string;
    display_name: string;
    first_name: string | null;
    current_title: string | null;
    current_company_id: string | null;
    identity_confidence: number;
  }>(
    db,
    `SELECT kind, display_name, first_name, current_title, current_company_id,
            identity_confidence
       FROM people WHERE id = ?`,
    [personId],
  );
  if (!person) return undefined;

  const company = person.current_company_id
    ? await queryOne<{ name: string }>(db, 'SELECT name FROM companies WHERE id = ?', [
        person.current_company_id,
      ])
    : undefined;

  const offering = await queryOne<{
    name: string;
    category: string;
    value_propositions: string;
    likely_pains: string;
    competitors: string;
  }>(
    db,
    `SELECT o.name, o.category, o.value_propositions, o.likely_pains, o.competitors
       FROM offerings o JOIN campaigns c ON c.offering_id = o.id WHERE c.id = ?`,
    [campaignId],
  );
  if (!offering) return undefined;

  const voice = await queryOne<{
    style: string;
    instructions: string | null;
    samples: string;
    max_words: number | null;
    prohibited_claims: string;
  }>(
    db,
    `SELECT v.style, v.instructions, v.samples, v.max_words, v.prohibited_claims
       FROM voice_profiles v JOIN campaigns c ON c.voice_profile_id = v.id WHERE c.id = ?`,
    [campaignId],
  );

  const workspace = await queryOne<{ min_outreach_confidence: number }>(
    db,
    'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
    [workspaceId],
  );

  return {
    offering: {
      name: offering.name,
      category: offering.category,
      valuePropositions: parseArray(offering.value_propositions),
      likelyPains: parseArray(offering.likely_pains),
      competitors: parseArray(offering.competitors),
    },
    prospect: {
      ...(person.kind === 'company_inbox' ? { kind: 'company_inbox' as const } : {}),
      displayName: person.display_name,
      ...(person.first_name ? { firstName: person.first_name } : {}),
      ...(person.current_title ? { title: person.current_title } : {}),
      ...(company?.name ? { companyName: company.name } : {}),
      identityConfidence: person.identity_confidence,
    },
    voice: voice
      ? {
          style: voice.style as OutreachStyle,
          ...(voice.instructions ? { instructions: voice.instructions } : {}),
          samples: parseArray(voice.samples),
          ...(voice.max_words == null ? {} : { maxWords: voice.max_words }),
          prohibitedClaims: parseArray(voice.prohibited_claims),
        }
      : undefined,
    minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
  };
}

function parseArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
