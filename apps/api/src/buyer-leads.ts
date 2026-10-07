/**
 * Buyer leads: `/api/v1/buyer-leads/*`.
 *
 * Monitors watch public communities (Reddit, Hacker News, Bluesky) for one
 * brand's keywords; every matched post is scored for buyer intent, and the ones
 * over a monitor's floor are leads. A reply can be drafted for any lead. It is
 * never posted: there is deliberately no route that posts to a community.
 *
 * Reading is open to every member. Monitors, scans and drafts are
 * approver-only: a scan spends the public archives' goodwill and model calls,
 * and a draft is a model call.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { TextModel } from '@outreachgraph/ai';
import {
  createLeadMonitor,
  deleteLeadMonitor,
  draftCommunityLeadReply,
  getCommunityLead,
  getLeadMonitor,
  listCommunityLeads,
  listLeadMonitors,
  scanLeadMonitor,
  updateCommunityLead,
  updateLeadMonitor,
  LEAD_SOURCES,
  LEAD_STATUSES,
  MonitorInputError,
  NoModelError,
  type LeadMonitor,
  type LeadStatus,
} from '@outreachgraph/pipeline';
import type { FeedSource, WebSearcher } from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface LeadRouteDeps {
  /** Scores intent, drafts replies and suggests keywords; absent means patterns only, no drafts. */
  readonly model?: TextModel | undefined;
  /** Test seam: the sources a monitor reads. */
  readonly leadSources?: ((monitor: LeadMonitor) => readonly FeedSource[]) | undefined;
  /** Google search (ValueSERP) for the `web` source. */
  readonly searcher?: WebSearcher | undefined;
}

const monitorFields = {
  name: z.string().min(1).max(120).optional(),
  url: z.string().max(500).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  keywords: z.array(z.string().max(60)).max(25).optional(),
  subreddits: z.array(z.string().max(40)).max(25).optional(),
  exclude: z.array(z.string().max(60)).max(25).optional(),
  sources: z.array(z.string().max(20)).max(5).optional(),
  enabled: z.boolean().optional(),
  everyMinutes: z.number().int().min(60).max(10_080).optional(),
  minIntent: z.number().int().min(0).max(100).optional(),
  digest: z.boolean().optional(),
};

const createSchema = z.object({ ...monitorFields, offeringId: z.string().max(80).optional() });
const updateSchema = z.object(monitorFields);
const leadUpdateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  replyDraft: z.string().max(4000).nullable().optional(),
});

async function body<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  try {
    const text = await request.text();
    raw = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  return parsed.data;
}

function requireApprover(actor: RequestActor, doing: string): void {
  if (!canApprove(actor)) throw ApiError.forbidden(doing);
}

function asBadRequest(error: unknown): never {
  if (error instanceof MonitorInputError) throw ApiError.badRequest(error.message);
  throw error;
}

export function leadRoutes(deps: LeadRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  /** Leads (newest first) and the monitors that found them. */
  router.get('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const status = c.req.query('status');
    if (status && !(LEAD_STATUSES as readonly string[]).includes(status)) {
      throw ApiError.badRequest(`status must be one of ${LEAD_STATUSES.join(', ')}`);
    }
    const minIntent = c.req.query('minIntent') ?? c.req.query('min_intent');
    const limit = c.req.query('limit');
    return c.json({
      leads: await listCommunityLeads(db, actor.workspaceId, {
        monitorId: c.req.query('monitor') || undefined,
        ...(status ? { status: status as LeadStatus } : {}),
        ...(minIntent !== undefined && minIntent !== '' ? { minIntent: Number(minIntent) } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      }),
      monitors: await listLeadMonitors(db, actor.workspaceId),
      sources: LEAD_SOURCES,
      statuses: LEAD_STATUSES,
      judgeEnabled: Boolean(deps.model),
      // Stated so every client can say it: a human posts, the product never does.
      posting: 'manual',
    });
  });

  router.get('/monitors', async (c) =>
    c.json({ monitors: await listLeadMonitors(c.get('db'), c.get('actor').workspaceId) }),
  );

  router.post('/monitors', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'creating a lead monitor');
    const input = await body(c.req.raw, createSchema);
    const db = c.get('db');
    const monitor = await createLeadMonitor(
      { db, model: deps.model },
      actor.workspaceId,
      input,
    ).catch(asBadRequest);
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'leads.monitor_created',
      entityKind: 'lead_monitor',
      entityId: monitor.id,
      detail: {
        name: monitor.name,
        keywords: monitor.keywords.length,
        subreddits: monitor.subreddits.length,
      },
    });
    return c.json({ monitor }, 201);
  });

  router.get('/monitors/:id', async (c) => {
    const monitor = await getLeadMonitor(
      c.get('db'),
      c.get('actor').workspaceId,
      c.req.param('id'),
    );
    if (!monitor) throw ApiError.notFound('lead monitor');
    return c.json({ monitor });
  });

  router.patch('/monitors/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'changing a lead monitor');
    const input = await body(c.req.raw, updateSchema);
    const monitor = await updateLeadMonitor(
      c.get('db'),
      actor.workspaceId,
      c.req.param('id'),
      input,
    ).catch(asBadRequest);
    if (!monitor) throw ApiError.notFound('lead monitor');
    return c.json({ monitor });
  });

  router.delete('/monitors/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'deleting a lead monitor');
    if (!(await deleteLeadMonitor(c.get('db'), actor.workspaceId, c.req.param('id'))))
      throw ApiError.notFound('lead monitor');
    return c.json({ deleted: true });
  });

  /** Scan now, rather than waiting for the schedule. Takes up to a minute. */
  router.post('/monitors/:id/scan', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'scanning for leads');
    const db = c.get('db');
    if (!(await getLeadMonitor(db, actor.workspaceId, c.req.param('id'))))
      throw ApiError.notFound('lead monitor');
    const result = await scanLeadMonitor(
      {
        db,
        model: deps.model,
        ...(deps.leadSources ? { sources: deps.leadSources } : {}),
        ...(deps.searcher ? { searcher: deps.searcher } : {}),
      },
      actor.workspaceId,
      c.req.param('id'),
    );
    return c.json({ result });
  });

  router.get('/:id', async (c) => {
    const lead = await getCommunityLead(c.get('db'), c.get('actor').workspaceId, c.req.param('id'));
    if (!lead) throw ApiError.notFound('lead');
    return c.json({ lead });
  });

  /** Mark replied or dismissed, or save an edited draft. */
  router.patch('/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'changing a lead');
    const input = await body(c.req.raw, leadUpdateSchema);
    const lead = await updateCommunityLead(
      c.get('db'),
      actor.workspaceId,
      c.req.param('id'),
      input,
    );
    if (!lead) throw ApiError.notFound('lead');
    return c.json({ lead });
  });

  /** Draft a reply for a human to post. Nothing is posted. */
  router.post('/:id/draft', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'drafting a reply');
    let lead;
    try {
      lead = await draftCommunityLeadReply(
        { db: c.get('db'), model: deps.model },
        actor.workspaceId,
        c.req.param('id'),
      );
    } catch (error) {
      if (error instanceof NoModelError) {
        return c.json({ error: { code: 'no_model', message: error.message } }, 503);
      }
      return c.json({ error: { code: 'draft_failed', message: (error as Error).message } }, 502);
    }
    if (!lead) throw ApiError.notFound('lead');
    return c.json({ lead });
  });

  return router;
}
