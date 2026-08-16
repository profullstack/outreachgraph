/**
 * Data access for the API.
 *
 * Every query here is workspace-scoped. That is not a convention to remember —
 * each function takes `workspaceId` as a required argument, so omitting it is
 * a type error (PRD §34 row-level authorization).
 */

import { newId, OUTBOUND_ACTION_KINDS, type ActionKind, type Network } from '@outreachgraph/domain';
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
/**
 * What the approval queue can be narrowed to.
 *
 * The queue was one undifferentiated list, and in practice that made it
 * unusable: production held 73 `refresh_research` cards — internal actions
 * that have no message by definition and never will — against a single email
 * actually waiting for a decision. Every one of the 73 renders as a card with
 * nothing written on it, so the queue reads as "the composer is broken" when
 * it is really "you are looking at the wrong 73 rows".
 */
export const APPROVAL_FILTERS = ['all', 'ready', 'needs_draft', 'research'] as const;
export type ApprovalFilter = (typeof APPROVAL_FILTERS)[number];

export function isApprovalFilter(value: unknown): value is ApprovalFilter {
  return typeof value === 'string' && (APPROVAL_FILTERS as readonly string[]).includes(value);
}

export async function listPendingRecommendations(
  db: Client,
  workspaceId: string,
  limit: number,
  filter: ApprovalFilter = 'all',
) {
  const outbound = OUTBOUND_ACTION_KINDS.map(() => '?').join(', ');

  // `ready` is the one that answers "what can I actually approve right now" —
  // an outbound action with a message already written.
  const clause: Readonly<Record<ApprovalFilter, string>> = {
    all: '',
    ready: `AND r.action IN (${outbound}) AND d.id IS NOT NULL`,
    needs_draft: `AND r.action IN (${outbound}) AND d.id IS NULL`,
    research: `AND r.action NOT IN (${outbound})`,
  };

  // Every row carries the bucket it belongs to, whatever the query was
  // narrowed to. That is what lets the page fetch once and switch tabs
  // without going back to the server: the classification the tabs sort by
  // comes from the same SQL that produces the counts, so a client-side tab
  // can never disagree with the badge next to it.
  const bucketExpression = `CASE
              WHEN r.action NOT IN (${outbound}) THEN 'research'
              WHEN d.id IS NOT NULL THEN 'ready'
              ELSE 'needs_draft'
            END AS bucket`;

  // Placeholders bind in the order they appear in the statement, so the
  // bucket expression's arguments come first — it sits in the SELECT list,
  // ahead of the WHERE clause the filter narrows.
  const clauseArgs: string[] = filter === 'all' ? [] : [...OUTBOUND_ACTION_KINDS];

  return queryAll(
    db,
    `SELECT r.*, p.display_name, p.current_title, p.identity_confidence,
            s.summary AS signal_summary, s.source_url AS signal_url,
            s.source_timestamp AS signal_at,
            d.body AS draft_body, d.subject AS draft_subject,
            sc.opportunity,
            ${bucketExpression}
       FROM recommendations r
       JOIN people p ON p.id = r.person_id
  LEFT JOIN signals s ON s.id = r.trigger_signal_id
  LEFT JOIN drafts d ON d.recommendation_id = r.id
  LEFT JOIN scores sc ON sc.person_id = r.person_id AND sc.campaign_id = r.campaign_id
      WHERE r.workspace_id = ? AND r.status = 'pending'
        AND (r.expires_at IS NULL OR r.expires_at > ?)
        ${clause[filter]}
   ORDER BY r.priority DESC, r.created_at ASC
      LIMIT ?`,
    [...OUTBOUND_ACTION_KINDS, workspaceId, now(), ...clauseArgs, limit],
  );
}

/** How many pending cards sit in each filter, for the counts on the tabs. */
export async function approvalCounts(
  db: Client,
  workspaceId: string,
): Promise<Record<ApprovalFilter, number>> {
  const outbound = OUTBOUND_ACTION_KINDS.map(() => '?').join(', ');

  const row = await queryOne<{
    total: number;
    ready: number;
    needs_draft: number;
    research: number;
  }>(
    db,
    // Not `AS all` — `all` is a reserved word and SQLite rejects it outright.
    `SELECT count(*) AS total,
            sum(CASE WHEN r.action IN (${outbound}) AND d.id IS NOT NULL THEN 1 ELSE 0 END) AS ready,
            sum(CASE WHEN r.action IN (${outbound}) AND d.id IS NULL THEN 1 ELSE 0 END) AS needs_draft,
            sum(CASE WHEN r.action NOT IN (${outbound}) THEN 1 ELSE 0 END) AS research
       FROM recommendations r
  LEFT JOIN drafts d ON d.recommendation_id = r.id
      WHERE r.workspace_id = ? AND r.status = 'pending'
        AND (r.expires_at IS NULL OR r.expires_at > ?)`,
    [
      ...OUTBOUND_ACTION_KINDS,
      ...OUTBOUND_ACTION_KINDS,
      ...OUTBOUND_ACTION_KINDS,
      workspaceId,
      now(),
    ],
  );

  return {
    all: Number(row?.total ?? 0),
    ready: Number(row?.ready ?? 0),
    needs_draft: Number(row?.needs_draft ?? 0),
    research: Number(row?.research ?? 0),
  };
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
  /**
   * An action to leave out of the counts — the one being executed.
   *
   * Approval creates the action row *after* the policy check, so it never
   * counts against itself there. Re-checking at execution time reads a table
   * that already contains it, and with the default of one action per prospect
   * per week that is enough for every send to be refused by its own existence.
   * The limit is about how often we contact someone, not about how many times
   * we ask permission to.
   */
  excludeActionId?: string,
): Promise<{ today: number; thisProspectThisWeek: number; hoursSinceLast?: number }> {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const exclude = excludeActionId ? 'AND id != ?' : '';
  const excludeArgs = excludeActionId ? [excludeActionId] : [];

  const today = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND created_at >= ? AND status != 'cancelled' ${exclude}`,
    [workspaceId, dayAgo, ...excludeArgs],
  );

  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM actions
      WHERE workspace_id = ? AND person_id = ? AND created_at >= ? AND status != 'cancelled'
        ${exclude}`,
    [workspaceId, personId, weekAgo, ...excludeArgs],
  );

  const last = await queryOne<{ created_at: string }>(
    db,
    `SELECT created_at FROM actions
      WHERE workspace_id = ? AND person_id = ? AND status != 'cancelled' ${exclude}
   ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, personId, ...excludeArgs],
  );

  const hoursSinceLast = last ? (Date.now() - Date.parse(last.created_at)) / 3_600_000 : undefined;

  return {
    today: Number(today?.n ?? 0),
    thisProspectThisWeek: Number(week?.n ?? 0),
    ...(hoursSinceLast === undefined ? {} : { hoursSinceLast }),
  };
}

export interface ContactAddress {
  readonly address: string;
  /** True when this is the company's inbox rather than the person's own. */
  readonly shared: boolean;
}

/**
 * The address an email to this person would actually be delivered to.
 *
 * Mirrors `pickEmailRecipient` in `@outreachgraph/pipeline` deliberately: the
 * policy engine has to count against the same mailbox the sender will use, and
 * if the two ever disagree the limits are protecting an address nobody writes
 * to. Personal identity first, company inbox second, nothing third.
 */
export async function resolveContactAddress(
  db: Client,
  personId: string,
): Promise<ContactAddress | undefined> {
  const personal = await queryOne<{ handle: string }>(
    db,
    `SELECT handle FROM social_identities
      WHERE person_id = ? AND network = 'email' AND handle IS NOT NULL AND trim(handle) <> ''
   ORDER BY confidence DESC LIMIT 1`,
    [personId],
  );
  if (personal?.handle) return { address: personal.handle.trim().toLowerCase(), shared: false };

  const company = await queryOne<{ contact_email: string }>(
    db,
    `SELECT co.contact_email FROM people p
       JOIN companies co ON co.id = p.current_company_id
      WHERE p.id = ? AND co.contact_email IS NOT NULL AND trim(co.contact_email) <> ''`,
    [personId],
  );
  if (company?.contact_email) {
    return { address: company.contact_email.trim().toLowerCase(), shared: true };
  }

  return undefined;
}

/**
 * How much mail one address has had, regardless of who it was addressed to.
 *
 * Counted from `interactions` rather than `actions` because an interaction is
 * the record of something that actually went out. An approved action that has
 * not been sent has not reached anyone's inbox, and refusing on account of it
 * would block the very send it is waiting for.
 */
export async function addressCounts(
  db: Client,
  workspaceId: string,
  address: string,
  /** The action being executed, which must not count against its own limit. */
  excludeActionId?: string,
): Promise<{ thisWeek: number; hoursSinceLast?: number }> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const exclude = excludeActionId ? 'AND (action_id IS NULL OR action_id != ?)' : '';
  const excludeArgs = excludeActionId ? [excludeActionId] : [];

  const week = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound'
        AND occurred_at >= ? ${exclude}`,
    [workspaceId, address, weekAgo, ...excludeArgs],
  );

  const last = await queryOne<{ occurred_at: string }>(
    db,
    `SELECT occurred_at FROM interactions
      WHERE workspace_id = ? AND contact_address = ? AND direction = 'outbound' ${exclude}
   ORDER BY occurred_at DESC LIMIT 1`,
    [workspaceId, address, ...excludeArgs],
  );

  const hoursSinceLast = last ? (Date.now() - Date.parse(last.occurred_at)) / 3_600_000 : undefined;

  return {
    thisWeek: Number(week?.n ?? 0),
    ...(hoursSinceLast === undefined ? {} : { hoursSinceLast }),
  };
}

/**
 * Whether this contact has written back.
 *
 * Checked by person *and* by address: a reply from a shared inbox answers on
 * behalf of everyone who was written to there, and continuing to mail
 * colleagues after someone at the company has replied is the same mistake in
 * a thinner disguise.
 */
export async function conversationOpen(
  db: Client,
  workspaceId: string,
  personId: string,
  address?: string,
): Promise<boolean> {
  const byPerson = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND person_id = ? AND direction = 'inbound'`,
    [workspaceId, personId],
  );
  if (Number(byPerson?.n ?? 0) > 0) return true;

  if (!address) return false;

  const byAddress = await queryOne<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM interactions
      WHERE workspace_id = ? AND contact_address = ? AND direction = 'inbound'`,
    [workspaceId, address],
  );
  return Number(byAddress?.n ?? 0) > 0;
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
  readonly mode: 'official_api' | 'manual' | 'crm' | 'customer_managed';
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
