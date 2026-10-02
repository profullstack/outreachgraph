/**
 * Job posts: `/api/v1/job-posts/*`.
 *
 * A list of job postings and the people found behind each one. Saving or
 * searching queues the read; `/:id/resolve` runs it now, for a client that is
 * waiting. Promoting a contact puts them in a campaign through the ordinary
 * social intake — nothing here sends.
 *
 * Reading the list is open to every member; changing it is approver-only,
 * like the other intake sources, because a promoted contact is a targeting
 * decision.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  JOB_BOARDS,
  JOB_POST_STATUSES,
  MAX_JOB_URLS,
  MAX_SEARCH_RESULTS,
} from '@outreachgraph/domain';
import {
  deleteJobPost,
  enqueueResolve,
  getJobPost,
  listJobPosts,
  promoteJobPostContact,
  resolveJobPost,
  saveJobPosts,
  searchJobPosts,
  updateJobPost,
} from '@outreachgraph/pipeline';
import type { JobReaderOptions, WebSearcher } from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface JobPostRouteDeps {
  /** ValueSERP in production; absent without `VALUESERP_API_KEY`. */
  readonly searcher?: WebSearcher | undefined;
  /** Test seam for the job boards and company sites. */
  readonly reader?: JobReaderOptions | undefined;
}

const saveSchema = z.object({
  url: z.string().max(2_000).optional(),
  urls: z.array(z.string().max(2_000)).max(MAX_JOB_URLS).optional(),
  campaignId: z.string().min(1).max(64).optional(),
});

const searchSchema = z.object({
  keyword: z.string().min(2).max(200),
  boards: z.array(z.enum(JOB_BOARDS)).max(JOB_BOARDS.length).optional(),
  campaignId: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional(),
});

const updateSchema = z.object({
  status: z.enum(JOB_POST_STATUSES).optional(),
  notes: z.string().max(5_000).nullable().optional(),
  campaignId: z.string().min(1).max(64).nullable().optional(),
});

const promoteSchema = z.object({
  campaignId: z.string().min(1).max(64).optional(),
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
  if (!parsed.success) {
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  }
  return parsed.data;
}

function requireApprover(actor: RequestActor, doing: string): void {
  if (!canApprove(actor)) throw ApiError.forbidden(doing);
}

export function jobPostRoutes(deps: JobPostRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  async function requireCampaign(
    db: AppEnv['Variables']['db'],
    workspaceId: string,
    id?: string | null,
  ) {
    if (!id) return;
    if (!(await repo.getCampaign(db, workspaceId, id))) throw ApiError.notFound('campaign');
  }

  router.get('/', async (c) => {
    const actor = c.get('actor');
    const status = c.req.query('status');
    if (status && !(JOB_POST_STATUSES as readonly string[]).includes(status)) {
      throw ApiError.badRequest(`status must be one of ${JOB_POST_STATUSES.join(', ')}`);
    }
    const campaignId = c.req.query('campaignId');
    return c.json({
      jobPosts: await listJobPosts(c.get('db'), actor.workspaceId, {
        ...(status ? { status: status as (typeof JOB_POST_STATUSES)[number] } : {}),
        ...(campaignId ? { campaignId } : {}),
      }),
      boards: JOB_BOARDS,
      statuses: JOB_POST_STATUSES,
      searchEnabled: Boolean(deps.searcher),
    });
  });

  router.post('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'adding job posts');

    const input = await body(c.req.raw, saveSchema);
    const urls = [...(input.urls ?? []), ...(input.url ? [input.url] : [])].filter((u) => u.trim());
    if (urls.length === 0) throw ApiError.badRequest('enter at least one job posting URL');
    await requireCampaign(db, actor.workspaceId, input.campaignId);

    const result = await saveJobPosts(db, {
      workspaceId: actor.workspaceId,
      urls,
      ...(input.campaignId ? { campaignId: input.campaignId } : {}),
    });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'job_posts.saved',
      entityKind: 'job_post',
      entityId: result.saved[0]?.id ?? 'none',
      detail: {
        saved: result.saved.length,
        duplicates: result.duplicates.length,
        rejected: result.rejected.length,
      },
    });

    return c.json(result, result.saved.length > 0 ? 201 : 200);
  });

  /** Search the job boards by keyword and add the postings found. */
  router.post('/search', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'searching for job posts');
    if (!deps.searcher) {
      throw ApiError.badRequest('job search needs VALUESERP_API_KEY on this deployment');
    }

    const input = await body(c.req.raw, searchSchema);
    await requireCampaign(db, actor.workspaceId, input.campaignId);

    let result;
    try {
      result = await searchJobPosts(
        { db, searcher: deps.searcher },
        {
          workspaceId: actor.workspaceId,
          keyword: input.keyword,
          ...(input.boards ? { boards: input.boards } : {}),
          ...(input.campaignId ? { campaignId: input.campaignId } : {}),
          ...(input.limit ? { limit: input.limit } : {}),
        },
      );
    } catch (error) {
      throw ApiError.badRequest(error instanceof Error ? error.message : String(error));
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'job_posts.searched',
      entityKind: 'job_post',
      entityId: result.saved[0]?.id ?? 'none',
      detail: { keyword: input.keyword, found: result.found, saved: result.saved.length },
    });

    return c.json(result);
  });

  router.get('/:id', async (c) => {
    const post = await getJobPost(c.get('db'), c.get('actor').workspaceId, c.req.param('id'));
    if (!post) throw ApiError.notFound('job post');
    return c.json({ jobPost: post });
  });

  router.patch('/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'editing a job post');
    const input = await body(c.req.raw, updateSchema);
    await requireCampaign(db, actor.workspaceId, input.campaignId);

    const post = await updateJobPost(db, actor.workspaceId, c.req.param('id'), input);
    if (!post) throw ApiError.notFound('job post');
    return c.json({ jobPost: post });
  });

  router.delete('/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'removing a job post');
    if (!(await deleteJobPost(db, actor.workspaceId, c.req.param('id')))) {
      throw ApiError.notFound('job post');
    }
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'job_posts.deleted',
      entityKind: 'job_post',
      entityId: c.req.param('id'),
      detail: {},
    });
    return c.json({ deleted: true });
  });

  /**
   * Read the posting and search for its people now, rather than waiting for
   * the worker. `?queue=1` queues it instead, for a client that will poll.
   */
  router.post('/:id/resolve', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'resolving a job post');
    const id = c.req.param('id');
    if (!(await getJobPost(db, actor.workspaceId, id))) throw ApiError.notFound('job post');

    if (c.req.query('queue')) {
      return c.json({ queued: await enqueueResolve(db, actor.workspaceId, id) }, 202);
    }

    try {
      const result = await resolveJobPost(
        { db, searcher: deps.searcher, reader: deps.reader },
        actor.workspaceId,
        id,
      );
      return c.json({ jobPost: result.post, contacts: result.contacts, promoted: result.promoted });
    } catch (error) {
      const post = await getJobPost(db, actor.workspaceId, id);
      return c.json(
        {
          error: {
            code: 'resolve_failed',
            message: error instanceof Error ? error.message : String(error),
          },
          jobPost: post,
        },
        502,
      );
    }
  });

  /** Put one contact into a campaign: the posting's own, unless another is named. */
  router.post('/:id/contacts/:contactId/promote', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'adding a contact to a campaign');

    const post = await getJobPost(db, actor.workspaceId, c.req.param('id'));
    if (!post) throw ApiError.notFound('job post');
    const contact = post.contacts.find((candidate) => candidate.id === c.req.param('contactId'));
    if (!contact) throw ApiError.notFound('contact');

    const input = await body(c.req.raw, promoteSchema);
    const campaignId = input.campaignId ?? post.campaignId;
    if (!campaignId) {
      throw ApiError.badRequest('name a campaign: this posting is not attached to one');
    }
    await requireCampaign(db, actor.workspaceId, campaignId);

    const result = await promoteJobPostContact(db, actor.workspaceId, contact.id, campaignId);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'job_posts.contact_promoted',
      entityKind: 'person',
      entityId: result.personId,
      detail: { jobPostId: post.id, campaignId, email: result.email },
    });

    return c.json({ ...result, campaignId });
  });

  return router;
}
