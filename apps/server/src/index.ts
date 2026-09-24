#!/usr/bin/env bun
/**
 * The single OutreachGraph process.
 *
 * One container, one public port, three responsibilities:
 *
 *   /api/v1/*, /health/*  → the Hono API, in-process
 *   everything else       → the Next.js PWA, a child process on loopback
 *   background loop       → signal expiry, deletion jobs, session pruning
 *
 * Next ships its own server and there is no supported way to mount it inside
 * another Bun server, so it runs as a child on 127.0.0.1 and this process
 * proxies to it. The child is never exposed; only this listener binds a
 * public port.
 *
 * The worker loop runs here rather than as a separate service. It is a
 * single-instance loop by design — two copies would both claim the same
 * pending deletion job — so scaling this container horizontally would need
 * the loop split back out behind a lock.
 */

import { closeDatabase, getDatabase, migrate, queryAll } from '@outreachgraph/db';
import {
  ClaudeModel,
  FallbackModel,
  GeminiModel,
  OpenAIModel,
  isBudgetExhausted,
  type FallbackEntry,
} from '@outreachgraph/ai';
import { ImapReader, ResendMailer } from '@outreachgraph/email';
import { CoinPayClient } from '@outreachgraph/payments';
import { secretKeyFromEnv } from '@outreachgraph/secrets';
import { createApp } from '../../api/src/app';
import { prunePasswordResetTokens, pruneSessions } from '../../api/src/auth';
import { verifyOpenAccessBearer } from '../../api/src/openaccess';
import {
  drainQueue,
  emitEvent,
  expireSignals,
  listeningCampaigns,
  autoApproveInternal,
  enrichContact,
  findEmail,
  sweepFindEmail,
  workspacesAwaitingEmailSearch,
  sweepContactEnrichment,
  workspacesAwaitingEnrichment,
  processDeletion,
  workspacesWithInternalBacklog,
  pruneWorkflowEvents,
  regenerateRecommendations,
  rescoreProspect,
  reseedIdleCampaigns,
  runAutopilot,
  applyProjectBudgets,
  sweepProfilePhotos,
  workspacesAwaitingPhotos,
  runCadences,
  runCrawlJob,
  runDiscoveryJob,
  runNichedbDiscoveryJob,
  runOpenProfileJob,
  loadImapCredentials,
  receiveReplies,
  runListening,
  sendDailyDigest,
  sendLeadAlerts,
  workspacesWithReadableMailbox,
  type ListeningTargets,
  type QueuedJob,
  runSocialDelivery,
  triageReply,
} from '@outreachgraph/pipeline';
import {
  BlueskyFeedSource,
  BlueskyProvider,
  createSmtpProber,
  NostrSource,
  RedditSource,
  RssSource,
  SiteProvider,
  ValueSerpClient,
  type FeedSource,
} from '@outreachgraph/providers';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3001);
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 60_000);

/**
 * How often a mailbox is read, as opposed to how often the worker ticks.
 *
 * Five minutes because a reply is not urgent — the thing it must beat is the
 * next outreach send, not the reader's patience — and an IMAP login per
 * workspace per minute is a great deal of connection churn for a mailbox that
 * receives a handful of replies a day.
 */
const RECEIVE_POLL_MS = Number(process.env.RECEIVE_POLL_MS ?? 300_000);

/** Last successful poll per workspace, so the slower clock survives a tick. */
const lastPolledAt = new Map<string, number>();
const ENVIRONMENT = process.env.NODE_ENV ?? 'development';

const db = getDatabase();

// --------------------------------------------------------------- migrations
/**
 * Migrations run at boot, before anything serves.
 *
 * This is safe here specifically because the deployment is one container
 * pinned to one replica — the concern with boot-time migrations is several
 * replicas racing, which cannot happen while `numReplicas` is 1. It also
 * removes a manual release step that is easy to forget, and forgetting it
 * means the app answers requests against a schema that is not there.
 *
 * Set RUN_MIGRATIONS=false to take over that responsibility elsewhere.
 */
if (process.env.RUN_MIGRATIONS !== 'false') {
  const migrationsDir = `${import.meta.dir}/../../../migrations`;
  try {
    const result = await migrate(db, migrationsDir);
    if (result.applied.length > 0) {
      console.log(`applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
    } else {
      console.log(`schema up to date (${result.skipped.length} migrations)`);
    }
  } catch (error) {
    // Serving against an unmigrated schema produces confusing 500s on every
    // route; failing to start is the honest outcome.
    console.error('migrations failed; refusing to start', error);
    process.exit(1);
  }
}

// -------------------------------------------------------------------- model
/**
 * The composer is optional infrastructure.
 *
 * Without a key the product still works: signals are ingested, prospects
 * resolved, recommendations scored and queued — the reviewer writes the
 * message. Refusing to boot over a missing key would take the whole system
 * down for a feature that is, by design, allowed to produce nothing.
 */
/**
 * Which provider leads, and which ones back it up.
 *
 * `MODEL_CHAIN` is a comma list of provider names in preference order, e.g.
 * `openai,anthropic`. It exists because the right leader is a billing
 * decision, not an architectural one: drafting one short email per prospect is
 * the highest-volume model call the product makes, and a frontier model is
 * simply the wrong tool for it. Naming the order in the environment lets that
 * be changed without a deploy, and a provider left out of the list is not
 * built at all — the cheap chain stays cheap rather than quietly falling
 * through to an expensive one.
 *
 * Unset preserves the original order, so nothing changes for a deployment that
 * has not thought about it.
 */
const DEFAULT_CHAIN_ORDER = ['anthropic', 'openai', 'gemini'] as const;

const builders: Record<string, () => FallbackEntry | undefined> = {
  anthropic: () =>
    process.env.ANTHROPIC_API_KEY
      ? {
          name: 'anthropic',
          model: new ClaudeModel({
            ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
          }),
        }
      : undefined,
  openai: () =>
    process.env.OPENAI_API_KEY
      ? {
          name: 'openai',
          model: new OpenAIModel({
            ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
          }),
        }
      : undefined,
  gemini: () =>
    process.env.GEMINI_API_KEY
      ? {
          name: 'gemini',
          model: new GeminiModel({
            ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
          }),
        }
      : undefined,
};

const requestedOrder = (process.env.MODEL_CHAIN ?? '')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

// An unrecognised name is louder than it is fatal: booting with a silently
// shorter chain is how a deployment ends up with no composer and no clue why.
for (const name of requestedOrder) {
  if (!(name in builders)) console.log(`MODEL_CHAIN: ignoring unknown provider "${name}"`);
}

const order = requestedOrder.length > 0 ? requestedOrder : [...DEFAULT_CHAIN_ORDER];

const chain: FallbackEntry[] = [];
for (const name of order) {
  const entry = builders[name]?.();
  if (entry && !chain.some((existing) => existing.name === entry.name)) chain.push(entry);
}

const model =
  chain.length > 0
    ? new FallbackModel(chain, {
        onFallback: (attempt) =>
          console.log(`model fallback: ${attempt.provider} unavailable — ${attempt.reason ?? ''}`),
      })
    : undefined;

if (model) console.log(`model chain: ${model.providers.join(' -> ')}`);
else console.log('no model key configured: drafting disabled, queue still runs');

/**
 * Account email.
 *
 * Same shape as the model above: absent credentials degrade to logging rather
 * than to a refusal to boot. A verification link printed in the container log
 * is recoverable; a container that will not start is not.
 */
const mailer =
  process.env.RESEND_API_KEY && process.env.EMAIL_FROM
    ? new ResendMailer({
        apiKey: process.env.RESEND_API_KEY,
        from: process.env.EMAIL_FROM,
      })
    : undefined;

if (!mailer) console.log('no RESEND_API_KEY/EMAIL_FROM: verification links are logged, not sent');

/**
 * Unlocks mailbox credentials a workspace has stored.
 *
 * A bad key is fatal on purpose, unlike an absent one. Absent means "nobody
 * has connected a mailbox here yet", which is a normal state for a fresh
 * deployment. Present-but-wrong means every stored credential silently reads
 * as no-account, and a product that quietly stops sending is worse than one
 * that refuses to start.
 */
const encryptionKey = secretKeyFromEnv();

if (!encryptionKey) {
  console.log('no SECRET_ENCRYPTION_KEY: workspaces cannot connect their own sending mailbox');
}

/**
 * Pictures of leads, by search.
 *
 * Optional: crawls, public profile enrichment and Gravatar also supply photos.
 * Each search lookup is a paid request, so the sweep is
 * capped per workspace per day as well as per tick.
 */
const photoFinder = process.env.VALUESERP_API_KEY
  ? new ValueSerpClient({ apiKey: process.env.VALUESERP_API_KEY })
  : undefined;

const photoLookupsPerDay = Number(process.env.PHOTO_LOOKUPS_PER_DAY ?? 300);

if (!photoFinder)
  console.log('no VALUESERP_API_KEY: lead photos come from public profiles and crawls');

// ------------------------------------------------------------- find_email
/**
 * The RCPT prober for `find_email`, unless turned off.
 *
 * On by default because it degrades on its own: Railway, like most cloud
 * hosts, blocks outbound port 25, and the prober notices after three failed
 * connections and stops asking for an hour. The job then verifies by MX and
 * the learned domain pattern alone. `FIND_EMAIL_SMTP_PROBE=off` skips even
 * those three attempts, for a host where the answer is already known.
 *
 * The EHLO name should be a domain we own, because a server that checks it
 * will refuse a stranger's.
 */
const smtpProber =
  process.env.FIND_EMAIL_SMTP_PROBE === 'off'
    ? undefined
    : createSmtpProber({
        ...(process.env.SMTP_PROBE_HELO ? { helo: process.env.SMTP_PROBE_HELO } : {}),
        ...(process.env.SMTP_PROBE_FROM !== undefined ? { from: process.env.SMTP_PROBE_FROM } : {}),
      });

/**
 * The feed clients for one campaign's own targets.
 *
 * The split here is deliberate, and it is the whole point of this function.
 * *Where* to listen — which subreddits, which feeds — comes from the campaign,
 * because two workspaces on this container sell different things to different
 * people and sharing a set of communities makes at most one of them right.
 * *How* to reach a network — user agents, tokens, relay hosts — comes from the
 * environment, because that is infrastructure and genuinely is per-deployment.
 *
 * Listening previously read its targeting from `LISTEN_SUBREDDITS` and
 * `LISTEN_RSS_FEEDS`, which put both halves in the environment and quietly
 * cross-wired every workspace. Those variables are gone; targeting now lives on
 * `campaign_filters` (migration 0012) and is edited per campaign in setup.
 */
function buildListeningSources(targets: ListeningTargets): FeedSource[] {
  const enabled = new Set<string>(targets.sources);
  const sources: FeedSource[] = [];

  if (enabled.has('reddit')) {
    sources.push(
      new RedditSource({
        subreddits: targets.subreddits,
        ...(process.env.REDDIT_USER_AGENT ? { userAgent: process.env.REDDIT_USER_AGENT } : {}),
        ...(process.env.REDDIT_ACCESS_TOKEN
          ? { accessToken: process.env.REDDIT_ACCESS_TOKEN }
          : {}),
      }),
    );
  }

  // A feed source with no feeds polls nothing, so it is left out rather than
  // constructed: an empty RSS client in the list reads as working listening.
  if (enabled.has('rss') && targets.feeds.length > 0) {
    sources.push(new RssSource({ feedUrls: targets.feeds }));
  }

  if (enabled.has('bluesky')) sources.push(new BlueskyFeedSource());

  if (enabled.has('nostr')) {
    const relays = splitList(process.env.LISTEN_NOSTR_RELAYS);
    sources.push(new NostrSource(relays.length > 0 ? { relays } : {}));
  }

  return sources;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Where the links in outbound email point.
 *
 * `APP_URL` unset used to mean `http://localhost:8080`, which is right in
 * development and useless everywhere else — and because a send failure is
 * audited but a *delivered* mail is not, production spent a week mailing real
 * people a link to their own machine with nothing anywhere saying so.
 *
 * Railway always supplies the public hostname, so on a deployed service the
 * fallback is derivable rather than guessed. The localhost default survives
 * only where it is correct.
 */
const appUrl =
  process.env.APP_URL ??
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : undefined);

if (!appUrl && ENVIRONMENT === 'production') {
  console.log(
    'APP_URL is unset and no public domain is known: email links will point at localhost',
  );
} else if (!process.env.APP_URL && appUrl) {
  console.log(`APP_URL unset; email links will use ${appUrl}`);
}

/**
 * Which commit is actually serving.
 *
 * `/` and `/health/live` have always been able to report this, and in
 * production they never did: `COMMIT_HASH` is not a variable anything sets, so
 * the field was simply absent and there was no way to tell what a deploy was
 * running without opening the dashboard. That is the one question worth asking
 * of a deployment you have just pushed to.
 *
 * Railway stamps the deployed SHA into every service it builds from a repo, so
 * taking it from there needs no configuration and cannot drift from what is
 * running. `COMMIT_HASH` stays the override for anything deployed another way.
 */
const commitHash = process.env.COMMIT_HASH ?? process.env.RAILWAY_GIT_COMMIT_SHA;

/**
 * Selling credits, if this deployment has been given the means to.
 *
 * All three variables or none. A client holding two of them fails at the
 * moment a customer clicks Buy, which is the worst possible time to discover
 * a missing environment variable; refusing to construct it means `/billing`
 * reports honestly that it cannot take payments, and the checkout button is
 * never offered in the first place.
 */
const coinpay =
  process.env.COINPAY_API_KEY &&
  process.env.COINPAY_BUSINESS_ID &&
  process.env.COINPAY_WEBHOOK_SECRET
    ? new CoinPayClient({
        apiKey: process.env.COINPAY_API_KEY,
        businessId: process.env.COINPAY_BUSINESS_ID,
        webhookSecret: process.env.COINPAY_WEBHOOK_SECRET,
        ...(process.env.COINPAY_BASE_URL ? { baseUrl: process.env.COINPAY_BASE_URL } : {}),
      })
    : undefined;

if (!coinpay) {
  console.log('CoinPayPortal credentials absent: credit packs are not for sale on this deployment');
}

// Where CoinPayPortal should send webhooks. The API and the PWA share a
// hostname in production, so this is the same origin the browser uses.
const apiUrl = process.env.API_URL ?? appUrl;

// The X app accounts are connected through, over OAuth 2.1. The callback is
// registered on the X app as exactly this URL, so it is derived from the one
// origin the API is served on rather than configured separately.
const xOAuth =
  process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET && apiUrl
    ? {
        clientId: process.env.X_CLIENT_ID,
        clientSecret: process.env.X_CLIENT_SECRET,
        redirectUri: `${apiUrl.replace(/\/$/, '')}/api/v1/x/oauth/callback`,
      }
    : undefined;

if (!xOAuth) console.log('X_CLIENT_ID/X_CLIENT_SECRET unset: X cards stay hand-offs');

// ---------------------------------------------------------------------- api
const api = createApp({
  ...(xOAuth ? { xOAuth } : {}),
  db,
  ...(coinpay ? { coinpay } : {}),
  ...(apiUrl ? { apiUrl } : {}),
  ...(model ? { model } : {}),
  ...(mailer ? { mailer } : {}),
  ...(encryptionKey ? { encryptionKey } : {}),
  ...(appUrl ? { appUrl } : {}),
  ...(process.env.API_TOKEN ? { serviceToken: process.env.API_TOKEN } : {}),
  // A person editing their own OpenProfile.md carries an OpenAccess bearer
  // rather than a session here.
  verifyBearer: verifyOpenAccessBearer,
  // Cookies must not be Secure over plain HTTP, or local development can
  // never hold a session.
  secureCookies: ENVIRONMENT === 'production',
  version: process.env.APP_VERSION ?? '0.4.0',
  ...(commitHash ? { commitHash } : {}),
});

// ---------------------------------------------------------------------- web
// `next start` is skipped in development: `bun run dev` serves the PWA itself.
const webEntry = `${import.meta.dir}/../../web/server.js`;
const hasBuiltWeb = await Bun.file(webEntry).exists();

let web: Bun.Subprocess | undefined;

if (hasBuiltWeb) {
  web = Bun.spawn(['bun', webEntry], {
    env: {
      ...process.env,
      // The child's own listener.
      PORT: String(WEB_PORT),
      HOSTNAME: '127.0.0.1',
      // Where the child should call the API. Must be set explicitly: the
      // child's PORT is its own, so deriving the API address from PORT makes
      // the PWA call itself and get Next's 404 instead of the API.
      INTERNAL_API_URL: `http://127.0.0.1:${PORT}`,
    },
    stdout: 'inherit',
    stderr: 'inherit',
    onExit(_proc, code) {
      // The PWA dying is not recoverable from here, and a half-serving
      // container is worse than one Railway will restart.
      console.error(`web child exited with code ${code}; shutting down`);
      void shutdown('web-exit');
    },
  });
  console.log(`web child started on 127.0.0.1:${WEB_PORT}`);
} else {
  console.warn(`no built PWA at ${webEntry}; serving API only`);
}

/** Forwards a request to the Next child, preserving method, headers and body. */
async function proxyToWeb(request: Request): Promise<Response> {
  if (!web) {
    return new Response('the web application is not built in this image', { status: 503 });
  }

  const incoming = new URL(request.url);
  const target = new URL(incoming.pathname + incoming.search, `http://127.0.0.1:${WEB_PORT}`);

  // Ask the child for identity encoding. `fetch` transparently decompresses
  // what it receives, so a forwarded `content-encoding: gzip` would describe a
  // body that is no longer compressed — the client then fails to decode it and
  // renders nothing. Not requesting compression over loopback avoids the
  // mismatch entirely and costs nothing.
  const headers = new Headers(request.headers);
  headers.set('accept-encoding', 'identity');

  let response: Response;
  try {
    response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      // Streaming bodies require this; without it Bun buffers and rejects.
      ...(request.body ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    console.error('web proxy failed', error);
    return new Response('the web application is not responding', { status: 502 });
  }

  // Strip hop-by-hop and body-framing headers. Whatever the child said about
  // length or encoding describes its own wire format, not the one this
  // response will be sent with.
  const outbound = new Headers(response.headers);
  outbound.delete('content-encoding');
  outbound.delete('content-length');
  outbound.delete('transfer-encoding');
  outbound.delete('connection');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outbound,
  });
}

// ------------------------------------------------------------------- server
const server = Bun.serve({
  port: PORT,
  idleTimeout: 60,
  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname.startsWith('/api/') || pathname.startsWith('/health')) {
      return api.fetch(request);
    }
    return proxyToWeb(request);
  },
});

console.log(`outreachgraph listening on :${PORT} (${ENVIRONMENT})`);

// ------------------------------------------------------------------- daemon
let running = true;
let inFlight: Promise<void> = Promise.resolve();

/**
 * Runs one queued job.
 *
 * Dispatch is explicit rather than a lookup table so an unhandled kind is a
 * loud failure with the kind in the message, not a job that quietly reports
 * success. A throw here is how the queue is told to retry or, once attempts
 * run out, to keep the row as `failed` with the reason attached.
 */
/** The site crawler, sharing the composer's key for its extraction fallback. */
const site = new SiteProvider(model ? { model } : {});

/**
 * Providers the fan-out may consult once a candidate exists.
 *
 * Bluesky only, for now, and deliberately: its AppView needs no key and no
 * contract, so it can run here without a commercial decision attached. X and
 * the enrichment vendors both do, and shipping an adapter that cannot be
 * exercised would be code pretending to be a feature.
 */
const fanOutProviders = [new BlueskyProvider()];

/**
 * Fetches one company URL and runs everyone it names.
 *
 * A page that names nobody is a completed job, not a failed one. Homepages
 * frequently describe a company without naming a single person, and retrying
 * that four more times would spend the crawl budget re-reading a page whose
 * answer will not change.
 */
async function crawlSite(job: QueuedJob): Promise<void> {
  const result = await runCrawlJob(
    {
      db,
      site,
      providers: fanOutProviders,
      ...(model ? { model } : {}),
      // Tells the policy engine email is a channel this deployment can
      // actually send through. Without it `email/send_email` evaluates to
      // `manual_only` and no email recommendation is ever produced.
      //
      // A workspace with its own connected mailbox is covered by the
      // `integration_accounts` check inside the pipeline, so this only has to
      // account for the platform sender.
      emailSendingEnabled: mailer !== undefined,
    },
    job,
  );

  if (result.outcome !== 'ok') {
    console.log(`crawl ${result.url}: ${result.outcome}`);
    return;
  }

  console.log(
    `crawl ${result.url}: ${result.companyName ?? 'unnamed company'},` +
      ` ${result.peopleQueued} people (${result.usedSignals.join(', ') || 'no signals'})`,
  );
}

/**
 * Expands one keyword into companies and queues a crawl for each.
 *
 * Throws when the model is unavailable rather than completing quietly: a
 * campaign that reports success and produces nothing is the exact failure this
 * whole path exists to remove, and the backoff will retry once a key works.
 */
async function discoverDomains(job: QueuedJob): Promise<void> {
  const result = await runDiscoveryJob({ db, ...(model ? { model } : {}) }, job);

  console.log(
    `discover "${result.keyword}": ${result.found} companies, ${result.queued} queued` +
      `${result.campaignName ? ` (${result.campaignName})` : ''}`,
  );
}

/** nichedb.dev's open collections, read since a cursor, become crawls; needs no model. */
async function discoverNichedb(job: QueuedJob): Promise<void> {
  const result = await runNichedbDiscoveryJob({ db }, job);
  console.log(
    `discover nichedb for ${result.campaignId}: read ${result.read}, ${result.candidates} sites, queued ${result.queued}` +
      `${result.rescheduled ? ', next run queued' : ''}`,
  );
}

async function runJob(job: QueuedJob): Promise<void> {
  switch (job.kind) {
    case 'crawl_site':
      await crawlSite(job);
      return;
    case 'discover_domains':
      await discoverDomains(job);
      return;
    case 'discover_nichedb':
      await discoverNichedb(job);
      return;
    case 'rescore_prospect': {
      const { campaignId, personId } = job.payload as { campaignId?: string; personId?: string };
      if (!campaignId || !personId)
        throw new Error('rescore_prospect needs campaignId and personId');
      await rescoreProspect(db, campaignId, personId);
      return;
    }
    case 'regenerate_recommendations': {
      const { campaignId, limit } = job.payload as { campaignId?: string; limit?: number };
      if (!campaignId) throw new Error('regenerate_recommendations needs campaignId');

      const result = await regenerateRecommendations({
        db,
        workspaceId: job.workspaceId,
        campaignId,
        ...(typeof limit === 'number' ? { limit } : {}),
        providers: fanOutProviders,
        ...(model ? { model } : {}),
        emailSendingEnabled: mailer !== undefined,
      });

      console.log(
        `regenerate ${campaignId}: ${result.replaced} replaced,` +
          ` ${result.unchanged} unchanged of ${result.considered}`,
      );
      return;
    }
    case 'process_deletion': {
      const { deletionJobId } = job.payload as { deletionJobId?: string };
      if (!deletionJobId) throw new Error('process_deletion needs deletionJobId');
      await processDeletion(db, deletionJobId);
      return;
    }
    case 'openprofile': {
      const result = await runOpenProfileJob({ db }, job);
      console.log(
        `openprofile ${result.personId}: ${result.outcome}` +
          (result.outcome === 'ok' || result.outcome === 'published'
            ? `, ${result.accounts} accounts, ${result.identities} new identit${result.identities === 1 ? 'y' : 'ies'}` +
              (result.corroborated ? ', corroborated by rel=me' : '') +
              (result.recommendationId ? `, card ${result.recommendationId}` : ', no card yet')
            : result.detail
              ? ` (${result.detail})`
              : ''),
      );
      return;
    }
    case 'deliver_social': {
      const result = await runSocialDelivery(
        {
          db,
          ...(encryptionKey ? { encryptionKey } : {}),
          ...(xOAuth ? { xOAuth } : {}),
        },
        job,
      );
      console.log(
        `deliver_social ${String(job.payload.network)} ${String(job.payload.actionId)}: ` +
          (result.sent ? `sent ${result.url ?? ''}` : `not sent (${result.reason ?? 'unknown'})`),
      );
      return;
    }
    case 'enrich_contact': {
      const { personId } = job.payload as { personId?: string };
      if (!personId) throw new Error('enrich_contact needs personId');

      const result = await enrichContact(db, { workspaceId: job.workspaceId, personId });

      // A miss is the majority answer and must not read as a failure: most
      // addresses have no published profile, and logging seventeen thousand
      // "failed" lines would bury the ones that actually broke.
      if (result.found) {
        console.log(
          `enriched ${personId}: ${result.identities} identit${result.identities === 1 ? 'y' : 'ies'}`,
        );
      }
      return;
    }
    case 'find_email': {
      const { personId } = job.payload as { personId?: string };
      if (!personId) throw new Error('find_email needs personId');

      const result = await findEmail(
        {
          db,
          ...(smtpProber && !smtpProber.blocked() ? { smtp: smtpProber } : {}),
          emailSendingEnabled: mailer !== undefined,
        },
        { workspaceId: job.workspaceId, personId },
      );

      // Every outcome is logged: there are dozens of these, not thousands, and
      // the SMTP column is how anyone learns whether port 25 is open here.
      console.log(
        `find_email ${personId}: ${result.outcome}` +
          (result.domain ? ` at ${result.domain}` : '') +
          (result.address ? `, ${result.address} (${result.confidence})` : '') +
          (result.smtp ? `, smtp ${result.smtp}` : '') +
          (result.recommendationIds.length > 0
            ? `, re-decided into ${result.recommendationIds.join(', ')}`
            : ''),
      );
      return;
    }
    case 'triage_reply': {
      const { interactionId } = job.payload as { interactionId?: string };
      if (!interactionId) throw new Error('triage_reply needs interactionId');

      // No model is a working state, not a failure: rules still label, a
      // rule-matched stop still suppresses, and the reply still sits in the
      // inbox for a human. Only the drafted answer is missing.
      const result = await triageReply(
        {
          db,
          ...(model ? { model } : {}),
          ...(mailer ? { mailer } : {}),
          ...(encryptionKey ? { encryptionKey } : {}),
          ...(appUrl ? { appUrl } : {}),
        },
        { workspaceId: job.workspaceId, interactionId },
      );

      console.log(
        `triage_reply ${interactionId}: ${result.outcome}` +
          (result.label
            ? ` (${result.label.label} ${Math.round(result.label.confidence * 100)}% by ${result.label.source})`
            : '') +
          (result.recommendationId ? `, card ${result.recommendationId}` : '') +
          ` — ${result.reason}`,
      );
      return;
    }
    default:
      throw new Error(`no handler for job kind ${job.kind}`);
  }
}

async function tick(): Promise<void> {
  const workspaces = await queryAll<{ id: string }>(
    db,
    `SELECT id FROM workspaces WHERE status = 'active'`,
  );

  for (const workspace of workspaces) {
    const expired = await expireSignals(db, workspace.id);
    const count = Number(expired.detail.expired ?? 0);
    if (count > 0) console.log(`expired ${count} signals in ${workspace.id}`);
  }

  const pending = await queryAll<{ id: string }>(
    db,
    `SELECT id FROM deletion_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 50`,
  );

  for (const job of pending) {
    const result = await processDeletion(db, job.id);
    console.log(`deletion job ${job.id}: ${result.ok ? 'completed' : 'failed'}`);
  }

  const pruned = await pruneSessions(db);
  if (pruned > 0) console.log(`pruned ${pruned} expired sessions`);

  // Spent and expired reset tokens are dead weight, and a hashed one is still
  // a row tying an address to a moment someone lost their password.
  const prunedResets = await prunePasswordResetTokens(db);
  if (prunedResets > 0) console.log(`pruned ${prunedResets} password reset tokens`);

  // Progress rows accumulate at roughly one per prospect per stage. Nothing
  // reads a fortnight-old one, and the audit log they would otherwise bloat is
  // a separate table precisely so this can be aggressive.
  const prunedEvents = await pruneWorkflowEvents(db);
  if (prunedEvents > 0) console.log(`pruned ${prunedEvents} workflow events`);

  // Cards that reach nobody are cleared before the queue drains, so the crawls
  // they enqueue run on this tick rather than waiting for the next one.
  for (const workspaceId of await workspacesWithInternalBacklog(db)) {
    const cleared = await autoApproveInternal(db, { workspaceId });

    if (cleared.approved > 0 || cleared.cooledDown > 0) {
      console.log(
        `auto-approved ${cleared.approved} internal card(s) in ${workspaceId}` +
          `${cleared.queuedCrawls > 0 ? `, queued ${cleared.queuedCrawls} crawl(s)` : ''}` +
          `${cleared.cooledDown > 0 ? `, ${cleared.cooledDown} already researched today` : ''}` +
          `${cleared.refused > 0 ? `, ${cleared.refused} refused by policy` : ''}`,
      );
    }
  }

  // Imported contacts are looked up from a derived set rather than a queue —
  // seventeen thousand job rows written inside one request is what made
  // finishing an import never return. Concurrent inside the sweep, because the
  // work is a network round trip and nothing else.
  for (const workspaceId of await workspacesAwaitingEnrichment(db)) {
    const swept = await sweepContactEnrichment(db, { workspaceId });

    if (swept.looked > 0) {
      console.log(
        `enrichment: looked up ${swept.looked} in ${workspaceId}, ` +
          `${swept.pagesQueued} page(s) queued, ${swept.noPresence} point nowhere, ` +
          `${swept.found} had a profile, ${swept.identities} identities, ` +
          `${swept.remaining} left`,
      );
    }
  }

  // People held on a hand-carried card with nothing to email get a search for
  // one. New cards queue their own; this catches everyone carded before that,
  // a bounded handful per tick so the drain below still has room for crawls.
  for (const workspaceId of await workspacesAwaitingEmailSearch(db)) {
    try {
      const swept = await sweepFindEmail(db, { workspaceId });
      if (swept.queued > 0) {
        console.log(`find_email: queued ${swept.queued} search(es) in ${workspaceId}`);
      }
    } catch (error) {
      console.error(`find_email sweep failed for ${workspaceId}`, error);
    }
  }

  // A face for the people about to be written to. Bounded per tick and per
  // day inside the sweep; this loop only decides who is looked at.
  if (photoFinder) {
    for (const workspaceId of await workspacesAwaitingPhotos(db)) {
      try {
        const swept = await sweepProfilePhotos(
          { db, finder: photoFinder, dailyCap: photoLookupsPerDay },
          { workspaceId },
        );

        if (swept.looked > 0) {
          console.log(
            `photos: looked up ${swept.looked} in ${workspaceId}, ${swept.found} found, ` +
              `${swept.profiles} LinkedIn profile(s) recorded, ${swept.remainingToday} left today`,
          );
        }
      } catch (error) {
        console.error(`photo sweep failed for ${workspaceId}`, error);
      }
    }
  }

  // Campaigns whose seed has not been read in a week are asked again. This is
  // the only thing that puts work back into an idle queue: once the first crop
  // of research cards is cleared, nothing else ever asks the seed for more.
  for (const workspace of workspaces) {
    try {
      const reseeded = await reseedIdleCampaigns(db, { workspaceId: workspace.id });
      if (reseeded.queued > 0) {
        console.log(`reseeded ${reseeded.queued} idle campaign(s) in ${workspace.id}`);
      }
    } catch (error) {
      console.error(`reseed failed for ${workspace.id}`, error);
    }
  }

  // The queue drains before the send sweep, so anything discovered this tick
  // can go out on the same tick rather than waiting for the next one.
  const drained = await drainQueue(db, runJob, { isOutage: isBudgetExhausted });
  if (drained.processed > 0 || drained.reclaimed > 0) {
    console.log(
      `jobs: ${drained.succeeded} done, ${drained.retried} retrying, ` +
        `${drained.dead} failed, ${drained.deferred} deferred, ` +
        `${drained.reclaimed} reclaimed`,
    );
  }

  // Said plainly and every tick it happens, because the previous version of
  // this outage was silent: the queue drained itself to death against providers
  // that had no budget left, and the only trace was a 400 in `jobs.last_error`
  // that read like a bug in the crawler.
  if (drained.deferred > 0) {
    console.log(
      'jobs: every model provider is refusing work, so the queue is holding ' +
        'rather than spending attempts — it resumes on its own once they answer',
    );
  }

  // A job that has run out of attempts is the one queue outcome a user needs
  // told about: it means a piece of their campaign stopped for good, and until
  // now that fact lived only in `jobs.last_error`.
  if (drained.dead > 0) {
    for (const workspace of workspaces) {
      const dead = await queryAll<{ kind: string; last_error: string | null }>(
        db,
        `SELECT kind, last_error FROM jobs
          WHERE workspace_id = ? AND status = 'failed' AND finished_at >= ?
          ORDER BY finished_at DESC LIMIT 5`,
        [workspace.id, new Date(Date.now() - TICK_MS * 2).toISOString()],
      );

      for (const job of dead) {
        await emitEvent(db, {
          workspaceId: workspace.id,
          phase: 'system',
          level: 'error',
          message: `A ${job.kind.replace(/_/g, ' ')} job gave up: ${(job.last_error ?? 'no reason recorded').slice(0, 200)}`,
          detail: { kind: job.kind },
        });
      }
    }
  }

  // ------------------------------------------------------------- listening
  //
  // Public feeds, searched for each campaign's own keywords. This is the only
  // intake that does not start from a company: it finds the person from what
  // they said, which is the only way to reach buyers who have no engineering
  // blog and no GitHub profile.
  //
  // `listeningCampaigns` returns only campaigns that chose somewhere to
  // listen, so a workspace that never enabled it costs one query per tick.
  for (const workspace of workspaces) {
    try {
      for (const campaign of await listeningCampaigns(db, workspace.id)) {
        const heard = await runListening(
          { db, resolveSources: buildListeningSources },
          { workspaceId: workspace.id, campaignId: campaign.id },
        );

        if (heard.kept > 0) {
          console.log(
            `listening ${campaign.name}: ${heard.kept} new from ${heard.found} posts ` +
              `(${heard.peopleCreated} new people)`,
          );
        }

        // A source that could not be reached is reported rather than
        // swallowed: "found nothing" and "could not look" are different
        // problems, and only one of them is worth investigating.
        for (const failure of heard.failures) {
          console.log(`listening ${campaign.name}: ${failure.slug} — ${failure.reason}`);
        }
      }
    } catch (error) {
      console.error(`listening failed for ${workspace.id}`, error);
    }
  }

  // ------------------------------------------------------------- receiving
  //
  // Replies, read over IMAP. This runs *before* the send sweep on purpose: a
  // reply noticed on this tick has to stop a message that would otherwise go
  // out on the same tick, and reading afterwards would let exactly the send we
  // are trying to prevent slip through every time.
  //
  // Polled on its own, slower clock. The worker tick is a minute; opening an
  // IMAP connection per workspace per minute is a lot of login traffic for a
  // mailbox that gets a handful of replies a day.
  for (const workspaceId of await workspacesWithReadableMailbox(db)) {
    const last = lastPolledAt.get(workspaceId) ?? 0;
    if (Date.now() - last < RECEIVE_POLL_MS) continue;
    lastPolledAt.set(workspaceId, Date.now());

    try {
      const credentials = await loadImapCredentials(db, workspaceId, encryptionKey);
      // Undefined covers "no mailbox", "no IMAP host" and "the key changed so
      // the password no longer decrypts". All three mean the same thing here.
      if (!credentials) continue;

      const received = await receiveReplies({
        db,
        workspaceId,
        reader: new ImapReader(credentials),
      });

      if (received.recorded > 0) {
        console.log(
          `replies ${workspaceId}: ${received.recorded} recorded, ${received.triageQueued} queued for triage`,
        );
      }
      if (received.automatedRecorded > 0) {
        console.log(
          `replies ${workspaceId}: ${received.automatedRecorded} absence notice(s)/bounce(s) filed to their threads`,
        );
      }

      // Worth a line even at zero: an inbox full of skipped auto-replies and
      // an inbox nobody answers look identical from the outside, and only one
      // of them is a problem.
      const skipped = Object.entries(received.automated);
      if (skipped.length > 0) {
        console.log(
          `replies ${workspaceId}: ignored ${skipped.map(([k, n]) => `${n} ${k}`).join(', ')}`,
        );
      }
    } catch (error) {
      // A mailbox that will not open is this workspace's problem, not the
      // tick's. Sending still has to happen for everyone else.
      console.error(`reading replies failed for ${workspaceId}`, error);
    }
  }

  // ------------------------------------------------------------- autopilot
  //
  // Sending, alerting and the digest, per workspace. Each is wrapped
  // separately: one workspace with a broken sending domain must not stop the
  // others from being processed, and a failed digest must not prevent the
  // outreach sweep that follows it.
  for (const workspace of workspaces) {
    // Cadences run before autopilot, not after. A step that falls due this
    // tick writes a recommendation, and running the sweep first means that
    // card waits a whole cycle before anything looks at it — which for an
    // hourly loop turns "follow up in 3 days" into "follow up in 3 days and
    // an hour", every step, compounding down the plan.
    try {
      const cadence = await runCadences(
        { db, platformEmailEnabled: mailer !== undefined },
        workspace.id,
      );

      if (cadence.considered > 0) {
        console.log(
          `cadences ${workspace.id}: ${cadence.automated} queued, ${cadence.manual} for a human, ` +
            `${cadence.skipped} skipped, ${cadence.completed} finished, ${cadence.stopped} stopped`,
        );
      }
    } catch (error) {
      console.error(`cadences failed for ${workspace.id}`, error);
    }

    try {
      // Project ceilings become campaign caps before the sender reads them,
      // so a budget set a minute ago is the budget this tick honours.
      const budgets = await applyProjectBudgets(db, workspace.id);
      if (budgets.changed > 0) {
        console.log(`budgets ${workspace.id}: ${budgets.changed} campaign cap(s) reallocated`);
      }
    } catch (error) {
      console.error(`budget allocation failed for ${workspace.id}`, error);
    }

    try {
      // The customer's own mail server when they have connected one, the
      // platform mailer otherwise. `runAutopilot` resolves which, once per
      // run, and records it on the send — outreach quietly going out under our
      // domain when the customer believes it is going out under theirs is the
      // one outcome worth engineering against.
      const result = await runAutopilot(
        {
          db,
          ...(mailer ? { mailer } : {}),
          ...(encryptionKey ? { encryptionKey } : {}),
          ...(appUrl ? { appUrl } : {}),
          // So a lead whose draft was never written can be rescued rather than
          // reported. Without this the sweep only ever says "no drafted
          // message", once per tick, forever.
          ...(model ? { model } : {}),
        },
        workspace.id,
      );

      if (result.sent.length > 0 || result.failed > 0) {
        console.log(
          `autopilot ${workspace.id}: ${result.sent.length} sent, ` +
            `${result.failed} failed, ${result.skipped.length} skipped`,
        );
      }

      // Skips are the most useful log line this loop produces: "no address
      // published" and "still requires human approval" are the two reasons a
      // campaign looks like it is doing nothing, and neither is an error
      // anywhere else.
      for (const skip of result.skipped.slice(0, 5)) {
        console.log(`autopilot skip ${skip.personName}: ${skip.reason}`);
      }
    } catch (error) {
      console.error(`autopilot failed for ${workspace.id}`, error);
    }

    if (!appUrl) continue;

    try {
      const alerts = await sendLeadAlerts(
        { db, ...(mailer ? { mailer } : {}), appUrl },
        workspace.id,
      );
      if (alerts > 0) console.log(`sent ${alerts} lead alert(s) for ${workspace.id}`);
    } catch (error) {
      console.error(`lead alerts failed for ${workspace.id}`, error);
    }

    try {
      const digested = await sendDailyDigest(
        { db, ...(mailer ? { mailer } : {}), appUrl },
        workspace.id,
      );
      if (digested) console.log(`sent the daily digest for ${workspace.id}`);
    } catch (error) {
      console.error(`daily digest failed for ${workspace.id}`, error);
    }
  }
}

async function loop(): Promise<void> {
  while (running) {
    inFlight = tick().catch((error: unknown) => {
      // A bad tick must not kill the container; Railway would restart it into
      // the same failure.
      console.error('worker tick failed', error);
    });
    await inFlight;
    if (!running) break;
    await Bun.sleep(TICK_MS);
  }
}

void loop();

// ----------------------------------------------------------------- shutdown
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`${signal} received, draining`);
  running = false;

  // Finish the current tick so a half-processed deletion is not left pending
  // with rows already removed.
  await inFlight;

  await server.stop(false);
  web?.kill();
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
