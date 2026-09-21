/**
 * The AutoGTM surface, end to end against a real database.
 *
 * Every route here is a translation onto code that has its own tests, so
 * these check the translation: that a dollar becomes the cap the engine
 * reads, that autopilot really does take the wheel, that a reply goes through
 * policy and out of the mailer, that a suppress list halts what was queued.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { Hono } from 'hono';
import type { Mailer, Message } from '@outreachgraph/email';
import { CONTACT_PRICE_USD, newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { createApp, type AppOptions } from './app';
import type { AppEnv, RequestActor } from './context';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import { OPERATIONS } from './autogtm-docs';

const ACTOR: RequestActor = {
  userId: SEED.userId,
  workspaceId: SEED.workspaceId,
  organizationId: SEED.organizationId,
  role: 'owner',
  credential: 'api_key',
};

let active: SeededDatabase | undefined;

afterEach(() => {
  active?.cleanup();
  active = undefined;
});

function stubMailer(): { mailer: Mailer; sent: Message[] } {
  const sent: Message[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        sent.push(message);
        return { id: `msg_${sent.length}` };
      },
    },
  };
}

async function harness(
  label: string,
  extra: Partial<AppOptions> = {},
  actor: RequestActor | null = ACTOR,
): Promise<{ app: Hono<AppEnv>; seeded: SeededDatabase }> {
  const seeded = await seedDatabase(label);
  active = seeded;
  const app = createApp({
    db: seeded.db,
    authenticate: async () => actor ?? undefined,
    ...extra,
  });
  return { app, seeded };
}

const get = (app: Hono<AppEnv>, path: string) => app.request(`/api/v1${path}`);
const send = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(`/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function json<T = Record<string, unknown>>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Jane gets an email address, one message out, and one reply in. */
async function giveJaneAThread(seeded: SeededDatabase): Promise<void> {
  const { db } = seeded;
  const stamp = now();
  const recId = newId('recommendation');
  const actionId = newId('action');

  await db.batch([
    {
      sql: `INSERT INTO social_identities (id, person_id, network, handle, platform_user_id,
            confidence, source_type, verified_by, first_seen_at)
            VALUES ('sid_jane_email', ?, 'email', 'jane@acme.com', NULL, 0.97, 'crawl', '[]', ?)`,
      args: [SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO recommendations (id, workspace_id, campaign_id, person_id, action, network,
            priority, reason, policy_status, policy_version, expected_goal, status, created_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 80, 'seed', 'allow_with_approval',
            '2026-08-11', 'start_conversation', 'executed', ?)`,
      args: [recId, SEED.workspaceId, SEED.campaignId, SEED.personId, stamp],
    },
    {
      sql: `INSERT INTO drafts (id, workspace_id, recommendation_id, subject, body,
            grounded_signal_ids, checks_json, created_at, updated_at)
            VALUES (?, ?, ?, 'Cross-border payouts at Acme', 'Hi Jane', '[]', '[]', ?, ?)`,
      args: [newId('draft'), SEED.workspaceId, recId, stamp, stamp],
    },
    {
      sql: `INSERT INTO actions (id, workspace_id, recommendation_id, person_id, kind, network,
            mode, status, body, created_at, executed_at)
            VALUES (?, ?, ?, ?, 'send_email', 'email', 'customer_managed', 'completed', 'Hi Jane',
            ?, ?)`,
      args: [actionId, SEED.workspaceId, recId, SEED.personId, stamp, stamp],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, action_id, network,
            direction, state, body, contact_address, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, ?, 'email', 'outbound', 'contacted', 'Hi Jane', 'jane@acme.com',
            '2026-09-01T10:00:00.000Z', ?)`,
      args: [
        newId('interaction'),
        SEED.workspaceId,
        SEED.personId,
        SEED.campaignId,
        actionId,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO interactions (id, workspace_id, person_id, campaign_id, network, direction,
            state, body, contact_address, occurred_at, recorded_at)
            VALUES (?, ?, ?, ?, 'email', 'inbound', 'responded', 'Sure, tell me more',
            'jane@acme.com', '2026-09-02T09:00:00.000Z', ?)`,
      args: [newId('interaction'), SEED.workspaceId, SEED.personId, SEED.campaignId, stamp],
    },
    {
      sql: `UPDATE campaign_people SET status = 'responded', interaction_state = 'responded'
             WHERE campaign_id = ? AND person_id = ?`,
      args: [SEED.campaignId, SEED.personId],
    },
  ]);
}

// ------------------------------------------------------------------ docs

describe('the machine-readable docs', () => {
  test('are keyless and agree with each other', async () => {
    const { app } = await harness('docs', {}, null);

    const openapi = await get(app, '/public/openapi.json');
    expect(openapi.status).toBe(200);
    const doc = await json<{
      paths: Record<string, Record<string, unknown>>;
      info: { title: string };
    }>(openapi);
    expect(doc.info.title).toContain('AutoGTM');

    const llms = await get(app, '/public/llms.txt');
    expect(llms.status).toBe(200);
    const text = await llms.text();
    expect(text).toContain('X-API-Key');

    for (const op of OPERATIONS) {
      expect(doc.paths[op.path]?.[op.method]).toBeDefined();
      expect(text).toContain(`${op.method.toUpperCase()} ${op.path}`);
    }
  });

  test('every documented route exists', async () => {
    const { app } = await harness('docs-routes');

    for (const op of OPERATIONS) {
      const path = op.path.replace(/\{[^}]+\}/g, 'nope');
      const response = await app.request(`/api/v1${path}`, {
        method: op.method.toUpperCase(),
        headers: { 'content-type': 'application/json' },
        body: op.method === 'get' || op.method === 'delete' ? undefined : '{}',
      });
      // Anything but "route not found": 404 with a named entity, 400, 403...
      if (response.status === 404) {
        const body = await json<{ error: { message: string } }>(response);
        expect(body.error.message).not.toBe('route not found');
      }
    }
  });
});

// -------------------------------------------------------------- projects

describe('projects', () => {
  test('a project is an offering, with its budget and switch', async () => {
    const { app } = await harness('projects');
    const listed = await json<{
      projects: { id: string; autopilot: boolean; campaigns: number }[];
    }>(await get(app, '/autogtm/projects'));
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]?.id).toBe(SEED.offeringId);
    expect(listed.projects[0]?.autopilot).toBe(false);
    expect(listed.projects[0]?.campaigns).toBe(1);

    const one = await get(app, `/autogtm/projects/${SEED.offeringId}`);
    expect(one.status).toBe(200);
    expect((await get(app, '/autogtm/projects/off_nope')).status).toBe(404);
  });

  test('a project ceiling with autopilot on becomes campaign caps', async () => {
    const { app, seeded } = await harness('project-budget');

    const set = await send(app, 'PATCH', `/autogtm/projects/${SEED.offeringId}/budget`, {
      daily_budget_usd: 6,
    });
    expect(set.status).toBe(200);
    // Autopilot off: the ceiling is a cap on hand-set budgets, and there are none yet.
    expect((await json(set)).campaigns_reallocated).toBe(0);

    const on = await send(app, 'PATCH', `/autogtm/projects/${SEED.offeringId}/autopilot`, {
      enabled: true,
    });
    expect(on.status).toBe(200);
    expect((await json(on)).campaigns_reallocated).toBe(1);

    const campaign = await queryOne<{ approval_mode: string; budget_json: string }>(
      seeded.db,
      'SELECT approval_mode, budget_json FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(campaign?.approval_mode).toBe('trusted_automation');
    const budget = JSON.parse(campaign?.budget_json ?? '{}');
    expect(budget.dailyBudgetUsd).toBe(6);
    expect(budget.maxActionsPerDay).toBe(Math.floor(6 / CONTACT_PRICE_USD));
    // The seed's other knob survives.
    expect(budget.maxActionsPerProspectPerWeek).toBe(1);

    const read = await json<{ allocated_usd: number; allocation: { daily_limit_usd: number }[] }>(
      await get(app, `/autogtm/projects/${SEED.offeringId}/budget`),
    );
    expect(read.allocated_usd).toBe(6);
    expect(read.allocation[0]?.daily_limit_usd).toBe(6);

    const off = await send(app, 'PATCH', `/autogtm/projects/${SEED.offeringId}/autopilot`, {
      enabled: false,
    });
    expect(off.status).toBe(200);
    const after = await queryOne<{ approval_mode: string }>(
      seeded.db,
      'SELECT approval_mode FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(after?.approval_mode).toBe('draft_and_approve');
  });

  test('a viewer may read but not spend', async () => {
    const { app } = await harness('viewer', {}, { ...ACTOR, role: 'viewer' });
    expect((await get(app, '/autogtm/projects')).status).toBe(200);
    const set = await send(app, 'PATCH', `/autogtm/projects/${SEED.offeringId}/budget`, {
      daily_budget_usd: 6,
    });
    expect(set.status).toBe(403);
  });
});

// ------------------------------------------------------------- campaigns

describe('campaigns', () => {
  test('list, read and the status vocabulary', async () => {
    const { app } = await harness('campaigns');
    const list = await json<{ campaigns: { id: string; status: string; leads_pool: number }[] }>(
      await get(app, '/autogtm/campaigns'),
    );
    expect(list.campaigns).toHaveLength(1);
    // Seeded as draft_and_approve + 'running': sends wait for a human.
    expect(list.campaigns[0]?.status).toBe('review');
    expect(list.campaigns[0]?.leads_pool).toBe(1);

    const filtered = await json<{ campaigns: unknown[] }>(
      await get(app, '/autogtm/campaigns?project_id=off_other'),
    );
    expect(filtered.campaigns).toHaveLength(0);

    const one = await json<{
      campaign: { targeting: { titles: string[] }; instructions: unknown };
    }>(await get(app, `/autogtm/campaigns/${SEED.campaignId}`));
    expect(Array.isArray(one.campaign.targeting.titles)).toBe(true);
  });

  test('targeting and instructions are editable', async () => {
    const { app, seeded } = await harness('campaign-patch');
    const patched = await send(app, 'PATCH', `/autogtm/campaigns/${SEED.campaignId}`, {
      instructions: 'Lead with the settlement angle.',
      targeting: { titles: ['VP Engineering', 'CTO'], employee_count_min: 50 },
    });
    expect(patched.status).toBe(200);

    const filters = await queryOne<{ titles: string; employee_count_min: number | null }>(
      seeded.db,
      'SELECT titles, employee_count_min FROM campaign_filters WHERE campaign_id = ?',
      [SEED.campaignId],
    );
    expect(JSON.parse(filters?.titles ?? '[]')).toEqual(['VP Engineering', 'CTO']);
    expect(filters?.employee_count_min).toBe(50);

    const brief = await queryOne<{ brief: string }>(
      seeded.db,
      'SELECT brief FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(brief?.brief).toBe('Lead with the settlement angle.');

    const empty = await send(app, 'PATCH', `/autogtm/campaigns/${SEED.campaignId}`, {});
    expect(empty.status).toBe(400);
  });

  test('start, stop and a per-campaign budget, until autopilot owns them', async () => {
    const { app, seeded } = await harness('campaign-control');

    const stopped = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/stop`);
    expect(stopped.status).toBe(200);
    expect((await json(stopped)).status).toBe('listening');

    const started = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/start`);
    expect((await json(started)).status).toBe('outreach');

    const budget = await send(app, 'PATCH', `/autogtm/campaigns/${SEED.campaignId}/budget`, {
      daily_limit_usd: 1.5,
    });
    expect(budget.status).toBe(200);
    const stored = await json<{ daily_limit_usd: number; max_contacts_per_day: number }>(budget);
    expect(stored.daily_limit_usd).toBe(1.5);
    expect(stored.max_contacts_per_day).toBe(10);

    await send(app, 'PATCH', `/autogtm/projects/${SEED.offeringId}/autopilot`, { enabled: true });

    const refused = await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/stop`);
    expect(refused.status).toBe(409);
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('autopilot_on');

    const refusedBudget = await send(app, 'PATCH', `/autogtm/campaigns/${SEED.campaignId}/budget`, {
      daily_limit_usd: 3,
    });
    expect(refusedBudget.status).toBe(409);

    const row = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM campaigns WHERE id = ?',
      [SEED.campaignId],
    );
    expect(row?.status).toBe('active');
  });

  test('a campaign in another workspace is not reachable', async () => {
    const { app } = await harness('campaign-scope', {}, { ...ACTOR, workspaceId: 'wsp_other' });
    expect((await get(app, `/autogtm/campaigns/${SEED.campaignId}`)).status).toBe(404);
    expect((await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/stop`)).status).toBe(
      404,
    );
  });
});

// ------------------------------------------------------------- analytics

describe('analytics', () => {
  test('count what happened and price it', async () => {
    const { app, seeded } = await harness('analytics');
    await giveJaneAThread(seeded);

    const a = await json<{
      emails_sent: number;
      replies: number;
      reply_rate: number;
      hot_leads: number;
      need_reply: number;
      spend_usd: number;
      cost_per_lead_usd: number;
    }>(await get(app, `/autogtm/campaigns/${SEED.campaignId}/analytics`));

    expect(a.emails_sent).toBe(1);
    expect(a.replies).toBe(1);
    expect(a.reply_rate).toBe(1);
    expect(a.hot_leads).toBe(1);
    expect(a.need_reply).toBe(1);
    expect(a.spend_usd).toBe(CONTACT_PRICE_USD);
    expect(a.cost_per_lead_usd).toBe(CONTACT_PRICE_USD);

    const windowed = await json<{ emails_sent: number }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/analytics?since=2026-09-02T00:00:00Z`),
    );
    expect(windowed.emails_sent).toBe(0);

    const project = await json<{ totals: { replies: number }; campaigns: unknown[] }>(
      await get(app, `/autogtm/projects/${SEED.offeringId}/analytics`),
    );
    expect(project.totals.replies).toBe(1);
    expect(project.campaigns).toHaveLength(1);
  });
});

// ----------------------------------------------------------------- inbox

describe('inbox', () => {
  test('tabs by who spoke last, and the thread reads in order', async () => {
    const { app, seeded } = await harness('inbox');
    await giveJaneAThread(seeded);

    const need = await json<{ conversations: { person_id: string; status: string }[] }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox?tab=need_reply`),
    );
    expect(need.conversations).toHaveLength(1);
    expect(need.conversations[0]?.status).toBe('need_reply');

    const sent = await json<{ conversations: unknown[] }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox?tab=sent`),
    );
    expect(sent.conversations).toHaveLength(0);

    const bad = await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox?tab=spam`);
    expect(bad.status).toBe(400);

    const thread = await json<{ messages: { from: string; subject: string | null }[] }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}`),
    );
    expect(thread.messages.map((m) => m.from)).toEqual(['you', 'lead']);
    expect(thread.messages[0]?.subject).toBe('Cross-border payouts at Acme');

    expect((await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox/per_nope`)).status).toBe(
      404,
    );
  });

  test('a reply goes through policy and out of the mailer, threaded', async () => {
    const { mailer, sent } = stubMailer();
    const { app, seeded } = await harness('inbox-reply', { mailer, appUrl: 'https://og.test' });
    await giveJaneAThread(seeded);

    const reply = await send(
      app,
      'POST',
      `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/reply`,
      { text: 'Happy to. Does Thursday work?' },
    );
    expect(reply.status).toBe(200);
    const body = await json<{ sent: boolean; subject: string; to: string }>(reply);
    expect(body.sent).toBe(true);
    expect(body.subject).toBe('Re: Cross-border payouts at Acme');
    expect(body.to).toBe('jane@acme.com');

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain('Happy to. Does Thursday work?');

    // Recorded like any other send: an outbound interaction, an approval, an action.
    const outbound = await queryAll<{ direction: string }>(
      seeded.db,
      `SELECT direction FROM interactions WHERE person_id = ? ORDER BY occurred_at`,
      [SEED.personId],
    );
    expect(outbound.map((r) => r.direction)).toEqual(['outbound', 'inbound', 'outbound']);

    const tabs = await json<{ conversations: { status: string }[] }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox?tab=replied`),
    );
    expect(tabs.conversations[0]?.status).toBe('replied');
  });

  test('a reply to a suppressed lead is refused by policy', async () => {
    const { mailer, sent } = stubMailer();
    const { app, seeded } = await harness('inbox-reply-suppressed', { mailer });
    await giveJaneAThread(seeded);

    const listed = await send(app, 'POST', '/autogtm/suppress-list/people', {
      list_name: 'opted-out',
      emails: ['Jane@Acme.com'],
    });
    expect(listed.status).toBe(201);

    const reply = await send(
      app,
      'POST',
      `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/reply`,
      { text: 'One more thing' },
    );
    expect(reply.status).toBe(409);
    expect((await json<{ error: { code: string } }>(reply)).error.code).toBe('policy_denied');
    expect(sent).toHaveLength(0);
  });

  test('notes are per lead per campaign', async () => {
    const { app } = await harness('inbox-note');

    const set = await send(
      app,
      'POST',
      `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/note`,
      { note: 'Wants a demo in Q4' },
    );
    expect(set.status).toBe(200);

    const read = await json<{ note: string }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/note`),
    );
    expect(read.note).toBe('Wants a demo in Q4');

    await send(app, 'POST', `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/note`, {
      note: null,
    });
    const cleared = await json<{ note: string | null }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox/${SEED.personId}/note`),
    );
    expect(cleared.note).toBeNull();
  });

  test('hot leads are the people who replied, across campaigns, pollable', async () => {
    const { app, seeded } = await harness('hot-leads');

    const before = await json<{ hot_leads: unknown[] }>(await get(app, '/autogtm/hot-leads'));
    expect(before.hot_leads).toHaveLength(0);

    await giveJaneAThread(seeded);

    const after = await json<{ hot_leads: { person_id: string; last_reply_preview: string }[] }>(
      await get(app, '/autogtm/hot-leads'),
    );
    expect(after.hot_leads).toHaveLength(1);
    expect(after.hot_leads[0]?.person_id).toBe(SEED.personId);
    expect(after.hot_leads[0]?.last_reply_preview).toBe('Sure, tell me more');

    const polled = await json<{ hot_leads: unknown[] }>(
      await get(app, '/autogtm/hot-leads?since=2026-09-03T00:00:00Z'),
    );
    expect(polled.hot_leads).toHaveLength(0);
  });
});

// -------------------------------------------------------- suppress lists

describe('suppress lists', () => {
  test('a people list halts what was queued and reads back', async () => {
    const { app, seeded } = await harness('suppress-people');
    await giveJaneAThread(seeded);

    // The seed's pending card for Jane.
    const pendingBefore = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [SEED.recommendationId],
    );
    expect(pendingBefore?.status).toBe('pending');

    const created = await send(app, 'POST', '/autogtm/suppress-list/people', {
      list_name: 'competitors',
      emails: ['jane@acme.com', 'bob@example.com'],
    });
    expect(created.status).toBe(201);
    const result = await json<{ added: number; people_halted: number }>(created);
    expect(result.added).toBe(2);
    expect(result.people_halted).toBe(1);

    const pendingAfter = await queryOne<{ status: string }>(
      seeded.db,
      'SELECT status FROM recommendations WHERE id = ?',
      [SEED.recommendationId],
    );
    expect(pendingAfter?.status).toBe('skipped');

    const lists = await json<{ lists: { list_name: string; entries: number }[] }>(
      await get(app, '/autogtm/suppress-list/people'),
    );
    expect(lists.lists).toEqual([
      expect.objectContaining({ list_name: 'competitors', entries: 2 }),
    ]);

    const one = await json<{ emails: string[] }>(
      await get(app, '/autogtm/suppress-list/people/competitors'),
    );
    expect(one.emails.sort()).toEqual(['bob@example.com', 'jane@acme.com']);

    const inbox = await json<{ conversations: { status: string }[] }>(
      await get(app, `/autogtm/campaigns/${SEED.campaignId}/inbox?tab=unsubscribed`),
    );
    expect(inbox.conversations[0]?.status).toBe('unsubscribed');

    const deleted = await send(app, 'DELETE', '/autogtm/suppress-list/people/competitors');
    expect(deleted.status).toBe(200);
    expect((await get(app, '/autogtm/suppress-list/people/competitors')).status).toBe(404);

    const keys = await queryOne<{ n: number }>(
      seeded.db,
      `SELECT count(*) AS n FROM suppression_keys WHERE workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(Number(keys?.n)).toBe(0);
  });

  test('a company list matches by normalised domain', async () => {
    const { app } = await harness('suppress-companies');

    const created = await send(app, 'POST', '/autogtm/suppress-list/companies', {
      list_name: 'customers',
      domains: ['https://www.Acme.com/', 'other.io'],
    });
    expect(created.status).toBe(201);
    const result = await json<{ people_halted: number }>(created);
    // Jane works at acme.com.
    expect(result.people_halted).toBe(1);

    const one = await json<{ domains: string[] }>(
      await get(app, '/autogtm/suppress-list/companies/customers'),
    );
    expect(one.domains.sort()).toEqual(['acme.com', 'other.io']);
  });
});

// ---------------------------------------------------------------- import

describe('import', () => {
  test('creates a campaign, its members, and queues their sites for research', async () => {
    const { app, seeded } = await harness('import');

    const created = await send(app, 'POST', '/autogtm/campaigns/import', {
      name: 'Q4 list',
      instructions: 'Short and specific.',
      leads: [
        {
          email: 'ana@northwind.io',
          first_name: 'Ana',
          last_name: 'Reyes',
          company_domain: 'northwind.io',
          job_title: 'Head of Ops',
        },
        { email: 'sam@northwind.io', first_name: 'Sam', last_name: 'Lee' },
        { email: 'not-an-email', first_name: 'Nope' },
        { email: 'pat@gmail.com', first_name: 'Pat', last_name: 'Free' },
      ],
    });
    // The bad row fails the schema, so the whole request is refused: an
    // import that silently drops a row is an import nobody can reconcile.
    expect(created.status).toBe(400);

    const ok = await send(app, 'POST', '/autogtm/campaigns/import', {
      name: 'Q4 list',
      instructions: 'Short and specific.',
      leads: [
        {
          email: 'ana@northwind.io',
          first_name: 'Ana',
          last_name: 'Reyes',
          company_domain: 'northwind.io',
          job_title: 'Head of Ops',
        },
        { email: 'sam@northwind.io', first_name: 'Sam', last_name: 'Lee' },
        { email: 'pat@gmail.com', first_name: 'Pat', last_name: 'Free' },
      ],
    });
    expect(ok.status).toBe(201);
    const body = await json<{
      task_id: string;
      campaign_id: string;
      imported: number;
      crawls_queued: number;
    }>(ok);
    expect(body.imported).toBe(3);
    // Two at northwind.io share one crawl; gmail is nobody's company.
    expect(body.crawls_queued).toBe(1);

    const members = await queryOne<{ n: number }>(
      seeded.db,
      'SELECT count(*) AS n FROM campaign_people WHERE campaign_id = ?',
      [body.campaign_id],
    );
    expect(Number(members?.n)).toBe(3);

    const job = await queryOne<{ payload_json: string }>(
      seeded.db,
      `SELECT payload_json FROM jobs WHERE kind = 'crawl_site' AND workspace_id = ?`,
      [SEED.workspaceId],
    );
    expect(JSON.parse(job?.payload_json ?? '{}')).toEqual({
      url: 'https://northwind.io',
      campaignId: body.campaign_id,
    });

    const campaign = await json<{
      campaign: { status: string; leads_pool: number; instructions: string };
    }>(await get(app, `/autogtm/campaigns/${body.campaign_id}`));
    expect(campaign.campaign.leads_pool).toBe(3);
    expect(campaign.campaign.instructions).toBe('Short and specific.');

    const task = await json<{ status: string; imported: number }>(
      await get(app, `/autogtm/campaigns/import/${body.task_id}`),
    );
    expect(task.status).toBe('completed');
    expect(task.imported).toBe(3);

    expect((await get(app, '/autogtm/campaigns/import/imp_nope')).status).toBe(404);
  });

  test('an unknown project is a 404, not a new offering', async () => {
    const { app, seeded } = await harness('import-project');
    const refused = await send(app, 'POST', '/autogtm/campaigns/import', {
      name: 'x',
      project_id: 'off_nope',
      leads: [{ email: 'a@b.co' }],
    });
    expect(refused.status).toBe(404);
    const offerings = await queryOne<{ n: number }>(
      seeded.db,
      'SELECT count(*) AS n FROM offerings',
      [],
    );
    expect(Number(offerings?.n)).toBe(1);
  });
});

// --------------------------------------------------------------- billing

describe('billing', () => {
  test('balance reads the plan and credits', async () => {
    const { app } = await harness('billing');
    const balance = await json<{
      plan: { id: string };
      credits: { remaining: number; price_per_contact_usd: number };
      exhausted: boolean;
    }>(await get(app, '/autogtm/billing/balance'));
    expect(balance.plan.id).toBe('free');
    expect(balance.credits.remaining).toBe(0);
    expect(balance.credits.price_per_contact_usd).toBe(CONTACT_PRICE_USD);
    expect(balance.exhausted).toBe(false);
  });
});
