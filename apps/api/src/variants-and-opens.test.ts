/**
 * A/B variants on cadence steps and the open pixel, through the HTTP surface.
 *
 * The pixel is the second route a stranger reaches without a session, so it
 * gets the same scrutiny as the link redirect: it must answer with an image
 * whatever the token, and never reveal which tokens exist.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { newId } from '@outreachgraph/domain';
import { queryAll, queryOne } from '@outreachgraph/db';
import { enrollInCadence, issueOpenPixel, runCadences } from '@outreachgraph/pipeline';
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

async function harness(label: string): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;

  const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
  return { app, seeded };
}

function json(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('GET /o/:file', () => {
  test('answers with a GIF and records the fetch', async () => {
    const { app, seeded } = await harness('pixel-known');
    const url = await issueOpenPixel(seeded.db, {
      workspaceId: SEED.workspaceId,
      personId: SEED.personId,
      origin: 'https://app.test',
    });
    const path = new URL(url!).pathname;

    const response = await app.request(path, { headers: { 'user-agent': 'Mozilla/5.0' } });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 6))).toBe('GIF89a');

    expect(await queryAll(seeded.db, 'SELECT id FROM email_opens')).toHaveLength(1);
  });

  test('answers an unknown token exactly like a known one', async () => {
    const { app } = await harness('pixel-unknown');

    const response = await app.request('/o/opx_doesnotexist.gif');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/gif');
  });
});

describe('settings', () => {
  test('open tracking is off until switched on, and survives a round trip', async () => {
    const { app } = await harness('settings-opens');

    const before = (await (await app.request('/api/v1/settings')).json()) as {
      trackOpens: boolean;
    };
    expect(before.trackOpens).toBe(false);

    const saved = await app.request('/api/v1/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trackOpens: true }),
    });
    expect(saved.status).toBe(200);

    const after = (await (await app.request('/api/v1/settings')).json()) as {
      trackOpens: boolean;
    };
    expect(after.trackOpens).toBe(true);
  });
});

describe('cadence variants', () => {
  test('stores variants and returns them with the plan', async () => {
    const { app } = await harness('variants-roundtrip');

    const created = await app.request(
      '/api/v1/cadences',
      json({
        name: 'Tested plan',
        steps: [
          {
            network: 'email',
            action: 'send_email',
            delayHours: 0,
            intent: 'reference their post',
            variants: ['ask who owns onboarding'],
          },
        ],
      }),
    );
    expect(created.status).toBe(201);
    const { cadenceId } = (await created.json()) as { cadenceId: string };

    const detail = (await (await app.request(`/api/v1/cadences/${cadenceId}`)).json()) as {
      steps: Array<{ intent: string; variants: string[] }>;
    };
    expect(detail.steps[0]?.variants).toEqual(['ask who owns onboarding']);
  });

  test('refuses variants with no intent, in words', async () => {
    const { app } = await harness('variants-refused');

    const response = await app.request(
      '/api/v1/cadences',
      json({
        name: 'Bad plan',
        steps: [{ network: 'email', action: 'send_email', variants: ['something'] }],
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { details: { steps: string[] } } };
    expect(body.error.details.steps.join(' ')).toContain('the intent is variant A');
  });

  test('reports sends and replies per arm', async () => {
    const { app, seeded } = await harness('variants-report');
    const { db } = seeded;

    const created = await app.request(
      '/api/v1/cadences',
      json({
        name: 'Reported plan',
        campaignId: SEED.campaignId,
        status: 'active',
        steps: [
          {
            network: 'email',
            action: 'send_email',
            delayHours: 0,
            intent: 'reference their post',
            variants: ['ask who owns onboarding'],
          },
        ],
      }),
    );
    const { cadenceId } = (await created.json()) as { cadenceId: string };

    const enrolledAt = new Date('2026-08-18T09:00:00.000Z');
    await enrollInCadence(db, {
      cadenceId,
      workspaceId: SEED.workspaceId,
      campaignId: SEED.campaignId,
      personId: SEED.personId,
      at: enrolledAt,
    });
    await runCadences(
      { db, platformEmailEnabled: true, now: new Date(enrolledAt.getTime() + 1000) },
      SEED.workspaceId,
    );

    const card = await queryOne<{ id: string; variant: string }>(
      db,
      "SELECT id, variant FROM recommendations WHERE reason LIKE 'Cadence step%'",
    );
    expect(card?.variant).toMatch(/^[AB]$/);

    // The send, then a reply after it.
    await db.execute({
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, created_at, executed_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'completed', ?, ?)`,
      args: [
        newId('action'),
        SEED.workspaceId,
        card!.id,
        SEED.personId,
        '2026-08-18T10:00:00.000Z',
        '2026-08-18T10:00:00.000Z',
      ],
    });
    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, network, direction, state,
            occurred_at, recorded_at)
            VALUES (?, ?, ?, 'email', 'inbound', 'replied', ?, ?)`,
      args: [
        newId('interaction'),
        SEED.workspaceId,
        SEED.personId,
        '2026-08-19T08:00:00.000Z',
        '2026-08-19T08:00:00.000Z',
      ],
    });

    const report = (await (await app.request(`/api/v1/cadences/${cadenceId}/variants`)).json()) as {
      variants: Array<{
        step: number;
        variant: string;
        sent: number;
        replied: number;
        replyRate: number;
      }>;
    };

    expect(report.variants).toEqual([
      {
        step: 0,
        variant: card!.variant,
        assigned: 1,
        sent: 1,
        opened: 0,
        clicked: 0,
        replied: 1,
        replyRate: 1,
      } as never,
    ]);
  });

  test('does not show another workspace its report', async () => {
    const { app } = await harness('variants-foreign');
    const response = await app.request('/api/v1/cadences/cad_someoneelse/variants');
    expect(response.status).toBe(404);
  });
});
