/**
 * The discovery-to-queue pipeline (PRD §8).
 *
 * Walks one prospect from a bare handle to a card in the approval queue:
 *
 *   enrich → resolve identities → collect signals → score → recommend
 *
 * Each stage persists before the next runs, so a crash resumes from the last
 * completed stage rather than restarting the whole chain — and so a partially
 * enriched prospect is still inspectable in the UI.
 */

import { newId, type Network, type SignalType } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { resolveIdentity, type EvidenceInput } from '@outreachgraph/identity';
import {
  deriveEvidence,
  extractSignals,
  GitHubProvider,
  GitHubRateLimitError,
  type ExtractedSignal,
  type PersonCandidate,
  type PersonEnrichmentProvider,
} from '@outreachgraph/providers';
import { generateRecommendation, type CandidateSignal } from '@outreachgraph/recommend';
import { draftForRecommendation, type TextModel } from '@outreachgraph/ai';
import { rescoreProspect } from './jobs';

export interface PipelineOptions {
  readonly db: Client;
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly providers: readonly PersonEnrichmentProvider[];
  /** Supplies GitHub activity. Omit to skip signal collection. */
  readonly github?: GitHubProvider;
  /**
   * Writes the message. Omit to run the pipeline with no LLM at all — the
   * recommendation still reaches the queue, just without a draft.
   */
  readonly model?: TextModel;
  readonly now?: Date;
}

export interface PipelineResult {
  readonly personId?: string;
  readonly stage: 'enriched' | 'resolved' | 'researched' | 'scored' | 'recommended' | 'stopped';
  readonly identitiesLinked: number;
  readonly signalsStored: number;
  readonly recommendationId?: string;
  readonly draftId?: string;
  readonly stoppedBecause?: string;
}

/**
 * Runs the full chain for one GitHub handle.
 *
 * GitHub-first is deliberate: it is free, its profiles carry self-declared
 * cross-links, and the launch wedge is developer tooling (PRD §45).
 */
export async function runPipeline(
  options: PipelineOptions,
  handle: string,
): Promise<PipelineResult> {
  const { db, workspaceId, campaignId } = options;
  const stamp = now();

  // ---------------------------------------------------------------- enrich
  const github = options.github ?? new GitHubProvider();
  const enrichment = await github.enrich({ handles: { github: handle } });

  if (!enrichment.candidate) {
    return {
      stage: 'stopped',
      identitiesLinked: 0,
      signalsStored: 0,
      stoppedBecause: `no GitHub profile for ${handle}`,
    };
  }

  const candidate = enrichment.candidate;
  const personId = await upsertPerson(db, candidate, stamp);

  await recordProvenance(db, personId, candidate, stamp);
  await ensureCampaignMembership(db, campaignId, personId, workspaceId, stamp);

  // Suppression outranks everything: a suppressed person is never researched
  // or scored, only recorded as excluded (PRD §6.6, §17.3).
  if (await isSuppressed(db, workspaceId, personId)) {
    await setStatus(db, campaignId, personId, 'suppressed', 'matched a suppression key');
    return {
      personId,
      stage: 'stopped',
      identitiesLinked: 0,
      signalsStored: 0,
      stoppedBecause: 'suppressed',
    };
  }

  // -------------------------------------------------------------- resolve
  const linked = await linkIdentities(db, personId, candidate, github, stamp);
  await setStatus(db, campaignId, personId, 'resolved');

  // ------------------------------------------------------------- research
  let stored = 0;
  try {
    const activity = await github.activity(handle);
    const context = await extractionContext(db, campaignId);
    const extracted = extractSignals(activity.events, activity.repos, context);
    stored = await storeSignals(db, workspaceId, personId, extracted, stamp);
    await setStatus(db, campaignId, personId, 'researching');
  } catch (error) {
    // A quota wall is not a prospect failure — keep what we have and let the
    // next tick resume research.
    if (!(error instanceof GitHubRateLimitError)) throw error;
  }

  // ---------------------------------------------------------------- score
  await rescoreProspect(db, campaignId, personId);
  await setStatus(db, campaignId, personId, 'qualified');

  // ------------------------------------------------------------ recommend
  const recommendationId = await createRecommendation(db, options, personId);

  if (!recommendationId) {
    return {
      personId,
      stage: 'scored',
      identitiesLinked: linked,
      signalsStored: stored,
      stoppedBecause: 'no permitted action',
    };
  }

  // ---------------------------------------------------------------- draft
  // A failed or absent draft is not a pipeline failure. The card still shows
  // the prospect, the evidence and the recommended action; the reviewer
  // writes the message. That beats showing a fabricated one.
  let draftId: string | undefined;
  if (options.model) {
    const draft = await draftForRecommendation(db, options.model, recommendationId);
    if (draft.ok) draftId = draft.draftId;
    else console.log(`no draft for ${recommendationId}: ${draft.reason}`);
  }

  await setStatus(db, campaignId, personId, 'awaiting_approval');

  return {
    personId,
    stage: 'recommended',
    identitiesLinked: linked,
    signalsStored: stored,
    recommendationId,
    ...(draftId ? { draftId } : {}),
  };
}

/** Matches on the stable platform id, never the renameable handle. */
async function upsertPerson(
  db: Client,
  candidate: PersonCandidate,
  stamp: string,
): Promise<string> {
  const githubIdentity = candidate.identities.find((i) => i.network === 'github');

  const existing = githubIdentity?.platformUserId
    ? await queryOne<{ person_id: string }>(
        db,
        'SELECT person_id FROM social_identities WHERE network = ? AND platform_user_id = ?',
        ['github', githubIdentity.platformUserId],
      )
    : undefined;

  if (existing) return existing.person_id;

  const companyId = candidate.companyName ? await upsertCompany(db, candidate, stamp) : undefined;

  const personId = newId('person');
  await db.execute({
    sql: `INSERT INTO people (id, display_name, first_name, last_name, current_company_id,
          current_title, location, identity_confidence, status, outreach_eligible,
          believed_minor, created_at, updated_at, last_resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'active', 1, 0, ?, ?, ?)`,
    args: [
      personId,
      candidate.fullName,
      candidate.firstName ?? null,
      candidate.lastName ?? null,
      companyId ?? null,
      candidate.title ?? null,
      candidate.location ?? null,
      stamp,
      stamp,
      stamp,
    ],
  });

  return personId;
}

async function upsertCompany(
  db: Client,
  candidate: PersonCandidate,
  stamp: string,
): Promise<string> {
  if (candidate.companyDomain) {
    const existing = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM companies WHERE domain = ?',
      [candidate.companyDomain],
    );
    if (existing) return existing.id;
  }

  const id = newId('company');
  await db.execute({
    sql: `INSERT INTO companies (id, name, domain, employee_count, industry, technologies,
          created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', ?, ?)`,
    args: [
      id,
      candidate.companyName ?? 'Unknown',
      candidate.companyDomain ?? null,
      candidate.employeeCount ?? null,
      candidate.industry ?? null,
      stamp,
      stamp,
    ],
  });
  return id;
}

/**
 * Scores each discovered identity and stores only those clearing the
 * workspace's auto-merge threshold. Anything in the candidate band becomes a
 * review row instead of a silent link (PRD §9.4).
 */
async function linkIdentities(
  db: Client,
  personId: string,
  candidate: PersonCandidate,
  provider: GitHubProvider,
  stamp: string,
): Promise<number> {
  const workspace = await queryOne<{ auto_merge_threshold: number; candidate_threshold: number }>(
    db,
    `SELECT w.auto_merge_threshold, w.candidate_threshold FROM workspaces w LIMIT 1`,
  );

  const thresholds = {
    autoMerge: workspace?.auto_merge_threshold ?? 0.9,
    candidate: workspace?.candidate_threshold ?? 0.7,
  };

  // Handles the person published on their own GitHub profile — these are what
  // make a cross-link, rather than an inference.
  const declared = candidate.identities
    .map((i) => i.handle)
    .filter((h): h is string => typeof h === 'string');

  let linked = 0;

  for (const identity of candidate.identities) {
    const evidence: EvidenceInput[] = deriveEvidence({
      identity,
      candidate,
      capabilities: provider.capabilities(),
      crossLinkedHandles: declared,
      ...(candidate.companyName ? { platformEmployer: candidate.companyName } : {}),
    });

    // The GitHub account itself is the anchor, not an inference about it.
    const resolution =
      identity.network === 'github'
        ? { decision: 'merge' as const, score: 1, verifiedBy: ['provider_asserted_link'] }
        : resolveIdentity(evidence, { thresholds });

    if (resolution.decision === 'merge') {
      await db.execute({
        sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
              profile_url, confidence, source_type, verified_by, first_seen_at, last_verified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'official_api', ?, ?, ?)
              -- The uniqueness index is partial, so the conflict target has to
              -- repeat its WHERE clause or SQLite refuses to match it.
              ON CONFLICT(network, platform_user_id) WHERE platform_user_id IS NOT NULL
              DO NOTHING`,
        args: [
          newId('socialIdentity'),
          personId,
          identity.network,
          identity.handle ?? null,
          identity.platformUserId ?? null,
          identity.profileUrl ?? null,
          resolution.score,
          JSON.stringify(resolution.verifiedBy),
          stamp,
          stamp,
        ],
      });
      linked += 1;
    } else if (resolution.decision === 'candidate') {
      await db.execute({
        sql: `INSERT INTO identity_candidates (id, workspace_id, person_id, network, handle,
              platform_user_id, profile_url, score, status, created_at)
              VALUES (?, (SELECT id FROM workspaces LIMIT 1), ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        args: [
          newId('identityCandidate'),
          personId,
          identity.network,
          identity.handle ?? null,
          identity.platformUserId ?? null,
          identity.profileUrl ?? null,
          resolution.score,
          stamp,
        ],
      });
    }
  }

  // The person is only as trustworthy as their weakest confirmed link.
  const scores = await queryAll<{ confidence: number }>(
    db,
    'SELECT confidence FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const aggregate = scores.length === 0 ? 0 : Math.min(...scores.map((s) => s.confidence));

  await db.execute({
    sql: 'UPDATE people SET identity_confidence = ?, last_resolved_at = ? WHERE id = ?',
    args: [aggregate, stamp, personId],
  });

  return linked;
}

async function storeSignals(
  db: Client,
  workspaceId: string,
  personId: string,
  extracted: readonly ExtractedSignal[],
  stamp: string,
): Promise<number> {
  let stored = 0;

  for (const signal of extracted) {
    // The source URL is the natural dedupe key: re-running research must not
    // duplicate the same public event.
    if (signal.sourceUrl) {
      const existing = await queryOne<{ id: string }>(
        db,
        'SELECT id FROM signals WHERE workspace_id = ? AND person_id = ? AND source_url = ? AND signal_type = ?',
        [workspaceId, personId, signal.sourceUrl, signal.type],
      );
      if (existing) continue;
    }

    await db.execute({
      sql: `INSERT INTO signals (id, workspace_id, person_id, network, signal_type, subtype,
            summary, evidence, source_url, source_timestamp, observed_at, confidence,
            relevance, sentiment)
            VALUES (?, ?, ?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('signal'),
        workspaceId,
        personId,
        signal.type,
        signal.subtype ?? null,
        signal.summary,
        signal.evidence ?? null,
        signal.sourceUrl ?? null,
        signal.sourceTimestamp,
        stamp,
        signal.confidence,
        signal.relevance,
        signal.sentiment,
      ],
    });
    stored += 1;
  }

  return stored;
}

async function createRecommendation(
  db: Client,
  options: PipelineOptions,
  personId: string,
): Promise<string | undefined> {
  const { db: _db, workspaceId, campaignId } = options;
  void _db;

  const person = await queryOne<{
    identity_confidence: number;
    status: string;
    believed_minor: number;
  }>(db, 'SELECT identity_confidence, status, believed_minor FROM people WHERE id = ?', [personId]);
  if (!person) return undefined;

  const campaign = await queryOne<{ approval_mode: string; budget_json: string }>(
    db,
    'SELECT approval_mode, budget_json FROM campaigns WHERE id = ?',
    [campaignId],
  );
  if (!campaign) return undefined;

  const workspace = await queryOne<{ min_outreach_confidence: number }>(
    db,
    'SELECT min_outreach_confidence FROM workspaces WHERE id = ?',
    [workspaceId],
  );

  const signalRows = await queryAll<{
    id: string;
    network: string;
    signal_type: string;
    summary: string;
    evidence: string | null;
    source_url: string | null;
    source_timestamp: string | null;
    observed_at: string;
    confidence: number;
    relevance: number;
    expires_at: string | null;
  }>(
    db,
    `SELECT id, network, signal_type, summary, evidence, source_url, source_timestamp,
            observed_at, confidence, relevance, expires_at
       FROM signals WHERE workspace_id = ? AND person_id = ?`,
    [workspaceId, personId],
  );

  const signals: CandidateSignal[] = signalRows.map((row) => ({
    id: row.id,
    network: row.network as Network,
    type: row.signal_type as SignalType,
    summary: row.summary,
    ...(row.evidence ? { evidence: row.evidence } : {}),
    ...(row.source_url ? { sourceUrl: row.source_url } : {}),
    ...(row.source_timestamp ? { sourceTimestamp: row.source_timestamp } : {}),
    observedAt: row.observed_at,
    confidence: row.confidence,
    relevance: row.relevance,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
  }));

  const identities = await queryAll<{ network: string }>(
    db,
    'SELECT DISTINCT network FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const score = await queryOne<{ opportunity: number }>(
    db,
    'SELECT opportunity FROM scores WHERE campaign_id = ? AND person_id = ?',
    [campaignId, personId],
  );

  const budget = safeJson(campaign.budget_json);
  const counts = await actionCounts(db, workspaceId, personId);
  const flags = await featureFlags(db, workspaceId);
  const connected = await connectedNetworks(db, workspaceId);

  const result = generateRecommendation({
    personId,
    campaignId,
    signals,
    reachableNetworks: identities.map((i) => i.network as Network),
    opportunity: score?.opportunity ?? 0,
    ...(options.now ? { now: options.now } : {}),
    policy: {
      approvalMode: campaign.approval_mode as 'draft_and_approve',
      // Resolved per-network below by the engine's own policy calls; this is
      // the workspace-wide answer for the common case.
      hasConnectedAccount: connected.size > 0,
      personSuppressed: person.status === 'suppressed',
      personBelievedMinor: person.believed_minor === 1,
      personDeleted: person.status === 'deleted',
      identityConfidence: person.identity_confidence,
      minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
      actionsToday: counts.today,
      maxActionsPerDay: numberOr(budget.maxActionsPerDay, 50),
      actionsToThisProspectThisWeek: counts.thisProspect,
      maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
      featureFlags: flags,
    },
  });

  if (!result.ok) return undefined;

  const recommendation = result.recommendation;
  const id = newId('recommendation');

  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
          priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
          status, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    args: [
      id,
      workspaceId,
      campaignId,
      personId,
      recommendation.action,
      recommendation.network,
      recommendation.priority,
      recommendation.reason,
      recommendation.triggerSignalId ?? null,
      recommendation.policyDecision,
      recommendation.policyVersion,
      recommendation.expectedGoal,
      now(),
      recommendation.expiresAt ?? null,
    ],
  });

  return id;
}

async function recordProvenance(
  db: Client,
  personId: string,
  candidate: PersonCandidate,
  stamp: string,
): Promise<void> {
  const fields: [string, string | undefined][] = [
    ['fullName', candidate.fullName],
    ['companyName', candidate.companyName],
    ['location', candidate.location],
    ['personalDomain', candidate.personalDomain],
  ];

  for (const [field, value] of fields) {
    if (!value) continue;
    await db.execute({
      sql: `INSERT INTO field_provenance (id, entity_kind, entity_id, field, value, source_type,
            provider, source_record_id, license_class, confidence, observed_at, created_at)
            VALUES (?, 'person', ?, ?, ?, 'official_api', 'github', ?, 'public_api', 1.0, ?, ?)`,
      args: [
        newId('fieldProvenance'),
        personId,
        field,
        value,
        candidate.sourceRecordId ?? null,
        candidate.observedAt,
        stamp,
      ],
    });
  }
}

async function ensureCampaignMembership(
  db: Client,
  campaignId: string,
  personId: string,
  workspaceId: string,
  stamp: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
          interaction_state, discovered_at, updated_at)
          VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)
          ON CONFLICT(campaign_id, person_id) DO NOTHING`,
    args: [campaignId, personId, workspaceId, stamp, stamp],
  });
}

async function setStatus(
  db: Client,
  campaignId: string,
  personId: string,
  status: string,
  reason?: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE campaign_people SET status = ?, status_reason = ?, updated_at = ?
           WHERE campaign_id = ? AND person_id = ?`,
    args: [status, reason ?? null, now(), campaignId, personId],
  });
}

async function isSuppressed(db: Client, workspaceId: string, personId: string): Promise<boolean> {
  const identities = await queryAll<{ network: string; platform_user_id: string | null }>(
    db,
    'SELECT network, platform_user_id FROM social_identities WHERE person_id = ?',
    [personId],
  );

  const keys = [`person:${personId}`];
  for (const identity of identities) {
    if (identity.platform_user_id) {
      keys.push(`platform:${identity.network}:${identity.platform_user_id}`);
    }
  }

  const placeholders = keys.map(() => '?').join(', ');
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${placeholders}) AND (scope = 'global' OR workspace_id = ?)`,
    [...keys, workspaceId],
  );

  return Number(row?.n ?? 0) > 0;
}

async function extractionContext(db: Client, campaignId: string) {
  const filters = await queryOne<{ technologies: string; keywords: string }>(
    db,
    'SELECT technologies, keywords FROM campaign_filters WHERE campaign_id = ?',
    [campaignId],
  );

  const offering = await queryOne<{ competitors: string }>(
    db,
    `SELECT o.competitors FROM offerings o
       JOIN campaigns c ON c.offering_id = o.id WHERE c.id = ?`,
    [campaignId],
  );

  return {
    technologies: parseArray(filters?.technologies),
    keywords: parseArray(filters?.keywords),
    competitors: parseArray(offering?.competitors),
  };
}

async function actionCounts(db: Client, workspaceId: string, personId: string) {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const today = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions WHERE workspace_id = ? AND created_at >= ?`,
    [workspaceId, dayAgo],
  );
  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions WHERE workspace_id = ? AND person_id = ? AND created_at >= ?`,
    [workspaceId, personId, weekAgo],
  );

  return { today: Number(today?.n ?? 0), thisProspect: Number(week?.n ?? 0) };
}

async function featureFlags(db: Client, workspaceId: string): Promise<Record<string, boolean>> {
  const rows = await queryAll<{ key: string; enabled: number }>(
    db,
    'SELECT key, enabled FROM feature_flags WHERE workspace_id IS NULL OR workspace_id = ?',
    [workspaceId],
  );

  const flags: Record<string, boolean> = {};
  for (const row of rows) flags[row.key] = row.enabled === 1;
  return flags;
}

async function connectedNetworks(db: Client, workspaceId: string): Promise<Set<string>> {
  const rows = await queryAll<{ network: string }>(
    db,
    `SELECT DISTINCT network FROM integration_accounts WHERE workspace_id = ? AND status = 'active'`,
    [workspaceId],
  );
  return new Set(rows.map((r) => r.network));
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

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
