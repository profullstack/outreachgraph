/**
 * The brain round trip over HTTP: export a product as markdown files, edit
 * them, import them back, and the voice the composer reads has changed.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { now, queryOne } from '@outreachgraph/db';
import { parseFrontmatter } from '@outreachgraph/domain';
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
  actor: RequestActor = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const stamp = now();
  await seeded.db.batch([
    {
      sql: `INSERT INTO voice_profiles (id, workspace_id, name, style, instructions, samples,
              max_words, prohibited_claims, created_at, updated_at)
            VALUES ('voi_test', ?, 'ExamplePay', 'plain', 'be brief', '["An old sample."]', 90,
              '[]', ?, ?)`,
      args: [SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `UPDATE campaigns SET voice_profile_id = 'voi_test' WHERE id = ?`,
      args: [SEED.campaignId],
    },
    {
      sql: `INSERT INTO campaign_filters (campaign_id, titles, countries, updated_at)
            VALUES (?, '["VP Engineering","CTO"]', '["US"]', ?)`,
      args: [SEED.campaignId, stamp],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
              state, body, occurred_at, recorded_at, reply_label, reply_label_reason)
            VALUES ('int_q', ?, ?, ?, 'email', 'inbound', 'received', ?, '2026-10-01T10:00:00Z', ?,
              'question', 'asks whether Acme can use it')`,
      args: [
        SEED.workspaceId,
        SEED.personId,
        SEED.campaignId,
        'Hi Test, does this work for Acme in Brazil? Jane Smith, jane@acme.com, +1 415 555 0100',
        stamp,
      ],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
              state, body, occurred_at, recorded_at, reply_label, reply_label_reason)
            VALUES ('int_yes', ?, ?, ?, 'email', 'inbound', 'received', 'Yes please.',
              '2026-10-02T10:00:00Z', ?, 'interested', 'wants a call')`,
      args: [SEED.workspaceId, SEED.personId, SEED.campaignId, stamp],
    },
  ]);

  return { app: createApp({ db: seeded.db, authenticate: async () => actor }), seeded };
}

async function getBrain(app: Hono<AppEnv>, query = '') {
  const response = await app.request(`/api/v1/products/${SEED.offeringId}/brain${query}`);
  return {
    status: response.status,
    body: (await response.json()) as { files: Record<string, string> },
  };
}

function put(app: Hono<AppEnv>, body: unknown, id: string = SEED.offeringId) {
  return app.request(`/api/v1/products/${id}/brain`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /products/:id/brain', () => {
  test('exports the four knowledge files', async () => {
    const { app } = await harness('brain-export');
    const { status, body } = await getBrain(app);
    expect(status).toBe(200);
    expect(Object.keys(body.files).sort()).toEqual([
      'knowledge/audience.md',
      'knowledge/objections.md',
      'knowledge/positioning.md',
      'knowledge/voice.md',
    ]);
    expect(parseFrontmatter(body.files['knowledge/positioning.md']!).data.product).toBe(
      'ExamplePay',
    );
    expect(body.files['knowledge/voice.md']).toContain('> An old sample.');
    expect(body.files['knowledge/audience.md']).toContain('- VP Engineering\n- CTO');
  });

  test('objections carry the reason and a redacted excerpt, never names or emails', async () => {
    const { app } = await harness('brain-objections');
    const objections = (await getBrain(app)).body.files['knowledge/objections.md']!;
    expect(objections).toContain('## Questions (1)');
    expect(objections).not.toContain('wants a call');
    expect(objections).toContain('**asks whether [name] can use it**');
    expect(objections).toContain('"does this work for [name] in Brazil?"');
    for (const leak of ['Jane', 'Smith', 'Acme', 'acme.com', '555', 'Test User']) {
      expect(objections).not.toContain(leak);
    }
  });

  test('a slug nests the paths', async () => {
    const { app } = await harness('brain-slug');
    const { body } = await getBrain(app, '?slug=examplepay');
    expect(Object.keys(body.files)).toContain('knowledge/examplepay/voice.md');
  });

  test('another workspace’s product is not found', async () => {
    const { app } = await harness('brain-404');
    const response = await app.request('/api/v1/products/off_other/brain');
    expect(response.status).toBe(404);
  });
});

describe('PUT /products/:id/brain', () => {
  test('edited files write the offering and the voice, samples and claims included', async () => {
    const { app, seeded } = await harness('brain-import');
    const { files } = (await getBrain(app)).body;
    const edited = {
      ...files,
      'knowledge/positioning.md': files['knowledge/positioning.md']!.replace(
        '## Competitors\n\n_None yet._',
        '## Competitors\n\n- Stripe\n- Wise',
      ),
      'knowledge/voice.md': files['knowledge/voice.md']!.replace(
        '> An old sample.',
        '> A new sample.\n\n> And another.',
      ).replace('## Never claim\n\n_None yet._', '## Never claim\n\n- instant settlement'),
    };

    const response = await put(app, { files: edited });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { product: string[]; voice: string[] };
    expect(result.product).toEqual(['competitors']);
    expect(result.voice.sort()).toEqual(['prohibited_claims', 'samples']);

    const offering = await queryOne<{ competitors: string; name: string }>(
      seeded.db,
      'SELECT name, competitors FROM offerings WHERE id = ?',
      [SEED.offeringId],
    );
    expect(JSON.parse(offering!.competitors)).toEqual(['Stripe', 'Wise']);
    expect(offering!.name).toBe('ExamplePay');

    const voice = await queryOne<{ samples: string; prohibited_claims: string; style: string }>(
      seeded.db,
      "SELECT samples, prohibited_claims, style FROM voice_profiles WHERE id = 'voi_test'",
    );
    expect(JSON.parse(voice!.samples)).toEqual(['A new sample.', 'And another.']);
    expect(JSON.parse(voice!.prohibited_claims)).toEqual(['instant settlement']);
    expect(voice!.style).toBe('plain');
  });

  test('re-importing an unchanged export changes nothing', async () => {
    const { app } = await harness('brain-noop');
    const { files } = (await getBrain(app)).body;
    const result = (await (await put(app, { files })).json()) as {
      product: string[];
      voice: string[];
    };
    expect(result.product).toEqual([]);
    expect(result.voice).toEqual([]);
  });

  test('rejects files with no knowledge in them and lists that break the limits', async () => {
    const { app } = await harness('brain-invalid');
    expect((await put(app, { files: { 'README.md': '# hi' } })).status).toBe(400);
    const many = Array.from({ length: 30 }, (_, i) => `- claim ${i}`).join('\n');
    const response = await put(app, {
      files: { 'knowledge/voice.md': `---\nstyle: plain\n---\n## Never claim\n\n${many}\n` },
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: Record<string, string[]> } };
    expect(Object.keys(body.error.details)).toContain('voice.prohibitedClaims');
  });

  test('a viewer may read but not write', async () => {
    const { app } = await harness('brain-viewer', { ...ACTOR, role: 'viewer' });
    expect((await getBrain(app)).status).toBe(200);
    expect((await put(app, { files: {} })).status).toBe(403);
  });
});
