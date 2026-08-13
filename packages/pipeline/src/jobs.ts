/**
 * Background jobs (PRD §1.1 principle 7).
 *
 * Enrichment, research, scoring and privacy work never runs inside a request.
 * Each job here is a pure-ish function of (database, payload) so it can be
 * driven by BullMQ in production and called directly in tests.
 */

import { newId, type Network, type SignalType } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  scoreIcpFit,
  scoreIntent,
  scoreOpportunity,
  scoreReachability,
} from '@outreachgraph/scoring';
import type { DecayableSignal } from '@outreachgraph/signals';

export const JOB_KINDS = [
  'enrich_person',
  'resolve_identities',
  'refresh_signals',
  'rescore_prospect',
  'expire_signals',
  'process_deletion',
  'poll_drop',
  /** Fetch one company URL, read it, and run everyone it names. */
  'crawl_site',
] as const;

export type JobKind = (typeof JOB_KINDS)[number];

export interface JobResult {
  readonly kind: JobKind;
  readonly ok: boolean;
  readonly detail: Record<string, unknown>;
}

/**
 * Recomputes every score for one prospect in one campaign (PRD §12).
 *
 * Reads the campaign's own filters and signal rules, so the same person can
 * legitimately rank differently in two campaigns.
 */
export async function rescoreProspect(
  db: Client,
  campaignId: string,
  personId: string,
): Promise<JobResult> {
  const campaign = await queryOne<{ workspace_id: string; score_weights_json: string | null }>(
    db,
    'SELECT workspace_id, score_weights_json FROM campaigns WHERE id = ?',
    [campaignId],
  );
  if (!campaign) return { kind: 'rescore_prospect', ok: false, detail: { reason: 'no_campaign' } };

  const person = await queryOne<{
    current_title: string | null;
    identity_confidence: number;
    current_company_id: string | null;
  }>(db, 'SELECT current_title, identity_confidence, current_company_id FROM people WHERE id = ?', [
    personId,
  ]);
  if (!person) return { kind: 'rescore_prospect', ok: false, detail: { reason: 'no_person' } };

  const company = person.current_company_id
    ? await queryOne<{ industry: string | null; employee_count: number | null }>(
        db,
        'SELECT industry, employee_count FROM companies WHERE id = ?',
        [person.current_company_id],
      )
    : undefined;

  const filterRow = await queryOne<{
    titles: string;
    seniorities: string;
    industries: string;
    countries: string;
    technologies: string;
    keywords: string;
    exclusions: string;
    funding_stages: string;
    employee_count_min: number | null;
    employee_count_max: number | null;
    hiring: number | null;
  }>(db, 'SELECT * FROM campaign_filters WHERE campaign_id = ?', [campaignId]);

  const filters = {
    titles: parseArray(filterRow?.titles),
    seniorities: parseArray(filterRow?.seniorities),
    industries: parseArray(filterRow?.industries),
    countries: parseArray(filterRow?.countries),
    technologies: parseArray(filterRow?.technologies),
    keywords: parseArray(filterRow?.keywords),
    exclusions: parseArray(filterRow?.exclusions),
    fundingStages: parseArray(filterRow?.funding_stages),
    ...(filterRow?.employee_count_min == null
      ? {}
      : { employeeCountMin: filterRow.employee_count_min }),
    ...(filterRow?.employee_count_max == null
      ? {}
      : { employeeCountMax: filterRow.employee_count_max }),
  };

  const signalRows = await queryAll<{
    signal_type: string;
    source_timestamp: string | null;
    observed_at: string;
    confidence: number;
    relevance: number;
    expires_at: string | null;
  }>(
    db,
    `SELECT signal_type, source_timestamp, observed_at, confidence, relevance, expires_at
       FROM signals WHERE person_id = ? AND workspace_id = ?`,
    [personId, campaign.workspace_id],
  );

  const signals: DecayableSignal[] = signalRows.map((row) => ({
    type: row.signal_type as SignalType,
    ...(row.source_timestamp ? { sourceTimestamp: row.source_timestamp } : {}),
    observedAt: row.observed_at,
    confidence: row.confidence,
    relevance: row.relevance,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  }));

  const ruleRows = await queryAll<{ signal_type: string; enabled: number; weight: number }>(
    db,
    'SELECT signal_type, enabled, weight FROM campaign_signal_rules WHERE campaign_id = ?',
    [campaignId],
  );

  const signalWeights: Partial<Record<SignalType, number>> = {};
  for (const rule of ruleRows) {
    signalWeights[rule.signal_type as SignalType] = rule.enabled === 1 ? rule.weight : 0;
  }

  const identityCount = await queryOne<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const icp = scoreIcpFit(
    {
      ...(person.current_title ? { title: person.current_title } : {}),
      ...(company?.industry ? { industry: company.industry } : {}),
      ...(company?.employee_count == null ? {} : { employeeCount: company.employee_count }),
    },
    filters,
  );

  const intent = scoreIntent({ signals, signalWeights });

  const reachability = scoreReachability({
    reachableNetworkCount: Number(identityCount?.n ?? 0),
    hasConnectedAccount: false,
    ...(signals.length > 0 ? { daysSinceLastActivity: freshestAgeDays(signals) } : {}),
  });

  const weights = campaign.score_weights_json
    ? (safeJson(campaign.score_weights_json) as never)
    : undefined;

  const opportunity = scoreOpportunity({
    icpFit: icp.score,
    intent: intent.score,
    reachability,
    relationship: 0,
    identity: Math.round(person.identity_confidence * 100),
    ...(weights ? { weights } : {}),
  });

  await db.execute({
    sql: `INSERT INTO scores (id, campaign_id, person_id, workspace_id, icp_fit,
          identity_confidence, intent, reachability, relationship, opportunity,
          weights_json, computed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(campaign_id, person_id) DO UPDATE SET
            icp_fit = excluded.icp_fit,
            identity_confidence = excluded.identity_confidence,
            intent = excluded.intent,
            reachability = excluded.reachability,
            relationship = excluded.relationship,
            opportunity = excluded.opportunity,
            weights_json = excluded.weights_json,
            computed_at = excluded.computed_at`,
    args: [
      newId('score'),
      campaignId,
      personId,
      campaign.workspace_id,
      opportunity.components.icpFit,
      opportunity.components.identity,
      opportunity.components.intent,
      opportunity.components.reachability,
      opportunity.components.relationship,
      opportunity.opportunity,
      JSON.stringify(opportunity.weights),
      now(),
    ],
  });

  return {
    kind: 'rescore_prospect',
    ok: true,
    detail: {
      opportunity: opportunity.opportunity,
      excluded: icp.excluded,
      signalsConsidered: intent.contributingCount,
    },
  };
}

/**
 * Marks decayed signals expired so they drop out of the working set
 * (PRD §11.3, §35).
 */
export async function expireSignals(db: Client, workspaceId: string): Promise<JobResult> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();

  const result = await db.execute({
    sql: `UPDATE signals SET expires_at = ?
           WHERE workspace_id = ?
             AND expires_at IS NULL
             AND COALESCE(source_timestamp, observed_at) < ?`,
    args: [now(), workspaceId, cutoff],
  });

  return {
    kind: 'expire_signals',
    ok: true,
    detail: { expired: Number(result.rowsAffected ?? 0) },
  };
}

/**
 * Marks a source unavailable and stops its signals grounding new claims
 * (PRD §17.6).
 */
export async function markSourceUnavailable(
  db: Client,
  sourceDocumentId: string,
): Promise<JobResult> {
  await db.execute({
    sql: `UPDATE source_documents SET availability = 'unavailable', excerpt = NULL WHERE id = ?`,
    args: [sourceDocumentId],
  });

  const affected = await db.execute({
    sql: `UPDATE signals SET evidence = NULL WHERE source_document_id = ?`,
    args: [sourceDocumentId],
  });

  return {
    kind: 'refresh_signals',
    ok: true,
    detail: { signalsUngrounded: Number(affected.rowsAffected ?? 0) },
  };
}

/**
 * Works a pending deletion job to completion, recording what was removed so
 * processing status can be demonstrated (PRD §17.2).
 */
export async function processDeletion(db: Client, deletionJobId: string): Promise<JobResult> {
  const job = await queryOne<{ id: string; person_id: string | null; status: string }>(
    db,
    'SELECT id, person_id, status FROM deletion_jobs WHERE id = ?',
    [deletionJobId],
  );

  if (!job) return { kind: 'process_deletion', ok: false, detail: { reason: 'no_job' } };
  if (job.status === 'completed') {
    return { kind: 'process_deletion', ok: true, detail: { alreadyDone: true } };
  }

  const counts: Record<string, number> = {};

  if (job.person_id) {
    for (const table of ['signals', 'scores', 'recommendations', 'social_identities']) {
      const result = await db.execute({
        sql: `DELETE FROM ${table} WHERE person_id = ?`,
        args: [job.person_id],
      });
      counts[table] = Number(result.rowsAffected ?? 0);
    }

    await db.execute({
      sql: `UPDATE people SET status = 'deleted', outreach_eligible = 0, display_name = '[deleted]',
            first_name = NULL, last_name = NULL, current_title = NULL, location = NULL,
            updated_at = ? WHERE id = ?`,
      args: [now(), job.person_id],
    });
  }

  const stamp = now();
  await db.batch([
    {
      sql: `UPDATE deletion_jobs SET status = 'completed', deleted_counts_json = ?,
            started_at = COALESCE(started_at, ?), completed_at = ? WHERE id = ?`,
      args: [JSON.stringify(counts), stamp, stamp, deletionJobId],
    },
    {
      sql: `UPDATE privacy_requests SET status = 'completed', completed_at = ?
             WHERE id = (SELECT privacy_request_id FROM deletion_jobs WHERE id = ?)`,
      args: [stamp, deletionJobId],
    },
  ]);

  return { kind: 'process_deletion', ok: true, detail: { counts } };
}

function freshestAgeDays(signals: readonly DecayableSignal[]): number {
  const stamps = signals
    .map((s) => Date.parse(s.sourceTimestamp ?? s.observedAt))
    .filter((n) => !Number.isNaN(n));

  if (stamps.length === 0) return Number.POSITIVE_INFINITY;
  return (Date.now() - Math.max(...stamps)) / 86_400_000;
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type { Network };
