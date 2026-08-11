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

import { newId, type ActionKind, type Network, type OutreachStyle } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { composeDraft, type ComposeResult, type TextModel } from '@outreachgraph/ai';

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
  }>(
    db,
    `SELECT id, workspace_id, campaign_id, person_id, action, network, trigger_signal_id
       FROM recommendations WHERE id = ?`,
    [recommendationId],
  );
  if (!recommendation) return { ok: false, reason: 'no_recommendation' };

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
    display_name: string;
    first_name: string | null;
    current_title: string | null;
    current_company_id: string | null;
    identity_confidence: number;
  }>(
    db,
    `SELECT display_name, first_name, current_title, current_company_id, identity_confidence
       FROM people WHERE id = ?`,
    [recommendation.person_id],
  );
  if (!person) return { ok: false, reason: 'no_person' };

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
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, body, grounded_signal_ids,
            checks_json, similarity_hash, model, edited_by_user, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      args: [
        draftId,
        recommendation.workspace_id,
        recommendation.id,
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
