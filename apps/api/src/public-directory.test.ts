/**
 * The public directory, and the line it holds.
 *
 * Two things matter here. That the route is reachable with no session and no
 * token at all, since its reader has neither. And that what it says is exactly
 * the public half: a company by its domain, a person only when they publish
 * their own profile, and never an address, a location, a score or a workspace.
 * The withholding tests are the ones that must not be loosened.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv } from './context';
import {
  FixedWindowLimiter,
  companyTopics,
  decodeCursor,
  encodeCursor,
  listPublicDirectory,
  topicsFromOpenProfile,
} from './public-directory';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const T0 = '2026-09-01T00:00:00.000Z';
const T1 = '2026-09-02T00:00:00.000Z';
const T2 = '2026-09-03T00:00:00.000Z';

/** An app whose authentication answers nobody, which is what a public reader is. */
async function harness(
  label: string,
  limiter?: FixedWindowLimiter,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => undefined,
    ...(limiter ? { publicDirectoryLimiter: limiter } : {}),
  });
  return { app, seeded };
}

async function get(app: Hono<AppEnv>, query = ''): Promise<Response> {
  return app.request(`/api/v1/public/directory${query}`);
}

interface PersonFixture {
  id: string;
  name: string;
  status?: string;
  kind?: string;
  publishedUrl?: string | null;
  corroborated?: boolean;
  markdown?: string;
  updatedAt?: string;
}

async function person(seeded: SeededDatabase, p: PersonFixture): Promise<void> {
  const stamp = p.updatedAt ?? T1;
  await seeded.db.execute({
    sql: `INSERT INTO people (id, display_name, current_company_id, current_title, location,
          identity_confidence, status, kind, outreach_eligible, believed_minor, created_at, updated_at)
          VALUES (?, ?, ?, 'Maintainer', 'Lisbon, Portugal', 0.9, ?, ?, 1, 0, ?, ?)`,
    args: [p.id, p.name, SEED.companyId, p.status ?? 'active', p.kind ?? 'person', stamp, stamp],
  });
  if (p.publishedUrl !== undefined || p.corroborated !== undefined || p.markdown) {
    await seeded.db.execute({
      sql: `INSERT INTO openprofiles (person_id, markdown, sources_json, published_url, corroborated, generated_at)
            VALUES (?, ?, '[]', ?, ?, ?)`,
      args: [
        p.id,
        p.markdown ?? `# ${p.name}\n\n- **Kind**: person\n- **Handle**: @${p.id}\n`,
        p.publishedUrl ?? null,
        p.corroborated ? 1 : 0,
        stamp,
      ],
    });
  }
}

async function identity(
  seeded: SeededDatabase,
  personId: string,
  network: string,
  handle: string,
  profileUrl: string | null,
  confidence = 0.9,
): Promise<void> {
  await seeded.db.execute({
    sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id, profile_url,
          confidence, source_type, verified_by, first_seen_at, last_verified_at)
          VALUES (?, ?, ?, ?, NULL, ?, ?, 'public_web', '[]', ?, ?)`,
    args: [`sid_${personId}_${network}`, personId, network, handle, profileUrl, confidence, T1, T1],
  });
}

describe('public directory', () => {
  test('answers without a session or token, cacheable for five minutes', async () => {
    const { app } = await harness('dir-keyless');
    const response = await get(app);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('access-control-allow-origin')).toBe('*');

    const body = (await response.json()) as { items: unknown[]; next: string | null };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.next).toBeNull();
  });

  test('lists a crawled company by its domain, with industry and technologies as topics', async () => {
    const { app, seeded } = await harness('dir-company');
    await seeded.db.execute({
      sql: `UPDATE companies SET technologies = '["Postgres", "bun"]', contact_email = 'hello@acme.com',
            location = '1 Market St, San Francisco' WHERE id = ?`,
      args: [SEED.companyId],
    });

    const body = (await (await get(app)).json()) as { items: Record<string, unknown>[] };
    const acme = body.items.find((item) => item.id === SEED.companyId);

    expect(acme).toEqual({
      id: SEED.companyId,
      kind: 'company',
      name: 'Acme',
      url: 'https://acme.com',
      description: null,
      topics: ['saas', 'postgres', 'bun'],
      country: null,
      openprofile: null,
      updated: expect.any(String),
    });
  });

  test('a row named only after its domain is a site, not a company', async () => {
    const { app, seeded } = await harness('dir-site');
    await seeded.db.execute({
      sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
            VALUES ('co_site', 'example.org', 'example.org', '[]', ?, ?)`,
      args: [T1, T1],
    });

    const body = (await (await get(app)).json()) as { items: Record<string, unknown>[] };
    const site = body.items.find((item) => item.id === 'co_site');

    expect(site?.kind).toBe('site');
    expect(site?.url).toBe('https://example.org');
  });

  test('a company without a domain is not listed', async () => {
    const { app, seeded } = await harness('dir-nodomain');
    await seeded.db.execute({
      sql: `INSERT INTO companies (id, name, domain, technologies, created_at, updated_at)
            VALUES ('co_ghost', 'Ghost Ltd', NULL, '[]', ?, ?)`,
      args: [T1, T1],
    });

    const body = (await (await get(app)).json()) as { items: { id: string }[] };
    expect(body.items.map((item) => item.id)).not.toContain('co_ghost');
  });

  test('a person is listed only when they publish their own profile', async () => {
    const { app, seeded } = await harness('dir-people');

    // The seeded Jane has no OpenProfile at all: a prospect, not a publisher.
    await person(seeded, {
      id: 'per_assembled',
      name: 'Assembled Only',
      publishedUrl: null,
      corroborated: false,
    });
    await person(seeded, {
      id: 'per_published',
      name: 'Ada Publishes',
      publishedUrl: 'https://ada.example/.well-known/openprofile.md',
      markdown:
        '# Ada\n\n- **Handle**: @ada\n- **Email**: ada@example.com\n\n## Topics\n\n- #rust, distributed systems, Rust\n',
    });
    await identity(seeded, 'per_published', 'website', 'ada.example', 'https://ada.example');
    await identity(seeded, 'per_published', 'email', 'ada@example.com', null);
    await person(seeded, { id: 'per_relme', name: 'Rel Me', corroborated: true });
    await identity(
      seeded,
      'per_relme',
      'mastodon',
      'rel@hachyderm.io',
      'https://hachyderm.io/@rel',
    );
    await person(seeded, {
      id: 'per_suppressed',
      name: 'Opted Out',
      publishedUrl: 'https://gone.example/.well-known/openprofile.md',
      status: 'suppressed',
    });
    await person(seeded, {
      id: 'per_inbox',
      name: 'Acme team',
      kind: 'company_inbox',
      corroborated: true,
    });

    const body = (await (await get(app)).json()) as { items: Record<string, unknown>[] };
    const ids = body.items.map((item) => item.id);

    expect(ids).toContain('per_published');
    expect(ids).toContain('per_relme');
    expect(ids).not.toContain(SEED.personId);
    expect(ids).not.toContain('per_assembled');
    expect(ids).not.toContain('per_suppressed');
    expect(ids).not.toContain('per_inbox');

    const ada = body.items.find((item) => item.id === 'per_published');
    expect(ada).toEqual({
      id: 'per_published',
      kind: 'person',
      name: 'Ada Publishes',
      url: 'https://ada.example',
      description: 'Maintainer at Acme',
      topics: ['rust', 'distributed systems'],
      country: null,
      openprofile: 'https://ada.example/.well-known/openprofile.md',
      updated: T1,
    });

    const rel = body.items.find((item) => item.id === 'per_relme');
    expect(rel?.url).toBe('https://hachyderm.io/@rel');
    expect(rel?.openprofile).toBeNull();
  });

  test('never carries an address, a location, a score or a workspace', async () => {
    const { app, seeded } = await harness('dir-withheld');
    await seeded.db.execute({
      sql: `UPDATE companies SET contact_email = 'support@acme.com', location = '1 Market St' WHERE id = ?`,
      args: [SEED.companyId],
    });
    await person(seeded, {
      id: 'per_published',
      name: 'Ada Publishes',
      publishedUrl: 'https://ada.example/.well-known/openprofile.md',
      markdown: '# Ada\n\n- **Email**: ada@example.com\n\n## Topics\n\n- rust\n',
    });
    await identity(seeded, 'per_published', 'email', 'ada@example.com', null);

    const text = await (await get(app)).text();

    expect(text).not.toContain('@acme.com');
    expect(text).not.toContain('ada@example.com');
    expect(text).not.toContain('Market St');
    expect(text).not.toContain('Lisbon');
    expect(text).not.toContain(SEED.workspaceId);
    expect(text).not.toContain('identity_confidence');
    expect(text).not.toContain('score');

    const body = JSON.parse(text) as { items: Record<string, unknown>[] };
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual([
        'country',
        'description',
        'id',
        'kind',
        'name',
        'openprofile',
        'topics',
        'updated',
        'url',
      ]);
    }
  });

  test('pages by cursor without repeating or skipping, and filters by since', async () => {
    const { app, seeded } = await harness('dir-paging');
    await seeded.db.execute({
      sql: `UPDATE companies SET updated_at = ? WHERE id = ?`,
      args: [T0, SEED.companyId],
    });
    await person(seeded, {
      id: 'per_a',
      name: 'A',
      publishedUrl: 'https://a.example/.well-known/openprofile.md',
      updatedAt: T1,
    });
    await person(seeded, {
      id: 'per_b',
      name: 'B',
      publishedUrl: 'https://b.example/.well-known/openprofile.md',
      updatedAt: T2,
    });

    const first = (await (await get(app, '?limit=2')).json()) as {
      items: { id: string; updated: string }[];
      next: string | null;
    };
    expect(first.items.map((item) => item.id)).toEqual([SEED.companyId, 'per_a']);
    expect(first.next).not.toBeNull();

    const second = (await (await get(app, `?limit=2&cursor=${first.next}`)).json()) as {
      items: { id: string }[];
      next: string | null;
    };
    expect(second.items.map((item) => item.id)).toEqual(['per_b']);
    expect(second.next).toBeNull();

    const since = (await (await get(app, `?since=${encodeURIComponent(T1)}`)).json()) as {
      items: { id: string }[];
    };
    expect(since.items.map((item) => item.id)).toEqual(['per_a', 'per_b']);
  });

  test('refuses a malformed since or cursor rather than guessing', async () => {
    const { app } = await harness('dir-bad-input');

    const since = await get(app, '?since=yesterday');
    expect(since.status).toBe(400);

    const cursor = await get(app, '?cursor=not-a-cursor');
    expect(cursor.status).toBe(400);
  });

  test('throttles a caller who exceeds the window and says when to retry', async () => {
    const limiter = new FixedWindowLimiter(2, 60_000);
    const { app } = await harness('dir-throttle', limiter);

    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(200);
    const third = await get(app);
    expect(third.status).toBe(429);
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);

    const other = await app.request('/api/v1/public/directory', {
      headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' },
    });
    expect(other.status).toBe(200);
  });

  test('other routes stay authenticated', async () => {
    const { app } = await harness('dir-guard');
    const response = await app.request('/api/v1/prospects');
    expect(response.status).toBe(401);
  });
});

describe('directory helpers', () => {
  test('the cursor round-trips and rejects nonsense', () => {
    const cursor = encodeCursor(T1, 'co_x');
    expect(decodeCursor(cursor)).toEqual({ updated: T1, id: 'co_x' });
    expect(() => decodeCursor('')).toThrow();
    expect(() => decodeCursor(Buffer.from('no-separator').toString('base64url'))).toThrow();
    expect(() => decodeCursor(Buffer.from('nope|co_x').toString('base64url'))).toThrow();
  });

  test('company topics merge industry and technologies, lower-cased and unique', () => {
    expect(companyTopics('SaaS', '["Postgres", "saas", 7, "  "]')).toEqual(['saas', 'postgres']);
    expect(companyTopics(null, 'not json')).toEqual([]);
    expect(companyTopics(null, null)).toEqual([]);
  });

  test('topics are read from the Topics section only', () => {
    expect(topicsFromOpenProfile('# X\n\n- **Email**: x@y.z\n\n## Topics\n\n- #A, b ,B\n')).toEqual(
      ['a', 'b'],
    );
    expect(topicsFromOpenProfile('# X\n\n## Links\n\n- [a](https://a)\n')).toEqual([]);
    expect(topicsFromOpenProfile(null)).toEqual([]);
  });

  test('the limiter resets when the window ends', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(1, 1000, () => now);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a')).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    now = 1000;
    expect(limiter.take('a').allowed).toBe(true);
  });

  test('the query helper defaults and clamps the limit', async () => {
    const seeded = await seedDatabase('dir-limit');
    active = seeded;
    const page = await listPublicDirectory(seeded.db, { limit: 0 });
    expect(page.items.length).toBeLessThanOrEqual(1);
    const wide = await listPublicDirectory(seeded.db, { limit: 10_000 });
    expect(wide.next).toBeNull();
  });
});
