/**
 * The AutoGTM surface: `/api/v1/autogtm/*`.
 *
 * A public API shaped the way agents already expect an outreach product to be
 * shaped — projects, campaigns, budgets in dollars, an inbox, hot leads,
 * suppress lists, an import — and backed entirely by what was already here.
 * Nothing in this file sends a message, scores a lead or decides a policy.
 * It translates, and then it calls the same code the approval queue and the
 * worker call.
 *
 * Words, so the mapping is not a secret:
 *
 *   - A **project** is an offering: one product, one daily ceiling.
 *   - A campaign's **daily limit** is dollars per day, stored on the campaign
 *     beside the action caps the policy engine enforces, and converted at
 *     `CONTACT_PRICE_USD` — see `packages/domain/src/autogtm.ts`.
 *   - **Autopilot** on a project puts its campaigns into `trusted_automation`
 *     and hands their budgets to the allocator. While it is on, per-campaign
 *     start/stop and budget calls answer 409, because two hands on one wheel
 *     is how a customer ends up not knowing why a campaign paused.
 *   - The **inbox** is `interactions`, grouped by person, tabbed by who spoke
 *     last. A reply is a `reply` recommendation approved by the caller, which
 *     is the only way anything leaves this product: through the policy engine.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  autogtmStatus,
  CONTACT_PRICE_USD,
  newId,
  replyRate,
  usdForContacts,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  applyProjectBudget,
  budgetStatus,
  campaignBudgetFrom,
  crawlDedupeKey,
  domainMatchKey,
  emailMatchKey,
  enqueue,
  finishContactImport,
  importContactChunk,
  normaliseDomain,
  peopleMatchingKeys,
  recordDiscovered,
  setCampaignDailyBudget,
  startContactImport,
} from '@outreachgraph/pipeline';
import { POLICY_VERSION } from '@outreachgraph/policy';
import {
  ensureOffering,
  inheritFilters,
  setCampaignAutopilot,
  setCampaignStatus,
} from './campaigns';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';
import { UnknownProductError } from './workspace-profile';

/** Leads accepted in one import request. */
export const IMPORT_MAX_LEADS = 5_000;
/** Rows handed to the importer at a time. */
const IMPORT_CHUNK = 500;
/** Conversations or leads per page. */
const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

export interface ApproveResult {
  readonly ok: boolean;
  readonly actionId?: string;
  readonly reason?: string;
  readonly decision?: string;
  readonly gate?: string | undefined;
  readonly delivery?: { sent: boolean; to?: string; reason?: string };
}

export interface AutogtmDeps {
  /**
   * Approves a pending recommendation as the actor and, for an email, sends
   * it. The API's own approval path, injected so this module cannot grow a
   * second one.
   */
  readonly approve: (
    db: Client,
    actor: RequestActor,
    recommendation: repo.RecommendationRow,
  ) => Promise<ApproveResult>;
  /** Refuses an unverified account anything that reaches a stranger. */
  readonly requireVerifiedEmail: (db: Client, actor: RequestActor) => Promise<void>;
}

// ------------------------------------------------------------------ schemas

const budgetBody = z.object({
  daily_budget_usd: z.number().min(0).max(100_000).nullable(),
});

const campaignBudgetBody = z.object({
  daily_limit_usd: z.number().min(0).max(100_000).nullable(),
});

const autopilotBody = z.object({ enabled: z.boolean() });

const stringList = z.array(z.string().trim().min(1).max(120)).max(100);

const targetingBody = z
  .object({
    titles: stringList,
    seniorities: stringList,
    industries: stringList,
    countries: stringList,
    keywords: stringList,
    technologies: stringList,
    exclusions: stringList,
    employee_count_min: z.number().int().min(0).nullable(),
    employee_count_max: z.number().int().min(0).nullable(),
  })
  .partial();

const campaignPatchBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    instructions: z.string().max(4_000),
    targeting: targetingBody,
    daily_limit_usd: z.number().min(0).max(100_000).nullable(),
  })
  .partial();

const replyBody = z.object({ text: z.string().trim().min(1).max(20_000) });

const noteBody = z.object({ note: z.string().max(4_000).nullable() });

const suppressPeopleBody = z.object({
  list_name: z.string().trim().min(1).max(100),
  emails: z.array(z.string().trim().email()).min(1).max(10_000),
  reason: z.enum(['do_not_contact', 'customer_request', 'complaint', 'admin']).optional(),
});

const suppressCompaniesBody = z.object({
  list_name: z.string().trim().min(1).max(100),
  domains: z.array(z.string().trim().min(3).max(253)).min(1).max(10_000),
  reason: z.enum(['do_not_contact', 'customer_request', 'complaint', 'admin']).optional(),
});

const importLead = z.object({
  email: z.string().trim().email(),
  first_name: z.string().trim().max(100).optional(),
  last_name: z.string().trim().max(100).optional(),
  company_domain: z.string().trim().max(253).optional(),
  company: z.string().trim().max(200).optional(),
  job_title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
});

const importBody = z.object({
  name: z.string().trim().min(1).max(200),
  project_id: z.string().min(1).optional(),
  leads: z.array(importLead).min(1).max(IMPORT_MAX_LEADS),
  instructions: z.string().max(4_000).optional(),
  autopilot: z.boolean().optional(),
  consent_basis: z.string().max(200).optional(),
  consent_source: z.string().max(500).optional(),
});

// ------------------------------------------------------------------ rows

interface CampaignRow {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly approval_mode: string;
  readonly budget_json: string;
  readonly offering_id: string;
  readonly brief: string | null;
  readonly seed_kind: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly updated_at: string;
  readonly project_autopilot: number;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
  readonly daily_budget_usd: number | null;
  readonly autopilot: number;
  readonly created_at: string;
  readonly campaigns: number;
}

async function ownedCampaign(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<CampaignRow> {
  const row = await queryOne<CampaignRow>(
    db,
    `SELECT c.id, c.name, c.status, c.approval_mode, c.budget_json, c.offering_id, c.brief,
            c.seed_kind, c.created_at, c.started_at, c.updated_at,
            o.autopilot AS project_autopilot
       FROM campaigns c JOIN offerings o ON o.id = c.offering_id
      WHERE c.id = ? AND c.workspace_id = ?`,
    [campaignId, workspaceId],
  );
  if (!row) throw ApiError.notFound('campaign');
  return row;
}

async function ownedProject(
  db: Client,
  workspaceId: string,
  projectId: string,
): Promise<ProjectRow> {
  const row = await queryOne<ProjectRow>(
    db,
    `SELECT o.id, o.name, o.url, o.daily_budget_usd, o.autopilot, o.created_at,
            (SELECT COUNT(*) FROM campaigns c
              WHERE c.offering_id = o.id AND c.status != 'archived') AS campaigns
       FROM offerings o WHERE o.id = ? AND o.workspace_id = ?`,
    [projectId, workspaceId],
  );
  if (!row) throw ApiError.notFound('project');
  return row;
}

function projectView(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    domain: row.url ? normaliseDomain(row.url) : null,
    daily_budget_usd: row.daily_budget_usd,
    autopilot: row.autopilot === 1,
    campaigns: Number(row.campaigns),
    created_at: row.created_at,
  };
}

interface CampaignStats {
  readonly leads_pool: number;
  readonly contacted: number;
  readonly emails_sent: number;
  readonly replies: number;
  readonly need_reply: number;
  readonly hot_leads: number;
  readonly awaiting_approval: number;
  readonly last_activity_at: string | null;
}

/**
 * The counts behind every campaign row.
 *
 * Messages are attributed to a campaign through membership — the person is in
 * the campaign — rather than through `interactions.campaign_id`, which the
 * hand-recorded paths leave null. A person in two campaigns counts in both,
 * which is the honest answer to "how is this campaign doing" when the same
 * lead was reached from either.
 */
async function campaignStats(
  db: Client,
  workspaceId: string,
  campaignId: string,
  since?: string,
): Promise<CampaignStats> {
  const window = since ? 'AND i.occurred_at >= ?' : '';
  const windowArgs = since ? [since] : [];

  const row = await queryOne<{
    leads_pool: number;
    contacted: number;
    emails_sent: number;
    replies: number;
    need_reply: number;
    hot_leads: number;
    awaiting_approval: number;
    last_activity_at: string | null;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM campaign_people cp JOIN people p ON p.id = cp.person_id
         WHERE cp.campaign_id = ? AND p.status != 'deleted') AS leads_pool,
       (SELECT COUNT(DISTINCT i.person_id) FROM interactions i
          JOIN campaign_people cp ON cp.person_id = i.person_id AND cp.campaign_id = ?
         WHERE i.workspace_id = ? AND i.direction = 'outbound' ${window}) AS contacted,
       (SELECT COUNT(*) FROM interactions i
          JOIN campaign_people cp ON cp.person_id = i.person_id AND cp.campaign_id = ?
         WHERE i.workspace_id = ? AND i.direction = 'outbound' AND i.network = 'email'
           ${window}) AS emails_sent,
       (SELECT COUNT(*) FROM interactions i
          JOIN campaign_people cp ON cp.person_id = i.person_id AND cp.campaign_id = ?
         WHERE i.workspace_id = ? AND i.direction = 'inbound' ${window}) AS replies,
       (SELECT COUNT(*) FROM campaign_people cp
         WHERE cp.campaign_id = ? AND cp.interaction_state = 'responded'
           AND NOT EXISTS (
             SELECT 1 FROM interactions o
              WHERE o.workspace_id = ? AND o.person_id = cp.person_id AND o.direction = 'outbound'
                AND o.occurred_at > (SELECT MAX(x.occurred_at) FROM interactions x
                                       WHERE x.workspace_id = o.workspace_id
                                         AND x.person_id = cp.person_id
                                         AND x.direction = 'inbound'))) AS need_reply,
       (SELECT COUNT(*) FROM campaign_people cp
         WHERE cp.campaign_id = ?
           AND cp.status IN ('responded', 'qualified_opportunity')) AS hot_leads,
       (SELECT COUNT(*) FROM recommendations r
         WHERE r.campaign_id = ? AND r.status = 'pending') AS awaiting_approval,
       (SELECT MAX(e.occurred_at) FROM lead_stage_events e
         WHERE e.campaign_id = ?) AS last_activity_at`,
    [
      campaignId,
      campaignId,
      workspaceId,
      ...windowArgs,
      campaignId,
      workspaceId,
      ...windowArgs,
      campaignId,
      workspaceId,
      ...windowArgs,
      campaignId,
      workspaceId,
      campaignId,
      campaignId,
      campaignId,
    ],
  );

  return {
    leads_pool: Number(row?.leads_pool ?? 0),
    contacted: Number(row?.contacted ?? 0),
    emails_sent: Number(row?.emails_sent ?? 0),
    replies: Number(row?.replies ?? 0),
    need_reply: Number(row?.need_reply ?? 0),
    hot_leads: Number(row?.hot_leads ?? 0),
    awaiting_approval: Number(row?.awaiting_approval ?? 0),
    last_activity_at: row?.last_activity_at ?? null,
  };
}

function analyticsFrom(stats: CampaignStats) {
  const spend = usdForContacts(stats.contacted);
  return {
    leads_pool: stats.leads_pool,
    contacted: stats.contacted,
    emails_sent: stats.emails_sent,
    replies: stats.replies,
    reply_rate: replyRate(stats.emails_sent, stats.replies),
    need_reply: stats.need_reply,
    hot_leads: stats.hot_leads,
    awaiting_approval: stats.awaiting_approval,
    spend_usd: spend,
    cost_per_lead_usd:
      stats.hot_leads > 0 ? Math.round((spend / stats.hot_leads) * 100) / 100 : null,
    price_per_contact_usd: CONTACT_PRICE_USD,
    last_activity_at: stats.last_activity_at,
  };
}

function campaignView(row: CampaignRow, stats: CampaignStats) {
  const budget = campaignBudgetFrom(row.budget_json);
  return {
    id: row.id,
    project_id: row.offering_id,
    name: row.name,
    status: autogtmStatus({ ...row, contacted: stats.contacted }),
    raw_status: row.status,
    autopilot: row.approval_mode === 'trusted_automation',
    project_autopilot: row.project_autopilot === 1,
    daily_limit_usd: budget.dailyBudgetUsd ?? null,
    max_contacts_per_day: budget.maxActionsPerDay ?? null,
    source: row.seed_kind,
    created_at: row.created_at,
    started_at: row.started_at,
    updated_at: row.updated_at,
    ...analyticsFrom(stats),
  };
}

async function targetingFor(db: Client, campaignId: string) {
  const row = await queryOne<{
    titles: string;
    seniorities: string;
    industries: string;
    countries: string;
    keywords: string;
    technologies: string;
    exclusions: string;
    employee_count_min: number | null;
    employee_count_max: number | null;
  }>(
    db,
    `SELECT titles, seniorities, industries, countries, keywords, technologies, exclusions,
            employee_count_min, employee_count_max
       FROM campaign_filters WHERE campaign_id = ?`,
    [campaignId],
  );

  const list = (text: string | undefined): string[] => {
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  };

  return {
    titles: list(row?.titles),
    seniorities: list(row?.seniorities),
    industries: list(row?.industries),
    countries: list(row?.countries),
    keywords: list(row?.keywords),
    technologies: list(row?.technologies),
    exclusions: list(row?.exclusions),
    employee_count_min: row?.employee_count_min ?? null,
    employee_count_max: row?.employee_count_max ?? null,
  };
}

async function saveTargeting(
  db: Client,
  campaignId: string,
  patch: z.infer<typeof targetingBody>,
): Promise<void> {
  const current = await targetingFor(db, campaignId);
  const next = { ...current, ...stripUndefined(patch) };
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO campaign_filters (campaign_id, titles, seniorities, industries, countries,
            keywords, technologies, exclusions, employee_count_min, employee_count_max, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(campaign_id) DO UPDATE SET
            titles = excluded.titles, seniorities = excluded.seniorities,
            industries = excluded.industries, countries = excluded.countries,
            keywords = excluded.keywords, technologies = excluded.technologies,
            exclusions = excluded.exclusions,
            employee_count_min = excluded.employee_count_min,
            employee_count_max = excluded.employee_count_max,
            updated_at = excluded.updated_at`,
    args: [
      campaignId,
      JSON.stringify(next.titles),
      JSON.stringify(next.seniorities),
      JSON.stringify(next.industries),
      JSON.stringify(next.countries),
      JSON.stringify(next.keywords),
      JSON.stringify(next.technologies),
      JSON.stringify(next.exclusions),
      next.employee_count_min,
      next.employee_count_max,
      stamp,
    ],
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function clampPage(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.floor(n));
}

async function parse<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    throw ApiError.badRequest('body must be JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw ApiError.badRequest(
      `invalid body: ${issue ? `${issue.path.join('.') || 'body'} ${issue.message}` : 'bad shape'}`,
      result.error.issues,
    );
  }
  return result.data;
}

function autopilotOwnsIt(row: { readonly project_autopilot: number }): never {
  throw new ApiError(
    409,
    'autopilot_on',
    'this project is on autopilot, which owns campaign start/stop and budgets; ' +
      'turn it off with PATCH /autogtm/projects/{project_id}/autopilot first',
  );
  void row;
}

function requireWriter(actor: RequestActor, what: string): void {
  if (!canApprove(actor)) throw ApiError.forbidden(what);
}

// ------------------------------------------------------------------ routes

export function autogtmRoutes(deps: AutogtmDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  // -------------------------------------------------------------- projects

  r.get('/projects', async (c) => {
    const actor = c.get('actor');
    const rows = await queryAll<ProjectRow>(
      c.get('db'),
      `SELECT o.id, o.name, o.url, o.daily_budget_usd, o.autopilot, o.created_at,
              (SELECT COUNT(*) FROM campaigns c
                WHERE c.offering_id = o.id AND c.status != 'archived') AS campaigns
         FROM offerings o WHERE o.workspace_id = ? ORDER BY o.created_at`,
      [actor.workspaceId],
    );
    return c.json({ projects: rows.map(projectView) });
  });

  r.get('/projects/:id', async (c) => {
    const actor = c.get('actor');
    const project = await ownedProject(c.get('db'), actor.workspaceId, c.req.param('id'));
    return c.json({ project: projectView(project) });
  });

  r.get('/projects/:id/budget', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const project = await ownedProject(db, actor.workspaceId, c.req.param('id'));
    const campaigns = await queryAll<{
      id: string;
      name: string;
      status: string;
      budget_json: string;
    }>(
      db,
      `SELECT id, name, status, budget_json FROM campaigns
        WHERE offering_id = ? AND workspace_id = ? AND status != 'archived' ORDER BY created_at`,
      [project.id, actor.workspaceId],
    );

    const allocation = campaigns.map((row) => ({
      campaign_id: row.id,
      name: row.name,
      status: row.status,
      daily_limit_usd: campaignBudgetFrom(row.budget_json).dailyBudgetUsd ?? null,
    }));

    return c.json({
      project_id: project.id,
      daily_budget_usd: project.daily_budget_usd,
      autopilot: project.autopilot === 1,
      allocated_usd: allocation.reduce((sum, row) => sum + (row.daily_limit_usd ?? 0), 0),
      allocation,
    });
  });

  r.patch('/projects/:id/budget', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'changing a budget');

    const project = await ownedProject(db, actor.workspaceId, c.req.param('id'));
    const body = await parse(c.req.raw, budgetBody);

    await db.execute({
      sql: 'UPDATE offerings SET daily_budget_usd = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      args: [body.daily_budget_usd, now(), project.id, actor.workspaceId],
    });
    const changed = await applyProjectBudget(db, actor.workspaceId, project.id);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'project.budget_changed',
      entityKind: 'offering',
      entityId: project.id,
      detail: { dailyBudgetUsd: body.daily_budget_usd, campaignsReallocated: changed },
    });

    return c.json({
      project_id: project.id,
      daily_budget_usd: body.daily_budget_usd,
      campaigns_reallocated: changed,
    });
  });

  r.patch('/projects/:id/autopilot', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'changing autopilot');

    const project = await ownedProject(db, actor.workspaceId, c.req.param('id'));
    const body = await parse(c.req.raw, autopilotBody);

    // Turning it on spends money without asking again.
    if (body.enabled) await deps.requireVerifiedEmail(db, actor);

    await db.execute({
      sql: 'UPDATE offerings SET autopilot = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
      args: [body.enabled ? 1 : 0, now(), project.id, actor.workspaceId],
    });

    const campaigns = await queryAll<{ id: string }>(
      db,
      `SELECT id FROM campaigns WHERE offering_id = ? AND workspace_id = ? AND status != 'archived'`,
      [project.id, actor.workspaceId],
    );
    for (const campaign of campaigns) {
      await setCampaignAutopilot(db, actor.workspaceId, campaign.id, body.enabled);
    }
    const changed = await applyProjectBudget(db, actor.workspaceId, project.id);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: body.enabled ? 'project.autopilot_enabled' : 'project.autopilot_disabled',
      entityKind: 'offering',
      entityId: project.id,
      detail: { campaigns: campaigns.length, campaignsReallocated: changed },
    });

    return c.json({
      project_id: project.id,
      autopilot: body.enabled,
      campaigns: campaigns.length,
      campaigns_reallocated: changed,
    });
  });

  r.get('/projects/:id/analytics', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const project = await ownedProject(db, actor.workspaceId, c.req.param('id'));
    const since = c.req.query('since');

    const rows = await queryAll<CampaignRow>(
      db,
      `SELECT c.id, c.name, c.status, c.approval_mode, c.budget_json, c.offering_id, c.brief,
              c.seed_kind, c.created_at, c.started_at, c.updated_at,
              o.autopilot AS project_autopilot
         FROM campaigns c JOIN offerings o ON o.id = c.offering_id
        WHERE c.offering_id = ? AND c.workspace_id = ? AND c.status != 'archived'
        ORDER BY c.created_at`,
      [project.id, actor.workspaceId],
    );

    const campaigns = [];
    const totals = {
      leads_pool: 0,
      contacted: 0,
      emails_sent: 0,
      replies: 0,
      need_reply: 0,
      hot_leads: 0,
      awaiting_approval: 0,
      last_activity_at: null as string | null,
    };

    for (const row of rows) {
      const stats = await campaignStats(db, actor.workspaceId, row.id, since);
      campaigns.push(campaignView(row, stats));
      totals.leads_pool += stats.leads_pool;
      totals.contacted += stats.contacted;
      totals.emails_sent += stats.emails_sent;
      totals.replies += stats.replies;
      totals.need_reply += stats.need_reply;
      totals.hot_leads += stats.hot_leads;
      totals.awaiting_approval += stats.awaiting_approval;
      if (
        stats.last_activity_at &&
        (!totals.last_activity_at || stats.last_activity_at > totals.last_activity_at)
      ) {
        totals.last_activity_at = stats.last_activity_at;
      }
    }

    return c.json({
      project: projectView(project),
      ...(since ? { since } : {}),
      totals: analyticsFrom(totals),
      campaigns,
    });
  });

  // ------------------------------------------------------------- campaigns

  r.get('/campaigns', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const projectId = c.req.query('project_id');
    const includeArchived = c.req.query('include_archived') === 'true';

    const rows = await queryAll<CampaignRow>(
      db,
      `SELECT c.id, c.name, c.status, c.approval_mode, c.budget_json, c.offering_id, c.brief,
              c.seed_kind, c.created_at, c.started_at, c.updated_at,
              o.autopilot AS project_autopilot
         FROM campaigns c JOIN offerings o ON o.id = c.offering_id
        WHERE c.workspace_id = ?
          ${projectId ? 'AND c.offering_id = ?' : ''}
          ${includeArchived ? '' : "AND c.status != 'archived'"}
        ORDER BY CASE c.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
                 c.created_at DESC`,
      projectId ? [actor.workspaceId, projectId] : [actor.workspaceId],
    );

    const campaigns = [];
    for (const row of rows) {
      campaigns.push(campaignView(row, await campaignStats(db, actor.workspaceId, row.id)));
    }
    return c.json({ campaigns });
  });

  // Registered before `/campaigns/:id` so "import" is never read as an id.
  r.post('/campaigns/import', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'importing leads');
    await deps.requireVerifiedEmail(db, actor);

    const body = await parse(c.req.raw, importBody);
    if (body.autopilot) await deps.requireVerifiedEmail(db, actor);

    let offering;
    try {
      offering = await ensureOffering(db, actor.workspaceId, body.project_id);
    } catch (error) {
      if (error instanceof UnknownProductError) throw ApiError.notFound('project');
      throw error;
    }

    const campaignId = newId('campaign');
    const stamp = now();

    await db.execute({
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, voice_profile_id, brief,
            networks, approval_mode, status, seed_kind, seed_value, created_at, updated_at,
            started_at)
            VALUES (?, ?, ?, ?, ?, ?, '["email"]', ?, 'active', 'import', ?, ?, ?, ?)`,
      args: [
        campaignId,
        actor.workspaceId,
        body.name,
        offering.id,
        offering.voiceProfileId,
        body.instructions ?? null,
        body.autopilot ? 'trusted_automation' : 'draft_and_approve',
        `${body.leads.length} imported leads`,
        stamp,
        stamp,
        stamp,
      ],
    });
    await inheritFilters(db, campaignId, actor.workspaceId, offering.id, stamp);

    const importId = await startContactImport(db, {
      workspaceId: actor.workspaceId,
      userId: actor.userId,
      campaignId,
      filename: `autogtm:${body.name}`,
      consentBasis: body.consent_basis ?? 'opt_in',
      ...(body.consent_source ? { consentSource: body.consent_source } : {}),
    });

    let imported = 0;
    let merged = 0;
    let rejected = 0;
    const personIds = new Set<string>();

    for (let offset = 0; offset < body.leads.length; offset += IMPORT_CHUNK) {
      const rows = body.leads.slice(offset, offset + IMPORT_CHUNK).map((lead) => ({
        email: lead.email,
        ...(lead.first_name ? { firstName: lead.first_name } : {}),
        ...(lead.last_name ? { lastName: lead.last_name } : {}),
        ...(lead.company ? { company: lead.company } : {}),
        ...(lead.job_title ? { title: lead.job_title } : {}),
        ...(lead.location ? { location: lead.location } : {}),
      }));

      const result = await importContactChunk(db, importId, rows, { startRow: offset });
      imported += result.imported;
      merged += result.merged;
      rejected += result.rejected;
      for (const id of result.personIds) personIds.add(id);
    }

    // The importer makes people; a campaign is a membership. Without this the
    // leads exist and the campaign is empty, which is the bug the old
    // `/contacts/imports` path shipped with.
    for (const personId of personIds) {
      const inserted = await db.execute({
        sql: `INSERT OR IGNORE INTO campaign_people (campaign_id, person_id, workspace_id, status,
              interaction_state, discovered_at, updated_at)
              VALUES (?, ?, ?, 'discovered', 'never_contacted', ?, ?)`,
        args: [campaignId, personId, actor.workspaceId, stamp, stamp],
      });
      if (inserted.rowsAffected > 0) {
        await recordDiscovered(db, { workspaceId: actor.workspaceId, campaignId, personId });
      }
    }

    // Research is what makes a lead sendable: every message is grounded in
    // something read about them, so their company site is queued under this
    // campaign. One crawl per domain however many colleagues were listed.
    const domains = new Set<string>();
    for (const lead of body.leads) {
      const domain = lead.company_domain
        ? normaliseDomain(lead.company_domain)
        : normaliseDomain(lead.email.split('@')[1] ?? '');
      if (domain && !FREEMAIL.has(domain)) domains.add(domain);
    }
    let crawls = 0;
    for (const domain of domains) {
      const url = `https://${domain}`;
      const queued = await enqueue(db, {
        workspaceId: actor.workspaceId,
        kind: 'crawl_site',
        payload: { url, campaignId },
        dedupeKey: crawlDedupeKey(url),
      });
      if (queued.queued) crawls += 1;
    }

    await finishContactImport(db, importId);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'autogtm.campaign_imported',
      entityKind: 'campaign',
      entityId: campaignId,
      detail: { importId, imported, merged, rejected, crawls },
    });

    return c.json(
      {
        task_id: importId,
        campaign_id: campaignId,
        project_id: offering.id,
        status: 'completed',
        imported,
        merged,
        rejected,
        crawls_queued: crawls,
      },
      201,
    );
  });

  r.get('/campaigns/import/:task_id', async (c) => {
    const actor = c.get('actor');
    const row = await queryOne<{
      id: string;
      campaign_id: string | null;
      status: string;
      total_rows: number;
      imported: number;
      merged: number;
      rejected: number;
      created_at: string;
      updated_at: string;
    }>(
      c.get('db'),
      `SELECT id, campaign_id, status, total_rows, imported, merged, rejected, created_at, updated_at
         FROM contact_imports WHERE id = ? AND workspace_id = ?`,
      [c.req.param('task_id'), actor.workspaceId],
    );
    if (!row) throw ApiError.notFound('import');

    return c.json({
      task_id: row.id,
      campaign_id: row.campaign_id,
      status:
        row.status === 'complete' ? 'completed' : row.status === 'failed' ? 'failed' : 'pending',
      total_rows: row.total_rows,
      imported: row.imported,
      merged: row.merged,
      rejected: row.rejected,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  });

  r.get('/campaigns/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const [stats, targeting] = await Promise.all([
      campaignStats(db, actor.workspaceId, row.id),
      targetingFor(db, row.id),
    ]);

    return c.json({
      campaign: {
        ...campaignView(row, stats),
        instructions: row.brief,
        targeting,
        targeting_editable: true,
      },
    });
  });

  r.patch('/campaigns/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'changing a campaign');

    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const body = await parse(c.req.raw, campaignPatchBody);
    const changed: Record<string, unknown> = {};

    if (body.name !== undefined) {
      await db.execute({
        sql: 'UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?',
        args: [body.name, now(), row.id],
      });
      changed.name = body.name;
    }

    if (body.instructions !== undefined) {
      await db.execute({
        sql: 'UPDATE campaigns SET brief = ?, updated_at = ? WHERE id = ?',
        args: [body.instructions || null, now(), row.id],
      });
      changed.instructions = body.instructions;
    }

    if (body.targeting !== undefined) {
      await saveTargeting(db, row.id, body.targeting);
      changed.targeting = await targetingFor(db, row.id);
    }

    if (body.daily_limit_usd !== undefined) {
      if (row.project_autopilot === 1) autopilotOwnsIt(row);
      const budget = await setCampaignDailyBudget(
        db,
        actor.workspaceId,
        row.id,
        body.daily_limit_usd,
      );
      await applyProjectBudget(db, actor.workspaceId, row.offering_id);
      changed.daily_limit_usd = budget?.dailyBudgetUsd ?? null;
    }

    if (Object.keys(changed).length === 0) {
      throw ApiError.badRequest(
        'send at least one of name, instructions, targeting or daily_limit_usd',
      );
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'autogtm.campaign_changed',
      entityKind: 'campaign',
      entityId: row.id,
      detail: { fields: Object.keys(changed) },
    });

    return c.json({ campaign_id: row.id, ...changed });
  });

  r.post('/campaigns/:id/start', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'starting a campaign');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    if (row.project_autopilot === 1) autopilotOwnsIt(row);
    if (row.status === 'archived') throw ApiError.badRequest('an archived campaign cannot start');

    await setCampaignStatus(db, actor.workspaceId, row.id, 'active');
    return c.json({ campaign_id: row.id, status: 'outreach', raw_status: 'active' });
  });

  r.post('/campaigns/:id/stop', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'stopping a campaign');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    if (row.project_autopilot === 1) autopilotOwnsIt(row);
    if (row.status === 'archived') throw ApiError.badRequest('an archived campaign cannot stop');

    await setCampaignStatus(db, actor.workspaceId, row.id, 'paused');
    return c.json({ campaign_id: row.id, status: 'listening', raw_status: 'paused' });
  });

  r.get('/campaigns/:id/budget', async (c) => {
    const actor = c.get('actor');
    const row = await ownedCampaign(c.get('db'), actor.workspaceId, c.req.param('id'));
    const budget = campaignBudgetFrom(row.budget_json);
    return c.json({
      campaign_id: row.id,
      daily_limit_usd: budget.dailyBudgetUsd ?? null,
      max_contacts_per_day: budget.maxActionsPerDay ?? null,
      price_per_contact_usd: CONTACT_PRICE_USD,
      managed_by_autopilot: row.project_autopilot === 1,
    });
  });

  r.patch('/campaigns/:id/budget', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'changing a budget');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    if (row.project_autopilot === 1) autopilotOwnsIt(row);

    const body = await parse(c.req.raw, campaignBudgetBody);
    const budget = await setCampaignDailyBudget(
      db,
      actor.workspaceId,
      row.id,
      body.daily_limit_usd,
    );
    // The project ceiling still applies to hand-set budgets.
    await applyProjectBudget(db, actor.workspaceId, row.offering_id);
    const after = await ownedCampaign(db, actor.workspaceId, row.id);
    const stored = campaignBudgetFrom(after.budget_json);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'campaign.limits_changed',
      entityKind: 'campaign',
      entityId: row.id,
      detail: {
        dailyBudgetUsd: budget?.dailyBudgetUsd ?? null,
        maxActionsPerDay: stored.maxActionsPerDay,
      },
    });

    return c.json({
      campaign_id: row.id,
      daily_limit_usd: stored.dailyBudgetUsd ?? null,
      max_contacts_per_day: stored.maxActionsPerDay ?? null,
    });
  });

  r.get('/campaigns/:id/analytics', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const since = c.req.query('since');
    const stats = await campaignStats(db, actor.workspaceId, row.id, since);
    return c.json({
      campaign_id: row.id,
      status: autogtmStatus({ ...row, contacted: stats.contacted }),
      ...(since ? { since } : {}),
      ...analyticsFrom(stats),
    });
  });

  // ----------------------------------------------------------------- inbox

  r.get('/campaigns/:id/inbox', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const tab = c.req.query('tab') ?? 'all';
    const limit = clampPage(c.req.query('limit'));
    const before = c.req.query('before');

    if (!['all', 'need_reply', 'replied', 'sent', 'unsubscribed'].includes(tab)) {
      throw ApiError.badRequest('tab must be one of all, need_reply, replied, sent, unsubscribed');
    }

    const conversations = await queryAll<{
      person_id: string;
      display_name: string;
      current_title: string | null;
      company_name: string | null;
      company_domain: string | null;
      lead_status: string;
      note: string | null;
      inbound: number;
      outbound: number;
      last_at: string;
      last_direction: string;
      last_body: string | null;
      suppressed: number;
    }>(
      db,
      `SELECT p.id AS person_id, p.display_name, p.current_title,
              co.name AS company_name, co.domain AS company_domain,
              cp.status AS lead_status, cp.note,
              t.inbound, t.outbound, t.last_at,
              (SELECT i.direction FROM interactions i
                WHERE i.workspace_id = ? AND i.person_id = p.id
                ORDER BY i.occurred_at DESC LIMIT 1) AS last_direction,
              (SELECT i.body FROM interactions i
                WHERE i.workspace_id = ? AND i.person_id = p.id
                ORDER BY i.occurred_at DESC LIMIT 1) AS last_body,
              (SELECT COUNT(*) FROM suppression_keys sk
                WHERE sk.match_key = 'person:' || p.id
                  AND (sk.scope = 'global' OR sk.workspace_id = ?)) AS suppressed
         FROM campaign_people cp
         JOIN people p ON p.id = cp.person_id
         LEFT JOIN companies co ON co.id = p.current_company_id
         JOIN (SELECT i.person_id,
                      SUM(CASE WHEN i.direction = 'inbound' THEN 1 ELSE 0 END) AS inbound,
                      SUM(CASE WHEN i.direction = 'outbound' THEN 1 ELSE 0 END) AS outbound,
                      MAX(i.occurred_at) AS last_at
                 FROM interactions i WHERE i.workspace_id = ? GROUP BY i.person_id) t
           ON t.person_id = cp.person_id
        WHERE cp.campaign_id = ? AND p.status != 'deleted'
          ${before ? 'AND t.last_at < ?' : ''}
        ORDER BY t.last_at DESC
        LIMIT ?`,
      [
        actor.workspaceId,
        actor.workspaceId,
        actor.workspaceId,
        actor.workspaceId,
        row.id,
        ...(before ? [before] : []),
        // Over-fetch so a tab filter still fills a page.
        limit * 4,
      ],
    );

    const tabbed = conversations
      .map((conv) => {
        const status =
          Number(conv.suppressed) > 0
            ? 'unsubscribed'
            : conv.last_direction === 'inbound'
              ? 'need_reply'
              : Number(conv.inbound) > 0
                ? 'replied'
                : 'sent';
        return {
          person_id: conv.person_id,
          name: conv.display_name,
          job_title: conv.current_title,
          company: conv.company_name,
          company_domain: conv.company_domain,
          status,
          lead_status: conv.lead_status,
          messages: { inbound: Number(conv.inbound), outbound: Number(conv.outbound) },
          last_message_at: conv.last_at,
          last_message_from: conv.last_direction === 'inbound' ? 'lead' : 'you',
          last_message_preview: conv.last_body ? conv.last_body.slice(0, 200) : null,
          note: conv.note,
        };
      })
      .filter((conv) => tab === 'all' || conv.status === tab)
      .slice(0, limit);

    const last = tabbed[tabbed.length - 1];
    return c.json({
      campaign_id: row.id,
      tab,
      conversations: tabbed,
      ...(tabbed.length === limit && last ? { next_before: last.last_message_at } : {}),
    });
  });

  r.get('/campaigns/:id/inbox/:person_id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const personId = c.req.param('person_id');
    const member = await leadInCampaign(db, row.id, personId);
    if (!member) throw ApiError.notFound('lead');

    const messages = await queryAll<{
      id: string;
      direction: string;
      network: string;
      state: string;
      body: string | null;
      subject: string | null;
      contact_address: string | null;
      occurred_at: string;
    }>(
      db,
      `SELECT i.id, i.direction, i.network, i.state, i.body, i.contact_address, i.occurred_at,
              (SELECT d.subject FROM actions a
                 JOIN drafts d ON d.recommendation_id = a.recommendation_id
                WHERE a.id = i.action_id LIMIT 1) AS subject
         FROM interactions i
        WHERE i.workspace_id = ? AND i.person_id = ?
        ORDER BY i.occurred_at ASC`,
      [actor.workspaceId, personId],
    );

    return c.json({
      campaign_id: row.id,
      lead: member,
      messages: messages.map((m) => ({
        id: m.id,
        from: m.direction === 'inbound' ? 'lead' : 'you',
        network: m.network,
        state: m.state,
        subject: m.subject,
        body: m.body,
        address: m.contact_address,
        at: m.occurred_at,
      })),
    });
  });

  r.post('/campaigns/:id/inbox/:person_id/reply', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'replying to a lead');
    await deps.requireVerifiedEmail(db, actor);

    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const personId = c.req.param('person_id');
    const member = await leadInCampaign(db, row.id, personId);
    if (!member) throw ApiError.notFound('lead');

    const body = await parse(c.req.raw, replyBody);

    // Threading: the subject of the last thing we sent them, prefixed.
    const lastSubject = await queryOne<{ subject: string | null }>(
      db,
      `SELECT d.subject FROM interactions i
         JOIN actions a ON a.id = i.action_id
         JOIN drafts d ON d.recommendation_id = a.recommendation_id
        WHERE i.workspace_id = ? AND i.person_id = ? AND i.direction = 'outbound'
        ORDER BY i.occurred_at DESC LIMIT 1`,
      [actor.workspaceId, personId],
    );
    const subjectBase = lastSubject?.subject?.trim() || `Following up`;
    const subject = /^re:/i.test(subjectBase) ? subjectBase : `Re: ${subjectBase}`;

    const recommendationId = newId('recommendation');
    const draftId = newId('draft');
    const stamp = now();

    await db.batch([
      {
        // `send_email` because that is the one email capability the matrix
        // describes; the goal is what marks it as an answer rather than a
        // fresh approach, and what the policy recheck reads as a follow-up.
        sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
              priority, reason, trigger_signal_id, policy_status, policy_version, expected_goal,
              status, created_at)
              VALUES (?, ?, ?, ?, 'send_email', 'email', 100, 'Reply written through the API', NULL,
              'allow_with_approval', ?, 'continue_conversation', 'pending', ?)`,
        args: [recommendationId, actor.workspaceId, row.id, personId, POLICY_VERSION, stamp],
      },
      {
        sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
              grounded_signal_ids, checks_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, '[]', '[]', ?, ?)`,
        args: [draftId, actor.workspaceId, recommendationId, subject, body.text, stamp, stamp],
      },
    ]);

    const recommendation = await repo.getRecommendation(db, actor.workspaceId, recommendationId);
    if (!recommendation) throw new Error('reply recommendation vanished');

    const outcome = await deps.approve(db, actor, recommendation);

    if (!outcome.ok) {
      // Retired rather than left pending: a refused answer must not sit in
      // the queue as a card somebody, or something, later approves.
      await db.execute({
        sql: `UPDATE recommendations SET status = 'skipped' WHERE id = ?`,
        args: [recommendationId],
      });
      throw ApiError.policyDenied(outcome.reason ?? 'refused by policy', {
        decision: outcome.decision,
        gate: outcome.gate,
      });
    }

    if (outcome.delivery && !outcome.delivery.sent) {
      return c.json(
        {
          sent: false,
          campaign_id: row.id,
          person_id: personId,
          action_id: outcome.actionId,
          reason: outcome.delivery.reason,
        },
        502,
      );
    }

    return c.json({
      sent: outcome.delivery?.sent === true,
      campaign_id: row.id,
      person_id: personId,
      action_id: outcome.actionId,
      subject,
      ...(outcome.delivery?.to ? { to: outcome.delivery.to } : {}),
      ...(outcome.delivery
        ? {}
        : { note: 'recorded for a human to send: this deployment cannot put email on the wire' }),
    });
  });

  r.get('/campaigns/:id/inbox/:person_id/note', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const personId = c.req.param('person_id');
    const member = await leadInCampaign(db, row.id, personId);
    if (!member) throw ApiError.notFound('lead');
    return c.json({ campaign_id: row.id, person_id: personId, note: member.note });
  });

  r.post('/campaigns/:id/inbox/:person_id/note', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'writing a note');
    const row = await ownedCampaign(db, actor.workspaceId, c.req.param('id'));
    const personId = c.req.param('person_id');
    const member = await leadInCampaign(db, row.id, personId);
    if (!member) throw ApiError.notFound('lead');

    const body = await parse(c.req.raw, noteBody);
    const note = body.note?.trim() || null;
    await db.execute({
      sql: `UPDATE campaign_people SET note = ?, updated_at = ? WHERE campaign_id = ? AND person_id = ?`,
      args: [note, now(), row.id, personId],
    });
    return c.json({ campaign_id: row.id, person_id: personId, note });
  });

  r.get('/hot-leads', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const since = c.req.query('since');
    const limit = clampPage(c.req.query('limit'));

    const rows = await queryAll<{
      person_id: string;
      campaign_id: string;
      campaign_name: string;
      display_name: string;
      current_title: string | null;
      company_name: string | null;
      company_domain: string | null;
      lead_status: string;
      note: string | null;
      replied_at: string | null;
      last_reply: string | null;
    }>(
      db,
      `SELECT cp.person_id, cp.campaign_id, c.name AS campaign_name,
              p.display_name, p.current_title, co.name AS company_name, co.domain AS company_domain,
              cp.status AS lead_status, cp.note,
              (SELECT MAX(i.occurred_at) FROM interactions i
                WHERE i.workspace_id = ? AND i.person_id = cp.person_id
                  AND i.direction = 'inbound') AS replied_at,
              (SELECT i.body FROM interactions i
                WHERE i.workspace_id = ? AND i.person_id = cp.person_id
                  AND i.direction = 'inbound'
                ORDER BY i.occurred_at DESC LIMIT 1) AS last_reply
         FROM campaign_people cp
         JOIN campaigns c ON c.id = cp.campaign_id
         JOIN people p ON p.id = cp.person_id
         LEFT JOIN companies co ON co.id = p.current_company_id
        WHERE cp.workspace_id = ? AND p.status != 'deleted'
          AND (cp.status IN ('responded', 'qualified_opportunity')
               OR cp.interaction_state = 'responded')
          ${since ? 'AND replied_at >= ?' : ''}
        ORDER BY replied_at DESC
        LIMIT ?`,
      [actor.workspaceId, actor.workspaceId, actor.workspaceId, ...(since ? [since] : []), limit],
    );

    return c.json({
      ...(since ? { since } : {}),
      hot_leads: rows.map((lead) => ({
        person_id: lead.person_id,
        campaign_id: lead.campaign_id,
        campaign_name: lead.campaign_name,
        name: lead.display_name,
        job_title: lead.current_title,
        company: lead.company_name,
        company_domain: lead.company_domain,
        lead_status: lead.lead_status,
        replied_at: lead.replied_at,
        last_reply_preview: lead.last_reply ? lead.last_reply.slice(0, 300) : null,
        note: lead.note,
      })),
      polled_at: now(),
    });
  });

  // -------------------------------------------------------- suppress lists

  r.get('/suppress-list/people', async (c) => {
    const actor = c.get('actor');
    return c.json({ lists: await listSuppressLists(c.get('db'), actor.workspaceId, 'person') });
  });

  r.get('/suppress-list/companies', async (c) => {
    const actor = c.get('actor');
    return c.json({ lists: await listSuppressLists(c.get('db'), actor.workspaceId, 'company') });
  });

  r.post('/suppress-list/people', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'suppressing people');
    const body = await parse(c.req.raw, suppressPeopleBody);
    const keys = [...new Set(body.emails.map(emailMatchKey))];
    const result = await addToSuppressList(db, actor, {
      kind: 'person',
      name: body.list_name,
      reason: body.reason ?? 'do_not_contact',
      keys,
    });
    return c.json({ list_name: body.list_name, kind: 'person', ...result }, 201);
  });

  r.post('/suppress-list/companies', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireWriter(actor, 'suppressing companies');
    const body = await parse(c.req.raw, suppressCompaniesBody);
    const keys = [...new Set(body.domains.map(domainMatchKey))].filter((k) => k !== 'domain:');
    if (keys.length === 0) throw ApiError.badRequest('no usable domains');
    const result = await addToSuppressList(db, actor, {
      kind: 'company',
      name: body.list_name,
      reason: body.reason ?? 'do_not_contact',
      keys,
    });
    return c.json({ list_name: body.list_name, kind: 'company', ...result }, 201);
  });

  r.get('/suppress-list/people/:name', async (c) => {
    const actor = c.get('actor');
    const list = await readSuppressList(
      c.get('db'),
      actor.workspaceId,
      'person',
      c.req.param('name'),
    );
    if (!list) throw ApiError.notFound('list');
    return c.json({
      list_name: list.name,
      kind: 'person',
      emails: list.values,
      added_at: list.addedAt,
    });
  });

  r.get('/suppress-list/companies/:name', async (c) => {
    const actor = c.get('actor');
    const list = await readSuppressList(
      c.get('db'),
      actor.workspaceId,
      'company',
      c.req.param('name'),
    );
    if (!list) throw ApiError.notFound('list');
    return c.json({
      list_name: list.name,
      kind: 'company',
      domains: list.values,
      added_at: list.addedAt,
    });
  });

  r.delete('/suppress-list/people/:name', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor, 'deleting a suppress list');
    const removed = await deleteSuppressList(c.get('db'), actor, 'person', c.req.param('name'));
    if (!removed) throw ApiError.notFound('list');
    return c.json({ deleted: true, list_name: c.req.param('name'), kind: 'person' });
  });

  r.delete('/suppress-list/companies/:name', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor, 'deleting a suppress list');
    const removed = await deleteSuppressList(c.get('db'), actor, 'company', c.req.param('name'));
    if (!removed) throw ApiError.notFound('list');
    return c.json({ deleted: true, list_name: c.req.param('name'), kind: 'company' });
  });

  // --------------------------------------------------------------- billing

  r.get('/billing/balance', async (c) => {
    const actor = c.get('actor');
    const status = await budgetStatus(c.get('db'), actor.workspaceId);
    return c.json({
      plan: {
        id: status.plan.id,
        name: status.plan.name,
        contacts_per_month: status.plan.prospectsPerMonth,
      },
      this_month: {
        contacts_used: status.usage.prospectsContacted,
        contacts_remaining: Math.max(
          0,
          status.plan.prospectsPerMonth - status.usage.prospectsContacted,
        ),
      },
      credits: {
        remaining: status.credits.remaining,
        granted: status.credits.granted,
        spent: status.credits.spent,
        price_per_contact_usd: CONTACT_PRICE_USD,
      },
      on_credits: status.onCredits,
      exhausted: status.exhausted,
      ...(status.reason ? { reason: status.reason } : {}),
    });
  });

  return r;
}

// ----------------------------------------------------------------- helpers

/** Addresses that name a mailbox provider, not a company worth crawling. */
const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'protonmail.com',
  'proton.me',
  'mail.com',
  'gmx.com',
  'yandex.com',
]);

interface LeadMember {
  readonly person_id: string;
  readonly name: string;
  readonly job_title: string | null;
  readonly company: string | null;
  readonly company_domain: string | null;
  readonly lead_status: string;
  readonly note: string | null;
}

async function leadInCampaign(
  db: Client,
  campaignId: string,
  personId: string,
): Promise<LeadMember | undefined> {
  const row = await queryOne<{
    person_id: string;
    display_name: string;
    current_title: string | null;
    company_name: string | null;
    company_domain: string | null;
    status: string;
    note: string | null;
  }>(
    db,
    `SELECT cp.person_id, p.display_name, p.current_title, co.name AS company_name,
            co.domain AS company_domain, cp.status, cp.note
       FROM campaign_people cp
       JOIN people p ON p.id = cp.person_id
       LEFT JOIN companies co ON co.id = p.current_company_id
      WHERE cp.campaign_id = ? AND cp.person_id = ? AND p.status != 'deleted'`,
    [campaignId, personId],
  );
  if (!row) return undefined;
  return {
    person_id: row.person_id,
    name: row.display_name,
    job_title: row.current_title,
    company: row.company_name,
    company_domain: row.company_domain,
    lead_status: row.status,
    note: row.note,
  };
}

type ListKind = 'person' | 'company';

async function listSuppressLists(db: Client, workspaceId: string, kind: ListKind) {
  const rows = await queryAll<{ name: string; entries: number; created_at: string }>(
    db,
    `SELECT e.name, COUNT(k.match_key) AS entries, MIN(e.created_at) AS created_at
       FROM suppression_entries e
       LEFT JOIN suppression_keys k ON k.suppression_id = e.id
      WHERE e.workspace_id = ? AND e.kind = ? AND e.name IS NOT NULL
        AND (k.match_key IS NULL OR k.match_key NOT LIKE 'person:%')
      GROUP BY e.name ORDER BY MIN(e.created_at)`,
    [workspaceId, kind],
  );
  return rows.map((row) => ({
    list_name: row.name,
    kind,
    entries: Number(row.entries),
    created_at: row.created_at,
  }));
}

async function readSuppressList(db: Client, workspaceId: string, kind: ListKind, name: string) {
  const rows = await queryAll<{ match_key: string; created_at: string }>(
    db,
    `SELECT k.match_key, e.created_at
       FROM suppression_entries e
       JOIN suppression_keys k ON k.suppression_id = e.id
      WHERE e.workspace_id = ? AND e.kind = ? AND e.name = ?
        AND k.match_key NOT LIKE 'person:%'
      ORDER BY e.created_at, k.match_key`,
    [workspaceId, kind, name],
  );
  if (rows.length === 0) return undefined;
  const prefix = kind === 'person' ? 'email:' : 'domain:';
  return {
    name,
    values: rows.map((row) => row.match_key.slice(prefix.length)),
    addedAt: rows[0]?.created_at ?? null,
  };
}

async function addToSuppressList(
  db: Client,
  actor: RequestActor,
  input: { kind: ListKind; name: string; reason: string; keys: readonly string[] },
): Promise<{ added: number; people_halted: number }> {
  // People already on file who match get a `person:` key as well, so a later
  // edit to their address does not un-suppress them, and their queued cards
  // are cleared today.
  const matched = await peopleMatchingKeys(db, actor.workspaceId, input.keys);
  const id = newId('suppression');
  const stamp = now();

  await db.batch([
    {
      sql: `INSERT INTO suppression_entries (id, reason, scope, workspace_id, source, created_at,
            name, kind)
            VALUES (?, ?, 'workspace', ?, 'api', ?, ?, ?)`,
      args: [id, input.reason, actor.workspaceId, stamp, input.name, input.kind],
    },
    ...[...input.keys, ...matched.map((personId) => `person:${personId}`)].map((key) => ({
      sql: `INSERT OR IGNORE INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
            VALUES (?, ?, 'workspace', ?)`,
      args: [key, id, actor.workspaceId],
    })),
    ...matched.map((personId) => ({
      sql: `UPDATE recommendations SET status = 'skipped'
             WHERE workspace_id = ? AND person_id = ? AND status IN ('pending', 'approved')`,
      args: [actor.workspaceId, personId],
    })),
  ]);

  await repo.audit(db, {
    workspaceId: actor.workspaceId,
    actorKind: 'user',
    actorId: actor.userId,
    eventType: 'suppression.created',
    entityKind: 'suppression',
    entityId: id,
    detail: { list: input.name, kind: input.kind, keys: input.keys.length, halted: matched.length },
  });

  return { added: input.keys.length, people_halted: matched.length };
}

async function deleteSuppressList(
  db: Client,
  actor: RequestActor,
  kind: ListKind,
  name: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `DELETE FROM suppression_entries WHERE workspace_id = ? AND kind = ? AND name = ?`,
    args: [actor.workspaceId, kind, name],
  });
  if (result.rowsAffected === 0) return false;

  await repo.audit(db, {
    workspaceId: actor.workspaceId,
    actorKind: 'user',
    actorId: actor.userId,
    eventType: 'suppression.list_deleted',
    entityKind: 'suppression',
    entityId: name,
    detail: { kind, entries: result.rowsAffected },
  });
  return true;
}
