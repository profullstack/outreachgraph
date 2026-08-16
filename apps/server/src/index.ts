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
  type FallbackEntry,
} from '@outreachgraph/ai';
import { ResendMailer } from '@outreachgraph/email';
import { secretKeyFromEnv } from '@outreachgraph/secrets';
import { createApp } from '../../api/src/app';
import { pruneSessions } from '../../api/src/auth';
import {
  drainQueue,
  emitEvent,
  expireSignals,
  listeningCampaigns,
  processDeletion,
  pruneWorkflowEvents,
  rescoreProspect,
  runAutopilot,
  runCrawlJob,
  runDiscoveryJob,
  runListening,
  sendDailyDigest,
  sendLeadAlerts,
  type QueuedJob,
} from '@outreachgraph/pipeline';
import {
  BlueskyFeedSource,
  BlueskyProvider,
  NostrSource,
  RedditSource,
  RssSource,
  SiteProvider,
  type FeedSource,
} from '@outreachgraph/providers';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3001);
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 60_000);
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
const chain: FallbackEntry[] = [];

if (process.env.ANTHROPIC_API_KEY) {
  chain.push({
    name: 'anthropic',
    model: new ClaudeModel({
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
    }),
  });
}

// Second, not instead of. A capped Anthropic key regains access on its own, and
// when it does the chain returns to Claude with no redeploy — which is what a
// fallback should do rather than becoming a permanent quiet substitution.
//
// OpenAI comes before Gemini because it is the closer substitute: the prompts
// and the deterministic gates were built around Claude, and a same-shaped model
// is likelier to produce a draft that still passes them.
if (process.env.OPENAI_API_KEY) {
  chain.push({
    name: 'openai',
    model: new OpenAIModel({
      ...(process.env.OPENAI_MODEL ? { model: process.env.OPENAI_MODEL } : {}),
    }),
  });
}

if (process.env.GEMINI_API_KEY) {
  chain.push({
    name: 'gemini',
    model: new GeminiModel({
      ...(process.env.GEMINI_MODEL ? { model: process.env.GEMINI_MODEL } : {}),
    }),
  });
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
 * The public feeds this deployment listens to.
 *
 * Off unless asked for. Listening writes people and signals on a schedule, and
 * a deployment that starts polling four networks the moment it boots is not
 * something to switch on by accident.
 *
 * Reddit and RSS are the two that matter for reaching buyers outside software,
 * and both are configured by *where* to look rather than by credentials:
 * `LISTEN_SUBREDDITS` and `LISTEN_RSS_FEEDS` are the whole setting. An
 * unscoped Reddit search returns noise; three trade subreddits return buyers.
 */
const listeningSources = buildListeningSources();

function buildListeningSources(): FeedSource[] {
  const enabled = new Set(
    (process.env.LISTEN_SOURCES ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  if (enabled.size === 0) return [];

  const sources: FeedSource[] = [];

  if (enabled.has('reddit')) {
    sources.push(
      new RedditSource({
        subreddits: splitList(process.env.LISTEN_SUBREDDITS),
        ...(process.env.REDDIT_USER_AGENT ? { userAgent: process.env.REDDIT_USER_AGENT } : {}),
        ...(process.env.REDDIT_ACCESS_TOKEN
          ? { accessToken: process.env.REDDIT_ACCESS_TOKEN }
          : {}),
      }),
    );
  }

  if (enabled.has('rss')) {
    const feedUrls = splitList(process.env.LISTEN_RSS_FEEDS);
    // A feed source with no feeds polls nothing; saying so beats a silent
    // no-op that looks like the feature not working.
    if (feedUrls.length === 0)
      console.log('LISTEN_SOURCES includes rss but LISTEN_RSS_FEEDS is empty');
    else sources.push(new RssSource({ feedUrls }));
  }

  if (enabled.has('bluesky')) sources.push(new BlueskyFeedSource());

  if (enabled.has('nostr')) {
    const relays = splitList(process.env.LISTEN_NOSTR_RELAYS);
    sources.push(new NostrSource(relays.length > 0 ? { relays } : {}));
  }

  if (sources.length > 0) {
    console.log(`listening to: ${sources.map((source) => source.slug).join(', ')}`);
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

// ---------------------------------------------------------------------- api
const api = createApp({
  db,
  ...(model ? { model } : {}),
  ...(mailer ? { mailer } : {}),
  ...(encryptionKey ? { encryptionKey } : {}),
  ...(appUrl ? { appUrl } : {}),
  ...(process.env.API_TOKEN ? { serviceToken: process.env.API_TOKEN } : {}),
  // Cookies must not be Secure over plain HTTP, or local development can
  // never hold a session.
  secureCookies: ENVIRONMENT === 'production',
  version: process.env.APP_VERSION ?? '0.1.0',
  ...(process.env.COMMIT_HASH ? { commitHash: process.env.COMMIT_HASH } : {}),
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

async function runJob(job: QueuedJob): Promise<void> {
  switch (job.kind) {
    case 'crawl_site':
      await crawlSite(job);
      return;
    case 'discover_domains':
      await discoverDomains(job);
      return;
    case 'rescore_prospect': {
      const { campaignId, personId } = job.payload as { campaignId?: string; personId?: string };
      if (!campaignId || !personId)
        throw new Error('rescore_prospect needs campaignId and personId');
      await rescoreProspect(db, campaignId, personId);
      return;
    }
    case 'process_deletion': {
      const { deletionJobId } = job.payload as { deletionJobId?: string };
      if (!deletionJobId) throw new Error('process_deletion needs deletionJobId');
      await processDeletion(db, deletionJobId);
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

  // Progress rows accumulate at roughly one per prospect per stage. Nothing
  // reads a fortnight-old one, and the audit log they would otherwise bloat is
  // a separate table precisely so this can be aggressive.
  const prunedEvents = await pruneWorkflowEvents(db);
  if (prunedEvents > 0) console.log(`pruned ${prunedEvents} workflow events`);

  // The queue drains before the send sweep, so anything discovered this tick
  // can go out on the same tick rather than waiting for the next one.
  const drained = await drainQueue(db, runJob);
  if (drained.processed > 0 || drained.reclaimed > 0) {
    console.log(
      `jobs: ${drained.succeeded} done, ${drained.retried} retrying, ` +
        `${drained.dead} failed, ${drained.reclaimed} reclaimed`,
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
  if (listeningSources.length > 0) {
    for (const workspace of workspaces) {
      try {
        for (const campaign of await listeningCampaigns(db, workspace.id)) {
          const heard = await runListening(
            { db, sources: listeningSources },
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
  }

  // ------------------------------------------------------------- autopilot
  //
  // Sending, alerting and the digest, per workspace. Each is wrapped
  // separately: one workspace with a broken sending domain must not stop the
  // others from being processed, and a failed digest must not prevent the
  // outreach sweep that follows it.
  for (const workspace of workspaces) {
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
