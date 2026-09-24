/**
 * Outbound webhooks and CRM connections: `/api/v1/webhooks/*` and
 * `/api/v1/integrations/crm/*` (PRD §28).
 *
 * Every route here is owner/approver only, reads included. A webhook is a
 * standing instruction to copy workspace data — names, addresses, replies —
 * to somewhere outside the product, and deciding where a workspace's data
 * goes is the same kind of decision as approving outreach. A viewer can see
 * the prospects; they cannot point a firehose of them at a URL.
 *
 * Secrets go one way. The signing secret is returned exactly once, in the
 * response that creates the endpoint, and never again: not on the list, not
 * on the delivery log. A lost secret means deleting the endpoint and making a
 * new one, which is the correct amount of friction for a credential. CRM
 * tokens are never returned at all.
 *
 * Nothing here sends. "Test" queues a `ping` through the same delivery job
 * real events use, so a passing test proves the real path works.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  CRM_PROVIDERS,
  isCrmProvider,
  normaliseEventFilter,
  WEBHOOK_ENDPOINT_KINDS,
  WEBHOOK_EVENT_TYPES,
} from '@outreachgraph/domain';
import type { Client } from '@outreachgraph/db';
import {
  connectCrm,
  createWebhookEndpoint,
  crmStatus,
  CrmAccountError,
  deleteWebhookEndpoint,
  disconnectCrm,
  listWebhookDeliveries,
  listWebhookEndpoints,
  sendTestEvent,
  WebhookError,
  type CrmClientFactory,
} from '@outreachgraph/pipeline';
import type { FetchLike, HostLookup } from '@outreachgraph/providers';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';

export interface WebhookRouteDeps {
  readonly encryptionKey: Buffer | undefined;
  readonly requireVerifiedEmail: (db: Client, actor: RequestActor) => Promise<void>;
  /** Test seams: DNS for the SSRF check, and the CRM's network. */
  readonly lookup?: HostLookup | undefined;
  readonly crmFetch?: FetchLike | undefined;
  readonly crmClientFor?: CrmClientFactory | undefined;
}

const createWebhookSchema = z.object({
  url: z.string().min(8).max(2_000),
  kind: z.enum(WEBHOOK_ENDPOINT_KINDS).default('generic'),
  /** Event types to receive. Omitted or empty means all of them. */
  events: z
    .array(z.string().max(64))
    .max(WEBHOOK_EVENT_TYPES.length + 1)
    .optional(),
  description: z.string().max(200).optional(),
});

const connectCrmSchema = z.object({
  token: z.string().min(8).max(500),
  /** Tests only: there is no CRM to ask. */
  skipVerification: z.boolean().optional(),
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

export function webhookRoutes(deps: WebhookRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing webhooks');

    return c.json({
      endpoints: await listWebhookEndpoints(c.get('db'), actor.workspaceId),
      events: WEBHOOK_EVENT_TYPES,
      kinds: WEBHOOK_ENDPOINT_KINDS,
      canCreate: deps.encryptionKey !== undefined,
    });
  });

  router.post('/', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'adding a webhook');
    await deps.requireVerifiedEmail(db, actor);

    const input = await body(c.req.raw, createWebhookSchema);
    const filter = normaliseEventFilter(input.events);
    if (!filter.ok) {
      throw ApiError.badRequest(`unknown event type: ${filter.unknown.join(', ')}`, {
        known: WEBHOOK_EVENT_TYPES,
      });
    }

    try {
      const created = await createWebhookEndpoint(db, {
        workspaceId: actor.workspaceId,
        url: input.url,
        kind: input.kind,
        events: filter.events,
        description: input.description,
        createdBy: actor.userId,
        encryptionKey: deps.encryptionKey,
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });

      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'webhook.created',
        entityKind: 'webhook_endpoint',
        entityId: created.endpoint.id,
        // The hint, never the URL: the URL is a credential.
        detail: {
          kind: input.kind,
          urlHint: created.endpoint.urlHint,
          events: filter.events,
        },
      });

      return c.json(
        {
          endpoint: created.endpoint,
          // Shown once. The list never returns it.
          secret: created.secret,
        },
        201,
      );
    } catch (error) {
      if (error instanceof WebhookError) {
        throw new ApiError(error.code === 'not_configured' ? 503 : 400, error.code, error.message);
      }
      throw error;
    }
  });

  router.get('/deliveries', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing webhook deliveries');
    const limit = Number(c.req.query('limit') ?? 50);

    return c.json({
      deliveries: await listWebhookDeliveries(c.get('db'), actor.workspaceId, {
        endpointId: c.req.query('endpointId'),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  router.get('/:id/deliveries', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing webhook deliveries');
    const limit = Number(c.req.query('limit') ?? 50);

    return c.json({
      deliveries: await listWebhookDeliveries(c.get('db'), actor.workspaceId, {
        endpointId: c.req.param('id'),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    });
  });

  router.post('/:id/test', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'testing a webhook');

    const sent = await sendTestEvent(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!sent) throw ApiError.notFound('webhook');

    return c.json({ queued: true, ...sent }, 202);
  });

  router.delete('/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'removing a webhook');

    const id = c.req.param('id');
    const removed = await deleteWebhookEndpoint(db, actor.workspaceId, id);
    if (!removed) throw ApiError.notFound('webhook');

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'webhook.deleted',
      entityKind: 'webhook_endpoint',
      entityId: id,
      detail: {},
    });

    return c.json({ deleted: true, id });
  });

  return router;
}

/**
 * `/api/v1/integrations/crm`: which CRMs are connected, connect one, drop one.
 */
export function crmRoutes(deps: WebhookRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', async (c) => {
    const actor = c.get('actor');
    requireApprover(actor, 'viewing CRM connections');

    return c.json({
      providers: await crmStatus(c.get('db'), actor.workspaceId),
      canConnect: deps.encryptionKey !== undefined,
    });
  });

  router.put('/:provider', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'connecting a CRM');
    await deps.requireVerifiedEmail(db, actor);

    const provider = c.req.param('provider');
    if (!isCrmProvider(provider)) {
      throw ApiError.badRequest(`supported CRMs: ${CRM_PROVIDERS.join(', ')}`);
    }

    const input = await body(c.req.raw, connectCrmSchema);

    try {
      const connection = await connectCrm(db, {
        workspaceId: actor.workspaceId,
        provider,
        token: input.token,
        encryptionKey: deps.encryptionKey,
        verify: input.skipVerification !== true,
        ...(deps.crmFetch ? { fetchImpl: deps.crmFetch } : {}),
        ...(deps.crmClientFor ? { clientFor: deps.crmClientFor } : {}),
      });

      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'integration.connected',
        entityKind: 'workspace',
        entityId: actor.workspaceId,
        // Which CRM, never the token.
        detail: { network: provider },
      });

      return c.json({ connection });
    } catch (error) {
      if (error instanceof CrmAccountError) {
        throw new ApiError(error.code === 'not_configured' ? 503 : 400, error.code, error.message);
      }
      throw error;
    }
  });

  router.delete('/:provider', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    requireApprover(actor, 'disconnecting a CRM');

    const provider = c.req.param('provider');
    if (!isCrmProvider(provider)) {
      throw ApiError.badRequest(`supported CRMs: ${CRM_PROVIDERS.join(', ')}`);
    }

    const removed = await disconnectCrm(db, actor.workspaceId, provider);
    if (removed) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'integration.disconnected',
        entityKind: 'workspace',
        entityId: actor.workspaceId,
        detail: { network: provider },
      });
    }

    return c.json({ disconnected: removed });
  });

  return router;
}
