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
import { ClaudeModel } from '@outreachgraph/ai';
import { ResendMailer } from '@outreachgraph/email';
import { createApp } from '../../api/src/app';
import { pruneSessions } from '../../api/src/auth';
import {
  drainQueue,
  expireSignals,
  processDeletion,
  rescoreProspect,
  runCrawlJob,
  type QueuedJob,
} from '@outreachgraph/pipeline';
import { BlueskyProvider, SiteProvider } from '@outreachgraph/providers';

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
const model = process.env.ANTHROPIC_API_KEY
  ? new ClaudeModel({
      ...(process.env.ANTHROPIC_MODEL ? { model: process.env.ANTHROPIC_MODEL } : {}),
    })
  : undefined;

if (!model) console.log('no ANTHROPIC_API_KEY: drafting disabled, queue still runs');

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

// ---------------------------------------------------------------------- api
const api = createApp({
  db,
  ...(model ? { model } : {}),
  ...(mailer ? { mailer } : {}),
  ...(process.env.APP_URL ? { appUrl: process.env.APP_URL } : {}),
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
    { db, site, providers: fanOutProviders, ...(model ? { model } : {}) },
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

async function runJob(job: QueuedJob): Promise<void> {
  switch (job.kind) {
    case 'crawl_site':
      await crawlSite(job);
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

  // The queue drains last. The sweeps above are bounded and quick; this is the
  // part that can take the whole tick, and `limit` is what stops it running
  // away with the loop.
  const drained = await drainQueue(db, runJob);
  if (drained.processed > 0 || drained.reclaimed > 0) {
    console.log(
      `jobs: ${drained.succeeded} done, ${drained.retried} retrying, ` +
        `${drained.dead} failed, ${drained.reclaimed} reclaimed`,
    );
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
