/** Saved, editable writing for the Content Studio. Nothing is auto-published. */

import { Hono } from 'hono';
import { z } from 'zod';
import { draftContent, type ContentKind, type TextModel } from '@outreachgraph/ai';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { newId } from '@outreachgraph/domain';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';
import type { Throttles } from './throttle';
import { loadWorkspaceProfile } from './workspace-profile';

interface ContentDraftRow {
  id: string;
  workspace_id: string;
  offering_id: string | null;
  kind: string;
  title: string;
  topic: string;
  audience: string | null;
  notes: string | null;
  body: string;
  model: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ContentDraftView {
  readonly id: string;
  readonly offeringId?: string;
  readonly kind: ContentKind;
  readonly title: string;
  readonly topic: string;
  readonly audience?: string;
  readonly notes?: string;
  readonly body: string;
  readonly model?: string;
  readonly status: 'draft' | 'ready' | 'archived';
  readonly createdAt: string;
  readonly updatedAt: string;
}

function view(row: ContentDraftRow): ContentDraftView {
  return {
    id: row.id,
    ...(row.offering_id ? { offeringId: row.offering_id } : {}),
    kind: row.kind as ContentKind,
    title: row.title,
    topic: row.topic,
    ...(row.audience ? { audience: row.audience } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    body: row.body,
    ...(row.model ? { model: row.model } : {}),
    status: row.status as ContentDraftView['status'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ContentDraftRouteDeps {
  readonly model?: TextModel | undefined;
  readonly throttles?: Throttles | undefined;
}

const createSchema = z.object({
  kind: z.enum(['social', 'newsletter', 'article']),
  topic: z.string().trim().min(3).max(240),
  audience: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(4000).optional(),
  offeringId: z.string().max(80).optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  body: z.string().trim().min(1).max(20_000).optional(),
  status: z.enum(['draft', 'ready', 'archived']).optional(),
});

async function parseBody<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw ApiError.badRequest('request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw ApiError.badRequest('request body failed validation', parsed.error.flatten());
  }
  return parsed.data;
}

function requireWriter(actor: RequestActor): void {
  if (!canApprove(actor)) throw ApiError.forbidden('writing content');
}

async function getDraft(db: Client, workspaceId: string, id: string) {
  return queryOne<ContentDraftRow>(
    db,
    'SELECT * FROM content_drafts WHERE id = ? AND workspace_id = ?',
    [id, workspaceId],
  );
}

export function contentDraftRoutes(deps: ContentDraftRouteDeps): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/', async (c) => {
    const actor = c.get('actor');
    const rows = await queryAll<ContentDraftRow>(
      c.get('db'),
      `SELECT * FROM content_drafts WHERE workspace_id = ?
        ORDER BY updated_at DESC LIMIT 100`,
      [actor.workspaceId],
    );
    return c.json({ drafts: rows.map(view), draftingEnabled: Boolean(deps.model) });
  });

  router.post('/', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, createSchema);
    if (!deps.model) {
      throw new ApiError(
        503,
        'no_model',
        'no language model is configured, so content cannot be drafted',
      );
    }
    await deps.throttles?.take('contentDraft', actor.workspaceId);

    const db = c.get('db');
    const profile = await loadWorkspaceProfile(db, actor.workspaceId, input.offeringId);
    const product = input.offeringId
      ? profile.products?.find((item) => item.offeringId === input.offeringId)
      : profile.products?.[0];
    if (input.offeringId && !product) throw ApiError.badRequest('product is not in this workspace');

    const brand = profile.offering
      ? {
          name: profile.offering.name,
          ...(profile.offering.description ? { description: profile.offering.description } : {}),
          ...(profile.offering.valuePropositions.length
            ? { valuePropositions: profile.offering.valuePropositions }
            : {}),
        }
      : undefined;
    const generated = await draftContent(deps.model, {
      kind: input.kind,
      topic: input.topic,
      ...(input.audience ? { audience: input.audience } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(brand ? { brand } : {}),
      ...(profile.voice
        ? {
            voice: {
              style: profile.voice.style,
              ...(profile.voice.instructions ? { instructions: profile.voice.instructions } : {}),
              ...(profile.voice.maxWords ? { maxWords: profile.voice.maxWords } : {}),
            },
          }
        : {}),
    });
    if (!generated.body.trim()) {
      throw new ApiError(502, 'draft_failed', 'the model did not return content; try again');
    }

    const at = now();
    const row: ContentDraftRow = {
      id: newId('contentDraft'),
      workspace_id: actor.workspaceId,
      offering_id: product?.offeringId ?? null,
      kind: input.kind,
      title: generated.title || input.topic,
      topic: input.topic,
      audience: input.audience || null,
      notes: input.notes || null,
      body: generated.body,
      model: generated.model,
      status: 'draft',
      created_at: at,
      updated_at: at,
    };
    await db.execute({
      sql: `INSERT INTO content_drafts (id, workspace_id, offering_id, kind, title, topic,
              audience, notes, body, model, status, created_by, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
      args: [
        row.id,
        row.workspace_id,
        row.offering_id,
        row.kind,
        row.title,
        row.topic,
        row.audience,
        row.notes,
        row.body,
        row.model,
        actor.userId,
        at,
        at,
      ],
    });
    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'content.drafted',
      entityKind: 'content_draft',
      entityId: row.id,
      detail: { kind: row.kind, topic: row.topic },
    });
    return c.json({ draft: view(row) }, 201);
  });

  router.patch('/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const input = await parseBody(c.req.raw, updateSchema);
    if (!input.title && !input.body && !input.status) {
      throw ApiError.badRequest('include a title, body, or status to update');
    }
    const db = c.get('db');
    const row = await getDraft(db, actor.workspaceId, c.req.param('id'));
    if (!row) throw ApiError.notFound('content draft');
    const updated: ContentDraftRow = {
      ...row,
      ...(input.title ? { title: input.title } : {}),
      ...(input.body ? { body: input.body } : {}),
      ...(input.status ? { status: input.status } : {}),
      updated_at: now(),
    };
    await db.execute({
      sql: `UPDATE content_drafts SET title = ?, body = ?, status = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
      args: [
        updated.title,
        updated.body,
        updated.status,
        updated.updated_at,
        row.id,
        actor.workspaceId,
      ],
    });
    return c.json({ draft: view(updated) });
  });

  router.delete('/:id', async (c) => {
    const actor = c.get('actor');
    requireWriter(actor);
    const result = await c.get('db').execute({
      sql: 'DELETE FROM content_drafts WHERE id = ? AND workspace_id = ?',
      args: [c.req.param('id'), actor.workspaceId],
    });
    if (result.rowsAffected === 0) throw ApiError.notFound('content draft');
    return c.json({ deleted: true });
  });

  return router;
}
