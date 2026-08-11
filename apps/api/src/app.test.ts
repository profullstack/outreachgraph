import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
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

/**
 * `null` means "no authenticated caller". It is deliberately not `undefined`,
 * because an explicit `undefined` would fall back to the default parameter and
 * silently authenticate the request.
 */
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

async function get(app: Hono<AppEnv>, path: string): Promise<Response> {
  return app.request(`/api/v1${path}`);
}

async function post(app: Hono<AppEnv>, path: string, body: unknown = {}): Promise<Response> {
  return app.request(`/api/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('root', () => {
  test('the front door says what is running rather than 404ing', async () => {
    const { app } = await harness('root-index');
    const response = await app.request('/');

    // The bug this replaces: pasting the hostname into a browser returned
    // {"error":{"code":"not_found"}}, which reads as a broken deployment.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: 'api',
      endpoints: { health: '/health/live', api: '/api/v1' },
    });
  });

  test('an unknown path is still a 404', async () => {
    const { app } = await harness('root-unknown');
    const response = await app.request('/nope');

    expect(response.status).toBe(404);
  });
});

describe('health', () => {
  test('liveness does not depend on the database', async () => {
    const { app } = await harness('health-live');
    const response = await app.request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', service: 'api' });
  });

  test('readiness reports the database', async () => {
    const { app } = await harness('health-ready');
    const response = await app.request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ database: 'reachable' });
  });
});

describe('authentication and scoping', () => {
  test('rejects an unauthenticated request', async () => {
    const { app } = await harness('unauth', null);
    const response = await get(app, '/recommendations');

    expect(response.status).toBe(401);
  });

  test('a different workspace sees none of this workspace’s data', async () => {
    const { app } = await harness('scoping', { ...ACTOR, workspaceId: 'wsp_other' });
    const response = await get(app, '/recommendations');

    expect(response.status).toBe(200);
    expect((await response.json()).recommendations).toHaveLength(0);
  });
});

describe('approval queue (PRD §15)', () => {
  test('lists the pending recommendation with its signal and draft', async () => {
    const { app } = await harness('queue');
    const response = await get(app, '/recommendations');
    const body = await response.json();

    expect(body.recommendations).toHaveLength(1);
    const card = body.recommendations[0];

    expect(card.display_name).toBe('Jane Smith');
    expect(card.action).toBe('reply');
    expect(card.signal_summary).toContain('alternatives to a competitor');
    expect(card.draft_body).toContain('cross-border settlement');
    expect(card.opportunity).toBe(92);
  });

  test('orders by priority', async () => {
    const { app, seeded } = await harness('queue-order');
    await seeded.db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, expected_goal, status, created_at)
            VALUES ('rec_low', ?, ?, ?, 'observe', 'github', 10, 'low priority',
            'allow', '2026-08-11', 'gather_context', 'pending', ?)`,
      args: [SEED.workspaceId, SEED.campaignId, SEED.personId, new Date().toISOString()],
    });

    const body = await (await get(app, '/recommendations')).json();
    expect(body.recommendations.map((r: { id: string }) => r.id)).toEqual([
      SEED.recommendationId,
      'rec_low',
    ]);
  });

  test('hides expired recommendations', async () => {
    const { app, seeded } = await harness('queue-expired');
    await seeded.db.execute({
      sql: 'UPDATE recommendations SET expires_at = ? WHERE id = ?',
      args: [new Date(Date.now() - 1000).toISOString(), SEED.recommendationId],
    });

    const body = await (await get(app, '/recommendations')).json();
    expect(body.recommendations).toHaveLength(0);
  });
});

describe('approval re-checks policy (PRD §20.9)', () => {
  test('approves a permitted action and queues it', async () => {
    const { app, seeded } = await harness('approve-ok');
    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.approved).toBe(true);
    expect(body.actionId).toMatch(/^act_/);

    const action = await seeded.db.execute({
      sql: 'SELECT * FROM actions WHERE id = ?',
      args: [body.actionId],
    });
    expect(action.rows[0]?.kind).toBe('reply');
    expect(action.rows[0]?.status).toBe('queued');
  });

  test('records the approval and marks the recommendation approved', async () => {
    const { app, seeded } = await harness('approve-state');
    await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    const rec = await seeded.db.execute({
      sql: 'SELECT status FROM recommendations WHERE id = ?',
      args: [SEED.recommendationId],
    });
    expect(rec.rows[0]?.status).toBe('approved');

    const approval = await seeded.db.execute({
      sql: 'SELECT decision FROM approvals WHERE recommendation_id = ?',
      args: [SEED.recommendationId],
    });
    expect(approval.rows[0]?.decision).toBe('approve');
  });

  test('an edited draft is recorded as edit_and_approve', async () => {
    const { app, seeded } = await harness('approve-edited');
    await post(app, `/recommendations/${SEED.recommendationId}/approve`, {
      editedBody: 'My own words instead.',
    });

    const approval = await seeded.db.execute({
      sql: 'SELECT decision, edited_body FROM approvals WHERE recommendation_id = ?',
      args: [SEED.recommendationId],
    });
    expect(approval.rows[0]?.decision).toBe('edit_and_approve');
    expect(approval.rows[0]?.edited_body).toBe('My own words instead.');
  });

  test('refuses to approve when the person was suppressed after generation', async () => {
    const { app, seeded } = await harness('approve-suppressed');

    // The recommendation was generated while allowed; suppression lands after.
    await seeded.db.batch([
      {
        sql: `INSERT INTO suppression_entries (id, reason, scope, source, created_at)
              VALUES ('sup_1', 'consumer_opt_out', 'global', 'privacy_request', ?)`,
        args: [new Date().toISOString()],
      },
      {
        sql: `INSERT INTO suppression_keys (match_key, suppression_id, scope, workspace_id)
              VALUES (?, 'sup_1', 'global', NULL)`,
        args: [`platform:x:x_1001`],
      },
    ]);

    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe('policy_denied');
    expect(body.error.details.gate).toBe('person_ineligible');

    // Nothing was queued.
    const actions = await seeded.db.execute('SELECT count(*) AS n FROM actions');
    expect(Number(actions.rows[0]?.n)).toBe(0);
  });

  test('refuses to approve when a feature flag was switched off', async () => {
    const { app, seeded } = await harness('approve-flagged');
    await seeded.db.execute({
      sql: `INSERT INTO feature_flags (key, workspace_id, enabled, updated_at)
            VALUES ('network.x.reply', ?, 0, ?)`,
      args: [SEED.workspaceId, new Date().toISOString()],
    });

    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(409);
    expect((await response.json()).error.details.gate).toBe('feature_flag');
  });

  test('refuses to approve once the daily rate limit is reached', async () => {
    const { app, seeded } = await harness('approve-ratelimit');
    await seeded.db.execute({
      sql: 'UPDATE campaigns SET budget_json = ? WHERE id = ?',
      args: [JSON.stringify({ maxActionsPerDay: 0 }), SEED.campaignId],
    });

    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(409);
    expect((await response.json()).error.details.gate).toBe('rate_limit_daily');
  });

  test('refuses to approve a person whose identity confidence dropped', async () => {
    const { app, seeded } = await harness('approve-lowconf');
    await seeded.db.execute({
      sql: 'UPDATE people SET identity_confidence = 0.5 WHERE id = ?',
      args: [SEED.personId],
    });

    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(409);
    expect((await response.json()).error.details.gate).toBe('identity_confidence');
  });

  test('logs a blocked approval to the audit trail', async () => {
    const { app, seeded } = await harness('approve-audit');
    await seeded.db.execute({
      sql: 'UPDATE people SET believed_minor = 1 WHERE id = ?',
      args: [SEED.personId],
    });

    await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    const events = await seeded.db.execute(
      `SELECT event_type FROM audit_events WHERE event_type = 'recommendation.approval_blocked'`,
    );
    expect(events.rows).toHaveLength(1);
  });

  test('refuses a viewer role', async () => {
    const { app } = await harness('approve-viewer', { ...ACTOR, role: 'viewer' });
    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(response.status).toBe(403);
  });

  test('will not approve the same recommendation twice', async () => {
    const { app } = await harness('approve-twice');
    await post(app, `/recommendations/${SEED.recommendationId}/approve`);
    const second = await post(app, `/recommendations/${SEED.recommendationId}/approve`);

    expect(second.status).toBe(400);
  });
});

describe('skip and snooze', () => {
  test('skipping removes it from the queue', async () => {
    const { app } = await harness('skip');
    expect((await post(app, `/recommendations/${SEED.recommendationId}/skip`)).status).toBe(200);

    const body = await (await get(app, '/recommendations')).json();
    expect(body.recommendations).toHaveLength(0);
  });

  test('snoozing requires a valid timestamp', async () => {
    const { app } = await harness('snooze-invalid');
    const response = await post(app, `/recommendations/${SEED.recommendationId}/snooze`, {
      until: 'tomorrow',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('bad_request');
  });

  test('snoozing accepts an ISO timestamp', async () => {
    const { app } = await harness('snooze-ok');
    const until = new Date(Date.now() + 86_400_000).toISOString();
    const response = await post(app, `/recommendations/${SEED.recommendationId}/snooze`, { until });

    expect(response.status).toBe(200);
    expect((await response.json()).snoozed).toBe(true);
  });
});

describe('execution', () => {
  test('marking an action complete records an interaction', async () => {
    const { app, seeded } = await harness('execute');
    const approved = await (
      await post(app, `/recommendations/${SEED.recommendationId}/approve`)
    ).json();

    const response = await post(app, `/actions/${approved.actionId}/execute`, {
      mode: 'manual',
      externalUrl: 'https://x.com/you/status/2',
    });

    expect(response.status).toBe(200);

    const interactions = await seeded.db.execute({
      sql: 'SELECT direction, state FROM interactions WHERE person_id = ?',
      args: [SEED.personId],
    });
    expect(interactions.rows[0]).toMatchObject({ direction: 'outbound', state: 'contacted' });
  });

  test('refuses to execute the same action twice', async () => {
    const { app } = await harness('execute-twice');
    const approved = await (
      await post(app, `/recommendations/${SEED.recommendationId}/approve`)
    ).json();

    await post(app, `/actions/${approved.actionId}/execute`, { mode: 'manual' });
    const second = await post(app, `/actions/${approved.actionId}/execute`, { mode: 'manual' });

    expect(second.status).toBe(400);
  });
});

describe('prospect view', () => {
  test('returns identities, signals and provenance together', async () => {
    const { app } = await harness('person');
    const response = await get(app, `/people/${SEED.personId}`);
    const body = await response.json();

    expect(body.person.display_name).toBe('Jane Smith');
    expect(body.identities).toHaveLength(1);
    expect(body.signals).toHaveLength(1);
  });

  test('404s for an unknown person', async () => {
    const { app } = await harness('person-404');
    expect((await get(app, '/people/per_nobody')).status).toBe(404);
  });
});

describe('deletion (PRD §17.3, §47.16)', () => {
  test('removes derived data but leaves a suppression tombstone', async () => {
    const { app, seeded } = await harness('delete');

    const response = await app.request(`/api/v1/people/${SEED.personId}`, { method: 'DELETE' });
    expect(response.status).toBe(200);

    const person = await seeded.db.execute({
      sql: 'SELECT status, display_name FROM people WHERE id = ?',
      args: [SEED.personId],
    });
    expect(person.rows[0]?.status).toBe('deleted');
    expect(person.rows[0]?.display_name).toBe('[deleted]');

    for (const table of ['signals', 'scores', 'recommendations', 'social_identities']) {
      const remaining = await seeded.db.execute({
        sql: `SELECT count(*) AS n FROM ${table} WHERE person_id = ?`,
        args: [SEED.personId],
      });
      expect(Number(remaining.rows[0]?.n)).toBe(0);
    }

    // The tombstone must survive, keyed on the platform account, so a later
    // provider lookup cannot silently re-ingest this person.
    const keys = await seeded.db.execute('SELECT match_key FROM suppression_keys');
    const values = keys.rows.map((r) => String(r.match_key));
    expect(values).toContain('platform:x:x_1001');
    expect(values).toContain(`person:${SEED.personId}`);
  });

  test('a deleted person is no longer readable', async () => {
    const { app } = await harness('delete-then-read');
    await app.request(`/api/v1/people/${SEED.personId}`, { method: 'DELETE' });

    expect((await get(app, `/people/${SEED.personId}`)).status).toBe(404);
  });
});

describe('suppression and privacy', () => {
  test('creates a suppression entry with its keys', async () => {
    const { app, seeded } = await harness('suppress');
    const response = await post(app, '/suppressions', {
      matchKeys: ['platform:x:x_9999'],
      reason: 'consumer_opt_out',
      scope: 'global',
    });

    expect(response.status).toBe(201);
    const keys = await seeded.db.execute('SELECT match_key, scope FROM suppression_keys');
    expect(keys.rows[0]).toMatchObject({ match_key: 'platform:x:x_9999', scope: 'global' });
  });

  test('rejects an unknown suppression reason', async () => {
    const { app } = await harness('suppress-invalid');
    const response = await post(app, '/suppressions', {
      matchKeys: ['platform:x:1'],
      reason: 'because_i_said_so',
    });

    expect(response.status).toBe(400);
  });

  test('a privacy request opens a deletion job with a 45-day due date', async () => {
    const { app, seeded } = await harness('privacy');
    const response = await post(app, '/privacy/requests', {
      kind: 'delete',
      sourceChannel: 'drop',
      subjectMatchKeys: ['hashed_email:abc123'],
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.status).toBe('received');

    const dueInDays = (Date.parse(body.dueAt) - Date.now()) / 86_400_000;
    expect(dueInDays).toBeGreaterThan(44);
    expect(dueInDays).toBeLessThan(46);

    const jobs = await seeded.db.execute('SELECT status FROM deletion_jobs');
    expect(jobs.rows[0]?.status).toBe('pending');
  });
});

describe('errors', () => {
  test('unknown routes return the standard error shape', async () => {
    const { app } = await harness('404');
    const response = await app.request('/api/v1/nope');

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('not_found');
  });

  test('malformed JSON is a 400, not a 500', async () => {
    const { app } = await harness('bad-json');
    const response = await app.request(`/api/v1/recommendations/${SEED.recommendationId}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(response.status).toBe(400);
  });
});
