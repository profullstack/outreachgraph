/**
 * The Idea Generator: `/api/v1/ideas/*`.
 *
 * What people on Reddit keep asking for, grouped into ideas and ranked by how
 * many different people asked; and "Build it", which hands an idea to
 * chovy.com and returns the link that opens Chovy's intake with it filled in.
 *
 * Reading is open to every member. Scanning, settings and Build it are
 * approver-only: a scan spends the shared archive's goodwill and a model call,
 * and Build it starts real work.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { TextModel } from '@outreachgraph/ai';
import {
  briefFor,
  getIdea,
  getIdeaScan,
  listIdeas,
  recordHandoff,
  saveIdeaScan,
  scanIdeas,
  updateIdea,
  IDEA_STATUSES,
  type IdeaStatus,
} from '@outreachgraph/pipeline';
import { handToChovy, type ChovyConfig, type Fetcher } from '@outreachgraph/ideas';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface IdeaRouteDeps {
  /** The judge that drops pitches; absent means pattern verdicts only. */
  readonly model?: TextModel | undefined;
  /** chovy.com hand-off; absent without CHOVY_CAMPAIGN_SECRET, which disables Build it. */
  readonly chovy?: ChovyConfig | undefined;
  /** Test seams. */
  readonly chovyFetch?: typeof fetch | undefined;
  readonly redditFetch?: Fetcher | undefined;
  readonly archiveGapMs?: number | undefined;
}

/** An RSS Amplifier feed: its slug or directory URL, optionally with a role. */
const feedSchema = z.union([
  z.string().max(200),
  z.object({
    slug: z.string().max(200),
    role: z.enum(['asks', 'signals', 'built']).optional(),
    name: z.string().max(80).optional(),
  }),
]);

const settingsSchema = z.object({
  subs: z.array(z.string().max(40)).max(60).optional(),
  feeds: z.array(feedSchema).max(100).optional(),
  enabled: z.boolean().optional(),
  everyMinutes: z.number().int().min(30).max(10_080).optional(),
  buildAt: z.number().int().min(1).max(100).optional(),
  windowDays: z.number().int().min(1).max(365).optional(),
});

const updateSchema = z.object({
  status: z.enum(IDEA_STATUSES).optional(),
  label: z.string().min(2).max(80).optional(),
  notes: z.string().max(5_000).nullable().optional(),
});

const scanSchema = z.object({
  subs: z.array(z.string().max(40)).max(60).optional(),
  feeds: z.array(feedSchema).max(100).optional(),
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

export function ideaRoutes(deps: IdeaRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', async (c) => {
    const actor = c.get('actor');
    const status = c.req.query('status');
    if (status && !(IDEA_STATUSES as readonly string[]).includes(status)) {
      throw ApiError.badRequest(`status must be one of ${IDEA_STATUSES.join(', ')}`);
    }
    const db = c.get('db');
    return c.json({
      ideas: await listIdeas(db, actor.workspaceId, status ? { status: status as IdeaStatus } : {}),
      settings: await getIdeaScan(db, actor.workspaceId),
      statuses: IDEA_STATUSES,
      judgeEnabled: Boolean(deps.model),
      buildEnabled: Boolean(deps.chovy),
    });
  });

  router.get('/settings', async (c) =>
    c.json({ settings: await getIdeaScan(c.get('db'), c.get('actor').workspaceId) }),
  );

  router.put('/settings', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'changing idea scanning');
    const input = await body(c.req.raw, settingsSchema);
    const settings = await saveIdeaScan(c.get('db'), actor.workspaceId, input);
    await repo.audit(c.get('db'), {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'ideas.settings_saved',
      entityKind: 'workspace',
      entityId: actor.workspaceId,
      detail: {
        subs: settings.subs.length,
        feeds: settings.feeds.length,
        enabled: settings.enabled,
      },
    });
    return c.json({ settings });
  });

  router.post('/scan', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'scanning for ideas');
    const input = await body(c.req.raw, scanSchema);
    const result = await scanIdeas(
      {
        db: c.get('db'),
        model: deps.model,
        ...(deps.redditFetch ? { fetchJson: deps.redditFetch } : {}),
        ...(deps.archiveGapMs !== undefined ? { archiveGapMs: deps.archiveGapMs } : {}),
      },
      {
        workspaceId: actor.workspaceId,
        ...(input.subs ? { subs: input.subs } : {}),
        ...(input.feeds ? { feeds: input.feeds } : {}),
      },
    );
    return c.json({ result });
  });

  router.get('/:id', async (c) => {
    const actor = c.get('actor');
    const idea = await getIdea(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!idea) throw ApiError.notFound('idea');
    return c.json({ idea, buildEnabled: Boolean(deps.chovy) });
  });

  router.patch('/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'changing an idea');
    const input = await body(c.req.raw, updateSchema);
    const db = c.get('db');
    if (!(await updateIdea(db, actor.workspaceId, c.req.param('id'), input)))
      throw ApiError.notFound('idea');
    return c.json({ idea: await getIdea(db, actor.workspaceId, c.req.param('id')) });
  });

  /** Build it: hand the idea to chovy.com and return the link to its intake. */
  router.post('/:id/build', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'building an idea');
    if (!deps.chovy) {
      return c.json(
        {
          error: {
            code: 'build_unconfigured',
            message: 'Build it is not connected to chovy.com on this server',
          },
        },
        503,
      );
    }
    const db = c.get('db');
    const idea = await getIdea(db, actor.workspaceId, c.req.param('id'));
    if (!idea) throw ApiError.notFound('idea');
    let handoff;
    try {
      handoff = await handToChovy(deps.chovy, briefFor(idea), idea.id, deps.chovyFetch ?? fetch);
    } catch (error) {
      return c.json(
        {
          error: {
            code: 'build_failed',
            message: `chovy.com did not take the idea: ${(error as Error).message}`,
          },
        },
        502,
      );
    }
    await recordHandoff(db, actor.workspaceId, idea.id, {
      url: handoff.handoff_url,
      by: actor.userId,
    });
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'idea.build_started',
      entityKind: 'idea',
      entityId: idea.id,
      detail: { label: idea.label, askers: idea.askers },
    });
    return c.json({ handoffUrl: handoff.handoff_url, expiresAt: handoff.expires_at });
  });

  return router;
}
