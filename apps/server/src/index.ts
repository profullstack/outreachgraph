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

import { closeDatabase, getDatabase, queryAll } from '@outreachgraph/db';
import { createApp } from '../../api/src/app';
import { pruneSessions } from '../../api/src/auth';
import { expireSignals, processDeletion } from '../../worker/src/jobs';

const PORT = Number(process.env.PORT ?? 8080);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3001);
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 60_000);
const ENVIRONMENT = process.env.NODE_ENV ?? 'development';

const db = getDatabase();

// ---------------------------------------------------------------------- api
const api = createApp({
  db,
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
    env: { ...process.env, PORT: String(WEB_PORT), HOSTNAME: '127.0.0.1' },
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

  try {
    return await fetch(target, {
      method: request.method,
      headers: request.headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      redirect: 'manual',
      // Streaming bodies require this; without it Bun buffers and rejects.
      ...(request.body ? { duplex: 'half' } : {}),
    } as RequestInit);
  } catch (error) {
    console.error('web proxy failed', error);
    return new Response('the web application is not responding', { status: 502 });
  }
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
