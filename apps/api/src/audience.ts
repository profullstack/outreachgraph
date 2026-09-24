/**
 * Audience watches: `/api/v1/audience/*`.
 *
 * A watch says "the people who engage with this account of ours belong in
 * this campaign". That is a targeting decision — it decides who the product
 * spends research on and who a rule may enrol — so it is approver-only, like
 * campaign filters and webhooks, and a viewer cannot create one.
 *
 * `POST /engagements` is the hand-off half. LinkedIn has no readable audience
 * for us (reading reactions would mean driving the member's session for
 * something the LinkedIn opt-in never covered), so a human or a client posts
 * what they saw and it lands through the identical path: the same intake, the
 * same signal, the same rules. Nothing here sends, and nothing here raises
 * anybody's identity confidence.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  AUDIENCE_KINDS,
  AUDIENCE_MODES,
  AUDIENCE_NETWORKS,
  MAX_LOOKBACK_POSTS,
  MAX_PER_RUN_CAP,
  modesFor,
  normaliseAccount,
  parseAudienceWatch,
  type AudienceKind,
} from '@outreachgraph/domain';
import type { Client } from '@outreachgraph/db';
import {
  deleteAudienceWatch,
  getAudienceWatch,
  listAudienceWatches,
  recordEngagements,
  runAudienceWatch,
  saveAudienceWatch,
  type AudienceWatch,
  type RunWatchDeps,
} from '@outreachgraph/pipeline';
import type { AudienceReader } from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface AudienceRouteDeps {
  /**
   * The reader for one watch, or undefined when the workspace has no usable
   * connection for that network. Handed in rather than built here: the
   * credentials live in the pipeline's account modules, and the API's job is
   * to decide who may ask, not how to reach X.
   */
  readonly resolveReader: (db: Client, watch: AudienceWatch) => Promise<AudienceReader | undefined>;
  readonly requireVerifiedEmail: (db: Client, actor: RequestActor) => Promise<void>;
}

const watchSchema = z.object({
  network: z.enum(AUDIENCE_NETWORKS),
  account: z.string().min(1).max(200),
  campaignId: z.string().min(1).max(64),
  kinds: z.array(z.string().max(32)).max(AUDIENCE_KINDS.length).optional(),
  mode: z.enum(AUDIENCE_MODES).optional(),
  pollMinutes: z.number().int().optional(),
  lookbackPosts: z.number().int().optional(),
  perRunCap: z.number().int().optional(),
  enabled: z.boolean().optional(),
});

const engagementsSchema = z.object({
  /** The watch these were seen on. */
  watchId: z.string().min(1).max(64),
  engagements: z
    .array(
      z.object({
        kind: z.enum(AUDIENCE_KINDS),
        handle: z.string().min(1).max(200),
        displayName: z.string().max(200).optional(),
        bio: z.string().max(2_000).optional(),
        profileUrl: z.string().max(2_000).optional(),
        avatarUrl: z.string().max(2_000).optional(),
        platformUserId: z.string().max(200).optional(),
        /** The post they engaged with: its id, its URL, and what it said. */
        postId: z.string().max(500).optional(),
        postUrl: z.string().max(2_000).optional(),
        postText: z.string().max(5_000).optional(),
        at: z.string().max(40).optional(),
      }),
    )
    .min(1)
    .max(200),
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

export function audienceRoutes(deps: AudienceRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing audience watches');

    const campaignId = c.req.query('campaignId');
    return c.json({
      watches: await listAudienceWatches(c.get('db'), actor.workspaceId, {
        ...(campaignId ? { campaignId } : {}),
      }),
      networks: AUDIENCE_NETWORKS.map((network) => ({ network, modes: modesFor(network) })),
      kinds: AUDIENCE_KINDS,
      limits: { maxLookbackPosts: MAX_LOOKBACK_POSTS, maxPerRunCap: MAX_PER_RUN_CAP },
    });
  });

  router.post('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'watching an audience');
    await deps.requireVerifiedEmail(db, actor);

    const input = await body(c.req.raw, watchSchema);
    const spec = parseAudienceWatch(input);
    if ('reason' in spec) throw ApiError.badRequest(spec.reason);

    const campaign = await repo.getCampaign(db, actor.workspaceId, spec.campaignId);
    if (!campaign) throw ApiError.notFound('campaign');

    const watch = await saveAudienceWatch(db, { ...spec, workspaceId: actor.workspaceId });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'audience_watch.saved',
      entityKind: 'audience_watch',
      entityId: watch.id,
      detail: { network: watch.network, account: watch.account, kinds: [...watch.kinds] },
    });

    return c.json({ watch }, 201);
  });

  router.delete('/:id', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'removing an audience watch');

    const removed = await deleteAudienceWatch(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!removed) throw ApiError.notFound('audience watch');

    await repo.audit(c.get('db'), {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'audience_watch.deleted',
      entityKind: 'audience_watch',
      entityId: c.req.param('id'),
      detail: {},
    });

    return c.json({ deleted: true });
  });

  /**
   * Read one watch now rather than waiting for its interval.
   *
   * The same function the worker's sweep calls, so a run from here proves the
   * real path works — and a refusal is reported with the network's own reason
   * instead of a 500.
   */
  router.post('/:id/run', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'running an audience watch');

    const watch = await getAudienceWatch(db, actor.workspaceId, c.req.param('id'));
    if (!watch) throw ApiError.notFound('audience watch');
    if (watch.mode !== 'poll') {
      throw ApiError.badRequest(`a ${watch.network} watch is filled by hand-off, not by polling`);
    }

    const runDeps: RunWatchDeps = {
      db,
      resolveReader: (candidate) => deps.resolveReader(db, candidate),
    };
    const result = await runAudienceWatch(runDeps, watch);

    return c.json({ result }, result.outcome === 'ok' ? 200 : 202);
  });

  /** Engagements somebody saw and handed over, for a network we cannot read. */
  router.post('/engagements', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'recording audience engagements');
    await deps.requireVerifiedEmail(db, actor);

    const input = await body(c.req.raw, engagementsSchema);
    const watch = await getAudienceWatch(db, actor.workspaceId, input.watchId);
    if (!watch) throw ApiError.notFound('audience watch');

    const engagements = input.engagements.flatMap((raw) => {
      const handle = normaliseAccount(watch.network, raw.handle);
      if (!handle) return [];

      return [
        {
          kind: raw.kind as AudienceKind,
          actor: {
            handle,
            ...(raw.platformUserId ? { platformUserId: raw.platformUserId } : {}),
            ...(raw.displayName ? { displayName: raw.displayName } : {}),
            ...(raw.bio ? { bio: raw.bio } : {}),
            ...(raw.avatarUrl ? { avatarUrl: raw.avatarUrl } : {}),
            ...(raw.profileUrl ? { profileUrl: raw.profileUrl } : {}),
          },
          ...(raw.postId ? { subjectId: raw.postId } : {}),
          ...(raw.postUrl ? { subjectUrl: raw.postUrl } : {}),
          ...(raw.postText ? { subjectText: raw.postText } : {}),
          ...(raw.at ? { at: raw.at } : {}),
        },
      ];
    });

    const result = await recordEngagements(
      { db },
      { watch, engagements, source: `handoff:${actor.userId}` },
    );

    return c.json({ result }, 201);
  });

  return router;
}
