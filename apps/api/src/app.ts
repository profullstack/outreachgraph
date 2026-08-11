/**
 * The OutreachGraph API (PRD §23, §24).
 *
 * Built as a factory taking its database so tests drive a real app against a
 * temporary database rather than a mock. Every UI feature goes through these
 * same routes, which is what later makes a CLI, CRM plugins and customer
 * tooling possible without a second implementation (PRD §24).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import {
  approveRecommendationSchema,
  createSuppressionSchema,
  executeActionSchema,
  privacyRequestSchema,
  snoozeRecommendationSchema,
} from '@outreachgraph/contracts';
import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, type Client } from '@outreachgraph/db';
import { evaluatePolicy, isExecutable, POLICY_VERSION } from '@outreachgraph/policy';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface AppOptions {
  readonly db: Client;
  /**
   * Resolves the caller. Injected so the test suite and a future auth provider
   * plug in without the routes knowing how authentication works.
   */
  readonly authenticate: (request: Request) => Promise<RequestActor | undefined>;
  readonly version?: string;
  readonly commitHash?: string;
}

const STARTED_AT = Date.now();

export function createApp(options: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', cors());

  // ------------------------------------------------------------------ root
  // An API with no route at `/` answers the front door with a 404, which reads
  // as "the deployment is broken" to anybody who pastes the hostname into a
  // browser — including us. This says what is running and where to go instead.
  app.get('/', (c) =>
    c.json({
      service: 'api',
      name: 'outreachgraph',
      version: options.version ?? '0.1.0',
      ...(options.commitHash ? { commitHash: options.commitHash } : {}),
      docs: 'https://github.com/profullstack/outreachgraph',
      endpoints: {
        health: '/health/live',
        ready: '/health/ready',
        api: '/api/v1',
      },
    }),
  );

  // ---------------------------------------------------------------- health
  // Two endpoints: liveness never touches the database so a database blip
  // cannot cause Railway to kill a healthy process; readiness does.
  app.get('/health/live', (c) =>
    c.json({
      status: 'ok' as const,
      service: 'api',
      version: options.version ?? '0.1.0',
      ...(options.commitHash ? { commitHash: options.commitHash } : {}),
      uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    }),
  );

  app.get('/health/ready', async (c) => {
    try {
      await options.db.execute('SELECT 1');
      return c.json({ status: 'ok' as const, service: 'api', database: 'reachable' });
    } catch (error) {
      return c.json(
        {
          status: 'error' as const,
          service: 'api',
          database: error instanceof Error ? error.message : 'unreachable',
        },
        503,
      );
    }
  });

  const api = new Hono<AppEnv>();

  // Everything under /api/v1 is authenticated and workspace-scoped.
  api.use('*', async (c, next) => {
    const actor = await options.authenticate(c.req.raw);
    if (!actor) throw ApiError.unauthorized();

    c.set('db', options.db);
    c.set('actor', actor);
    c.set('requestId', newId('auditEvent'));
    await next();
  });

  // ------------------------------------------------------------ campaigns
  api.get('/campaigns', async (c) => {
    const actor = c.get('actor');
    const rows = await c.get('db').execute({
      sql: `SELECT id, name, status, approval_mode, created_at, started_at
                FROM campaigns WHERE workspace_id = ? ORDER BY created_at DESC`,
      args: [actor.workspaceId],
    });
    return c.json({ campaigns: rows.rows });
  });

  api.get('/campaigns/:id', async (c) => {
    const actor = c.get('actor');
    const campaign = await repo.getCampaign(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!campaign) throw ApiError.notFound('campaign');
    return c.json({ campaign });
  });

  api.get('/campaigns/:id/recommendations', async (c) => {
    const actor = c.get('actor');
    const limit = clampLimit(c.req.query('limit'));
    const rows = await c.get('db').execute({
      sql: `SELECT * FROM recommendations
             WHERE workspace_id = ? AND campaign_id = ? AND status = 'pending'
          ORDER BY priority DESC LIMIT ?`,
      args: [actor.workspaceId, c.req.param('id'), limit],
    });
    return c.json({ recommendations: rows.rows });
  });

  // -------------------------------------------------------------- people
  api.get('/people/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');

    const person = await repo.getPerson(db, personId);
    if (!person || person.status === 'deleted') throw ApiError.notFound('person');

    const [identities, signals, provenance] = await Promise.all([
      repo.listIdentities(db, personId),
      repo.listPersonSignals(db, actor.workspaceId, personId),
      repo.listProvenance(db, personId),
    ]);

    return c.json({ person, identities, signals, provenance });
  });

  api.get('/people/:id/identities', async (c) => {
    const identities = await repo.listIdentities(c.get('db'), c.req.param('id'));
    return c.json({ identities });
  });

  api.get('/people/:id/signals', async (c) => {
    const actor = c.get('actor');
    const signals = await repo.listPersonSignals(c.get('db'), actor.workspaceId, c.req.param('id'));
    return c.json({ signals });
  });

  /**
   * Deletes a person and everything derived from them, leaving a suppression
   * tombstone so a later provider lookup cannot re-ingest them (PRD §17.3,
   * §47.16).
   */
  api.delete('/people/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');

    const person = await repo.getPerson(db, personId);
    if (!person) throw ApiError.notFound('person');

    const matchKeys = await repo.suppressionKeysForPerson(db, personId);
    const suppressionId = newId('suppression');
    const stamp = now();

    await db.batch([
      {
        sql: `INSERT INTO suppression_entries (id, reason, scope, workspace_id, source, created_at)
              VALUES (?, 'customer_request', 'global', ?, 'privacy_request', ?)`,
        args: [suppressionId, actor.workspaceId, stamp],
      },
      ...matchKeys.map((key) => ({
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES (?, ?, 'global', NULL)`,
        args: [key, suppressionId],
      })),
      // Derived intelligence goes; the tombstone stays.
      { sql: 'DELETE FROM signals WHERE person_id = ?', args: [personId] },
      { sql: 'DELETE FROM scores WHERE person_id = ?', args: [personId] },
      { sql: 'DELETE FROM recommendations WHERE person_id = ?', args: [personId] },
      {
        sql: `DELETE FROM field_provenance WHERE entity_kind = 'person' AND entity_id = ?`,
        args: [personId],
      },
      { sql: 'DELETE FROM social_identities WHERE person_id = ?', args: [personId] },
      {
        sql: `UPDATE people SET status = 'deleted', outreach_eligible = 0,
              display_name = '[deleted]', first_name = NULL, last_name = NULL,
              current_title = NULL, location = NULL, updated_at = ? WHERE id = ?`,
        args: [stamp, personId],
      },
    ]);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'person.deleted',
      entityKind: 'person',
      entityId: personId,
      detail: { suppressionId, matchKeys: matchKeys.length },
    });

    return c.json({ deleted: true, personId, suppressionId });
  });

  // ----------------------------------------------------- approval queue
  api.get('/recommendations', async (c) => {
    const actor = c.get('actor');
    const limit = clampLimit(c.req.query('limit'));
    const recommendations = await repo.listPendingRecommendations(
      c.get('db'),
      actor.workspaceId,
      limit,
    );
    return c.json({ recommendations });
  });

  /**
   * Approving is where policy is enforced for real.
   *
   * The decision stored on the recommendation is a snapshot from generation
   * time; platform rules, feature flags, suppression and rate limits may all
   * have changed since. So the engine runs again here, against current state,
   * and an action row is only written if it still passes (PRD §20.9, §37).
   */
  api.post('/recommendations/:id/approve', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('this role cannot approve outbound actions');

    const body = await parseBody(c.req.raw, approveRecommendationSchema);
    const recommendation = await repo.getRecommendation(db, actor.workspaceId, c.req.param('id'));
    if (!recommendation) throw ApiError.notFound('recommendation');

    if (recommendation.status !== 'pending') {
      throw ApiError.badRequest(`recommendation is already ${recommendation.status}`);
    }

    const decision = await recheckPolicy(db, actor, recommendation);

    if (!isExecutable(decision.decision, true)) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'recommendation.approval_blocked',
        entityKind: 'recommendation',
        entityId: recommendation.id,
        detail: { decision: decision.decision, gate: decision.gate, reason: decision.reason },
      });

      throw ApiError.policyDenied(decision.reason, {
        decision: decision.decision,
        gate: decision.gate,
        policyVersion: decision.policyVersion,
      });
    }

    const draft = await db.execute({
      sql: 'SELECT body FROM drafts WHERE recommendation_id = ? LIMIT 1',
      args: [recommendation.id],
    });

    const finalBody = body.editedBody ?? (draft.rows[0]?.body as string | undefined) ?? undefined;

    const approvalId = newId('approval');
    const stamp = now();

    await db.batch([
      {
        sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by,
              decided_at, note, edited_body)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          approvalId,
          actor.workspaceId,
          recommendation.id,
          body.editedBody ? 'edit_and_approve' : 'approve',
          actor.userId,
          stamp,
          body.note ?? null,
          body.editedBody ?? null,
        ],
      },
      {
        sql: `UPDATE recommendations SET status = 'approved' WHERE id = ?`,
        args: [recommendation.id],
      },
    ]);

    // Manual-only actions are recorded for the user to carry out themselves.
    const mode =
      decision.decision === 'manual_only'
        ? 'manual'
        : modeForNetwork(recommendation.network as Network);

    const actionId = await repo.recordAction(db, {
      workspaceId: actor.workspaceId,
      recommendationId: recommendation.id,
      personId: recommendation.person_id,
      kind: recommendation.action as ActionKind,
      network: recommendation.network as Network,
      mode,
      ...(finalBody ? { body: finalBody } : {}),
    });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'recommendation.approved',
      entityKind: 'recommendation',
      entityId: recommendation.id,
      detail: { actionId, decision: decision.decision, edited: Boolean(body.editedBody) },
    });

    return c.json({
      approved: true,
      approvalId,
      actionId,
      policy: { decision: decision.decision, policyVersion: decision.policyVersion },
    });
  });

  api.post('/recommendations/:id/skip', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    const recommendation = await repo.getRecommendation(db, actor.workspaceId, c.req.param('id'));
    if (!recommendation) throw ApiError.notFound('recommendation');

    await db.batch([
      {
        sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by, decided_at)
              VALUES (?, ?, ?, 'skip', ?, ?)`,
        args: [newId('approval'), actor.workspaceId, recommendation.id, actor.userId, now()],
      },
      {
        sql: `UPDATE recommendations SET status = 'skipped' WHERE id = ?`,
        args: [recommendation.id],
      },
    ]);

    return c.json({ skipped: true });
  });

  api.post('/recommendations/:id/snooze', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, snoozeRecommendationSchema);

    const recommendation = await repo.getRecommendation(db, actor.workspaceId, c.req.param('id'));
    if (!recommendation) throw ApiError.notFound('recommendation');

    await db.batch([
      {
        sql: `INSERT INTO approvals (id, workspace_id, recommendation_id, decision, decided_by,
              decided_at, snoozed_until) VALUES (?, ?, ?, 'snooze', ?, ?, ?)`,
        args: [
          newId('approval'),
          actor.workspaceId,
          recommendation.id,
          actor.userId,
          now(),
          body.until,
        ],
      },
      {
        sql: `UPDATE recommendations SET status = 'snoozed' WHERE id = ?`,
        args: [recommendation.id],
      },
    ]);

    return c.json({ snoozed: true, until: body.until });
  });

  // -------------------------------------------------------------- actions
  api.get('/actions/:id', async (c) => {
    const actor = c.get('actor');
    const action = await repo.getAction(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!action) throw ApiError.notFound('action');
    return c.json({ action });
  });

  /** Marks a manual action complete, or records an API execution (PRD §27). */
  api.post('/actions/:id/execute', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, executeActionSchema);

    const action = await repo.getAction(db, actor.workspaceId, c.req.param('id'));
    if (!action) throw ApiError.notFound('action');
    if (action.status === 'completed') throw ApiError.badRequest('action is already completed');

    const stamp = now();
    await db.batch([
      {
        sql: `UPDATE actions SET status = 'completed', mode = ?, external_url = ?, executed_at = ?
               WHERE id = ?`,
        args: [body.mode, body.externalUrl ?? null, stamp, action.id],
      },
      {
        sql: `INSERT INTO interactions (id, workspace_id, person_id, action_id, network, direction,
              state, occurred_at, recorded_at)
              VALUES (?, ?, ?, ?, ?, 'outbound', 'contacted', ?, ?)`,
        args: [
          newId('interaction'),
          actor.workspaceId,
          action.person_id,
          action.id,
          action.network,
          stamp,
          stamp,
        ],
      },
      {
        sql: `UPDATE recommendations SET status = 'executed' WHERE id = ?`,
        args: [action.recommendation_id],
      },
    ]);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'action.executed',
      entityKind: 'action',
      entityId: action.id,
      detail: { mode: body.mode },
    });

    return c.json({ executed: true, actionId: action.id });
  });

  // --------------------------------------------------------------- signals
  api.get('/signals', async (c) => {
    const actor = c.get('actor');
    const signals = await repo.listSignals(
      c.get('db'),
      actor.workspaceId,
      clampLimit(c.req.query('limit')),
    );
    return c.json({ signals });
  });

  // ---------------------------------------------------------- suppressions
  api.post('/suppressions', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, createSuppressionSchema);

    const id = newId('suppression');
    await db.batch([
      {
        sql: `INSERT INTO suppression_entries (id, reason, scope, workspace_id, source, created_at)
              VALUES (?, ?, ?, ?, 'user', ?)`,
        args: [id, body.reason, body.scope, actor.workspaceId, now()],
      },
      ...body.matchKeys.map((key) => ({
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES (?, ?, ?, ?)`,
        args: [key, id, body.scope, body.scope === 'global' ? null : actor.workspaceId],
      })),
    ]);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'suppression.created',
      entityKind: 'suppression',
      entityId: id,
      detail: { reason: body.reason, scope: body.scope, keys: body.matchKeys.length },
    });

    return c.json({ suppressionId: id }, 201);
  });

  // ---------------------------------------------------------------- privacy
  api.post('/privacy/requests', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, privacyRequestSchema);

    const id = newId('privacyRequest');
    const stamp = now();
    // 45 days is the DROP processing cadence referenced in PRD §17.2.
    const dueAt = new Date(Date.now() + 45 * 86_400_000).toISOString();

    await db.execute({
      sql: `INSERT INTO privacy_requests (id, kind, status, source_channel, subject_match_keys,
            received_at, due_at, note) VALUES (?, ?, 'received', ?, ?, ?, ?, ?)`,
      args: [
        id,
        body.kind,
        body.sourceChannel,
        JSON.stringify(body.subjectMatchKeys),
        stamp,
        dueAt,
        body.note ?? null,
      ],
    });

    await db.execute({
      sql: `INSERT INTO deletion_jobs (id, privacy_request_id, status, created_at)
            VALUES (?, ?, 'pending', ?)`,
      args: [newId('deletionJob'), id, stamp],
    });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'privacy_request.received',
      entityKind: 'privacy_request',
      entityId: id,
      detail: { kind: body.kind, channel: body.sourceChannel },
    });

    return c.json({ privacyRequestId: id, status: 'received', dueAt }, 201);
  });

  // ------------------------------------------------------------------ usage
  api.get('/usage', async (c) => {
    const actor = c.get('actor');
    const rows = await c.get('db').execute({
      sql: `SELECT unit, sum(quantity) AS quantity, sum(cost_usd) AS cost_usd
              FROM usage_events WHERE workspace_id = ? GROUP BY unit`,
      args: [actor.workspaceId],
    });
    return c.json({ usage: rows.rows });
  });

  app.route(`/api/v1`, api);

  // Single error shape for every failure (PRD §24).
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        error.status as 400,
      );
    }

    console.error('unhandled error', error);
    return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'route not found' } }, 404));

  return app;
}

/**
 * Re-evaluates the policy for a stored recommendation against current state.
 *
 * This is the single most important function in the API: it is what makes the
 * PRD's "policy-gated outbound actions 100%" target true even when a
 * recommendation has been sitting in the queue for days.
 */
async function recheckPolicy(
  db: Client,
  actor: RequestActor,
  recommendation: repo.RecommendationRow,
) {
  const [person, workspace, campaign, counts, flags, connected] = await Promise.all([
    repo.getPerson(db, recommendation.person_id),
    repo.getWorkspace(db, actor.workspaceId),
    repo.getCampaign(db, actor.workspaceId, recommendation.campaign_id),
    repo.actionCounts(db, actor.workspaceId, recommendation.person_id),
    repo.featureFlags(db, actor.workspaceId),
    repo.hasConnectedAccount(db, actor.workspaceId, recommendation.network as Network),
  ]);

  if (!person) throw ApiError.notFound('person');
  if (!campaign) throw ApiError.notFound('campaign');

  const matchKeys = await repo.suppressionKeysForPerson(db, recommendation.person_id);
  const suppressed =
    person.status === 'suppressed' || (await repo.isSuppressed(db, actor.workspaceId, matchKeys));

  const budget = safeJson(campaign.budget_json);

  return evaluatePolicy({
    network: recommendation.network as Network,
    action: recommendation.action as ActionKind,
    approvalMode: campaign.approval_mode as 'draft_and_approve',
    hasConnectedAccount: connected,
    personSuppressed: suppressed,
    personBelievedMinor: person.believed_minor === 1,
    personDeleted: person.status === 'deleted',
    identityConfidence: person.identity_confidence,
    minIdentityConfidence: workspace?.min_outreach_confidence ?? 0.85,
    actionsToday: counts.today,
    maxActionsPerDay: numberOr(budget.maxActionsPerDay, 50),
    actionsToThisProspectThisWeek: counts.thisProspectThisWeek,
    maxActionsPerProspectPerWeek: numberOr(budget.maxActionsPerProspectPerWeek, 1),
    ...(counts.hoursSinceLast === undefined
      ? {}
      : { hoursSinceLastActionToProspect: counts.hoursSinceLast }),
    featureFlags: flags,
  });
}

/** Networks we can act on through an API; everything else is manual. */
function modeForNetwork(network: Network): 'official_api' | 'manual' | 'crm' {
  if (network === 'crm') return 'crm';
  if (network === 'x' || network === 'bluesky' || network === 'github') return 'official_api';
  return 'manual';
}

async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  }
  return parsed.data;
}

function clampLimit(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '50', 10);
  if (!Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(1, value));
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

export { POLICY_VERSION };
