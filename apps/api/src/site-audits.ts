/**
 * Site audits: `/api/v1/site-audits/*` and the person-scoped routes.
 *
 * The latest seo.rank audit of a lead's company homepage (score, grade, the
 * top fixes, when), written by the worker's site-audit runner. Reading is
 * free; asking for a fresh audit queues an `seo_audit` job, which the runner
 * picks up within a round. Nothing here calls seo.rank inline.
 */

import { Hono } from 'hono';
import { queryOne, type Client } from '@outreachgraph/db';
import {
  auditDomain,
  queueSiteAudit,
  siteAuditFor,
  siteAuditStats,
  type StoredSiteAudit,
} from '@outreachgraph/pipeline';
import { ApiError, type AppEnv } from './context';

export interface PersonSiteAudit {
  readonly company: { readonly id: string; readonly name: string; readonly domain: string | null };
  /** False for a platform domain (gmail.com, substack.com): nothing of theirs to audit. */
  readonly auditable: boolean;
  readonly audit: StoredSiteAudit | null;
}

/** The person's company and its latest audit, or null when they have no company. */
export async function siteAuditForPerson(
  db: Client,
  personId: string,
): Promise<PersonSiteAudit | null> {
  const company = await queryOne<{ id: string; name: string; domain: string | null }>(
    db,
    `SELECT c.id, c.name, c.domain FROM people p JOIN companies c ON c.id = p.current_company_id
      WHERE p.id = ?`,
    [personId],
  );
  if (!company) return null;
  return {
    company: { id: company.id, name: company.name, domain: company.domain },
    auditable: auditDomain(company.domain) !== undefined,
    audit: (await siteAuditFor(db, company.id)) ?? null,
  };
}

/** Mounted at `/api/v1/people`: GET and POST `/:id/site-audit`. */
export function personSiteAuditRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/:id/site-audit', async (c) => {
    const result = await siteAuditForPerson(c.get('db'), c.req.param('id'));
    if (!result) throw ApiError.notFound('company for this person');
    return c.json(result);
  });

  /** Queue a fresh audit now, even if the last one is recent. */
  router.post('/:id/site-audit', async (c) => {
    const actor = c.get('actor');
    const result = await siteAuditForPerson(c.get('db'), c.req.param('id'));
    if (!result) throw ApiError.notFound('company for this person');
    if (!result.auditable) {
      throw ApiError.badRequest(`${result.company.domain ?? 'no domain'} is not a site to audit`);
    }
    const queued = await queueSiteAudit(c.get('db'), {
      workspaceId: actor.workspaceId,
      companyId: result.company.id,
      domain: result.company.domain,
      force: true,
    });
    return c.json({ queued: queued.queued, alreadyQueued: !queued.queued, ...result }, 202);
  });

  return router;
}

/** Mounted at `/api/v1/site-audits`. */
export function siteAuditRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();
  /** How far the audit of every lead's homepage has got. */
  router.get('/stats', async (c) => c.json(await siteAuditStats(c.get('db'))));
  return router;
}
