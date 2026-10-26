/**
 * `/api/v1/workflows` through the real app and a real temp database.
 *
 * What matters here (PRD-ECO §14 acceptance): a workflow is created from
 * English or the template and shown as a step plan; invalid graphs are refused
 * before activation; a dry run transmits nothing yet gives a send / no-send
 * decision per person; de-duplication blocks people already emailed elsewhere;
 * editing never changes what runs until it is published; runs retry with
 * backoff, end in dead-letter, and a resumed or retried slot never repeats a
 * side effect; the scheduler and reply events start a slot once; pause stops
 * sending; and a model cannot switch on autopilot by itself.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { TextModel } from '@outreachgraph/ai';
import type { Client } from '@outreachgraph/db';
import { queryAll, queryOne } from '@outreachgraph/db';
import { ENGINEERING_CONTRACT_TEMPLATE } from '@outreachgraph/domain';
import type { WebResult, WebSearcher } from '@outreachgraph/providers';
import { createApp } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import { runDueWorkflows } from './workflows';

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

const OWNER: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
};
const VIEWER: RequestActor = { ...OWNER, role: 'viewer' };

const POSTING = 'https://apply.workable.com/raydar/j/C39C58F585/';

const searcher: WebSearcher = {
  async search(query): Promise<readonly WebResult[]> {
    if (query.startsWith('site:apply.workable.com')) {
      return [{ link: POSTING, title: 'Contract Software Engineer - Raydar' }];
    }
    return [];
  },
};

const brokenSearcher: WebSearcher = {
  async search() {
    throw new Error('ValueSERP answered 503');
  },
};

async function harness(
  label: string,
  options: { actor?: RequestActor; searcher?: WebSearcher | null; model?: TextModel } = {},
) {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => options.actor ?? OWNER,
    ...(options.searcher === null ? {} : { jobSearcher: options.searcher ?? searcher }),
    ...(options.model ? { model: options.model } : {}),
  });
  return { app, db: seeded.db };
}

function send(app: Hono<AppEnv>, method: string, path: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

interface WorkflowView {
  id: string;
  name: string;
  status: string;
  owner: string | null;
  version: number;
  publishedVersion: number | null;
  unpublishedChanges: boolean;
  campaignId: string | null;
  nextRunAt: string | null;
  settings: {
    outreach: { dailyLimit: number; approval: string };
    targeting: { countries: string[]; titles: string[] };
  };
  definition: { nodes: { id: string; type: string; config: Record<string, unknown> }[] };
  plan: { id: string; type: string; title: string; detail: string; warnings: string[] }[];
}

interface RunOutcome {
  runId: string;
  status: string;
  campaignId: string | null;
  retryAt: string | null;
  error: string | null;
  steps: { id: string; status: string; detail: string; idempotencyKey?: string }[];
}

async function fromTemplate(app: Hono<AppEnv>): Promise<WorkflowView> {
  const response = await send(app, 'POST', '/workflows', {
    templateId: 'engineering-contract-acquisition',
  });
  expect(response.status).toBe(201);
  return (await json<{ workflow: WorkflowView }>(response)).workflow;
}

async function published(app: Hono<AppEnv>): Promise<WorkflowView> {
  const workflow = await fromTemplate(app);
  const response = await send(app, 'POST', `/workflows/${workflow.id}/publish`);
  expect(response.status).toBe(200);
  return (await json<{ workflow: WorkflowView }>(response)).workflow;
}

async function runNow(app: Hono<AppEnv>, id: string): Promise<RunOutcome> {
  const response = await send(app, 'POST', `/workflows/${id}/run?wait=1`);
  expect(response.status).toBe(200);
  return (await json<{ run: RunOutcome }>(response)).run;
}

/** Jane, in the workflow's campaign with an address and a pending first email. */
async function janeAwaitingEmail(db: Client, campaignId: string): Promise<void> {
  const stamp = new Date().toISOString();
  for (const statement of [
    {
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
              interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
      args: [campaignId, SEED.personId, SEED.workspaceId, stamp, stamp],
    },
    {
      sql: `INSERT INTO person_emails (id, workspace_id, person_id, address, dedupe_key, source,
              verified, created_at)
            VALUES ('pem_jane', ?, ?, 'jane@acme.example', 'jane@acme.example', 'import', 1, ?)`,
      args: [SEED.workspaceId, SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
              priority, reason, policy_status, policy_version, expected_goal, status, created_at)
            VALUES ('rec_wf_jane', ?, ?, ?, 'send_email', 'email', 80, 'Hiring engineers',
              'allow_with_approval', '2026-09-24', 'start_conversation', 'pending', ?)`,
      args: [SEED.workspaceId, campaignId, SEED.personId, stamp],
    },
  ]) {
    await db.execute(statement);
  }
}

/** An email to Jane already went out from a different campaign yesterday. */
async function janeEmailedElsewhere(db: Client): Promise<void> {
  const yesterday = new Date(Date.now() - 864e5).toISOString();
  await db.execute({
    sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, expected_goal, status, created_at)
          VALUES ('rec_old_jane', ?, ?, ?, 'send_email', 'email', 50, 'Earlier campaign',
            'allow', '2026-09-24', 'start_conversation', 'executed', ?)`,
    args: [SEED.workspaceId, SEED.campaignId, SEED.personId, yesterday],
  });
  await db.execute({
    sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network, mode,
            status, created_at, executed_at)
          VALUES ('act_old_jane', ?, 'rec_old_jane', ?, 'send_email', 'email', 'automatic',
            'sent', ?, ?)`,
    args: [SEED.workspaceId, SEED.personId, yesterday, yesterday],
  });
}

describe('creating and validating', () => {
  test('the template is offered with its plan and 200/day', async () => {
    const { app } = await harness('workflows-templates');
    const body = await json<{
      templates: { id: string; settings: WorkflowView['settings']; plan: unknown[] }[];
    }>(send(app, 'GET', '/workflows/templates'));
    expect(body.templates[0]?.id).toBe('engineering-contract-acquisition');
    expect(body.templates[0]?.settings.outreach).toMatchObject({
      dailyLimit: 200,
      approval: 'review',
    });
    expect(body.templates[0]?.plan.length).toBe(
      ENGINEERING_CONTRACT_TEMPLATE.definition.nodes.length + 1,
    );
  });

  test('from the template: an unpublished draft with an owner and an honest ceiling', async () => {
    const { app } = await harness('workflows-create-template');
    const workflow = await fromTemplate(app);

    expect(workflow).toMatchObject({
      status: 'draft',
      name: 'Engineering Contract Acquisition',
      version: 1,
      publishedVersion: null,
      unpublishedChanges: true,
      owner: expect.any(String),
    });
    const sendStep = workflow.plan.find((s) => s.type === 'send')!;
    expect(sendStep.detail).toContain('Up to 25 a day (asked for 200)');
    expect(sendStep.warnings[0]).toContain('at most 25');

    const list = await json<{ workflows: WorkflowView[] }>(send(app, 'GET', '/workflows'));
    expect(list.workflows.map((w) => w.id)).toEqual([workflow.id]);
  });

  test('from English, read by the rules when there is no model', async () => {
    const { app } = await harness('workflows-create-english');
    const response = await send(app, 'POST', '/workflows', {
      prompt:
        'Find devtools startups. Search job boards for a rust engineer. Email the CTO. 40 emails a day.',
    });
    expect(response.status).toBe(201);
    const { workflow } = await json<{ workflow: WorkflowView }>(response);
    expect(workflow.settings.outreach.dailyLimit).toBe(40);
    expect(workflow.settings.targeting.titles).toEqual(['CTO']);
    expect(
      workflow.definition.nodes.filter((n) => n.type === 'discover_opportunities'),
    ).toHaveLength(2);
  });

  test('validate reports every problem before anything is saved', async () => {
    const { app } = await harness('workflows-validate');
    const nodes = ENGINEERING_CONTRACT_TEMPLATE.definition.nodes.map((n) =>
      n.id === 'enrich' ? { ...n, after: ['crm'] } : n,
    );
    const cyclic = await json<{ ok: boolean; errors: string[] }>(
      send(app, 'POST', '/workflows/validate', {
        definition: { ...ENGINEERING_CONTRACT_TEMPLATE.definition, nodes },
      }),
    );
    expect(cyclic.ok).toBe(false);
    expect(cyclic.errors[0]).toContain('cycle');

    const unknown = await send(app, 'POST', '/workflows', {
      name: 'x',
      definition: {
        ...ENGINEERING_CONTRACT_TEMPLATE.definition,
        nodes: [
          ...ENGINEERING_CONTRACT_TEMPLATE.definition.nodes,
          { id: 'evil', type: 'exec', after: [] },
        ],
      },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).toContain('unknown action');
  });

  test('a model cannot switch on autopilot that the words did not ask for', async () => {
    const model: TextModel = {
      async generate() {
        return {
          text: JSON.stringify({
            goal: 'Reach CTOs',
            sources: [{ kind: 'discover', query: 'fintech startups' }],
            targeting: { titles: ['CTO'] },
            outreach: { dailyLimit: 80, approval: 'autopilot' },
            schedule: { kind: 'daily', hour: 10, timezone: 'UTC' },
          }),
          model: 'fake',
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          refused: false,
        };
      },
    };
    const { app } = await harness('workflows-model-guard', { model });
    const body = await json<{
      settings: WorkflowView['settings'];
      interpretedBy: string;
      errors: string[];
    }>(send(app, 'POST', '/workflows/interpret', { prompt: 'Email fintech CTOs daily' }));

    expect(body.interpretedBy).toBe('model');
    expect(body.errors).toEqual([]);
    expect(body.settings.outreach.dailyLimit).toBe(80);
    expect(body.settings.outreach.approval).toBe('review');
  });

  test('a viewer can read but not create', async () => {
    const { app } = await harness('workflows-viewer', { actor: VIEWER });
    expect((await send(app, 'GET', '/workflows')).status).toBe(200);
    expect(
      (await send(app, 'POST', '/workflows', { templateId: 'engineering-contract-acquisition' }))
        .status,
    ).toBe(403);
  });
});

describe('versions and publishing', () => {
  test('an edit is a new version that runs only once published', async () => {
    const { app } = await harness('workflows-versions');
    const workflow = await published(app);
    expect(workflow).toMatchObject({ status: 'active', version: 1, publishedVersion: 1 });

    const edited = await json<{ workflow: WorkflowView; interpretedBy: string }>(
      send(app, 'PATCH', `/workflows/${workflow.id}`, {
        instruction: 'make it 100 emails a day and add Canada',
      }),
    );
    expect(edited.interpretedBy).toBe('rules');
    expect(edited.workflow).toMatchObject({
      version: 2,
      publishedVersion: 1,
      unpublishedChanges: true,
    });
    expect(edited.workflow.settings.outreach.dailyLimit).toBe(100);
    expect(edited.workflow.settings.targeting.countries).toContain('Canada');

    const run = await runNow(app, workflow.id);
    const versionRan = await json<{ run: { version: number } }>(
      send(app, 'GET', `/workflows/${workflow.id}/runs/${run.runId}`),
    );
    expect(versionRan.run.version).toBe(1);

    const versions = await json<{
      versions: { version: number; published: boolean; note: string }[];
    }>(send(app, 'GET', `/workflows/${workflow.id}/versions`));
    expect(versions.versions.map((v) => [v.version, v.published])).toEqual([
      [2, false],
      [1, true],
    ]);

    const restored = await json<{ workflow: WorkflowView }>(
      send(app, 'POST', `/workflows/${workflow.id}/versions/1/restore`),
    );
    expect(restored.workflow.version).toBe(3);
    expect(restored.workflow.settings.outreach.dailyLimit).toBe(200);
  });

  test('running an unpublished workflow is refused', async () => {
    const { app } = await harness('workflows-unpublished');
    const workflow = await fromTemplate(app);
    expect((await send(app, 'POST', `/workflows/${workflow.id}/run`)).status).toBe(409);
  });
});

describe('dry run', () => {
  test('transmits nothing, creates nothing, and decides per person', async () => {
    const { app, db } = await harness('workflows-dry-run', { searcher: null });
    const workflow = await published(app);
    const run = await runNow(app, workflow.id);
    await janeAwaitingEmail(db, run.campaignId!);
    await janeEmailedElsewhere(db);
    const actionsBefore = await queryAll(db, 'SELECT id FROM actions');
    const campaignsBefore = await queryAll(db, 'SELECT id FROM campaigns');

    const { preview } = await json<{
      preview: {
        transmitted: number;
        estimate: { effectiveDailyCap: number; dailyLimit: number };
        policy: { decision: string };
        checks: { id: string; status: string }[];
        candidates: {
          name: string;
          address: string;
          decision: string;
          reason: string;
          evidence: unknown[];
        }[];
      };
    }>(send(app, 'POST', `/workflows/${workflow.id}/dry-run`));

    expect(preview.transmitted).toBe(0);
    expect(preview.estimate).toMatchObject({ dailyLimit: 200, effectiveDailyCap: 25 });
    expect(preview.policy.decision).toBe('allow_with_approval');
    expect(preview.checks.find((c) => c.id === 'discover-1')?.status).toBe('warning');
    expect(preview.candidates).toEqual([
      expect.objectContaining({
        name: 'Jane Smith',
        address: 'ja••@acme.example',
        decision: 'no_send',
        reason: expect.stringContaining('already emailed'),
      }),
    ]);
    expect(preview.candidates[0]!.evidence).toHaveLength(1);
    expect(await queryAll(db, 'SELECT id FROM actions')).toEqual(actionsBefore);
    expect(await queryAll(db, 'SELECT id FROM campaigns')).toEqual(campaignsBefore);
  });

  test('without prior contact the person is queued for approval, not sent', async () => {
    const { app, db } = await harness('workflows-dry-run-clean');
    const workflow = await published(app);
    const run = await runNow(app, workflow.id);
    await janeAwaitingEmail(db, run.campaignId!);

    const { preview } = await json<{ preview: { candidates: { decision: string }[] } }>(
      send(app, 'POST', `/workflows/${workflow.id}/dry-run`),
    );
    expect(preview.candidates.map((c) => c.decision)).toEqual(['queue_for_approval']);
  });
});

describe('contactability', () => {
  /** Jane, queued for a first email, reachable only at her company's shared inbox. */
  async function janeOnlyAtTeamInbox(db: Client, campaignId: string) {
    const stamp = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO campaign_people (campaign_id, person_id, workspace_id, status,
              interaction_state, discovered_at, updated_at)
            VALUES (?, ?, ?, 'recommended', 'never_contacted', ?, ?)`,
      args: [campaignId, SEED.personId, SEED.workspaceId, stamp, stamp],
    });
    await db.execute({
      sql: `UPDATE companies SET contact_email = 'team@acme.example' WHERE id = ?`,
      args: [SEED.companyId],
    });
    await db.execute({
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
              priority, reason, policy_status, policy_version, expected_goal, status, created_at)
            VALUES ('rec_wf_team', ?, ?, ?, 'send_email', 'email', 80, 'Hiring engineers',
              'allow_with_approval', '2026-09-24', 'start_conversation', 'pending', ?)`,
      args: [SEED.workspaceId, campaignId, SEED.personId, stamp],
    });
  }

  test('the dry run says why, and a run skips the first email to a shared inbox', async () => {
    const { app, db } = await harness('workflows-shared-inbox');
    const workflow = await published(app);
    const first = await runNow(app, workflow.id);
    await janeOnlyAtTeamInbox(db, first.campaignId!);

    const { preview } = await json<{
      preview: { candidates: { decision: string; reason: string; address: string }[] };
    }>(send(app, 'POST', `/workflows/${workflow.id}/dry-run`));
    expect(preview.candidates[0]).toMatchObject({
      decision: 'no_send',
      address: 'te••@acme.example',
      reason: expect.stringContaining('shared company inbox'),
    });

    const run = await runNow(app, workflow.id);
    expect(run.steps.find((s) => s.id === 'verify')?.detail).toContain('1 first emails');
    const rec = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = 'rec_wf_team'`,
    );
    expect(rec?.status).toBe('skipped');
  });

  test('a person with their own address is left alone', async () => {
    const { app, db } = await harness('workflows-personal-address');
    const workflow = await published(app);
    const first = await runNow(app, workflow.id);
    await janeAwaitingEmail(db, first.campaignId!);
    await runNow(app, workflow.id);
    const rec = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = 'rec_wf_jane'`,
    );
    expect(rec?.status).toBe('pending');
  });
});

describe('running', () => {
  test('one run at a time: a second Run now is refused while one is live', async () => {
    const { app, db } = await harness('workflows-one-at-a-time');
    const workflow = await published(app);
    await db.execute({
      sql: `INSERT INTO workflow_runs (id, workflow_id, workspace_id, version, run_trigger, status,
              slot_key, started_at)
            VALUES ('wfr_live', ?, ?, 1, 'manual', 'running', 'manual:live', ?)`,
      args: [workflow.id, SEED.workspaceId, new Date().toISOString()],
    });
    const response = await send(app, 'POST', `/workflows/${workflow.id}/run`);
    expect(response.status).toBe(409);
    expect(await response.text()).toContain('already in progress');
  });

  test('drives a campaign through targeting, discovery, job boards and limits', async () => {
    const { app, db } = await harness('workflows-run');
    const workflow = await published(app);
    const run = await runNow(app, workflow.id);

    expect(run.status).toBe('succeeded');
    expect(run.steps.map((s) => s.id)).toEqual(
      ENGINEERING_CONTRACT_TEMPLATE.definition.nodes.map((n) => n.id),
    );
    expect(run.steps.find((s) => s.id === 'crm')?.status).toBe('skipped');

    const campaign = await queryOne<{ approval_mode: string; budget_json: string }>(
      db,
      'SELECT approval_mode, budget_json FROM campaigns WHERE id = ?',
      [run.campaignId],
    );
    expect(campaign?.approval_mode).toBe('draft_and_approve');
    expect(JSON.parse(campaign!.budget_json)).toMatchObject({ maxActionsPerDay: 200 });

    const filters = await queryOne<{ titles: string; employee_count_max: number }>(
      db,
      'SELECT titles, employee_count_max FROM campaign_filters WHERE campaign_id = ?',
      [run.campaignId],
    );
    expect(JSON.parse(filters!.titles)).toContain('Technical Recruiter');
    expect(Number(filters!.employee_count_max)).toBe(1000);

    const discovery = await queryAll(
      db,
      `SELECT id FROM jobs WHERE kind = 'discover_domains' AND payload_json LIKE ?`,
      [`%${run.campaignId}%`],
    );
    expect(discovery).toHaveLength(2);
    expect(
      await queryAll(db, 'SELECT id FROM job_posts WHERE campaign_id = ?', [run.campaignId]),
    ).toHaveLength(1);

    const again = await runNow(app, workflow.id);
    expect(again.campaignId).toBe(run.campaignId);
  });

  test('de-duplication skips a person already emailed from another campaign', async () => {
    const { app, db } = await harness('workflows-dedupe');
    const workflow = await published(app);
    const first = await runNow(app, workflow.id);
    await janeAwaitingEmail(db, first.campaignId!);
    await janeEmailedElsewhere(db);

    const run = await runNow(app, workflow.id);
    expect(run.steps.find((s) => s.id === 'dedupe')?.detail).toContain('1 already contacted');
    const rec = await queryOne<{ status: string }>(
      db,
      `SELECT status FROM recommendations WHERE id = 'rec_wf_jane'`,
    );
    expect(rec?.status).toBe('skipped');
  });
});

describe('durability', () => {
  test('a failing step retries with backoff, never repeats side effects, then dead-letters', async () => {
    const { app, db } = await harness('workflows-retry', { searcher: brokenSearcher });
    const workflow = await published(app);
    const first = await runNow(app, workflow.id);

    expect(first.status).toBe('retry_scheduled');
    expect(first.error).toContain('503');
    expect(first.steps.find((s) => s.id === 'discover-1')?.status).toBe('failed');
    expect(first.steps.find((s) => s.id === 'discover-3')?.status).toBe('ok');
    // One failed source does not hold the rest: the join runs on what finished.
    expect(first.steps.find((s) => s.id === 'enrich')?.status).toBe('ok');
    expect(first.steps.find((s) => s.id === 'send')?.status).toBe('ok');

    // Only the retries, not the next scheduled slot.
    await db.execute({
      sql: 'UPDATE workflows SET next_run_at = NULL WHERE id = ?',
      args: [workflow.id],
    });
    let at = new Date(first.retryAt!);
    const statuses: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      at = new Date(at.getTime() + 121 * 60_000);
      const [result] = await runDueWorkflows(db, { searcher: brokenSearcher, now: () => at });
      expect(result?.trigger).toBe('retry');
      statuses.push(result!.status);
      const detail = await json<{ run: { steps: { id: string; status: string }[] } }>(
        send(app, 'GET', `/workflows/${workflow.id}/runs/${result!.runId}`),
      );
      expect(detail.run.steps.find((s) => s.id === 'discover-3')?.status).toBe('replayed');
    }
    expect(statuses).toEqual(['retry_scheduled', 'retry_scheduled', 'dead_letter']);

    // One discovery job for the slot, however many attempts.
    const discovery = await queryAll(db, `SELECT id FROM jobs WHERE kind = 'discover_domains'`);
    expect(discovery.length).toBe(2);
  });

  test('resuming a failed run replays what was done and finishes the rest', async () => {
    const { app, db } = await harness('workflows-resume', { searcher: brokenSearcher });
    const workflow = await published(app);
    const failed = await runNow(app, workflow.id);
    await send(app, 'POST', `/workflows/${workflow.id}/runs/${failed.runId}/cancel`);

    const fixed = createApp({ db, authenticate: async () => OWNER, jobSearcher: searcher });
    const resumed = await json<{ run: RunOutcome }>(
      send(fixed, 'POST', `/workflows/${workflow.id}/runs/${failed.runId}/resume?wait=1`),
    );
    expect(resumed.run.status).toBe('succeeded');
    expect(resumed.run.steps.find((s) => s.id === 'discover-3')?.status).toBe('replayed');
    expect(resumed.run.steps.find((s) => s.id === 'discover-1')?.status).toBe('ok');
  });

  test('run now answers at once and the run finishes in the background', async () => {
    const { app } = await harness('workflows-async');
    const workflow = await published(app);
    const response = await send(app, 'POST', `/workflows/${workflow.id}/run`);
    expect(response.status).toBe(202);
    const { run } = await json<{ run: RunOutcome }>(response);
    expect(run.status).toBe('running');

    let status = 'running';
    for (let i = 0; i < 100 && status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = (
        await json<{ run: { status: string } }>(
          send(app, 'GET', `/workflows/${workflow.id}/runs/${run.runId}`),
        )
      ).run.status;
    }
    expect(status).toBe('succeeded');
  });

  test('a run a restart left behind becomes a retry of its own slot', async () => {
    const { app, db } = await harness('workflows-orphan');
    const workflow = await published(app);
    await db.execute({
      sql: 'UPDATE workflows SET next_run_at = NULL WHERE id = ?',
      args: [workflow.id],
    });
    const long = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await db.execute({
      sql: `INSERT INTO workflow_runs (id, workflow_id, workspace_id, version, run_trigger, status,
              slot_key, attempt, started_at)
            VALUES ('wfr_orphan', ?, ?, 1, 'schedule', 'running', 'schedule:orphan', 1, ?)`,
      args: [workflow.id, SEED.workspaceId, long],
    });

    const ran = await runDueWorkflows(db, { searcher });
    expect(ran.map((r) => r.trigger)).toEqual(['retry']);
    const retry = await queryOne<{ slot_key: string; attempt: number; retry_of: string }>(
      db,
      `SELECT slot_key, attempt, retry_of FROM workflow_runs WHERE id = ?`,
      [ran[0]!.runId],
    );
    expect(retry).toMatchObject({ slot_key: 'schedule:orphan', retry_of: 'wfr_orphan' });
    expect(Number(retry!.attempt)).toBe(2);
  });

  test('cancel stops a pending retry', async () => {
    const { app, db } = await harness('workflows-cancel', { searcher: brokenSearcher });
    const workflow = await published(app);
    const failed = await runNow(app, workflow.id);
    expect(
      (await send(app, 'POST', `/workflows/${workflow.id}/runs/${failed.runId}/cancel`)).status,
    ).toBe(200);
    const ran = await runDueWorkflows(db, { now: () => new Date(Date.now() + 864e5) });
    expect(ran.filter((r) => r.trigger === 'retry')).toEqual([]);
  });
});

describe('scheduling', () => {
  test('publish makes it due; the scheduler runs the slot once and moves on', async () => {
    const { app, db } = await harness('workflows-schedule');
    const workflow = await published(app);
    expect(workflow.nextRunAt).not.toBeNull();

    const later = new Date(Date.now() + 60_000);
    const ran = await runDueWorkflows(db, { searcher, now: () => later });
    expect(ran.map((r) => [r.workflowId, r.trigger])).toEqual([[workflow.id, 'schedule']]);
    expect(await runDueWorkflows(db, { searcher, now: () => later })).toEqual([]);

    const row = await queryOne<{ next_run_at: string; last_run_status: string }>(
      db,
      'SELECT next_run_at, last_run_status FROM workflows WHERE id = ?',
      [workflow.id],
    );
    expect(row?.last_run_status).toBe('succeeded');
    expect(new Date(row!.next_run_at) > later).toBe(true);
    // 08:00 in Los Angeles: 15:00 or 16:00 UTC depending on DST.
    expect([15, 16]).toContain(new Date(row!.next_run_at).getUTCHours());
  });

  test('a reply starts an event-triggered workflow, once', async () => {
    const { app, db } = await harness('workflows-event');
    const workflow = await fromTemplate(app);
    const definition = {
      ...ENGINEERING_CONTRACT_TEMPLATE.definition,
      schedule: { kind: 'event', event: 'reply_received', hour: 8, minute: 0, timezone: 'UTC' },
    };
    await send(app, 'PATCH', `/workflows/${workflow.id}`, { definition });
    await send(app, 'POST', `/workflows/${workflow.id}/publish`);
    const first = await runNow(app, workflow.id);

    await db.execute({
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
              state, body, occurred_at, recorded_at)
            VALUES ('int_reply', ?, ?, ?, 'email', 'inbound', 'received', 'Interested!', ?, ?)`,
      args: [
        SEED.workspaceId,
        SEED.personId,
        first.campaignId,
        new Date(Date.now() + 1_000).toISOString(),
        new Date().toISOString(),
      ],
    });
    const later = new Date(Date.now() + 60_000);
    const ran = await runDueWorkflows(db, { searcher, now: () => later });
    expect(ran.map((r) => r.trigger)).toEqual(['event']);
    expect(await runDueWorkflows(db, { searcher, now: () => later })).toEqual([]);
  });

  test('pause stops the runs and the sending', async () => {
    const { app, db } = await harness('workflows-pause');
    const workflow = await published(app);
    const run = await runNow(app, workflow.id);
    await db.execute({
      sql: `UPDATE campaigns SET approval_mode = 'trusted_automation' WHERE id = ?`,
      args: [run.campaignId],
    });

    const paused = await json<{ workflow: WorkflowView }>(
      send(app, 'POST', `/workflows/${workflow.id}/pause`),
    );
    expect(paused.workflow).toMatchObject({ status: 'paused', nextRunAt: null });
    const campaign = await queryOne<{ status: string; approval_mode: string }>(
      db,
      'SELECT status, approval_mode FROM campaigns WHERE id = ?',
      [run.campaignId],
    );
    expect(campaign).toEqual({ status: 'paused', approval_mode: 'draft_and_approve' });
    expect(
      await runDueWorkflows(db, { searcher, now: () => new Date(Date.now() + 864e5) }),
    ).toEqual([]);

    const resumed = await json<{ workflow: WorkflowView }>(
      send(app, 'POST', `/workflows/${workflow.id}/resume`),
    );
    expect(resumed.workflow.status).toBe('active');
  });
});

describe('lifecycle', () => {
  test('clone, export, import, archive and delete', async () => {
    const { app, db } = await harness('workflows-lifecycle');
    const workflow = await fromTemplate(app);

    const clone = await json<{ workflow: WorkflowView }>(
      send(app, 'POST', `/workflows/${workflow.id}/clone`),
    );
    expect(clone.workflow.name).toBe('Copy of Engineering Contract Acquisition');

    const exported = await json<{ format: string; definition: unknown; name: string }>(
      send(app, 'GET', `/workflows/${workflow.id}/export`),
    );
    expect(exported.format).toBe('outreachgraph.workflow/v1');
    const imported = await send(app, 'POST', '/workflows/import', {
      name: 'Imported',
      definition: exported.definition,
    });
    expect(imported.status).toBe(201);

    expect((await send(app, 'POST', `/workflows/${clone.workflow.id}/archive`)).status).toBe(200);
    expect((await send(app, 'GET', `/workflows/${clone.workflow.id}`)).status).toBe(404);

    expect((await send(app, 'DELETE', `/workflows/${workflow.id}`)).status).toBe(200);
    expect(
      await queryAll(db, 'SELECT * FROM workflow_versions WHERE workflow_id = ?', [workflow.id]),
    ).toEqual([]);
    const list = await json<{ workflows: WorkflowView[] }>(send(app, 'GET', '/workflows'));
    expect(list.workflows.map((w) => w.name)).toEqual(['Imported']);
  });
});
