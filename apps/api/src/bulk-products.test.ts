import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { StubModel, type ProfileDraft } from '@outreachgraph/ai';
import { SiteProvider, type FetchLike } from '@outreachgraph/providers';
import { queryAll, queryOne } from '@outreachgraph/db';
import { claimNext, runDiscoveryJob, type QueuedJob } from '@outreachgraph/pipeline';
import { createApp } from './app';
import {
  marketFromDraft,
  parseDomainList,
  queueBulkProducts,
  runBootstrapProductJob,
} from './bulk-products';
import type { AppEnv, RequestActor } from './context';
import { saveWorkspaceProfile } from './workspace-profile';
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

function stubNetwork(): FetchLike {
  return async (input) =>
    input.toString().endsWith('/robots.txt')
      ? new Response('', { headers: { 'content-type': 'text/plain' } })
      : new Response(
          `<html><head><title>${new URL(input.toString()).hostname}</title></head>` +
            '<body><h1>Tools for independent creators</h1><p>Ship faster.</p></body></html>',
          { headers: { 'content-type': 'text/html' } },
        );
}

function draftFor(name: string, industry: string): string {
  return JSON.stringify({
    offering: {
      name,
      category: 'developer tooling',
      description: `${name} does one thing well.`,
      valuePropositions: ['Saves time'],
      likelyPains: ['Too much busywork'],
      competitors: [],
    },
    icp: {
      titles: ['Founder', 'Head of Growth'],
      seniorities: ['founder'],
      industries: [industry],
      technologies: [],
      keywords: ['indie hackers'],
      exclusions: [],
    },
    voice: { style: 'direct', instructions: 'no hype', maxWords: 90 },
    whereToFind: ['Indie Hackers forum.'],
  });
}

const site = new SiteProvider({ fetchImpl: stubNetwork() });

async function harness(
  label: string,
  model?: StubModel,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => ACTOR,
    site,
    ...(model ? { model } : {}),
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

/** Claims the next job of one kind, failing loudly if a different one is ahead of it. */
async function next(seeded: SeededDatabase, kind: string): Promise<QueuedJob> {
  const job = await claimNext(seeded.db, SEED.workspaceId);
  if (!job) throw new Error(`no ${kind} job queued`);
  expect(job.kind).toBe(kind as QueuedJob['kind']);
  return job;
}

describe('parseDomainList', () => {
  test('reads a pasted list in any separator and drops repeats', () => {
    const parsed = parseDomainList(
      'https://www.ugig.net/jobs\nnichedb.dev, bl0ggers.com;  UGIG.NET\n\nnot a site\nmailto:x@y.com',
    );
    expect(parsed.domains).toEqual(['ugig.net', 'nichedb.dev', 'bl0ggers.com']);
    expect(parsed.invalid).toEqual(['not', 'a', 'site', 'mailto:x@y.com']);
  });

  test('accepts any real-looking TLD, since every entry is meant to be a site', () => {
    const parsed = parseDomainList(
      'phonenumbers.bot qrypt.chat goingbroke.now aiornot.vote agenticjobs.work mediaanalyzer.pro x.q',
    );
    expect(parsed.domains).toEqual([
      'phonenumbers.bot',
      'qrypt.chat',
      'goingbroke.now',
      'aiornot.vote',
      'agenticjobs.work',
      'mediaanalyzer.pro',
    ]);
    expect(parsed.invalid).toEqual(['x.q']);
  });

  test('takes an array as given', () => {
    expect(parseDomainList(['a.com', 'b.io', 'a.com']).domains).toEqual(['a.com', 'b.io']);
  });
});

describe('marketFromDraft', () => {
  test('joins the buyer profile into a market discovery can search', () => {
    const draft = JSON.parse(draftFor('Ugig', 'freelance marketplaces')) as ProfileDraft;
    expect(marketFromDraft(draft)).toBe(
      'freelance marketplaces companies with Founder, Head of Growth interested in indie hackers',
    );
  });

  test('falls back to the category when the profile names no industry', () => {
    const draft = JSON.parse(draftFor('X', 'ignored')) as ProfileDraft;
    const bare = { ...draft, icp: { ...draft.icp, industries: [], titles: [], keywords: [] } };
    expect(marketFromDraft(bare)).toBe('Companies that buy developer tooling');
  });
});

describe('POST /campaigns/bulk', () => {
  test('refuses up front when there is no model to read the sites', async () => {
    const { app, seeded } = await harness('bulk-no-model');
    const response = await post(app, '/campaigns/bulk', { domains: 'ugig.net' });

    expect(response.status).toBe(503);
    const jobs = await queryAll(seeded.db, `SELECT id FROM jobs WHERE kind = 'bootstrap_product'`);
    expect(jobs).toHaveLength(0);
  });

  test('rejects a list with no websites in it', async () => {
    const { app } = await harness('bulk-empty', new StubModel('{}'));
    const response = await post(app, '/campaigns/bulk', { domains: 'hello world' });

    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('none of those look like websites');
  });

  test('queues one job per new site and leaves existing products alone', async () => {
    const { app, seeded } = await harness('bulk-queue', new StubModel('{}'));

    await saveWorkspaceProfile(
      seeded.db,
      SEED.workspaceId,
      {
        url: 'https://www.nichedb.dev/',
        offering: {
          name: 'nichedb',
          category: 'directory',
          valuePropositions: [],
          likelyPains: [],
          competitors: [],
        },
        icp: {
          titles: [],
          seniorities: [],
          industries: [],
          technologies: [],
          keywords: [],
          exclusions: [],
        },
        voice: { style: 'plain' },
      },
      { create: true },
    );

    const response = await post(app, '/campaigns/bulk', {
      domains: 'ugig.net\nnichedb.dev\nbl0ggers.com\nnope',
      autopilot: true,
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.queued).toEqual(['ugig.net', 'bl0ggers.com']);
    expect(body.existing.map((p: { domain: string }) => p.domain)).toEqual(['nichedb.dev']);
    expect(body.invalid).toEqual(['nope']);

    // Progress per site comes from the existing batch view, keyed by URL.
    const batch = await (await app.request(`/api/v1/batches/${body.batchId}`)).json();
    expect(batch.total).toBe(2);
    expect(batch.items.map((i: { url: string }) => i.url)).toEqual([
      'https://ugig.net',
      'https://bl0ggers.com',
    ]);

    const payload = await queryOne<{ payload_json: string }>(
      seeded.db,
      `SELECT payload_json FROM jobs WHERE kind = 'bootstrap_product' LIMIT 1`,
    );
    expect(JSON.parse(payload!.payload_json).autopilot).toBe(true);
  });
});

describe('bootstrap_product job', () => {
  test('each site becomes its own product with a campaign already searching', async () => {
    const { seeded } = await harness('bulk-run');
    const model = new StubModel([
      draftFor('Ugig', 'freelance marketplaces'),
      draftFor('Bl0ggers', 'publishing'),
    ]);

    await queueBulkProducts(seeded.db, SEED.workspaceId, ['ugig.net', 'bl0ggers.com'], {
      autopilot: true,
    });

    const first = await runBootstrapProductJob(
      { db: seeded.db, model, site },
      await next(seeded, 'bootstrap_product'),
    );
    const second = await runBootstrapProductJob(
      { db: seeded.db, model, site },
      await next(seeded, 'bootstrap_product'),
    );

    expect(first.outcome).toBe('started');
    expect(second.outcome).toBe('started');
    expect(first.offeringId).not.toBe(second.offeringId);
    expect(first.campaignId).not.toBe(second.campaignId);

    const campaign = await queryOne<{
      name: string;
      seed_kind: string;
      seed_value: string;
      approval_mode: string;
      networks: string;
      offering_id: string;
    }>(
      seeded.db,
      `SELECT name, seed_kind, seed_value, approval_mode, networks, offering_id
         FROM campaigns WHERE id = ?`,
      [second.campaignId!],
    );
    expect(campaign).toMatchObject({
      name: 'Bl0ggers',
      seed_kind: 'keyword',
      approval_mode: 'trusted_automation',
      networks: '["website","email"]',
      offering_id: second.offeringId,
    });
    expect(campaign!.seed_value).toContain('publishing companies');

    const offering = await queryOne<{ url: string }>(
      seeded.db,
      'SELECT url FROM offerings WHERE id = ?',
      [second.offeringId!],
    );
    expect(offering!.url).toBe('https://bl0ggers.com');

    const discover = await queryAll<{ payload_json: string }>(
      seeded.db,
      `SELECT payload_json FROM jobs WHERE kind = 'discover_domains' ORDER BY created_at`,
    );
    expect(discover.map((j) => JSON.parse(j.payload_json).campaignId)).toEqual([
      first.campaignId,
      second.campaignId,
    ]);
  });

  test('running again finishes without a second copy of the product', async () => {
    const { seeded } = await harness('bulk-idempotent');
    const model = new StubModel(draftFor('Ugig', 'freelance marketplaces'));
    const deps = { db: seeded.db, model, site };
    const job: QueuedJob = {
      id: 'job_test',
      workspaceId: SEED.workspaceId,
      kind: 'bootstrap_product',
      payload: { domain: 'ugig.net' },
      attempts: 1,
      maxAttempts: 5,
    };

    const first = await runBootstrapProductJob(deps, job);
    const again = await runBootstrapProductJob(deps, job);

    expect(again.outcome).toBe('already_started');
    expect(again.offeringId).toBe(first.offeringId);
    expect(model.calls).toHaveLength(1);

    const offerings = await queryAll(seeded.db, 'SELECT id FROM offerings WHERE url = ?', [
      'https://ugig.net',
    ]);
    expect(offerings).toHaveLength(1);
  });

  test('without a model the job throws so the queue retries it', async () => {
    const { seeded } = await harness('bulk-job-no-model');
    const job: QueuedJob = {
      id: 'job_test',
      workspaceId: SEED.workspaceId,
      kind: 'bootstrap_product',
      payload: { domain: 'ugig.net' },
      attempts: 1,
      maxAttempts: 5,
    };

    await expect(runBootstrapProductJob({ db: seeded.db, site }, job)).rejects.toThrow('no model');
  });
});

describe('discovery for one of many products', () => {
  test('searches for buyers of that campaign’s product, not the workspace’s first', async () => {
    const { seeded } = await harness('bulk-discover-grounding');
    const setupModel = new StubModel([
      draftFor('Ugig', 'freelance marketplaces'),
      draftFor('Bl0ggers', 'publishing'),
    ]);

    await queueBulkProducts(seeded.db, SEED.workspaceId, ['ugig.net', 'bl0ggers.com']);
    await runBootstrapProductJob(
      { db: seeded.db, model: setupModel, site },
      await next(seeded, 'bootstrap_product'),
    );
    await runBootstrapProductJob(
      { db: seeded.db, model: setupModel, site },
      await next(seeded, 'bootstrap_product'),
    );

    await next(seeded, 'discover_domains');
    const second = await next(seeded, 'discover_domains');

    const discoverModel = new StubModel(JSON.stringify({ companies: [] }));
    await runDiscoveryJob({ db: seeded.db, model: discoverModel }, second).catch(() => undefined);

    expect(discoverModel.calls[0]?.user).toContain('Bl0ggers');
    expect(discoverModel.calls[0]?.user).not.toContain('Ugig');
  });
});
