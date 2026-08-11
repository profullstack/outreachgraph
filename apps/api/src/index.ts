#!/usr/bin/env bun
/**
 * API server entry point.
 *
 * Railway sends SIGTERM on deploy; the handler below stops accepting
 * connections and closes the database before exiting, so an in-flight request
 * is not cut off mid-transaction (PRD §1.1 Docker requirements).
 */

import { closeDatabase, getDatabase } from '@outreachgraph/db';
import { createApp } from './app';
import type { RequestActor } from './context';

const port = Number(process.env.PORT ?? 8080);
const db = getDatabase();

/**
 * Placeholder authentication.
 *
 * V1 ships session auth; until then the API refuses to start outside
 * development unless a token is configured, so an unauthenticated deploy is
 * impossible rather than merely discouraged.
 */
const apiToken = process.env.API_TOKEN;
const environment = process.env.NODE_ENV ?? 'development';

if (!apiToken && environment === 'production') {
  console.error('API_TOKEN must be set in production');
  process.exit(1);
}

async function authenticate(request: Request): Promise<RequestActor | undefined> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;

  const token = header.slice('Bearer '.length);
  if (!apiToken || token !== apiToken) return undefined;

  const workspaceId = request.headers.get('x-workspace-id');
  const organizationId = request.headers.get('x-organization-id');
  if (!workspaceId || !organizationId) return undefined;

  return {
    userId: request.headers.get('x-user-id') ?? 'usr_service',
    workspaceId,
    organizationId,
    role: 'owner',
  };
}

const app = createApp({
  db,
  authenticate,
  version: process.env.APP_VERSION ?? '0.1.0',
  ...(process.env.COMMIT_HASH ? { commitHash: process.env.COMMIT_HASH } : {}),
});

const server = Bun.serve({ port, fetch: app.fetch });

console.log(`api listening on :${port} (${environment})`);

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, draining`);
  await server.stop(false);
  await closeDatabase();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
