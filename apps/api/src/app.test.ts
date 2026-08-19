import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import { StubModel } from '@outreachgraph/ai';
import { GitHubProvider } from '@outreachgraph/providers';
import type { Mailer, Message } from '@outreachgraph/email';
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

describe('drafting on demand (PRD §14)', () => {
  /** The seed's evidence is a cross-border payouts complaint. */
  const GROUNDED = 'Settlement taking days on cross-border payouts was our problem too.';

  async function withModel(
    label: string,
    responses: string | readonly string[],
  ): Promise<Hono<AppEnv>> {
    const seeded = await seedDatabase(label);
    active = seeded;

    return createApp({
      db: seeded.db,
      authenticate: async () => ACTOR,
      model: new StubModel(responses),
    });
  }

  test('returns 503 when no model is configured', async () => {
    const { app } = await harness('draft-nomodel');
    const response = await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('composer_unavailable');
  });

  test('composes a grounded message and returns it', async () => {
    const app = await withModel('draft-ok', GROUNDED);
    const response = await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafted).toBe(true);
    expect(body.body).toBe(GROUNDED);
  });

  test('replaces the previous draft rather than stacking a second one', async () => {
    const app = await withModel('draft-replace', GROUNDED);
    await post(app, `/recommendations/${SEED.recommendationId}/draft`);
    await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    const rows = await active!.db.execute({
      sql: 'SELECT count(*) AS n FROM drafts WHERE recommendation_id = ?',
      args: [SEED.recommendationId],
    });
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('reports a withheld draft instead of surfacing an invented one', async () => {
    const app = await withModel('draft-withheld', [
      'On cross-border payouts, Fluxwire solved this for us.',
      'Your payouts note — we moved to Fluxwire.',
    ]);

    const response = await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    // Not an error: refusing to write is a normal, expected answer.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.drafted).toBe(false);
    expect(body.reason).toBe('failed_checks');
    expect(body.unsupported).toContain('Fluxwire');
    expect(body.body).toBeUndefined();
  });

  test('a withheld draft is audited', async () => {
    const app = await withModel('draft-audit', [
      'On cross-border payouts, Fluxwire solved this for us.',
      'Your payouts note — we moved to Fluxwire.',
    ]);
    await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    const rows = await active!.db.execute(
      "SELECT count(*) AS n FROM audit_events WHERE event_type = 'draft.withheld'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('an unknown recommendation is a 404', async () => {
    const app = await withModel('draft-404', GROUNDED);
    expect((await post(app, '/recommendations/rec_missing/draft')).status).toBe(404);
  });

  test('a draft the user edited is never discarded by a recompose', async () => {
    const app = await withModel('draft-edited', GROUNDED);
    await active!.db.execute({
      sql: 'UPDATE drafts SET edited_by_user = 1 WHERE id = ?',
      args: [SEED.draftId],
    });

    await post(app, `/recommendations/${SEED.recommendationId}/draft`);

    const rows = await active!.db.execute({
      sql: 'SELECT edited_by_user FROM drafts WHERE id = ?',
      args: [SEED.draftId],
    });
    expect(rows.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- prospects

/** A GitHub profile carrying the self-declared cross-links the resolver uses. */
const GH_PROFILE = {
  login: 'alexchen',
  id: 4242,
  name: 'Alex Chen',
  company: '@Loopwright',
  blog: 'https://loopwright.io',
  location: 'Berlin',
  email: null,
  bio: 'Agent reliability',
  twitter_username: 'alexbuilds',
  public_repos: 30,
  followers: 500,
  html_url: 'https://github.com/alexchen',
  created_at: '2015-01-01T00:00:00Z',
  updated_at: '2026-08-01T00:00:00Z',
};

const GH_EVENTS = [
  {
    id: '1',
    type: 'IssuesEvent',
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    repo: { id: 9, name: 'loopwright/agents', url: '' },
    payload: {
      action: 'opened',
      issue: {
        title: 'Anyone know a good alternative to Stripe for cross-border payouts?',
        body: 'Fees are brutal.',
        html_url: 'https://github.com/loopwright/agents/issues/12',
      },
    },
  },
];

function stubGitHub(): GitHubProvider {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = url.includes('/events/public')
      ? GH_EVENTS
      : url.includes('/repos')
        ? []
        : url.includes('/users/alexchen')
          ? GH_PROFILE
          : null;

    if (!body) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return new GitHubProvider({ fetchImpl });
}

async function withGitHub(label: string): Promise<Hono<AppEnv>> {
  const seeded = await seedDatabase(label);
  active = seeded;
  return createApp({
    db: seeded.db,
    authenticate: async () => ACTOR,
    github: stubGitHub(),
  });
}

describe('adding a prospect (PRD §8)', () => {
  test('a GitHub handle walks the chain and lands in the workspace', async () => {
    const app = await withGitHub('prospect-add');
    const response = await post(app, '/prospects', { handle: 'alexchen' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.added).toBe(true);
    expect(body.personId).toBeTruthy();
    expect(body.stage).not.toBe('stopped');
  });

  test('a pasted profile URL means the same thing as the handle', async () => {
    const app = await withGitHub('prospect-url');
    const response = await post(app, '/prospects', { handle: 'https://github.com/alexchen' });

    expect(response.status).toBe(200);
    expect((await response.json()).added).toBe(true);
  });

  test('an @-prefixed handle is accepted rather than rejected as invalid', async () => {
    const app = await withGitHub('prospect-at');
    expect((await post(app, '/prospects', { handle: '@alexchen' })).status).toBe(200);
  });

  test('a handle GitHub could never issue is refused before spending a call', async () => {
    const app = await withGitHub('prospect-bad');
    expect((await post(app, '/prospects', { handle: 'not a username!' })).status).toBe(400);
  });

  test('an unknown profile reports why rather than failing the request', async () => {
    const app = await withGitHub('prospect-missing');
    const response = await post(app, '/prospects', { handle: 'ghostuser' });

    // A typo is information, not a server fault: 200 with a reason keeps the
    // client from showing "something went wrong".
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.added).toBe(false);
    expect(body.reason).toContain('ghostuser');
  });

  test('adding a prospect is audited', async () => {
    const app = await withGitHub('prospect-audit');
    await post(app, '/prospects', { handle: 'alexchen' });

    const rows = await active!.db.execute(
      "SELECT count(*) AS n FROM audit_events WHERE event_type = 'prospect.added'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('a viewer cannot add prospects', async () => {
    const seeded = await seedDatabase('prospect-viewer');
    active = seeded;
    const app = createApp({
      db: seeded.db,
      authenticate: async () => ({ ...ACTOR, role: 'viewer' }),
      github: stubGitHub(),
    });

    expect((await post(app, '/prospects', { handle: 'alexchen' })).status).toBe(403);
  });

  test('a workspace with no campaign gets one rather than an error', async () => {
    const app = await withGitHub('prospect-no-campaign');
    // Accounts created before registration provisioned a campaign have none.
    await active!.db.execute('DELETE FROM recommendations');
    await active!.db.execute('DELETE FROM campaign_people');
    await active!.db.execute('DELETE FROM campaigns');

    const response = await post(app, '/prospects', { handle: 'alexchen' });
    expect(response.status).toBe(200);

    const rows = await active!.db.execute('SELECT count(*) AS n FROM campaigns');
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });
});

// ------------------------------------------------------------ verification

/** Collects sent messages instead of delivering them. */
function recordingMailer(): { sent: Message[]; mailer: Mailer } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      send: async (message) => {
        sent.push(message);
        return {};
      },
    },
  };
}

describe('email verification', () => {
  test('registering mails a verification link', async () => {
    const seeded = await seedDatabase('verify-register');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });

    const response = await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    expect(response.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('new@example.com');
    expect(sent[0]!.text).toContain('https://og.test/verify?token=');
  });

  test('a new account is unverified until the link is followed', async () => {
    const seeded = await seedDatabase('verify-unverified');
    active = seeded;
    const { mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer });

    await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    const row = await seeded.db.execute({
      sql: 'SELECT email_verified_at FROM users WHERE email = ?',
      args: ['new@example.com'],
    });
    expect(row.rows[0]?.email_verified_at).toBeNull();
  });

  test('following the link confirms the address', async () => {
    const seeded = await seedDatabase('verify-confirm');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });

    await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    const token = sent[0]!.text.match(/token=([a-f0-9]+)/)?.[1];
    const response = await post(app, '/auth/verify', { token });

    expect(response.status).toBe(200);
    expect((await response.json()).verified).toBe(true);
  });

  test('a token cannot be used twice', async () => {
    const seeded = await seedDatabase('verify-replay');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });

    await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    const token = sent[0]!.text.match(/token=([a-f0-9]+)/)?.[1];
    await post(app, '/auth/verify', { token });

    expect((await post(app, '/auth/verify', { token })).status).toBe(400);
  });

  test('an expired token is refused', async () => {
    const seeded = await seedDatabase('verify-expired');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });

    await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    await seeded.db.execute({
      sql: 'UPDATE email_verification_tokens SET expires_at = ?',
      args: ['2000-01-01T00:00:00.000Z'],
    });

    const token = sent[0]!.text.match(/token=([a-f0-9]+)/)?.[1];
    expect((await post(app, '/auth/verify', { token })).status).toBe(400);
  });

  test('a made-up token is refused', async () => {
    const seeded = await seedDatabase('verify-forged');
    active = seeded;
    const app = createApp({ db: seeded.db });

    expect((await post(app, '/auth/verify', { token: 'deadbeef' })).status).toBe(400);
  });

  test('resending supersedes the previous link rather than stacking', async () => {
    const seeded = await seedDatabase('verify-resend');
    active = seeded;
    const { sent, mailer } = recordingMailer();

    let userId = '';
    const app = createApp({
      db: seeded.db,
      mailer,
      appUrl: 'https://og.test',
      authenticate: async () => (userId ? { ...ACTOR, userId } : undefined),
    });

    // Register through a second app instance so the guard above stays off
    // until the account exists.
    const open = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });
    const registered = await (
      await post(open, '/auth/register', {
        email: 'new@example.com',
        password: 'correct horse battery',
      })
    ).json();
    userId = registered.userId;

    await post(app, '/auth/verify/resend');

    const first = sent[0]!.text.match(/token=([a-f0-9]+)/)?.[1];
    const second = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];
    expect(second).not.toBe(first);

    // The old link must stop working, or "resend" becomes a way to hold
    // several simultaneously valid tokens.
    expect((await post(open, '/auth/verify', { token: first })).status).toBe(400);
    expect((await post(open, '/auth/verify', { token: second })).status).toBe(200);
  });

  test('an unverified account cannot approve outreach', async () => {
    const seeded = await seedDatabase('verify-gate');
    active = seeded;
    await seeded.db.execute({
      sql: 'UPDATE users SET email_verified_at = NULL WHERE id = ?',
      args: [SEED.userId],
    });

    const app = createApp({ db: seeded.db, authenticate: async () => ACTOR });
    const response = await post(app, `/recommendations/${SEED.recommendationId}/approve`, {});

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('email_unverified');
  });

  test('an unverified account can still add prospects and read evidence', async () => {
    const seeded = await seedDatabase('verify-gate-read');
    active = seeded;
    await seeded.db.execute({
      sql: 'UPDATE users SET email_verified_at = NULL WHERE id = ?',
      args: [SEED.userId],
    });

    const app = createApp({
      db: seeded.db,
      authenticate: async () => ACTOR,
      github: stubGitHub(),
    });

    // The gate is on sending, not on looking around.
    expect((await get(app, '/people')).status).toBe(200);
    expect((await post(app, '/prospects', { handle: 'alexchen' })).status).toBe(200);
  });

  test('a failed send does not fail the signup', async () => {
    const seeded = await seedDatabase('verify-send-fails');
    active = seeded;
    const app = createApp({
      db: seeded.db,
      mailer: {
        send: async () => {
          throw new Error('resend is down');
        },
      },
    });

    const response = await post(app, '/auth/register', {
      email: 'new@example.com',
      password: 'correct horse battery',
    });

    // Losing the account over a transient provider outage is worse than an
    // account whose owner has to press "resend".
    expect(response.status).toBe(201);

    const rows = await seeded.db.execute(
      "SELECT count(*) AS n FROM audit_events WHERE event_type = 'email.send_failed'",
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  test('/auth/me reports verification so the UI can warn before a refusal', async () => {
    const { app } = await harness('verify-me');
    const body = await (await get(app, '/auth/me')).json();

    expect(body.emailVerified).toBe(true);
  });
});

describe('password reset', () => {
  /** Registers an account and returns its id, through an unguarded app. */
  async function register(
    seeded: Awaited<ReturnType<typeof seedDatabase>>,
    mailer: Mailer,
    email = 'new@example.com',
  ) {
    const open = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });
    const body = await (
      await post(open, '/auth/register', { email, password: 'correct horse battery' })
    ).json();
    return { app: open, userId: body.userId as string };
  }

  test('asking for a link mails one', async () => {
    const seeded = await seedDatabase('reset-request');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    const response = await post(app, '/auth/password/forgot', { email: 'new@example.com' });

    expect(response.status).toBe(200);
    // [0] is the verification mail from registering.
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe('new@example.com');
    expect(sent[1]!.text).toContain('https://og.test/reset?token=');
  });

  test('an unknown address answers the same and mails nothing', async () => {
    const seeded = await seedDatabase('reset-unknown');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const app = createApp({ db: seeded.db, mailer, appUrl: 'https://og.test' });

    const response = await post(app, '/auth/password/forgot', { email: 'nobody@example.com' });

    // Identical to the hit case, or the endpoint enumerates accounts.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(sent).toHaveLength(0);
  });

  test('the link sets a password that then works', async () => {
    const seeded = await seedDatabase('reset-complete');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];

    const reset = await post(app, '/auth/password/reset', {
      token,
      password: 'a whole new passphrase',
    });
    expect(reset.status).toBe(200);

    expect(
      (
        await post(app, '/auth/login', {
          email: 'new@example.com',
          password: 'a whole new passphrase',
        })
      ).status,
    ).toBe(200);

    // The old one must stop working, or the reset changed nothing.
    expect(
      (
        await post(app, '/auth/login', {
          email: 'new@example.com',
          password: 'correct horse battery',
        })
      ).status,
    ).toBe(401);
  });

  test('resetting signs out every existing session', async () => {
    const seeded = await seedDatabase('reset-sessions');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app, userId } = await register(seeded, mailer);

    const before = await seeded.db.execute({
      sql: 'SELECT count(*) AS n FROM sessions WHERE user_id = ?',
      args: [userId],
    });
    expect(Number(before.rows[0]?.n)).toBeGreaterThan(0);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];
    await post(app, '/auth/password/reset', { token, password: 'a whole new passphrase' });

    // A reset is what someone does when a cookie may be in the wrong hands.
    const after = await seeded.db.execute({
      sql: 'SELECT count(*) AS n FROM sessions WHERE user_id = ?',
      args: [userId],
    });
    expect(Number(after.rows[0]?.n)).toBe(0);
  });

  test('a token cannot be used twice', async () => {
    const seeded = await seedDatabase('reset-replay');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];

    await post(app, '/auth/password/reset', { token, password: 'a whole new passphrase' });

    expect(
      (await post(app, '/auth/password/reset', { token, password: 'yet another passphrase' }))
        .status,
    ).toBe(400);
  });

  test('an expired token is refused', async () => {
    const seeded = await seedDatabase('reset-expired');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    await seeded.db.execute({
      sql: 'UPDATE password_reset_tokens SET expires_at = ?',
      args: ['2000-01-01T00:00:00.000Z'],
    });

    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];
    expect(
      (await post(app, '/auth/password/reset', { token, password: 'a whole new passphrase' }))
        .status,
    ).toBe(400);
  });

  test('a made-up token is refused', async () => {
    const seeded = await seedDatabase('reset-forged');
    active = seeded;
    const app = createApp({ db: seeded.db });

    expect(
      (
        await post(app, '/auth/password/reset', {
          token: 'deadbeef',
          password: 'a long passphrase',
        })
      ).status,
    ).toBe(400);
  });

  test('a weak password is refused without burning the link', async () => {
    const seeded = await seedDatabase('reset-weak');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];

    expect((await post(app, '/auth/password/reset', { token, password: 'short' })).status).toBe(
      400,
    );

    // The token survives, so a rejected choice is a retry rather than a
    // dead-end that needs a fresh email.
    expect(
      (await post(app, '/auth/password/reset', { token, password: 'a whole new passphrase' }))
        .status,
    ).toBe(200);
  });

  test('a second request inside the cooldown does not mail again', async () => {
    const seeded = await seedDatabase('reset-cooldown');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const response = await post(app, '/auth/password/forgot', { email: 'new@example.com' });

    // Still indistinguishable from a send, so the throttle does not leak
    // whether the address exists either.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: true });
    expect(sent).toHaveLength(2);
  });

  test('an outstanding link is superseded once the cooldown has passed', async () => {
    const seeded = await seedDatabase('reset-supersede');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const first = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];

    // Age the outstanding token past the cooldown rather than sleeping.
    await seeded.db.execute({
      sql: 'UPDATE password_reset_tokens SET created_at = ?',
      args: ['2000-01-01T00:00:00.000Z'],
    });

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const second = sent[2]!.text.match(/token=([a-f0-9]+)/)?.[1];
    expect(second).not.toBe(first);

    expect(
      (
        await post(app, '/auth/password/reset', {
          token: first,
          password: 'a whole new passphrase',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(app, '/auth/password/reset', {
          token: second,
          password: 'a whole new passphrase',
        })
      ).status,
    ).toBe(200);
  });

  test('completing a reset also confirms the address', async () => {
    const seeded = await seedDatabase('reset-verifies');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app, userId } = await register(seeded, mailer);

    await post(app, '/auth/password/forgot', { email: 'new@example.com' });
    const token = sent[1]!.text.match(/token=([a-f0-9]+)/)?.[1];
    await post(app, '/auth/password/reset', { token, password: 'a whole new passphrase' });

    // Receiving the mail proves the mailbox as well as a verification link.
    const row = await seeded.db.execute({
      sql: 'SELECT email_verified_at FROM users WHERE id = ?',
      args: [userId],
    });
    expect(row.rows[0]?.email_verified_at).toBeTruthy();
  });

  test('a suspended account gets no link', async () => {
    const seeded = await seedDatabase('reset-suspended');
    active = seeded;
    const { sent, mailer } = recordingMailer();
    const { app, userId } = await register(seeded, mailer);

    await seeded.db.execute({
      sql: "UPDATE users SET status = 'suspended' WHERE id = ?",
      args: [userId],
    });

    const response = await post(app, '/auth/password/forgot', { email: 'new@example.com' });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe('listing prospects', () => {
  test('the seeded prospect is listed with its score', async () => {
    const { app } = await harness('people-list');
    const response = await get(app, '/people');

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.people.length).toBeGreaterThan(0);
    expect(body.people[0].display_name).toBeTruthy();
  });

  test('a deleted person is not listed', async () => {
    const { app } = await harness('people-list-deleted');
    await active!.db.execute({
      sql: "UPDATE people SET status = 'deleted' WHERE id = ?",
      args: [SEED.personId],
    });

    const body = await (await get(app, '/people')).json();
    expect(body.people).toHaveLength(0);
  });
});
