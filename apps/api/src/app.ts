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
  addProspectSchema,
  approveRecommendationSchema,
  createSuppressionSchema,
  executeActionSchema,
  loginSchema,
  privacyRequestSchema,
  registerSchema,
  snoozeRecommendationSchema,
  workspaceProfileSchema,
} from '@outreachgraph/contracts';
import { newId, type ActionKind, type Network } from '@outreachgraph/domain';
import { now, queryOne, type Client } from '@outreachgraph/db';
import {
  actorFromSession,
  clearedCookie,
  isEmailVerified,
  login,
  logout,
  mintVerificationToken,
  readCookie,
  registerUser,
  SESSION_COOKIE,
  sessionCookie,
  verifyEmailToken,
  workspacesForUser,
} from './auth';
import { evaluatePolicy, isExecutable, POLICY_VERSION } from '@outreachgraph/policy';
import { draftForRecommendation, draftProfile, type TextModel } from '@outreachgraph/ai';
import { batchStatus, enqueue, runPipeline } from '@outreachgraph/pipeline';
import { GitHubProvider, SiteProvider, normaliseUrl } from '@outreachgraph/providers';
import { ConsoleMailer, verificationEmail, type Mailer } from '@outreachgraph/email';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';
import { loadWorkspaceProfile, saveWorkspaceProfile } from './workspace-profile';

/** One paste, one reviewable unit of work. */
const MAX_BULK_URLS = 100;

export interface AppOptions {
  readonly db: Client;
  /**
   * Overrides authentication entirely. Tests use this; production leaves it
   * unset and gets session cookies plus the optional service token below.
   */
  readonly authenticate?: (request: Request) => Promise<RequestActor | undefined>;
  /**
   * Machine credential for internal callers (the worker, scripts). Humans
   * authenticate with a session; this is not a login.
   */
  readonly serviceToken?: string;
  /** Set false for plain-HTTP local development so the cookie still sets. */
  readonly secureCookies?: boolean;
  /**
   * Writes outreach drafts. Omit to run without a language model — every
   * other route works unchanged and drafting returns 503.
   */
  readonly model?: TextModel;
  /**
   * Supplies GitHub enrichment and activity when adding a prospect. Tests
   * inject a fake; production leaves it unset and gets the real client.
   */
  readonly github?: GitHubProvider;
  /** Reads the customer's own site during onboarding. Tests inject a fake. */
  readonly site?: SiteProvider;
  /**
   * Sends account email. Omit to log messages instead of sending them, which
   * is what local development and the test suite do.
   */
  readonly mailer?: Mailer;
  /** Public origin, used to build links that land in someone's inbox. */
  readonly appUrl?: string;
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

  const secure = options.secureCookies ?? true;

  /**
   * Resolves the caller: a session cookie for humans, or the service token for
   * internal machine callers. Injected `authenticate` wins, which is how tests
   * drive the app without minting sessions.
   */
  const resolveActor = async (request: Request): Promise<RequestActor | undefined> => {
    if (options.authenticate) return options.authenticate(request);

    const cookie = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (cookie) {
      const actor = await actorFromSession(options.db, cookie);
      if (actor) return actor;
    }

    // Machine path. Requires explicit scope headers because a service token
    // has no session and therefore no implied workspace.
    const header = request.headers.get('authorization');
    if (options.serviceToken && header?.startsWith('Bearer ')) {
      const presented = header.slice('Bearer '.length);
      // Length-independent comparison; both sides are fixed-length hex.
      if (timingSafeEqual(presented, options.serviceToken)) {
        const workspaceId = request.headers.get('x-workspace-id');
        const organizationId = request.headers.get('x-organization-id');
        if (workspaceId && organizationId) {
          return {
            userId: request.headers.get('x-user-id') ?? 'usr_service',
            workspaceId,
            organizationId,
            role: 'owner',
          };
        }
      }
    }

    return undefined;
  };

  /**
   * Mints a token and mails the link.
   *
   * A send failure never fails the request that triggered it: an account that
   * exists and can sign in, with a resend button one tap away, beats a 500
   * that loses the password the user just chose. The failure is audited so it
   * is visible rather than silent.
   */
  const sendVerification = async (userId: string, email: string): Promise<void> => {
    const minted = await mintVerificationToken(options.db, userId, email);
    const link = `${options.appUrl ?? 'http://localhost:8080'}/verify?token=${minted.token}`;

    try {
      await (options.mailer ?? new ConsoleMailer()).send(verificationEmail(email, link));
    } catch (error) {
      await repo.audit(options.db, {
        actorKind: 'system',
        eventType: 'email.send_failed',
        entityKind: 'user',
        entityId: userId,
        detail: { kind: 'verification', message: String(error) },
      });
    }
  };

  const api = new Hono<AppEnv>();

  // ------------------------------------------------------------------- auth
  // These sit before the auth guard, since they are how you get a session.
  const auth = new Hono<AppEnv>();

  auth.post('/register', async (c) => {
    const body = await parseBody(c.req.raw, registerSchema);
    const result = await registerUser(options.db, body);

    // Registering logs you straight in; a signup that then demands a login is
    // just a worse signup. Verification gates outbound actions, not access —
    // someone should be able to look around while the mail is in flight.
    const session = await login(options.db, body.email, body.password, c.req.header('user-agent'));
    await sendVerification(result.userId, body.email);

    c.header('set-cookie', sessionCookie(session.token, session.expiresAt, secure));
    return c.json({ userId: result.userId, workspaceId: result.workspaceId }, 201);
  });

  /**
   * Confirms an address from the emailed link.
   *
   * Unauthenticated on purpose: the link is often opened in a different
   * browser from the one that signed up, and requiring a session there would
   * strand people on a login screen holding a valid token.
   */
  auth.post('/verify', async (c) => {
    const body = safeJson(await c.req.raw.text());
    const result = await verifyEmailToken(options.db, String(body.token ?? ''));
    return c.json({ verified: true, email: result.email });
  });

  auth.post('/verify/resend', async (c) => {
    const actor = await resolveActor(c.req.raw);
    if (!actor) throw ApiError.unauthorized();

    const user = await queryOne<{ email: string; email_verified_at: string | null }>(
      options.db,
      'SELECT email, email_verified_at FROM users WHERE id = ?',
      [actor.userId],
    );
    if (!user) throw ApiError.unauthorized();
    if (user.email_verified_at) return c.json({ sent: false, reason: 'already_verified' });

    await sendVerification(actor.userId, user.email);
    return c.json({ sent: true });
  });

  auth.post('/login', async (c) => {
    const body = await parseBody(c.req.raw, loginSchema);
    const session = await login(options.db, body.email, body.password, c.req.header('user-agent'));

    c.header('set-cookie', sessionCookie(session.token, session.expiresAt, secure));
    return c.json({ userId: session.actor.userId, workspaceId: session.actor.workspaceId });
  });

  auth.post('/logout', async (c) => {
    const cookie = readCookie(c.req.header('cookie') ?? null, SESSION_COOKIE);
    if (cookie) await logout(options.db, cookie);

    c.header('set-cookie', clearedCookie(secure));
    return c.json({ ok: true });
  });

  auth.get('/me', async (c) => {
    const actor = await resolveActor(c.req.raw);
    if (!actor) throw ApiError.unauthorized();

    const user = await queryOne<{
      id: string;
      email: string;
      name: string | null;
      email_verified_at: string | null;
    }>(options.db, 'SELECT id, email, name, email_verified_at FROM users WHERE id = ?', [
      actor.userId,
    ]);

    return c.json({
      user: user ?? { id: actor.userId, email: null, name: null },
      emailVerified: Boolean(user?.email_verified_at),
      workspaceId: actor.workspaceId,
      organizationId: actor.organizationId,
      role: actor.role,
      workspaces: await workspacesForUser(options.db, actor.userId),
    });
  });

  api.route('/auth', auth);

  // Everything else under /api/v1 is authenticated and workspace-scoped.
  api.use('*', async (c, next) => {
    const actor = await resolveActor(c.req.raw);
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

  // ----------------------------------------------------------- prospects
  /**
   * Adds one prospect by GitHub handle and runs the full chain (PRD §8).
   *
   * Synchronous on purpose: a first-run user needs to see something appear,
   * and a background job that silently produces nothing is exactly the empty
   * app this replaces. The chain is a handful of GitHub calls, so it returns
   * in seconds. When that stops being true, this becomes a queued job and the
   * response becomes a job id — the route shape already allows it.
   */
  api.post('/prospects', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('adding prospects');

    const raw = safeJson(await c.req.raw.text());
    const parsed = addProspectSchema.safeParse({ handle: normalizeHandle(raw.handle) });
    if (!parsed.success) {
      throw ApiError.badRequest(
        'enter a GitHub username or profile URL',
        parsed.error.flatten().fieldErrors,
      );
    }

    const handle = parsed.data.handle;
    const campaignId = await ensureDefaultCampaign(db, actor.workspaceId);

    const result = await runPipeline(
      {
        db,
        workspaceId: actor.workspaceId,
        campaignId,
        providers: [],
        github: options.github ?? new GitHubProvider(),
        ...(options.model ? { model: options.model } : {}),
      },
      handle,
    );

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'prospect.added',
      entityKind: 'person',
      entityId: result.personId ?? handle,
      detail: { handle, stage: result.stage, stoppedBecause: result.stoppedBecause },
    });

    // A stopped chain is a real answer, not an error: "no GitHub profile for
    // that handle" is information the user needs, and 200 with a reason keeps
    // the client from treating a typo as a server fault.
    return c.json({
      added: result.stage !== 'stopped',
      personId: result.personId,
      stage: result.stage,
      identitiesLinked: result.identitiesLinked,
      signalsStored: result.signalsStored,
      recommendationId: result.recommendationId,
      ...(result.stoppedBecause ? { reason: result.stoppedBecause } : {}),
    });
  });

  // ---------------------------------------------------------- onboarding
  /**
   * Reads your own site and drafts your profile (PRD §7, §11).
   *
   * The mirror image of the crawler that reads a prospect's site: the page
   * belongs to the person signing up, and what comes back describes their
   * business rather than a lead — what they sell, who plausibly buys it, how
   * they write, and where those buyers are active.
   *
   * Nothing is saved here. The reply is a draft to correct, because it is a
   * model's reading of a marketing page and not a fact about someone's company.
   * `PUT` is what commits it.
   *
   * Verified email is required before the model runs. An unverified signup is
   * an unattributed one, and this is the first route where a stranger can spend
   * our tokens.
   */
  api.post('/onboarding/profile', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('setting up the workspace');
    await requireVerifiedEmail(db, actor, 'we read your site');

    if (!options.model) {
      throw new ApiError(
        503,
        'composer_unavailable',
        'no language model is configured; fill the profile in by hand for now',
      );
    }

    const raw = safeJson(await c.req.raw.text());
    if (typeof raw.url !== 'string' || !raw.url.trim()) {
      throw ApiError.badRequest('enter your website address', { url: ['required'] });
    }

    let target: URL;
    try {
      target = new URL(normaliseUrl(raw.url));
    } catch {
      throw ApiError.badRequest('that does not look like a web address', { url: ['invalid'] });
    }

    const page = await (options.site ?? new SiteProvider()).crawl(target.toString());
    if (page.outcome !== 'ok') {
      // The site's own answer, phrased for the person who owns it.
      const why =
        page.outcome === 'robots_denied'
          ? 'your robots.txt blocks us from reading it'
          : `we could not read it (${page.outcome})`;
      throw ApiError.badRequest(`we could not read ${target.hostname}: ${why}`, {
        url: [page.outcome],
      });
    }

    const result = await draftProfile(options.model, page.pageText ?? '', page.finalUrl);
    if (!result.ok || !result.draft) {
      throw new ApiError(502, 'profile_draft_failed', result.reason ?? 'could not draft a profile');
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'onboarding.profile_drafted',
      entityKind: 'workspace',
      entityId: actor.workspaceId,
      detail: { url: page.finalUrl },
    });

    return c.json({
      url: page.finalUrl,
      companyName: page.company.name,
      draft: result.draft,
    });
  });

  /**
   * Commits the profile the person confirmed.
   *
   * Takes the edited draft rather than re-reading the site: what is saved has
   * to be what they approved, and re-running the model here would quietly
   * replace their corrections with a fresh guess.
   */
  api.put('/onboarding/profile', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('setting up the workspace');

    const raw = safeJson(await c.req.raw.text());
    const parsed = workspaceProfileSchema.safeParse(raw);
    if (!parsed.success) {
      throw ApiError.badRequest('that profile is incomplete', parsed.error.flatten().fieldErrors);
    }

    const saved = await saveWorkspaceProfile(db, actor.workspaceId, parsed.data);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'onboarding.profile_saved',
      entityKind: 'offering',
      entityId: saved.offeringId,
      detail: { name: parsed.data.offering.name },
    });

    return c.json({ saved: true, ...saved });
  });

  /** What the workspace currently believes about itself. */
  api.get('/onboarding/profile', async (c) => {
    const actor = c.get('actor');
    const profile = await loadWorkspaceProfile(c.get('db'), actor.workspaceId);
    return c.json(profile);
  });

  // ------------------------------------------------------------ by url
  /**
   * Adds prospects from company URLs (PRD §8, URL-first intake).
   *
   * Accepts one URL or up to a hundred, and answers immediately with a batch
   * id. Nothing is fetched inside the request: a single URL fans out to a
   * crawl, an extraction, an identity resolution per person named and a draft
   * per recommendation, and doing that inline for a hundred URLs is not a slow
   * request but a request that never returns.
   *
   * A URL already queued is reported as a duplicate rather than rejected. The
   * same address appearing twice in one paste is a normal thing for a human to
   * do and must not fail the other ninety-nine.
   */
  api.post('/prospects/by-url', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('adding prospects');

    const raw = safeJson(await c.req.raw.text());
    const submitted = Array.isArray(raw.urls) ? raw.urls : [raw.url];

    const cleaned: string[] = [];
    const rejected: { url: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const entry of submitted) {
      if (typeof entry !== 'string' || !entry.trim()) continue;

      let parsed: URL;
      try {
        parsed = new URL(normaliseUrl(entry));
      } catch {
        rejected.push({ url: String(entry), reason: 'not a url' });
        continue;
      }

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        rejected.push({ url: entry, reason: 'unsupported scheme' });
        continue;
      }

      // `new URL` is far more permissive than a domain is: prefixing a scheme
      // onto free text such as "not a url at all" produces a URL object with a
      // one-word host, which would otherwise become a crawl job that can only
      // ever fail. Require something that looks like a registrable domain.
      if (
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(parsed.hostname)
      ) {
        rejected.push({ url: entry, reason: 'not a domain' });
        continue;
      }

      // Deduped by host, not by the full string: `example.com`,
      // `https://example.com/` and `https://www.example.com` are one company,
      // and crawling a homepage three times helps nobody.
      const key = parsed.hostname.replace(/^www\./, '').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      cleaned.push(parsed.toString());
    }

    if (cleaned.length === 0) {
      throw ApiError.badRequest('enter at least one company URL', { urls: ['none were usable'] });
    }

    if (cleaned.length > MAX_BULK_URLS) {
      throw ApiError.badRequest(`at most ${MAX_BULK_URLS} URLs at a time`, {
        urls: [`received ${cleaned.length}`],
      });
    }

    const batchId = newId('job');
    const queued: string[] = [];
    const duplicates: string[] = [];

    for (const url of cleaned) {
      const result = await enqueue(db, {
        workspaceId: actor.workspaceId,
        kind: 'crawl_site',
        payload: { url },
        batchId,
        // One outstanding crawl per host per workspace. Releases itself when
        // the job finishes, so the site can be re-crawled later.
        dedupeKey: `crawl:${new URL(url).hostname.replace(/^www\./, '')}`,
      });

      if (result.queued) queued.push(url);
      else duplicates.push(url);
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'prospects.bulk_queued',
      entityKind: 'job',
      entityId: batchId,
      detail: { queued: queued.length, duplicates: duplicates.length, rejected: rejected.length },
    });

    return c.json(
      {
        batchId,
        queued: queued.length,
        urls: queued,
        ...(duplicates.length ? { duplicates } : {}),
        ...(rejected.length ? { rejected } : {}),
      },
      202,
    );
  });

  /**
   * Progress for one bulk submission.
   *
   * Reports the individual rows, not just counts: after a hundred URLs the
   * useful question is which ones failed and why, and that answer is on the row.
   */
  api.get('/batches/:id', async (c) => {
    const actor = c.get('actor');
    const status = await batchStatus(c.get('db'), actor.workspaceId, c.req.param('id'));

    if (!status) throw ApiError.notFound('batch');
    return c.json(status);
  });

  // -------------------------------------------------------------- people
  /**
   * The prospect list, ranked the way the UI ranks everything else — by
   * opportunity, so the top of the list is the top of the queue.
   */
  api.get('/people', async (c) => {
    const actor = c.get('actor');
    const limit = clampLimit(c.req.query('limit'));

    const rows = await c.get('db').execute({
      sql: `SELECT p.id, p.display_name, p.current_title, p.identity_confidence, p.status,
                   co.name AS current_company,
                   cp.status AS prospect_status, cp.interaction_state,
                   s.opportunity, s.icp_fit, s.intent, s.reachability,
                   (SELECT COUNT(*) FROM signals g
                     WHERE g.person_id = p.id AND g.workspace_id = cp.workspace_id)
                     AS signal_count
              FROM campaign_people cp
              JOIN people p ON p.id = cp.person_id
              LEFT JOIN companies co ON co.id = p.current_company_id
              LEFT JOIN scores s
                     ON s.person_id = cp.person_id AND s.campaign_id = cp.campaign_id
             WHERE cp.workspace_id = ? AND p.status != 'deleted'
          ORDER BY COALESCE(s.opportunity, -1) DESC, p.display_name ASC
             LIMIT ?`,
      args: [actor.workspaceId, limit],
    });

    return c.json({ people: rows.rows });
  });

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
    await requireVerifiedEmail(db, actor);

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

  /**
   * Compose (or recompose) the message for a recommendation.
   *
   * Separate from generation because a draft is optional: the pipeline places
   * the card in the queue whether or not the composer produced anything, and
   * the reviewer can ask for one here. A refusal to write is a normal answer,
   * returned with the reason and the specific fragments that failed grounding
   * — the alternative is showing an invented message, which is worse.
   */
  api.post('/recommendations/:id/draft', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!options.model) {
      throw new ApiError(
        503,
        'composer_unavailable',
        'no language model is configured; set ANTHROPIC_API_KEY to enable drafting',
      );
    }

    const recommendation = await repo.getRecommendation(db, actor.workspaceId, c.req.param('id'));
    if (!recommendation) throw ApiError.notFound('recommendation');

    // Recomposing replaces the previous draft; the writer asked for a rewrite.
    await db.execute({
      sql: 'DELETE FROM drafts WHERE recommendation_id = ? AND edited_by_user = 0',
      args: [recommendation.id],
    });

    const result = await draftForRecommendation(db, options.model, recommendation.id);

    if (!result.ok) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'draft.withheld',
        entityKind: 'recommendation',
        entityId: recommendation.id,
        detail: { reason: result.reason, unsupported: result.unsupported ?? [] },
      });

      return c.json(
        {
          drafted: false,
          reason: result.reason,
          ...(result.unsupported ? { unsupported: result.unsupported } : {}),
        },
        200,
      );
    }

    const draft = await queryOne<{ body: string }>(db, 'SELECT body FROM drafts WHERE id = ?', [
      result.draftId!,
    ]);

    return c.json({ drafted: true, draftId: result.draftId, body: draft?.body });
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

    await requireVerifiedEmail(db, actor);

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

/**
 * Refuses outbound work from an unconfirmed address.
 *
 * The gate is on sending, not on signing in: someone should be able to add
 * prospects and read evidence while the mail is in flight. It sits here
 * rather than in the policy engine deliberately — the engine decides what a
 * network permits, and account state is not a policy question.
 *
 * A service token has no user, so this cannot apply to it; machine callers
 * are authorised by holding the token.
 */
async function requireVerifiedEmail(
  db: Client,
  actor: RequestActor,
  action = 'sending anything',
): Promise<void> {
  if (actor.userId === 'usr_service') return;
  if (await isEmailVerified(db, actor.userId)) return;

  throw new ApiError(403, 'email_unverified', `confirm your email address before ${action}`);
}

/**
 * Accepts what people actually paste.
 *
 * A profile URL, an `@handle` and a bare username all mean the same thing to
 * the person typing, so all three are normalised to the handle rather than
 * rejected as invalid input.
 */
function normalizeHandle(value: unknown): string {
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/?#]+)/i);
  return (url?.[1] ?? trimmed).replace(/^@/, '').replace(/\/+$/, '');
}

/**
 * Returns the workspace's campaign, provisioning one if it has none.
 *
 * Registration now creates an offering and campaign up front, but accounts
 * made before that have neither, and an existing user hitting "add prospect"
 * must not get an error telling them to create something the UI does not yet
 * expose. Backfilling here keeps the failure mode out of the product.
 */
async function ensureDefaultCampaign(db: Client, workspaceId: string): Promise<string> {
  const existing = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM campaigns WHERE workspace_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
    [workspaceId],
  );
  if (existing) return existing.id;

  const stamp = now();
  const offering = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM offerings WHERE workspace_id = ? ORDER BY created_at ASC LIMIT 1',
    [workspaceId],
  );

  let offeringId = offering?.id;
  if (!offeringId) {
    offeringId = newId('offering');
    await db.execute({
      sql: `INSERT INTO offerings (id, workspace_id, name, category, description, created_at, updated_at)
            VALUES (?, ?, 'Your offering', 'unspecified', ?, ?, ?)`,
      args: [
        offeringId,
        workspaceId,
        'Describe what you sell here. Every draft is grounded in this text.',
        stamp,
        stamp,
      ],
    });
  }

  const campaignId = newId('campaign');
  await db.execute({
    sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, approval_mode, status,
                                 created_at, updated_at, started_at)
          VALUES (?, ?, 'First campaign', ?, 'draft_and_approve', 'active', ?, ?, ?)`,
    args: [campaignId, workspaceId, offeringId, stamp, stamp, stamp],
  });

  return campaignId;
}

/**
 * Constant-time string comparison, so a service token cannot be recovered by
 * timing how long a rejection takes.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

export { POLICY_VERSION };
