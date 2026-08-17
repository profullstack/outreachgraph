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
  connectEmailAccountSchema,
  createSuppressionSchema,
  decideEmailCandidateSchema,
  executeActionSchema,
  backfillDraftsSchema,
  recordReplySchema,
  loginSchema,
  privacyRequestSchema,
  registerSchema,
  snoozeRecommendationSchema,
  workspaceProfileSchema,
} from '@outreachgraph/contracts';
import {
  channelForNetwork,
  isNetwork,
  newId,
  OUTBOUND_ACTION_KINDS,
  type ActionKind,
  type Network,
} from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
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
import {
  evaluateAddressLimits,
  evaluatePolicy,
  isExecutable,
  POLICY_VERSION,
} from '@outreachgraph/policy';
import {
  campaignFunnel,
  campaignTerms,
  connectEmailAccount,
  deliverEmailAction,
  disconnectEmailAccount,
  emailAccountSummary,
  leadTimeline,
  loadListeningTargets,
  loadNotifySettings,
  mailerForWorkspace,
  normaliseTargets,
  notifyAddress,
  saveListeningTargets,
  workspaceAnalytics,
  EmailAccountError,
  LISTEN_SOURCE_SLUGS,
} from '@outreachgraph/pipeline';
import {
  archiveCampaign,
  createCampaignFromIntake,
  IntakeError,
  listCampaigns,
  renameCampaign,
  saveWorkspaceSettings,
  setCampaignAutopilot,
  setCampaignStatus,
} from './campaigns';
import { confirmShare, recordShare, shareLinksFor, SocialError } from './social';
import {
  candidatesForPerson,
  confirmCandidate,
  proposeAddresses,
  readEvents,
  rejectCandidate,
  workflowStatus,
} from '@outreachgraph/pipeline';
import { SHARE_TARGETS, type ShareNetwork } from '@outreachgraph/domain';
import { draftForRecommendation, draftProfile, type TextModel } from '@outreachgraph/ai';
import { batchStatus, enqueue, runPipeline } from '@outreachgraph/pipeline';
import {
  GitHubProvider,
  SiteProvider,
  normaliseUrl,
  suggestSubreddits,
  FeedRateLimitError,
} from '@outreachgraph/providers';
import { ConsoleMailer, SMTP_PRESETS, verificationEmail, type Mailer } from '@outreachgraph/email';
import { ApiError, canApprove, type AppEnv, type RequestActor } from './context';
import * as repo from './repository';
import {
  listProducts,
  loadWorkspaceProfile,
  saveWorkspaceProfile,
  UnknownProductError,
} from './workspace-profile';

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
  /**
   * Unlocks credentials a workspace has stored for its own mailbox. Without
   * it, connecting one is refused rather than stored in the clear, and any
   * already-stored mailbox reads as disconnected.
   */
  readonly encryptionKey?: Buffer | undefined;
  /**
   * Suggests the communities a campaign should listen to.
   *
   * Injected so the suggestion route is testable without reaching Reddit, and
   * so a deployment with its own registered OAuth app can pass a token.
   */
  readonly suggestSubreddits?: typeof suggestSubreddits;
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
    return c.json({ campaigns: await listCampaigns(c.get('db'), actor.workspaceId) });
  });

  api.get('/campaigns/:id', async (c) => {
    const actor = c.get('actor');
    const campaign = await repo.getCampaign(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!campaign) throw ApiError.notFound('campaign');
    return c.json({ campaign });
  });

  /**
   * The front door (PRD §8).
   *
   * One box, two paths. A company website is crawled directly; a description
   * of a market goes to discovery, which names real companies and queues a
   * crawl for each. The caller gets a campaign id straight back and watches it
   * fill, because neither path can finish inside a request.
   */
  api.post('/campaigns', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('starting a campaign');
    await requireVerifiedEmail(db, actor);

    const body = safeJson(await c.req.raw.text());
    const input = typeof body.input === 'string' ? body.input : '';

    let result;
    try {
      result = await createCampaignFromIntake(db, actor, input, {
        autopilot: body.autopilot === true,
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
      });
    } catch (error) {
      if (error instanceof IntakeError) {
        throw ApiError.badRequest(error.message, { input: [error.message] });
      }
      throw error;
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'campaign.created',
      entityKind: 'campaign',
      entityId: result.campaignId,
      detail: { kind: result.kind, seed: result.seed, autopilot: result.autopilot },
    });

    return c.json(result, 202);
  });

  /**
   * Changes one campaign: autopilot, run state, or name.
   *
   * All three in one route because they are all "edit this campaign" and the
   * client sends whichever fields it changed. Each is applied only when
   * present, so a form that posts just a name cannot silently switch autopilot
   * off by omitting it.
   */
  api.patch('/campaigns/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.param('id');

    if (!canApprove(actor)) throw ApiError.forbidden('changing a campaign');

    const body = safeJson(await c.req.raw.text());
    const changed: Record<string, unknown> = {};
    let touched = false;

    if (typeof body.autopilot === 'boolean') {
      // Turning it *on* spends money without asking again, so it carries the
      // same verification gate as starting a campaign.
      if (body.autopilot) await requireVerifiedEmail(db, actor);

      if (!(await setCampaignAutopilot(db, actor.workspaceId, campaignId, body.autopilot))) {
        throw ApiError.notFound('campaign');
      }

      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: body.autopilot ? 'campaign.autopilot_enabled' : 'campaign.autopilot_disabled',
        entityKind: 'campaign',
        entityId: campaignId,
        detail: {},
      });

      changed.autopilot = body.autopilot;
      touched = true;
    }

    if (typeof body.name === 'string') {
      if (!(await renameCampaign(db, actor.workspaceId, campaignId, body.name))) {
        throw ApiError.notFound('campaign');
      }
      changed.name = body.name.trim();
      touched = true;
    }

    if (body.status === 'active' || body.status === 'paused') {
      if (!(await setCampaignStatus(db, actor.workspaceId, campaignId, body.status))) {
        throw ApiError.notFound('campaign');
      }
      changed.status = body.status;
      touched = true;
    } else if (body.status === 'archived') {
      if (!(await archiveCampaign(db, actor.workspaceId, campaignId))) {
        throw ApiError.notFound('campaign');
      }
      changed.status = 'archived';
      touched = true;
    }

    if (!touched) {
      throw ApiError.badRequest('send at least one of autopilot, name or status');
    }

    return c.json({ campaignId, ...changed });
  });

  // --------------------------------------------------------------- listening
  //
  // Where a campaign listens, kept beside the keywords it listens for. This is
  // per campaign and not per deployment on purpose: a workspace selling to
  // plumbers and one selling to clinics share a container and share nothing
  // else, and a single set of subreddits could only ever suit one of them.

  api.get('/campaigns/:id/listening', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.param('id');

    if (!(await campaignInWorkspace(db, actor.workspaceId, campaignId))) {
      throw ApiError.notFound('campaign');
    }

    const targets = await loadListeningTargets(db, actor.workspaceId, campaignId);

    return c.json({
      campaignId,
      ...targets,
      available: LISTEN_SOURCE_SLUGS,
      // What it would search for if switched on, so the screen can say so
      // before anyone commits to a set of communities.
      terms: await campaignTerms(db, actor.workspaceId, campaignId),
    });
  });

  api.put('/campaigns/:id/listening', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.param('id');

    if (!canApprove(actor)) throw ApiError.forbidden('changing where a campaign listens');

    const body = safeJson(await c.req.raw.text());
    const { targets, unknown } = normaliseTargets({
      sources: stringList(body.sources),
      subreddits: stringList(body.subreddits),
      feeds: stringList(body.feeds),
    });

    // A typo would otherwise be dropped in silence, leaving the screen showing
    // listening as on while nothing polls.
    if (unknown.length > 0) {
      throw ApiError.badRequest(
        `unknown listening source: ${unknown.join(', ')}. Available: ${LISTEN_SOURCE_SLUGS.join(', ')}`,
      );
    }

    if (targets.sources.includes('rss') && targets.feeds.length === 0) {
      throw ApiError.badRequest(
        'rss needs at least one feed URL — a feed has no search of its own',
      );
    }

    if (!(await saveListeningTargets(db, actor.workspaceId, campaignId, targets))) {
      throw ApiError.notFound('campaign');
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'campaign.listening_changed',
      entityKind: 'campaign',
      entityId: campaignId,
      detail: { ...targets },
    });

    return c.json({ campaignId, ...targets });
  });

  /**
   * Communities worth listening to, found from the campaign's own keywords.
   *
   * Scoping Reddit is the difference between buyers and noise, and it asks the
   * operator to name subreddits they have usually never heard of. Reddit
   * indexes its own communities, so the product can answer that instead of
   * handing the research back.
   */
  api.get('/campaigns/:id/listening/suggestions', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.param('id');

    if (!(await campaignInWorkspace(db, actor.workspaceId, campaignId))) {
      throw ApiError.notFound('campaign');
    }

    const terms = await campaignTerms(db, actor.workspaceId, campaignId);
    if (terms.length === 0) return c.json({ campaignId, terms, suggestions: [] });

    const suggest = options.suggestSubreddits ?? suggestSubreddits;

    try {
      return c.json({ campaignId, terms, suggestions: await suggest(terms) });
    } catch (error) {
      if (error instanceof FeedRateLimitError) {
        throw new ApiError(
          503,
          'suggestions_unavailable',
          'Reddit is rate limiting suggestions — try again shortly, or add subreddits by hand',
        );
      }
      throw error;
    }
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
      // Keyed by full path, not by `flatten().fieldErrors` — that reports the
      // top-level object ("offering"), which tells someone staring at a form
      // nothing about which line of which list it objected to.
      const details: Record<string, string[]> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || 'profile';
        (details[key] ??= []).push(issue.message);
      }
      throw ApiError.badRequest('that profile is incomplete', details);
    }

    // `?new=1` adds a product instead of editing one. Without it, saving a
    // second product lands on the first row and quietly replaces the product
    // the workspace already sells.
    const create = c.req.query('new') === '1';

    let saved;
    try {
      saved = await saveWorkspaceProfile(db, actor.workspaceId, parsed.data, { create });
    } catch (error) {
      if (error instanceof UnknownProductError) throw ApiError.notFound('product');
      throw error;
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: create ? 'onboarding.product_added' : 'onboarding.profile_saved',
      entityKind: 'offering',
      entityId: saved.offeringId,
      detail: { name: parsed.data.offering.name },
    });

    return c.json({ saved: true, ...saved });
  });

  /**
   * What the workspace believes about one of its products.
   *
   * `?offeringId=` picks which. Absent, it is the first — the answer every
   * caller got back when a workspace could only describe one thing.
   */
  api.get('/onboarding/profile', async (c) => {
    const actor = c.get('actor');
    const offeringId = c.req.query('offeringId');
    const profile = await loadWorkspaceProfile(
      c.get('db'),
      actor.workspaceId,
      offeringId || undefined,
    );
    return c.json(profile);
  });

  /** Everything the workspace sells. */
  api.get('/products', async (c) => {
    const actor = c.get('actor');
    const products = await listProducts(c.get('db'), actor.workspaceId);
    return c.json({ products });
  });

  /**
   * Stops selling a product without deleting what it did.
   *
   * Archiving rather than deleting: an offering is referenced by campaigns,
   * which are referenced by recommendations, actions and interactions — the
   * record of every message already sent. Removing the row to tidy a settings
   * page would take that history with it. Archived campaigns are skipped by
   * the pipeline and by autopilot, which is the behaviour actually wanted.
   */
  api.delete('/products/:id', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('archiving a product');

    const owned = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM offerings WHERE id = ? AND workspace_id = ?',
      [c.req.param('id'), actor.workspaceId],
    );
    if (!owned) throw ApiError.notFound('product');

    const result = await db.execute({
      sql: `UPDATE campaigns SET status = 'archived', updated_at = ?
             WHERE workspace_id = ? AND offering_id = ? AND status != 'archived'`,
      args: [now(), actor.workspaceId, owned.id],
    });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'onboarding.product_archived',
      entityKind: 'offering',
      entityId: owned.id,
      detail: { campaigns: Number(result.rowsAffected ?? 0) },
    });

    return c.json({ archived: true, offeringId: owned.id });
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

    const [identities, companyIdentities, signals, provenance, emailCandidates] = await Promise.all(
      [
        repo.listIdentities(db, personId),
        repo.listCompanyIdentities(db, personId),
        repo.listPersonSignals(db, actor.workspaceId, personId),
        repo.listProvenance(db, personId),
        // Served here rather than behind its own fetch: deciding on an address
        // is a judgement about this person, made with their evidence on screen.
        candidatesForPerson(db, actor.workspaceId, personId),
      ],
    );

    return c.json({
      person,
      identities,
      companyIdentities,
      signals,
      provenance,
      emailCandidates,
    });
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
   * Records that this person replied, which takes them out of cold outreach.
   *
   * The product sends over SMTP and reads no mailbox, so it cannot notice a
   * reply by itself. Until inbound polling exists, this route is how a reply
   * becomes something the policy engine can act on: `conversation_open` then
   * refuses further outreach, and a follow-up has to be an explicit human
   * decision rather than the queue's next tick.
   *
   * Idempotent by intent rather than by constraint — recording a second reply
   * is a real event, and the gate only asks whether any exist.
   */
  api.post('/people/:id/replied', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');
    const body = await parseBody(c.req.raw, recordReplySchema);

    const person = await repo.getPerson(db, personId);
    if (!person) throw ApiError.notFound('person');

    const contact = await repo.resolveContactAddress(db, personId);
    const at = body.occurredAt ?? now();
    const address = body.fromAddress?.trim().toLowerCase() ?? contact?.address ?? null;

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction,
            state, body, contact_address, shared_inbox, occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?, ?, ?, ?)`,
      args: [
        newId('interaction'),
        actor.workspaceId,
        personId,
        body.body ?? null,
        address,
        contact?.shared ? 1 : 0,
        at,
        now(),
      ],
    });

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'interaction.reply_recorded',
      entityKind: 'person',
      entityId: personId,
      detail: { address },
    });

    return c.json({ recorded: true, personId, conversationOpen: true });
  });

  // ------------------------------------------------- reaching people at all
  /**
   * Candidate personal addresses for one prospect.
   *
   * Every prospect in production resolves to their company's shared inbox
   * because none of them has a personal address, which is why the address
   * limits refuse almost everything. These are proposals for a human to decide
   * on — nothing here is reachable until one is confirmed.
   */
  api.get('/people/:id/email-candidates', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');

    const person = await repo.getPerson(db, personId);
    if (!person) throw ApiError.notFound('person');

    return c.json({
      personId,
      candidates: await candidatesForPerson(db, actor.workspaceId, personId),
    });
  });

  /**
   * Accepts an address, which is the only path from a proposal to a send.
   *
   * Writes the `social_identities` row the sender reads, so the prospect stops
   * resolving to a shared inbox — and, because the address is now personal,
   * stops being rate-limited alongside every colleague behind that mailbox.
   */
  api.post('/people/:id/email-candidates/confirm', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');

    if (!canApprove(actor)) throw ApiError.forbidden('this role cannot confirm an address');

    const body = await parseBody(c.req.raw, decideEmailCandidateSchema);
    const person = await repo.getPerson(db, personId);
    if (!person) throw ApiError.notFound('person');

    const result = await confirmCandidate(db, {
      workspaceId: actor.workspaceId,
      personId,
      address: body.address,
      actorId: actor.userId,
    });

    if (!result.confirmed) throw ApiError.badRequest('that address could not be confirmed');

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'person.address_confirmed',
      entityKind: 'person',
      entityId: personId,
      detail: { address: body.address.trim().toLowerCase() },
    });

    return c.json({ confirmed: true, personId, address: body.address.trim().toLowerCase() });
  });

  /** Records that a proposed address is wrong, so it is not offered again. */
  api.post('/people/:id/email-candidates/reject', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const personId = c.req.param('id');

    if (!canApprove(actor)) throw ApiError.forbidden('this role cannot reject an address');

    const body = await parseBody(c.req.raw, decideEmailCandidateSchema);

    const rejected = await rejectCandidate(db, {
      workspaceId: actor.workspaceId,
      personId,
      address: body.address,
      actorId: actor.userId,
    });

    return c.json({ rejected, personId });
  });

  /**
   * Proposes addresses across the workspace.
   *
   * Safe to re-run, and meant to be: each pass applies whatever has been
   * learned from confirmations since the last one, so a company's colleagues
   * sharpen from guesses into derivations as the operator works through them.
   */
  api.post('/enrichment/propose', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('this role cannot run enrichment');

    const result = await proposeAddresses(db, actor.workspaceId);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'enrichment.proposed',
      entityKind: 'workspace',
      entityId: actor.workspaceId,
      detail: { ...result },
    });

    return c.json(result);
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
    const db = c.get('db');
    const limit = clampLimit(c.req.query('limit'));

    // An unknown filter falls back to `all` rather than erroring: a stale
    // bookmark should show the queue, not a 400.
    const requested = c.req.query('filter');
    const filter = repo.isApprovalFilter(requested) ? requested : 'all';

    // The channel narrows the same set on a second axis. It is applied here
    // rather than in SQL because the network is already on every row, so the
    // page can switch channels without another round trip — the counts are
    // what has to come from the database, not the classification.
    const requestedChannel = c.req.query('channel');
    const channel = repo.isChannelFilter(requestedChannel) ? requestedChannel : 'all';

    const [rows, counts, usage, budgets] = await Promise.all([
      repo.listPendingRecommendations(db, actor.workspaceId, limit, filter),
      repo.approvalCounts(db, actor.workspaceId),
      repo.pendingAddressUsage(db, actor.workspaceId),
      repo.campaignBudgets(db, actor.workspaceId),
    ]);

    const holds = addressHolds(usage, budgets);

    const decorated = rows.map((row) => {
      const entry = holds.get(String((row as { id?: unknown }).id));
      return entry ? { ...row, hold: entry.hold } : row;
    });

    const recommendations =
      channel === 'all'
        ? decorated
        : decorated.filter((row) => {
            const network = (row as { network?: unknown }).network;
            return isNetwork(network) && channelForNetwork(network) === channel;
          });

    // `ready` counted drafts and nothing else, so a queue where every card was
    // behind a shared inbox on cooldown reported twenty-eight ready and
    // approved none of them. The tab now says how many of those are actually
    // approvable right now, and the held ones say why on the card.
    const held = [...holds.values()].filter((entry) => entry.hasDraft).length;

    return c.json({
      recommendations,
      counts: { ...counts, held, approvable: Math.max(0, counts.buckets.ready - held) },
      filter,
      channel,
    });
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

    const decision = await recheckPolicy(db, actor, recommendation, options.mailer !== undefined);

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

    // Approving an email is the instruction to send it.
    //
    // Splitting approval from delivery is what left the product telling people
    // to go and paste the message into their own mail client. There is nothing
    // for a reviewer to do between the two steps: they have already read the
    // evidence, read the words and said yes. So the send happens here, inline,
    // and its outcome is part of the same answer — a failure the reviewer can
    // see beats an approved action sitting in a queue nobody is watching.
    const delivery =
      mode === 'customer_managed' && recommendation.network === 'email'
        ? await sendEmailAction(db, options, actor, actionId, decision.policyVersion)
        : undefined;

    // Approving research is the instruction to go and research.
    //
    // Until now it was not. `refresh_research` had no executor anywhere — the
    // job runner knows four kinds and this was not one of them — so approving
    // one of these cards wrote an approval row, an action row and an audit row
    // and then stopped. Nothing re-read the site, so the card that existed
    // *because* we had nothing to say produced nothing to say, and the next
    // tick proposed the same card again. Production held 73 of them.
    //
    // Re-crawling the company's own site is the whole of "research" for a
    // prospect found by crawling: it is where a name gains a job title, where
    // a shared inbox is published, and now where the social profiles come
    // from. `crawl_site` already does all of that and dedupes people, so this
    // queues the existing job rather than inventing a second path.
    let research: { queued: boolean; url?: string; reason?: string } | undefined;

    if (recommendation.action === 'refresh_research') {
      const site = await queryOne<{ domain: string }>(
        db,
        `SELECT co.domain
           FROM people p
           JOIN companies co ON co.id = p.current_company_id
          WHERE p.id = ? AND co.domain IS NOT NULL AND trim(co.domain) <> ''`,
        [recommendation.person_id],
      );

      // No domain is a real answer, not a failure: a person with no company on
      // file has no site to re-read, and saying so beats a job that cannot run.
      if (site?.domain) {
        const target = normaliseUrl(site.domain);
        const queued = await enqueue(db, {
          workspaceId: actor.workspaceId,
          kind: 'crawl_site',
          payload: {
            url: target,
            ...(recommendation.campaign_id ? { campaignId: recommendation.campaign_id } : {}),
          },
        });
        research = { queued: queued.queued, url: target };
      } else {
        research = { queued: false, reason: 'no company domain on file' };
      }
    }

    return c.json({
      approved: true,
      approvalId,
      actionId,
      policy: { decision: decision.decision, policyVersion: decision.policyVersion },
      ...(delivery ? { delivery } : {}),
      ...(research ? { research } : {}),
    });
  });

  /**
   * Writes the missing drafts for a queue that has gone unreviewed.
   *
   * Drafting has only ever happened one card at a time, on request, so a queue
   * that filled faster than anyone clicked ends up as a wall of cards with
   * nothing written on them — which is what the approvals page had become: 74
   * pending recommendations, zero drafts.
   *
   * Bounded rather than exhaustive, and sequential rather than parallel. Each
   * card is a model call, so an unbounded version of this route is an
   * unbounded invoice; `limit` is what the caller is willing to spend and the
   * response says exactly what was written, refused and skipped.
   */
  api.post('/recommendations/drafts/backfill', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, backfillDraftsSchema);

    if (!options.model) {
      throw new ApiError(
        503,
        'composer_unavailable',
        'no language model is configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to enable drafting',
      );
    }

    // Only actions that put a message in front of a human. Most of a real
    // queue is `refresh_research` and friends, which have no message by
    // definition — production had 75 of those against 2 genuinely undrafted
    // emails, so an unfiltered version of this route would have spent 75 model
    // calls to write nothing and reported them all as refusals.
    const outbound = OUTBOUND_ACTION_KINDS.map(() => '?').join(', ');

    const pending = await queryAll<{ id: string }>(
      db,
      `SELECT r.id FROM recommendations r
        WHERE r.workspace_id = ? AND r.status IN ('pending', 'approved')
          AND r.action IN (${outbound})
          AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.recommendation_id = r.id)
     ORDER BY r.created_at ASC
        LIMIT ?`,
      [actor.workspaceId, ...OUTBOUND_ACTION_KINDS, body.limit],
    );

    const written: string[] = [];
    const withheld: { id: string; reason: string }[] = [];

    for (const row of pending) {
      // One failure is not the batch's failure. A model that refuses this card
      // will happily write the next, and stopping here would leave the queue
      // as empty as it was found.
      try {
        const result = await draftForRecommendation(db, options.model, row.id);
        if (result.ok) written.push(row.id);
        else withheld.push({ id: row.id, reason: result.reason ?? 'withheld' });
      } catch (error) {
        withheld.push({ id: row.id, reason: error instanceof Error ? error.message : 'failed' });
      }
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'drafts.backfilled',
      entityKind: 'workspace',
      entityId: actor.workspaceId,
      detail: { considered: pending.length, written: written.length, withheld: withheld.length },
    });

    return c.json({
      considered: pending.length,
      written: written.length,
      withheld,
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
        'no language model is configured; set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to enable drafting',
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

  /**
   * Sends an approved action, or records that a human already did (PRD §27).
   *
   * Both meanings live here because both are real. An email goes out from the
   * workspace's mailbox; a LinkedIn message cannot and never will, so for that
   * the route records what the user did by hand. Which one happens is decided
   * by the channel and the requested mode, not by the caller's optimism.
   */
  api.post('/actions/:id/execute', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const body = await parseBody(c.req.raw, executeActionSchema);

    await requireVerifiedEmail(db, actor);

    const action = await repo.getAction(db, actor.workspaceId, c.req.param('id'));
    if (!action) throw ApiError.notFound('action');
    if (action.status === 'completed') throw ApiError.badRequest('action is already completed');

    // An email the product is meant to send, rather than one already sent
    // elsewhere. `deliverEmailAction` does all the bookkeeping the manual path
    // does below, plus the send itself.
    if (action.network === 'email' && body.mode === 'customer_managed') {
      const recommendation = await repo.getRecommendation(
        db,
        actor.workspaceId,
        action.recommendation_id,
      );
      if (!recommendation) throw ApiError.notFound('recommendation');

      const decision = await recheckPolicy(
        db,
        actor,
        recommendation,
        options.mailer !== undefined,
        action.id,
      );

      // Re-checked here as well as at approval: a suppression added in between
      // must stop the send, and this is the last moment it can.
      if (!isExecutable(decision.decision, true)) {
        throw ApiError.policyDenied(decision.reason, {
          decision: decision.decision,
          gate: decision.gate,
          policyVersion: decision.policyVersion,
        });
      }

      const delivery = await sendEmailAction(db, options, actor, action.id, decision.policyVersion);

      if (!delivery.sent) {
        return c.json({ executed: false, actionId: action.id, reason: delivery.reason }, 502);
      }

      return c.json({ executed: true, actionId: action.id, sent: true, to: delivery.to });
    }

    const stamp = now();

    // A message a human sent by hand still landed in someone's mailbox, so it
    // is recorded against the same address the automated path would have used.
    // Leaving it null here would let the queue offer that inbox again tomorrow
    // on the grounds that the product had never written to it.
    const manualContact =
      action.network === 'email'
        ? await repo.resolveContactAddress(db, action.person_id)
        : undefined;

    await db.batch([
      {
        sql: `UPDATE actions SET status = 'completed', mode = ?, external_url = ?, executed_at = ?
               WHERE id = ?`,
        args: [body.mode, body.externalUrl ?? null, stamp, action.id],
      },
      {
        sql: `INSERT INTO interactions (id, workspace_id, person_id, action_id, network, direction,
              state, contact_address, shared_inbox, occurred_at, recorded_at)
              VALUES (?, ?, ?, ?, ?, 'outbound', 'contacted', ?, ?, ?, ?)`,
        args: [
          newId('interaction'),
          actor.workspaceId,
          action.person_id,
          action.id,
          action.network,
          manualContact?.address ?? null,
          manualContact?.shared ? 1 : 0,
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

  // ------------------------------------------------------------- analytics
  /**
   * The funnel, plus the headline numbers above it (PRD §25).
   *
   * Stage counts come from the event log rather than the current-status
   * column, which is the only way "how many ever reached Contacted" is
   * answerable at all — see `lead_stage_events`.
   */
  api.get('/analytics', async (c) => {
    const actor = c.get('actor');
    const campaignId = c.req.query('campaignId');

    const [analytics, funnel] = await Promise.all([
      workspaceAnalytics(c.get('db'), actor.workspaceId),
      campaignId
        ? campaignFunnel(c.get('db'), { workspaceId: actor.workspaceId, campaignId })
        : undefined,
    ]);

    // A campaign-scoped request still gets the workspace headline numbers, so
    // the page has one request rather than two.
    return c.json({ ...analytics, ...(funnel ? { funnel } : {}) });
  });

  /** One row per lead, each a sequence of dated stage segments. */
  api.get('/analytics/timeline', async (c) => {
    const actor = c.get('actor');
    const campaignId = c.req.query('campaignId');

    const leads = await leadTimeline(c.get('db'), {
      workspaceId: actor.workspaceId,
      ...(campaignId ? { campaignId } : {}),
      limit: clampLimit(c.req.query('limit')),
    });

    return c.json({ leads });
  });

  // -------------------------------------------------------------- settings
  api.get('/settings', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const settings = await loadNotifySettings(db, actor.workspaceId);
    const address = await notifyAddress(db, actor.workspaceId, settings);

    const cap = await queryOne<{ autopilot_daily_cap: number; reply_to_email: string | null }>(
      db,
      `SELECT autopilot_daily_cap, reply_to_email FROM workspace_settings WHERE workspace_id = ?`,
      [actor.workspaceId],
    );

    return c.json({
      notifyEmail: settings.notify_email,
      // What mail would actually go to right now, resolved through the owner
      // fallback. Without this the settings page can only show an empty box
      // and leave the user unsure whether anything is configured at all.
      effectiveNotifyEmail: address ?? null,
      instantAlerts: settings.instant_alerts === 1,
      dailyDigest: settings.daily_digest === 1,
      digestHourUtc: settings.digest_hour_utc,
      alertMinOpportunity: settings.alert_min_opportunity,
      autopilotDailyCap: cap?.autopilot_daily_cap ?? 25,
      replyToEmail: cap?.reply_to_email ?? null,
      lastDigestSentOn: settings.last_digest_sent_on,
    });
  });

  api.put('/settings', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('changing workspace settings');

    const body = safeJson(await c.req.raw.text());

    await saveWorkspaceSettings(db, actor.workspaceId, {
      ...(body.notifyEmail === undefined
        ? {}
        : { notifyEmail: body.notifyEmail === null ? null : String(body.notifyEmail) }),
      ...(body.replyToEmail === undefined
        ? {}
        : { replyToEmail: body.replyToEmail === null ? null : String(body.replyToEmail) }),
      instantAlerts: body.instantAlerts !== false,
      dailyDigest: body.dailyDigest !== false,
      ...(body.digestHourUtc === undefined ? {} : { digestHourUtc: Number(body.digestHourUtc) }),
      ...(body.alertMinOpportunity === undefined
        ? {}
        : { alertMinOpportunity: Number(body.alertMinOpportunity) }),
      ...(body.autopilotDailyCap === undefined
        ? {}
        : { autopilotDailyCap: Number(body.autopilotDailyCap) }),
    });

    return c.json({ saved: true });
  });

  // ---------------------------------------------------------- integrations
  //
  // The mailbox outreach is sent from. One per workspace, and the only thing
  // standing between a drafted message and a delivered one.

  api.get('/integrations/email', async (c) => {
    const actor = c.get('actor');
    const summary = await emailAccountSummary(c.get('db'), actor.workspaceId);

    return c.json({
      account: summary,
      // Whether a mailbox *could* be connected, so the form can say what is
      // missing instead of failing on submit.
      canConnect: options.encryptionKey !== undefined,
      // The platform sender still works when no mailbox is connected. Saying
      // so stops "not connected" reading as "nothing can be sent".
      platformFallback: options.mailer !== undefined,
      presets: SMTP_PRESETS,
    });
  });

  api.put('/integrations/email', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('connecting a sending mailbox');
    await requireVerifiedEmail(db, actor);

    const body = await parseBody(c.req.raw, connectEmailAccountSchema);

    try {
      const account = await connectEmailAccount(db, {
        workspaceId: actor.workspaceId,
        account: {
          host: body.host,
          port: body.port,
          secure: body.secure,
          username: body.username,
          password: body.password,
          fromEmail: body.fromEmail,
          ...(body.fromName ? { fromName: body.fromName } : {}),
          ...(body.replyTo ? { replyTo: body.replyTo } : {}),
          ...(body.imapHost
            ? {
                imapHost: body.imapHost,
                imapPort: body.imapPort ?? 993,
                imapSecure: body.imapSecure ?? true,
              }
            : {}),
        },
        encryptionKey: options.encryptionKey,
        verify: body.skipVerification !== true,
      });

      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'integration.connected',
        entityKind: 'workspace',
        entityId: actor.workspaceId,
        // The host and address are recorded; the password is not, here or
        // anywhere else that is readable.
        detail: { network: 'email', host: body.host, fromEmail: body.fromEmail },
      });

      return c.json({ connected: true, account });
    } catch (error) {
      if (error instanceof EmailAccountError) {
        // The mail server's own words. "535 Username and Password not
        // accepted" is actionable; "could not connect" is not.
        throw new ApiError(error.code === 'not_configured' ? 503 : 400, error.code, error.message);
      }
      throw error;
    }
  });

  api.delete('/integrations/email', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('disconnecting a sending mailbox');

    const removed = await disconnectEmailAccount(db, actor.workspaceId);

    if (removed) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: 'integration.disconnected',
        entityKind: 'workspace',
        entityId: actor.workspaceId,
        detail: { network: 'email' },
      });
    }

    return c.json({ disconnected: removed });
  });

  // ---------------------------------------------------------------- status
  //
  // What the workflow is doing right now, and the running commentary behind it.
  api.get('/status', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.query('campaignId');

    const [status, events] = await Promise.all([
      workflowStatus(db, actor.workspaceId),
      readEvents(db, {
        workspaceId: actor.workspaceId,
        ...(campaignId ? { campaignId } : {}),
        limit: clampLimit(c.req.query('limit')),
      }),
    ]);

    return c.json({ status, events });
  });

  /**
   * The live feed, as Server-Sent Events.
   *
   * SSE rather than a WebSocket because the traffic is one-way and this process
   * already proxies HTTP for the PWA — a socket upgrade through that proxy is a
   * second transport to get right for no gain. Reconnection is the browser's
   * job and it resumes from `Last-Event-ID`, which is the `seq` cursor, so a
   * dropped connection replays exactly what was missed and nothing else.
   *
   * The loop polls rather than subscribing to an in-process bus: the writes
   * come from the worker loop, the API and (in future) any other process, and
   * a cursor over a table is the only thing that sees all three.
   */
  api.get('/events', (c) => {
    const actor = c.get('actor');
    const db = c.get('db');
    const campaignId = c.req.query('campaignId');

    // `Last-Event-ID` is sent by the browser on reconnect; the query parameter
    // is for a first connection that already rendered a page of history.
    const resumeFrom = Number(c.req.header('last-event-id') ?? c.req.query('since') ?? 0);

    let cursor = Number.isFinite(resumeFrom) && resumeFrom > 0 ? resumeFrom : 0;
    let closed = false;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();

        const send = (event: string, data: unknown, id?: number): void => {
          if (closed) return;
          try {
            controller.enqueue(
              encoder.encode(
                `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\n` +
                  `data: ${JSON.stringify(data)}\n\n`,
              ),
            );
          } catch {
            closed = true;
          }
        };

        // Tell the client how long to wait before reconnecting, then send the
        // current picture immediately so the UI is never blank while waiting
        // for something to happen.
        controller.enqueue(encoder.encode('retry: 3000\n\n'));

        try {
          const initial = await workflowStatus(db, actor.workspaceId);
          if (cursor === 0) cursor = initial.latestSeq;
          send('status', initial);
        } catch {
          // A failed first snapshot must not close the stream; the poll below
          // will produce one shortly.
        }

        let ticks = 0;

        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          if (closed) break;

          try {
            const events = await readEvents(db, {
              workspaceId: actor.workspaceId,
              ...(campaignId ? { campaignId } : {}),
              sinceSeq: cursor,
              limit: 100,
            });

            for (const event of events) {
              cursor = Math.max(cursor, event.seq);
              send('workflow', event, event.seq);
            }

            // The status block is a set of aggregates, so it is refreshed on a
            // slower beat than the event tail — every fifth tick — rather than
            // running six aggregate queries every two seconds per open tab.
            ticks += 1;
            if (events.length > 0 || ticks % 5 === 0) {
              send('status', await workflowStatus(db, actor.workspaceId));
            } else {
              // A comment frame. Keeps proxies and load balancers from closing
              // an idle connection, and costs one line.
              controller.enqueue(encoder.encode(': keepalive\n\n'));
            }
          } catch {
            closed = true;
          }
        }

        try {
          controller.close();
        } catch {
          // Already closed by the client going away.
        }
      },
      cancel() {
        closed = true;
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // The PWA is served through this same process's proxy, and a buffering
        // intermediary turns a live feed into a batch delivered at the end.
        'x-accel-buffering': 'no',
      },
    });
  });

  // ----------------------------------------------------------------- social
  //
  // Prefilled composers for the networks the capability matrix marks
  // manual-only. Nothing here posts on anyone's behalf.
  api.get('/recommendations/:id/share', async (c) => {
    const actor = c.get('actor');

    try {
      const view = await shareLinksFor(c.get('db'), actor.workspaceId, c.req.param('id'), {
        ...(c.req.query('mastodonInstance')
          ? { mastodonInstance: c.req.query('mastodonInstance') as string }
          : {}),
        ...(c.req.query('subreddit') ? { subreddit: c.req.query('subreddit') as string } : {}),
        ...(c.req.query('url') ? { url: c.req.query('url') as string } : {}),
      });

      return c.json(view);
    } catch (error) {
      if (error instanceof SocialError) throw ApiError.badRequest(error.message);
      throw error;
    }
  });

  /**
   * Records that a composer was opened.
   *
   * The client calls this as it opens the window rather than after, because
   * the window is the network's own site and nothing comes back from it.
   */
  api.post('/recommendations/:id/share', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    if (!canApprove(actor)) throw ApiError.forbidden('posting on a network');

    const body = safeJson(await c.req.raw.text());
    const network = String(body.network ?? '') as ShareNetwork;

    if (!(network in SHARE_TARGETS)) throw ApiError.badRequest('unknown network');

    try {
      const view = await shareLinksFor(db, actor.workspaceId, c.req.param('id'), {
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
        ...(typeof body.mastodonInstance === 'string'
          ? { mastodonInstance: body.mastodonInstance }
          : {}),
        ...(typeof body.subreddit === 'string' ? { subreddit: body.subreddit } : {}),
      });

      const link = view.links.find((candidate) => candidate.network === network);
      if (!link) throw new SocialError(`${network} cannot be posted to for this lead`);

      const recorded = await recordShare(db, actor.workspaceId, {
        recommendationId: c.req.param('id'),
        network,
        shareUrl: link.url,
        text: link.text || view.text,
        ...(typeof body.url === 'string' ? { url: body.url } : {}),
      });

      return c.json({ ...recorded, link }, 201);
    } catch (error) {
      if (error instanceof SocialError) throw ApiError.badRequest(error.message);
      throw error;
    }
  });

  api.post('/social-posts/:id/confirm', async (c) => {
    const actor = c.get('actor');
    const confirmed = await confirmShare(c.get('db'), actor.workspaceId, c.req.param('id'));
    if (!confirmed) throw ApiError.notFound('post');
    return c.json({ confirmed: true });
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
  /**
   * True when this deployment can put email on the wire without the workspace
   * connecting anything — the platform sender.
   *
   * This argument is the fix for the bug that made the whole email channel
   * unusable. `hasConnectedAccount` was read only from `integration_accounts`,
   * a table nothing could write to, so email always evaluated to `manual_only`
   * and the approval queue answered "No connected email account, so this must
   * be done manually." Meanwhile autopilot asked a different question — "is a
   * mailer configured?" — and happily sent the very same message unattended.
   * Two paths, two answers, and the one a human used was the broken one.
   */
  platformEmailEnabled = false,
  /** The action being executed, which must not count against its own limit. */
  excludeActionId?: string,
) {
  const [person, workspace, campaign, counts, flags, connected, contact] = await Promise.all([
    repo.getPerson(db, recommendation.person_id),
    repo.getWorkspace(db, actor.workspaceId),
    repo.getCampaign(db, actor.workspaceId, recommendation.campaign_id),
    repo.actionCounts(db, actor.workspaceId, recommendation.person_id, excludeActionId),
    repo.featureFlags(db, actor.workspaceId),
    repo.hasConnectedAccount(db, actor.workspaceId, recommendation.network as Network),
    recommendation.network === 'email'
      ? repo.resolveContactAddress(db, recommendation.person_id)
      : Promise.resolve(undefined),
  ]);

  if (!person) throw ApiError.notFound('person');
  if (!campaign) throw ApiError.notFound('campaign');

  const matchKeys = await repo.suppressionKeysForPerson(db, recommendation.person_id);
  const suppressed =
    person.status === 'suppressed' || (await repo.isSuppressed(db, actor.workspaceId, matchKeys));

  // Counted against the mailbox rather than the person. Skipped entirely when
  // no address resolves — there is nothing to protect and nothing to count.
  const [addressUsage, replied] = await Promise.all([
    contact
      ? repo.addressCounts(db, actor.workspaceId, contact.address, excludeActionId)
      : Promise.resolve(undefined),
    repo.conversationOpen(db, actor.workspaceId, recommendation.person_id, contact?.address),
  ]);

  const budget = safeJson(campaign.budget_json);

  return evaluatePolicy({
    network: recommendation.network as Network,
    action: recommendation.action as ActionKind,
    approvalMode: campaign.approval_mode as 'draft_and_approve',
    hasConnectedAccount: connected || (recommendation.network === 'email' && platformEmailEnabled),
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
    ...(addressUsage === undefined
      ? {}
      : {
          actionsToThisAddressThisWeek: addressUsage.thisWeek,
          maxActionsPerAddressPerWeek: numberOr(budget.maxActionsPerAddressPerWeek, 1),
          addressShared: contact?.shared === true,
          ...(addressUsage.hoursSinceLast === undefined
            ? {}
            : { hoursSinceLastActionToAddress: addressUsage.hoursSinceLast }),
        }),
    conversationOpen: replied,
    featureFlags: flags,
  });
}

/**
 * Puts one approved email on the wire.
 *
 * Resolves the sender the same way autopilot does — the workspace's own
 * mailbox when it has connected one, the platform sender otherwise — so an
 * approved message and an unattended one leave from the same address and are
 * recorded identically.
 *
 * Returns a report rather than throwing. "No address published for this
 * person" and "the mail server rejected the password" are both things the
 * reviewer needs to read, and a 500 tells them neither.
 */
async function sendEmailAction(
  db: Client,
  options: AppOptions,
  actor: RequestActor,
  actionId: string,
  policyVersion: string,
): Promise<{ sent: boolean; to?: string; reason?: string }> {
  const sender = await mailerForWorkspace(db, actor.workspaceId, {
    encryptionKey: options.encryptionKey,
    fallback: options.mailer,
  });

  if (!sender) {
    return { sent: false, reason: 'no mailbox is connected, so nothing could be sent' };
  }

  const result = await deliverEmailAction(
    {
      db,
      mailer: sender.mailer,
      ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
    },
    {
      workspaceId: actor.workspaceId,
      actionId,
      actor: { actorKind: 'user', actorId: actor.userId },
      policyVersion,
    },
  );

  return result.sent ? { sent: true, to: result.to } : { sent: false, reason: result.reason };
}

/** Networks we can act on through an API; everything else is manual. */
function modeForNetwork(network: Network): 'official_api' | 'manual' | 'crm' | 'customer_managed' {
  if (network === 'crm') return 'crm';
  // Sent through a mailbox the customer owns, which is what the capability
  // matrix has always called this channel.
  if (network === 'email') return 'customer_managed';
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

/** What the queue tells the reviewer about a card it knows will be refused. */
export interface ApprovalHold {
  readonly gate: string;
  readonly reason: string;
  /** The mailbox the message would reach, which is the thing being limited. */
  readonly address: string;
  /** True when that mailbox belongs to the company rather than the person. */
  readonly shared: boolean;
  /** When the hold lifts. Absent for the weekly cap, which has no fixed date. */
  readonly clears_at?: string;
}

/**
 * Works out, ahead of any click, which pending cards the address gates will
 * refuse.
 *
 * This is a *preview*, never a decision: approving still re-runs the whole
 * engine against current state, as it must (PRD §20.9). It exists because the
 * queue was silent about it — a reviewer looking at twenty-eight ready cards
 * behind four shared inboxes had no way to learn that none of them could be
 * approved except by clicking all twenty-eight.
 *
 * Only the address gates are previewed. They are the ones a reviewer cannot
 * infer from the card, because the limit is on a mailbox the card does not
 * name and is shared with colleagues the card does not list. Suppression,
 * confidence and per-prospect limits are all facts about the person in front
 * of them.
 */
function addressHolds(
  usage: readonly repo.PendingAddressUsage[],
  budgets: ReadonlyMap<string, string>,
): ReadonlyMap<string, { readonly hold: ApprovalHold; readonly hasDraft: boolean }> {
  const holds = new Map<string, { hold: ApprovalHold; hasDraft: boolean }>();

  for (const row of usage) {
    const budget = safeJson(budgets.get(row.campaignId) ?? '{}');

    const breaches = evaluateAddressLimits({
      actionsThisWeek: row.thisWeek,
      maxPerWeek: numberOr(budget.maxActionsPerAddressPerWeek, 1),
      shared: row.shared,
      ...(row.hoursSinceLast === undefined ? {} : { hoursSinceLast: row.hoursSinceLast }),
      ...(typeof budget.minHoursBetweenActions === 'number'
        ? { cooldownHours: budget.minHoursBetweenActions }
        : {}),
    });

    // The engine reports the last restriction when several fire, so the
    // preview shows the last one too — otherwise the badge and the refusal
    // would name different gates for the same card.
    const breach = breaches.at(-1);
    if (!breach) continue;

    holds.set(row.recommendationId, {
      hasDraft: row.hasDraft,
      hold: {
        gate: breach.gate,
        reason: breach.reason,
        address: row.address,
        shared: row.shared,
        ...(breach.clearsInHours === undefined
          ? {}
          : { clears_at: new Date(Date.now() + breach.clearsInHours * 3_600_000).toISOString() }),
      },
    });
  }

  return holds;
}

/** Accepts a JSON array of strings, or a comma-separated string. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return value.split(',');
  return [];
}

/**
 * Whether this campaign belongs to the caller's workspace.
 *
 * Read routes need it explicitly: the loaders below answer "no targets" for a
 * campaign in someone else's workspace and for one that does not exist, which
 * is the right default for the worker and the wrong answer for an API that
 * should say 404.
 */
async function campaignInWorkspace(
  db: Client,
  workspaceId: string,
  campaignId: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    db,
    'SELECT id FROM campaigns WHERE id = ? AND workspace_id = ?',
    [campaignId, workspaceId],
  );

  return row !== undefined;
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
