/**
 * Turning a recommendation into a draft (PRD §14).
 *
 * Runs after the recommendation exists, so the composer inherits a settled
 * decision: who, why, which channel, and which signal it may quote. It writes
 * a draft row only when every §14.2 gate passes.
 *
 * A missing draft is a working state, not a failure. The approval card still
 * shows the prospect, the evidence and the recommended action; the reviewer
 * writes the message themselves. That is strictly better than showing a
 * fabricated one.
 */

import {
  classifyPersona,
  newId,
  PERSONA_ANGLES,
  type ActionKind,
  type Network,
  type OutreachStyle,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  composeDraft,
  type ComposeResult,
  type SiteAuditContext,
  type TextModel,
} from '@outreachgraph/ai';
import { draftReplyForRecommendation } from './draft-reply';

export interface DraftResult {
  readonly ok: boolean;
  readonly draftId?: string;
  readonly reason?: string;
  readonly unsupported?: readonly string[];
}

/**
 * Composes and stores a draft for one recommendation.
 *
 * Idempotent: a recommendation that already has a draft is left alone, so a
 * retried pipeline run does not spend tokens rewriting an approved message.
 */
export async function draftForRecommendation(
  db: Client,
  model: TextModel,
  recommendationId: string,
): Promise<DraftResult> {
  const existing = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM drafts WHERE recommendation_id = ? LIMIT 1',
    [recommendationId],
  );
  if (existing) return { ok: true, draftId: existing.id };

  const recommendation = await queryOne<{
    id: string;
    workspace_id: string;
    campaign_id: string;
    person_id: string;
    action: string;
    network: string;
    trigger_signal_id: string | null;
    reply_to_interaction_id: string | null;
    guidance: string | null;
  }>(
    db,
    `SELECT id, workspace_id, campaign_id, person_id, action, network, trigger_signal_id,
            reply_to_interaction_id, guidance
       FROM recommendations WHERE id = ?`,
    [recommendationId],
  );
  if (!recommendation) return { ok: false, reason: 'no_recommendation' };

  // A reply card answers a message, not a signal, so it is grounded in the
  // conversation. See `draft-reply.ts`.
  if (recommendation.reply_to_interaction_id) {
    return draftReplyForRecommendation(db, model, recommendation.id);
  }

  // A fresh angle per role (account expansion): the budget holder hears the
  // outcome, the end user the friction, the reviewer the objection answered,
  // the manager the proof to forward. Added to whatever the step asked for.
  const titled = await queryOne<{ current_title: string | null }>(
    db,
    'SELECT current_title FROM people WHERE id = ?',
    [recommendation.person_id],
  );
  const angle = PERSONA_ANGLES[classifyPersona(titled?.current_title)];
  const guidance = [recommendation.guidance?.trim(), angle].filter(Boolean).join(' ') || undefined;

  // No trigger means nothing to quote, and §14.1 forbids personalising
  // without evidence.
  if (!recommendation.trigger_signal_id) return { ok: false, reason: 'no_trigger_signal' };

  const signal = await queryOne<{
    id: string;
    summary: string;
    evidence: string | null;
    source_url: string | null;
    network: string;
    source_timestamp: string | null;
    observed_at: string;
  }>(
    db,
    `SELECT id, summary, evidence, source_url, network, source_timestamp, observed_at
       FROM signals WHERE id = ?`,
    [recommendation.trigger_signal_id],
  );
  if (!signal?.evidence) return { ok: false, reason: 'no_evidence' };

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
    [recommendation.person_id],
  );
  if (!person) return { ok: false, reason: 'no_person' };

  const company = person.current_company_id
    ? await queryOne<{ name: string }>(db, 'SELECT name FROM companies WHERE id = ?', [
        person.current_company_id,
      ])
    : undefined;

  // Their homepage's latest seo.rank audit, offered as an optional angle: a
  // good audit from the last 60 days with at least one fix. Read inline
  // rather than through the pipeline package, which depends on this one.
  const audit = person.current_company_id
    ? await queryOne<{
        url: string;
        final_url: string | null;
        score: number | null;
        grade: string | null;
        fixes_json: string;
        checked_at: string | null;
      }>(
        db,
        `SELECT url, final_url, score, grade, fixes_json, checked_at FROM site_audits
          WHERE company_id = ? AND status = 'ok'`,
        [person.current_company_id],
      )
    : undefined;
  const siteAudit = siteAuditContext(audit);

  const offering = await queryOne<{
    name: string;
    category: string;
    value_propositions: string;
    likely_pains: string;
    competitors: string;
    demo_url: string | null;
  }>(
    db,
    `SELECT o.name, o.category, o.value_propositions, o.likely_pains, o.competitors, o.demo_url
       FROM offerings o JOIN campaigns c ON c.offering_id = o.id WHERE c.id = ?`,
    [recommendation.campaign_id],
  );
  if (!offering) return { ok: false, reason: 'no_offering' };

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
    [recommendation.campaign_id],
  );

  // The demo goes with the first email only. A cadence's later steps would
  // otherwise repeat the same link under every follow-up.
  const demoUrl = offering.demo_url?.trim() || undefined;
  const demoAlreadySent = demoUrl
    ? await queryOne<{ id: string }>(
        db,
        `SELECT d.id FROM drafts d JOIN recommendations r ON r.id = d.recommendation_id
          WHERE r.workspace_id = ? AND r.person_id = ? AND d.body LIKE ? LIMIT 1`,
        [recommendation.workspace_id, recommendation.person_id, `%${demoUrl}%`],
      )
    : undefined;

  const workspace = await queryOne<{ min_outreach_confidence: number }>(
    db,
    'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
    [recommendation.workspace_id],
  );

  // Every message already sent from this workspace, so a near-identical
  // second copy is caught before a human ever sees it (PRD §18).
  const priorHashes = await queryAll<{ similarity_hash: string }>(
    db,
    `SELECT DISTINCT similarity_hash FROM drafts
      WHERE workspace_id = ? AND similarity_hash IS NOT NULL`,
    [recommendation.workspace_id],
  );

  const result: ComposeResult = await composeDraft(model, {
    action: recommendation.action as ActionKind,
    network: recommendation.network as Network,
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
    trigger: {
      id: signal.id,
      summary: signal.summary,
      evidence: signal.evidence,
      ...(signal.source_url ? { sourceUrl: signal.source_url } : {}),
      network: signal.network as Network,
      ageDescription: describeAge(signal.source_timestamp ?? signal.observed_at),
    },
    ...(voice
      ? {
          voice: {
            style: voice.style as OutreachStyle,
            ...(voice.instructions ? { instructions: voice.instructions } : {}),
            samples: parseArray(voice.samples),
            ...(voice.max_words == null ? {} : { maxWords: voice.max_words }),
            prohibitedClaims: parseArray(voice.prohibited_claims),
          },
        }
      : {}),
    minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
    priorDraftHashes: priorHashes.map((r) => r.similarity_hash),
    ...(guidance ? { guidance } : {}),
    ...(siteAudit ? { siteAudit } : {}),
    ...(demoUrl && !demoAlreadySent ? { demoUrl } : {}),
  });

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      ...(result.report?.unsupported ? { unsupported: result.report.unsupported } : {}),
    };
  }

  const draftId = newId('draft');
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
            grounded_signal_ids, checks_json, similarity_hash, model, edited_by_user, created_at,
            updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      args: [
        draftId,
        recommendation.workspace_id,
        recommendation.id,
        result.subject ?? null,
        result.body,
        JSON.stringify(result.groundedSignalIds),
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

  return { ok: true, draftId };
}

function siteAuditContext(
  row:
    | {
        url: string;
        final_url: string | null;
        score: number | null;
        grade: string | null;
        fixes_json: string;
        checked_at: string | null;
      }
    | undefined,
): SiteAuditContext | undefined {
  if (!row || row.score == null || !row.checked_at) return undefined;
  if (Date.now() - Date.parse(row.checked_at) > 60 * 86_400_000) return undefined;
  let fixes: { fix?: unknown; label?: unknown }[] = [];
  try {
    const parsed: unknown = JSON.parse(row.fixes_json);
    if (Array.isArray(parsed)) fixes = parsed as typeof fixes;
  } catch {
    return undefined;
  }
  const topIssues = fixes
    .slice(0, 3)
    .map((f) => String(f.fix || f.label || '').trim())
    .filter(Boolean);
  if (!topIssues.length) return undefined;
  return {
    url: row.final_url ?? row.url,
    score: Number(row.score),
    grade: row.grade ?? '',
    ageDescription: describeAge(row.checked_at),
    topIssues,
  };
}

function describeAge(timestamp: string): string {
  const then = Date.parse(timestamp);
  if (Number.isNaN(then)) return 'recently';

  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 1) return 'in the last hour';
  if (hours < 24) return `${Math.round(hours)}h ago`;

  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
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
