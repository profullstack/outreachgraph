import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { queryAll } from '@outreachgraph/db';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

async function harness(
  label: string,
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({
    db: seeded.db,
    authenticate: async () => actor ?? undefined,
  });

  return { app, seeded };
}

async function post(app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /prospects/by-url', () => {
  test('a single URL is accepted and queued, not crawled inline', async () => {
    const { app, seeded } = await harness('byurl-single');

    const response = await post(app, '/prospects/by-url', { url: 'https://loopwright.io' });
    const body = await response.json();

    // 202, not 200: the work has been accepted, not done.
    expect(response.status).toBe(202);
    expect(body.queued).toBe(1);
    expect(body.batchId).toStartWith('job_');

    const jobs = await queryAll<{ kind: string; status: string; payload_json: string }>(
      seeded.db,
      'SELECT kind, status, payload_json FROM jobs',
    );

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.kind).toBe('crawl_site');
    expect(jobs[0]!.status).toBe('pending');
    expect(JSON.parse(jobs[0]!.payload_json).url).toContain('loopwright.io');
  });

  test('a bare domain is accepted', async () => {
    const { app } = await harness('byurl-bare');

    const response = await post(app, '/prospects/by-url', { url: 'loopwright.io' });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.urls[0]).toBe('https://loopwright.io/');
  });

  test('the same company twice in one paste is queued once', async () => {
    const { app } = await harness('byurl-dupe-in-batch');

    const response = await post(app, '/prospects/by-url', {
      urls: ['https://loopwright.io', 'https://www.loopwright.io/', 'loopwright.io'],
    });
    const body = await response.json();

    // Deduped by host: www and the bare domain are the same company, and
    // crawling a homepage three times helps nobody.
    expect(body.queued).toBe(1);
  });

  test('a URL already queued is reported, not rejected', async () => {
    const { app } = await harness('byurl-dupe-across');

    await post(app, '/prospects/by-url', { url: 'https://loopwright.io' });
    const second = await post(app, '/prospects/by-url', {
      urls: ['https://loopwright.io', 'https://other.example'],
    });
    const body = await second.json();

    expect(body.queued).toBe(1);
    expect(body.duplicates).toHaveLength(1);
    // The point: one repeat must not take the other URL down with it.
    expect(body.urls[0]).toContain('other.example');
  });

  test('unusable entries are named rather than silently dropped', async () => {
    const { app } = await harness('byurl-rejected');

    const response = await post(app, '/prospects/by-url', {
      urls: ['https://good.example', 'ftp://files.example', 'not a url at all'],
    });
    const body = await response.json();

    expect(body.queued).toBe(1);
    expect(body.rejected.map((r: { url: string }) => r.url)).toContain('ftp://files.example');
  });

  test('a submission with nothing usable is a 400', async () => {
    const { app } = await harness('byurl-empty');

    const response = await post(app, '/prospects/by-url', { urls: ['', '  '] });
    expect(response.status).toBe(400);
  });

  test('more than a hundred URLs is refused', async () => {
    const { app } = await harness('byurl-too-many');

    const urls = Array.from({ length: 101 }, (_, i) => `https://site-${i}.example`);
    const response = await post(app, '/prospects/by-url', { urls });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('100');
  });

  test('a hundred URLs is accepted and answers immediately', async () => {
    const { app, seeded } = await harness('byurl-hundred');

    const urls = Array.from({ length: 100 }, (_, i) => `https://site-${i}.example`);
    const response = await post(app, '/prospects/by-url', { urls });

    expect(response.status).toBe(202);
    expect((await response.json()).queued).toBe(100);

    const rows = await queryAll<{ n: number }>(seeded.db, 'SELECT COUNT(*) AS n FROM jobs');
    expect(Number(rows[0]!.n)).toBe(100);
  });

  test('a caller who cannot approve cannot add prospects', async () => {
    const { app } = await harness('byurl-forbidden', { ...ACTOR, role: 'viewer' });

    const response = await post(app, '/prospects/by-url', { url: 'https://loopwright.io' });
    expect(response.status).toBe(403);
  });
});

describe('GET /batches/:id', () => {
  test('progress reports each URL, not just a count', async () => {
    const { app } = await harness('batch-progress');

    const created = await post(app, '/prospects/by-url', {
      urls: ['https://one.example', 'https://two.example'],
    });
    const { batchId } = await created.json();

    const response = await app.request(`/api/v1/batches/${batchId}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.pending).toBe(2);
    // "Which ones, and why" is the question after a hundred URLs, and it can
    // only be answered from the individual rows.
    expect(body.items.map((i: { url: string }) => i.url).sort()).toEqual([
      'https://one.example/',
      'https://two.example/',
    ]);
  });

  test('an unknown batch is a 404', async () => {
    const { app } = await harness('batch-missing');

    const response = await app.request('/api/v1/batches/job_nope');
    expect(response.status).toBe(404);
  });

  test('another workspace cannot read this batch', async () => {
    const { app, seeded } = await harness('batch-scoped');

    const created = await post(app, '/prospects/by-url', { url: 'https://one.example' });
    const { batchId } = await created.json();

    // A second app over the *same* database, not a second harness: calling the
    // helper twice would replace the tracked handle and leak the first file.
    const other = createApp({
      db: seeded.db,
      authenticate: async () => ({ ...ACTOR, workspaceId: 'wsp_someone_else' }),
    });

    expect((await other.request(`/api/v1/batches/${batchId}`)).status).toBe(404);
  });
});
