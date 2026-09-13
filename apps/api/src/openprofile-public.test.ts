/**
 * A person's OpenProfile.md, public and corrected.
 *
 * What has to hold: a profile is private until switched on, and then it is
 * listed and served to anybody minus email and phone; a suppressed person is
 * never listed even when the switch is on; the owner's corrections win over
 * the generator section by section and survive a regeneration; a whole
 * edited file and a JSON overlay store the same thing; and a bearer edits
 * only when it carries the scope and is provably the person.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import type { BearerClaims } from './openprofile';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};

const GENERATED = [
  '# Jane Doe',
  '',
  '- **Kind**: person',
  '- **Handle**: @jane',
  '- **Web**: https://jane.example',
  '- **Email**: jane@example.com',
  '- **Avatar**: https://jane.example/jane.png',
  '',
  'Builds payment rails.',
  '',
  '## Accounts',
  '',
  '- [GitHub](https://github.com/jane)',
  '- [Email](mailto:jane@example.com)',
  '',
  '## Topics',
  '',
  '- payments',
  '',
  '## Contact',
  '',
  '- Phone: +1 555 0100',
  '',
].join('\n');

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

interface Harness {
  app: Hono<AppEnv>;
  seeded: SeededDatabase;
}

async function harness(
  label: string,
  options: {
    anonymous?: boolean;
    bearer?: (token: string) => Promise<BearerClaims | undefined>;
  } = {},
): Promise<Harness> {
  const seeded = await seedDatabase(label);
  active = seeded;
  await seeded.db.execute({
    sql: `INSERT INTO openprofiles (person_id, markdown, sources_json, published_url, generated_at)
          VALUES (?, ?, '[]', NULL, ?)`,
    args: [SEED.personId, GENERATED, '2026-09-13T00:00:00.000Z'],
  });
  const app = createApp({
    db: seeded.db,
    apiUrl: 'https://og.test',
    authenticate: async (request) =>
      options.anonymous || request.headers.get('x-anonymous') === '1' ? undefined : ACTOR,
    ...(options.bearer ? { verifyBearer: options.bearer } : {}),
  });
  return { app, seeded };
}

const get = (app: Hono<AppEnv>, path: string, headers: Record<string, string> = {}) =>
  app.request(`/api/v1${path}`, { headers });
const post = (app: Hono<AppEnv>, path: string, body: unknown = {}) =>
  app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const putJson = (
  app: Hono<AppEnv>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  app.request(`/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
const putMarkdown = (
  app: Hono<AppEnv>,
  path: string,
  body: string,
  headers: Record<string, string> = {},
) =>
  app.request(`/api/v1${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers },
    body,
  });

const ANON = { 'x-anonymous': '1' };
const profilePath = `/people/${SEED.personId}/openprofile`;

describe('public profiles', () => {
  test('private until switched on; then listed and served to anybody without email or phone', async () => {
    const { app } = await harness('openprofile-public-flip');

    // Nobody: a 404 that says nothing about whether the person exists.
    expect((await get(app, `${profilePath}.md`, ANON)).status).toBe(404);
    expect((await get(app, '/openprofiles', ANON)).json()).resolves.toEqual({
      openprofiles: [],
      next: null,
    });

    // The workspace that holds her still reads the whole thing.
    const held = await get(app, `${profilePath}.md`);
    expect(held.status).toBe(200);
    expect(await held.text()).toContain('jane@example.com');

    const published = await post(app, `${profilePath}/publish`, { public: true });
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({
      public: true,
      url: `https://og.test/api/v1/people/${SEED.personId}/openprofile.md`,
    });

    const open = await get(app, `${profilePath}.md`, ANON);
    expect(open.status).toBe(200);
    expect(open.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(open.headers.get('access-control-allow-origin')).toBe('*');
    const markdown = await open.text();
    expect(markdown).toContain('# Jane Doe');
    expect(markdown).toContain('- [GitHub](https://github.com/jane)');
    expect(markdown).not.toContain('jane@example.com');
    expect(markdown).not.toContain('mailto:');
    expect(markdown).not.toContain('Phone');
    expect(markdown).not.toContain('## Contact');

    const listing = await (await get(app, '/openprofiles', ANON)).json();
    expect(listing.next).toBeNull();
    expect(listing.openprofiles).toHaveLength(1);
    expect(listing.openprofiles[0]).toMatchObject({
      id: SEED.personId,
      name: 'Jane Doe',
      url: `https://og.test/api/v1/people/${SEED.personId}/openprofile.md`,
      accounts: ['https://github.com/jane'],
      web: 'https://jane.example',
    });

    // The detail says so, for the operator's screen.
    const detail = await (await get(app, `/people/${SEED.personId}`)).json();
    expect(detail.openprofile.public).toBe(true);

    // And back to private: gone from the listing, 404 again.
    expect((await post(app, `${profilePath}/publish`, { public: false })).status).toBe(200);
    expect((await get(app, `${profilePath}.md`, ANON)).status).toBe(404);
    expect((await (await get(app, '/openprofiles', ANON)).json()).openprofiles).toEqual([]);
  });

  test('a suppressed person is never public, even with the switch on', async () => {
    const { app, seeded } = await harness('openprofile-public-suppressed');
    expect((await post(app, `${profilePath}/publish`, { public: true })).status).toBe(200);
    await seeded.db.execute({
      sql: "UPDATE people SET status = 'suppressed' WHERE id = ?",
      args: [SEED.personId],
    });
    expect((await get(app, `${profilePath}.md`, ANON)).status).toBe(404);
    expect((await (await get(app, '/openprofiles', ANON)).json()).openprofiles).toEqual([]);
    // Switching it on again for a suppressed person is refused outright.
    await seeded.db.execute({
      sql: 'DELETE FROM openprofile_settings WHERE person_id = ?',
      args: [SEED.personId],
    });
    expect((await post(app, `${profilePath}/publish`, { public: true })).status).toBe(409);
  });

  test('the listing pages by cursor and filters by since', async () => {
    const { app, seeded } = await harness('openprofile-public-paging');
    // A second public person, held by the workspace.
    await seeded.db.batch([
      {
        sql: `INSERT INTO people (id, display_name, identity_confidence, status, created_at, updated_at)
              VALUES ('per_bob', 'Bob', 0.5, 'active', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z')`,
        args: [],
      },
      {
        sql: `INSERT INTO openprofiles (person_id, markdown, sources_json, published_url, generated_at)
              VALUES ('per_bob', '# Bob\n\n- **Kind**: person\n', '[]', NULL, '2026-09-12T00:00:00.000Z')`,
        args: [],
      },
      {
        sql: `INSERT INTO openprofile_settings (person_id, public, overrides_json, updated_at)
              VALUES ('per_bob', 1, '{}', '2026-09-12T00:00:00.000Z')`,
        args: [],
      },
      {
        sql: `INSERT INTO openprofile_settings (person_id, public, overrides_json, updated_at)
              VALUES (?, 1, '{}', '2026-09-14T00:00:00.000Z')`,
        args: [SEED.personId],
      },
    ]);
    const first = await (await get(app, '/openprofiles?limit=1', ANON)).json();
    expect(first.openprofiles.map((p: { id: string }) => p.id)).toEqual([SEED.personId]);
    expect(first.next).toBeTruthy();
    const second = await (
      await get(app, `/openprofiles?limit=1&cursor=${first.next}`, ANON)
    ).json();
    expect(second.openprofiles.map((p: { id: string }) => p.id)).toEqual(['per_bob']);
    expect(second.next).toBeNull();
    const since = await (
      await get(app, '/openprofiles?since=2026-09-13T12:00:00.000Z', ANON)
    ).json();
    expect(since.openprofiles.map((p: { id: string }) => p.id)).toEqual([SEED.personId]);
  });
});

describe('corrections', () => {
  test("the owner's sections win, the rest is still generated, and a regeneration keeps them", async () => {
    const { app, seeded } = await harness('openprofile-overrides');

    const patched = await putJson(app, profilePath, {
      headline: 'Payments, from the rails up.',
      identity: { Location: 'Lisbon', Email: null },
      sections: { topics: '- payments\n- rails', contact: 'none', guest: '- **Available**: yes' },
    });
    expect(patched.status).toBe(200);
    const body = await patched.json();
    expect(body.editedBy).toBe('operator');
    expect(body.markdown).toContain('Payments, from the rails up.');
    expect(body.markdown).toContain('- **Location**: Lisbon');
    expect(body.markdown).not.toContain('- **Email**');
    expect(body.markdown).toContain('- rails');
    expect(body.markdown).not.toContain('## Contact');
    expect(body.markdown).toContain('## Guest');
    // Untouched: still generated.
    expect(body.markdown).toContain('- [GitHub](https://github.com/jane)');

    // The job rewrites the generated file; the corrections stand.
    await seeded.db.execute({
      sql: 'UPDATE openprofiles SET markdown = ?, generated_at = ? WHERE person_id = ?',
      args: [
        GENERATED.replace('Builds payment rails.', 'Regenerated.'),
        '2026-09-15T00:00:00.000Z',
        SEED.personId,
      ],
    });
    const after = await (await get(app, `${profilePath}.md`)).text();
    expect(after).toContain('Payments, from the rails up.');
    expect(after).not.toContain('Regenerated.');
    expect(after).toContain('- **Location**: Lisbon');
  });

  test('a whole edited file stores the same overlay as JSON, and public and handle ride along', async () => {
    const { app } = await harness('openprofile-markdown-put');
    const edited = GENERATED.replace('Builds payment rails.', 'Countess of payments.').replace(
      '- payments',
      '- payments\n- ledgers',
    );
    const saved = await putMarkdown(app, profilePath, edited);
    expect(saved.status).toBe(200);
    const body = await saved.json();
    expect(body.markdown).toContain('Countess of payments.');
    expect(body.markdown).toContain('- ledgers');

    const flagged = await putJson(app, profilePath, { public: true, handle: '@Jane.Doe' });
    expect(flagged.status).toBe(200);
    expect(await flagged.json()).toMatchObject({ public: true, handle: 'jane.doe' });
    expect((await putJson(app, profilePath, { handle: 'x' })).status).toBe(400);
    expect((await putJson(app, profilePath, {})).status).toBe(400);
    expect((await putMarkdown(app, profilePath, '   ')).status).toBe(400);

    const detail = await (await get(app, `/people/${SEED.personId}`)).json();
    expect(detail.openprofile).toMatchObject({ public: true, handle: 'jane.doe' });
  });

  test('a bearer edits only with the scope and only as the person', async () => {
    const tokens: Record<string, BearerClaims> = {
      jane: { sub: 'oa_jane', scope: 'openid email openprofile:edit', email: 'Jane@Example.com' },
      noscope: { sub: 'oa_jane', scope: 'openid email', email: 'jane@example.com' },
      stranger: { sub: 'oa_x', scope: 'openprofile:edit', email: 'x@example.com' },
    };
    const { app, seeded } = await harness('openprofile-bearer', {
      bearer: async (token) => tokens[token],
    });
    const bearer = (token: string) => ({ ...ANON, authorization: `Bearer ${token}` });

    // Nothing verified for her yet: even the right email is not proof.
    expect((await putJson(app, profilePath, { headline: 'x' }, bearer('jane'))).status).toBe(403);

    await seeded.db.execute({
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source, verified, created_at)
            VALUES ('pem_1', ?, ?, 'jane@example.com', 'jane@example.com', 'import', 1, ?)`,
      args: [SEED.workspaceId, SEED.personId, '2026-09-13T00:00:00.000Z'],
    });

    expect((await putJson(app, profilePath, { headline: 'x' }, bearer('noscope'))).status).toBe(
      403,
    );
    expect((await putJson(app, profilePath, { headline: 'x' }, bearer('stranger'))).status).toBe(
      403,
    );
    expect((await putJson(app, profilePath, { headline: 'x' }, bearer('nonsense'))).status).toBe(
      401,
    );

    const own = await putJson(app, profilePath, { headline: 'In my own words.' }, bearer('jane'));
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body.editedBy).toBe('subject');
    expect(body.markdown).toContain('In my own words.');
    // The person sees the public view of their own file, so what they check is what strangers get.
    expect(body.markdown).not.toContain('jane@example.com');

    // The first edit by the person is their claim.
    const detail = await (await get(app, `/people/${SEED.personId}`)).json();
    expect(detail.openprofile.claimedAt).toBeTruthy();
  });
});
