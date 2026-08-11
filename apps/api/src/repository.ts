/**
 * Data access for the API.
 *
 * Every query here is workspace-scoped. That is not a convention to remember —
 * each function takes `workspaceId` as a required argument, so omitting it is
 * a type error (PRD §34 row-level authorization).
 */

import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';

export interface PersonRow {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  current_title: string | null;
  current_company_id: string | null;
  location: string | null;
  identity_confidence: number;
  status: string;
  outreach_eligible: number;
  believed_minor: number;
  created_at: string;
  updated_at: string;
}

export interface RecommendationRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  person_id: string;
  action: string;
  network: string;
  priority: number;
  reason: string;
  trigger_signal_id: string | null;
  draft_id: string | null;
  policy_status: string;
  policy_version: string;
  expected_goal: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

export interface ActionRow {
  id: string;
  workspace_id: string;
  recommendation_id: string;
  person_id: string;
  kind: string;
  network: string;
  mode: string;
  status: string;
  body: string | null;
  external_url: string | null;
  created_at: string;
  executed_at: string | null;
}

export async function getAction(
  db: Client,
  workspaceId: string,
  actionId: string,
): Promise<ActionRow | undefined> {
  return queryOne<ActionRow>(db, 'SELECT * FROM actions WHERE id = ? AND workspace_id = ?', [
    actionId,
    workspaceId,
  ]);
}

export async function getPerson(db: Client, personId: string): Promise<PersonRow | undefined> {
  return queryOne<PersonRow>(db, 'SELECT * FROM people WHERE id = ?', [personId]);
}

export async function getWorkspace(db: Client, workspaceId: string) {
  return queryOne<{
    id: string;
    organization_id: string;
    auto_merge_threshold: number;
    candidate_threshold: number;
    min_outreach_confidence: number;
    status: string;
  }>(db, 'SELECT * FROM workspaces WHERE id = ?', [workspaceId]);
}

export async function getCampaign(db: Client, workspaceId: string, campaignId: string) {
  return queryOne<{
    id: string;
    workspace_id: string;
    approval_mode: string;
    budget_json: string;
    status: string;
    name: string;
  }>(db, 'SELECT * FROM campaigns WHERE id = ? AND workspace_id = ?', [campaignId, workspaceId]);
}

export async function getRecommendation(
  db: Client,
  workspaceId: string,
  recommendationId: string,
): Promise<RecommendationRow | undefined> {
  return queryOne<RecommendationRow>(
    db,
    'SELECT * FROM recommendations WHERE id = ? AND workspace_id = ?',
    [recommendationId, workspaceId],
  );
}

/** The approval queue: pending work, highest priority first (PRD §15). */
export async function listPendingRecommendations(db: Client, workspaceId: string, limit: number) {
  return queryAll(
    db,
    `SELECT r.*, p.display_name, p.current_title, p.identity_confidence,
            s.summary AS signal_summary, s.source_url AS signal_url,
            s.source_timestamp AS signal_at,
            d.body AS draft_body, d.subject AS draft_subject,
            sc.opportunity
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
  LEFT JOIN signals s ON s.id = r.trigger_signal_id
  LEFT JOIN drafts d ON d.recommendation_id = r.id
  LEFT JOIN scores sc ON sc.person_id = r.person_id AND sc.campaign_id = r.campaign_id
      WHERE r.workspace_id = ? AND r.status = 'pending'
        AND (r.expires_at IS NULL OR r.expires_at > ?)
   ORDER BY r.priority DESC, r.created_at ASC
      LIMIT ?`,
    [workspaceId, now(), limit],
  );
}

export async function listSignals(db: Client, workspaceId: string, limit: number) {
  return queryAll(
    db,
    `SELECT s.*, p.display_name
       FROM signals s
  LEFT JOIN people p ON p.id = s.person_id
      WHERE s.workspace_id = ?
   ORDER BY COALESCE(s.source_timestamp, s.observed_at) DESC
      LIMIT ?`,
    [workspaceId, limit],
  );
}

export async function listPersonSignals(db: Client, workspaceId: string, personId: string) {
  return queryAll(
    db,
    `SELECT * FROM signals
      WHERE workspace_id = ? AND person_id = ?
   ORDER BY COALESCE(source_timestamp, observed_at) DESC
      LIMIT 200`,
    [workspaceId, personId],
  );
}

export async function listIdentities(db: Client, personId: string) {
  return queryAll(
    db,
    'SELECT * FROM social_identities WHERE person_id = ? ORDER BY confidence DESC',
    [personId],
  );
}

/** Field-level provenance for the expandable sources panel (PRD §25.2). */
export async function listProvenance(db: Client, personId: string) {
  return queryAll(
    db,
    `SELECT field, value, source_type, provider, source_url, license_class, observed_at, confidence
       FROM field_provenance
      WHERE entity_kind = 'person' AND entity_id = ?
   ORDER BY field`,
    [personId],
  );
}

/**
 * Counts recent actions for the rate-limit gates (PRD §7.7, §18).
 *
 * Both windows come from one pass so the policy check does not need two round
 * trips per recommendation.
 */
export async function actionCounts(
  db: Client,
  workspaceId: string,
  personId: string,
): Promise<{ today: number; thisProspectThisWeek: number; hoursSinceLast?: number }> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const today = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND created_at >= ? AND status != 'cancelled'`,
    [workspaceId, dayAgo],
  );

  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND person_id = ? AND created_at >= ? AND status != 'cancelled'`,
    [workspaceId, personId, weekAgo],
  );

  const last = await queryOne<{ created_at: string }>(
    db,
    `SELECT created_at FROM actions
      WHERE workspace_id = ? AND person_id = ? AND status != 'cancelled'
   ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, personId],
  );

  const hoursSinceLast = last ? (Date.now() - Date.parse(last.created_at)) / 3_600_000 : undefined;

  return {
    today: Number(today?.n ?? 0),
    thisProspectThisWeek: Number(week?.n ?? 0),
    ...(hoursSinceLast === undefined ? {} : { hoursSinceLast }),
  };
}

/** True when any suppression key matches this person (PRD §17.3). */
export async function isSuppressed(
  db: Client,
  workspaceId: string,
  matchKeys: readonly string[],
): Promise<boolean> {
  if (matchKeys.length === 0) return false;

  const placeholders = matchKeys.map(() => '?').join(', ');
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM suppression_keys
      WHERE match_key IN (${placeholders})
        AND (scope = 'global' OR workspace_id = ?)`,
    [...matchKeys, workspaceId],
  );

  return Number(row?.n ?? 0) > 0;
}

/** Match keys for a person, used for suppression lookup. */
export async function suppressionKeysForPerson(db: Client, personId: string): Promise<string[]> {
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
  return keys;
}

export async function hasConnectedAccount(
  db: Client,
  workspaceId: string,
  network: Network,
): Promise<boolean> {
  const row = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM integration_accounts
      WHERE workspace_id = ? AND network = ? AND status = 'active'`,
    [workspaceId, network],
  );
  return Number(row?.n ?? 0) > 0;
}

export async function featureFlags(
  db: Client,
  workspaceId: string,
): Promise<Record<string, boolean>> {
  const rows = await queryAll<{ key: string; enabled: number }>(
    db,
    'SELECT key, enabled FROM feature_flags WHERE workspace_id IS NULL OR workspace_id = ?',
    [workspaceId],
  );

  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    flags[row.key] = row.enabled === 1;
  }
  return flags;
}

export interface RecordActionInput {
  readonly workspaceId: string;
  readonly recommendationId: string;
  readonly personId: string;
  readonly kind: ActionKind;
  readonly network: Network;
  readonly mode: 'official_api' | 'manual' | 'crm';
  readonly body?: string;
  readonly externalUrl?: string;
}

export async function recordAction(db: Client, input: RecordActionInput): Promise<string> {
  const id = newId('action');
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
          mode, status, body, external_url, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    args: [
      id,
      input.workspaceId,
      input.recommendationId,
      input.personId,
      input.kind,
      input.network,
      input.mode,
      input.body ?? null,
      input.externalUrl ?? null,
      now(),
    ],
  });
  return id;
}

export interface AuditInput {
  readonly workspaceId?: string;
  readonly actorKind: 'user' | 'system' | 'worker';
  readonly actorId?: string;
  readonly eventType: string;
  readonly entityKind?: string;
  readonly entityId?: string;
  readonly detail?: unknown;
}

/** Append-only audit trail (PRD §18, §20.9). */
export async function audit(db: Client, input: AuditInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO audit_events (id, workspace_id, actor_kind, actor_id, event_type,
          entity_kind, entity_id, detail_json, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId('auditEvent'),
      input.workspaceId ?? null,
      input.actorKind,
      input.actorId ?? null,
      input.eventType,
      input.entityKind ?? null,
      input.entityId ?? null,
      JSON.stringify(input.detail ?? {}),
      now(),
    ],
  });
}

export async function recordUsage(
  db: Client,
  workspaceId: string,
  unit: string,
  quantity: number,
  costUsd = 0,
  provider?: string,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO usage_events (id, workspace_id, unit, quantity, cost_usd, provider, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [newId('usageEvent'), workspaceId, unit, quantity, costUsd, provider ?? null, now()],
  });
}
