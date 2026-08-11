#!/usr/bin/env bun
/**
 * Worker entry point.
 *
 * Runs the periodic maintenance loop. Queue-driven jobs (enrichment, research,
 * AI analysis) attach here once Redis/BullMQ is enabled; the schedule below is
 * the part that must run whether or not a queue exists, because signal expiry
 * and privacy processing are time-based obligations rather than reactions to
 * user activity (PRD §17.2).
 */

import { closeDatabase, getDatabase, queryAll } from '@outreachgraph/db';
import { expireSignals, processDeletion } from './jobs';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 60_000);
const db = getDatabase();

let running = true;
let inFlight: Promise<void> = Promise.resolve();

async function tick(): Promise<void> {
  const workspaces = await queryAll<{ id: string }>(
    db,
    `SELECT id FROM workspaces WHERE status = 'active'`,
  );

  for (const workspace of workspaces) {
    const expired = await expireSignals(db, workspace.id);
    if (Number(expired.detail.expired ?? 0) > 0) {
      console.log(`expired ${expired.detail.expired} signals in ${workspace.id}`);
    }
  }

  // Privacy work is not workspace-scoped: a deletion request spans the system.
  const pending = await queryAll<{ id: string }>(
    db,
    `SELECT id FROM deletion_jobs WHERE status = 'pending' ORDER BY created_at LIMIT 50`,
  );

  for (const job of pending) {
    const result = await processDeletion(db, job.id);
    console.log(`deletion job ${job.id}: ${result.ok ? 'completed' : 'failed'}`);
  }
}

async function loop(): Promise<void> {
  while (running) {
    inFlight = tick().catch((error: unknown) => {
      // One bad tick must not kill the worker; Railway would just restart it
      // into the same failure.
      console.error('worker tick failed', error);
    });
    await inFlight;
    if (!running) break;
    await Bun.sleep(TICK_MS);
  }
}

/** Liveness for Railway. The worker serves nothing else. */
const port = Number(process.env.PORT ?? 8081);
const server = Bun.serve({
  port,
  fetch: (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === '/health/live' || pathname === '/health/ready') {
      return Response.json({ status: 'ok', service: 'worker' });
    }
    return new Response('not found', { status: 404 });
  },
});

console.log(`worker started, tick ${TICK_MS}ms, health on :${port}`);
void loop();

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, finishing current tick`);
  running = false;
  // Let the in-flight tick finish so a half-processed deletion job does not
  // get left in 'pending' with rows already removed.
  await inFlight;
  await server.stop(false);
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
