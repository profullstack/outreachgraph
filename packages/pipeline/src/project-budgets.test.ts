import { afterEach, describe, expect, test } from 'bun:test';
import { createDatabase, migrate, now, queryOne, type Client } from '@outreachgraph/db';
import { CONTACT_PRICE_USD } from '@outreachgraph/domain';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  applyProjectBudget,
  applyProjectBudgets,
  campaignBudgetFrom,
  setCampaignDailyBudget,
} from './project-budgets';

const MIGRATIONS_DIR = join(import.meta.dir, '../../../migrations');

let db: Client | undefined;
let path: string | undefined;

afterEach(() => {
  db?.close();
  if (path) for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  db = undefined;
  path = undefined;
});

async function fresh(label: string): Promise<Client> {
  path = join(import.meta.dir, `../.test-budgets-${label}-${process.pid}.db`);
  db = createDatabase({ url: `file:${path}` });
  await migrate(db, MIGRATIONS_DIR);

  const stamp = now();
  await db.batch([
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at)
            VALUES ('org_b', 'B', 'b', ?, ?)`,
      args: [stamp, stamp],
    },
    {
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
            VALUES ('wsp_b', 'org_b', 'B', 'b', ?, ?)`,
      args: [stamp, stamp],
    },
    {
      sql: `INSERT INTO offerings (id, workspace_id, name, category, created_at, updated_at)
            VALUES ('off_b', 'wsp_b', 'Widget', 'saas', ?, ?)`,
      args: [stamp, stamp],
    },
    ...['cmp_1', 'cmp_2'].map((id) => ({
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, status, budget_json,
            created_at, updated_at)
            VALUES (?, 'wsp_b', ?, 'off_b', 'active', '{"minHoursBetweenActions": 4}', ?, ?)`,
      args: [id, id, stamp, stamp],
    })),
  ]);

  return db;
}

async function budgetOf(client: Client, campaignId: string) {
  const row = await queryOne<{ budget_json: string }>(
    client,
    'SELECT budget_json FROM campaigns WHERE id = ?',
    [campaignId],
  );
  return { raw: JSON.parse(row?.budget_json ?? '{}'), ...campaignBudgetFrom(row?.budget_json) };
}

describe('setCampaignDailyBudget', () => {
  test('writes the dollars and the cap together, keeping other knobs', async () => {
    const client = await fresh('set');

    const stored = await setCampaignDailyBudget(client, 'wsp_b', 'cmp_1', 3);
    expect(stored?.dailyBudgetUsd).toBe(3);
    expect(stored?.maxActionsPerDay).toBe(Math.floor(3 / CONTACT_PRICE_USD));

    const after = await budgetOf(client, 'cmp_1');
    expect(after.raw.minHoursBetweenActions).toBe(4);
    expect(after.maxActionsPerDay).toBe(20);
  });

  test('null clears both', async () => {
    const client = await fresh('clear');
    await setCampaignDailyBudget(client, 'wsp_b', 'cmp_1', 3);
    const cleared = await setCampaignDailyBudget(client, 'wsp_b', 'cmp_1', null);
    expect(cleared?.dailyBudgetUsd).toBeUndefined();
    expect(cleared?.maxActionsPerDay).toBeUndefined();
    expect((await budgetOf(client, 'cmp_1')).raw.minHoursBetweenActions).toBe(4);
  });

  test('another workspace cannot reach the campaign', async () => {
    const client = await fresh('scope');
    expect(await setCampaignDailyBudget(client, 'wsp_other', 'cmp_1', 3)).toBeUndefined();
  });
});

describe('applyProjectBudgets', () => {
  test('a project without a ceiling is left alone', async () => {
    const client = await fresh('noceiling');
    const result = await applyProjectBudgets(client, 'wsp_b');
    expect(result).toEqual({ changed: 0, projects: 0 });
  });

  test('autopilot splits the ceiling across active campaigns', async () => {
    const client = await fresh('split');
    await client.execute({
      sql: `UPDATE offerings SET daily_budget_usd = 6, autopilot = 1 WHERE id = 'off_b'`,
      args: [],
    });

    const result = await applyProjectBudgets(client, 'wsp_b');
    expect(result.projects).toBe(1);
    expect(result.changed).toBe(2);

    const one = await budgetOf(client, 'cmp_1');
    const two = await budgetOf(client, 'cmp_2');
    expect((one.dailyBudgetUsd ?? 0) + (two.dailyBudgetUsd ?? 0)).toBe(6);
    expect(one.maxActionsPerDay).toBe(20);

    // Running again changes nothing: the allocator is idempotent.
    expect((await applyProjectBudgets(client, 'wsp_b')).changed).toBe(0);
  });

  test('manual budgets are only scaled when they exceed the ceiling', async () => {
    const client = await fresh('cap');
    await setCampaignDailyBudget(client, 'wsp_b', 'cmp_1', 30);
    await setCampaignDailyBudget(client, 'wsp_b', 'cmp_2', 10);
    await client.execute({
      sql: `UPDATE offerings SET daily_budget_usd = 20, autopilot = 0 WHERE id = 'off_b'`,
      args: [],
    });

    expect(await applyProjectBudget(client, 'wsp_b', 'off_b')).toBe(2);
    expect((await budgetOf(client, 'cmp_1')).dailyBudgetUsd).toBe(15);
    expect((await budgetOf(client, 'cmp_2')).dailyBudgetUsd).toBe(5);

    // Raise the ceiling: nothing is scaled back up, the customer's numbers stand.
    await client.execute({
      sql: `UPDATE offerings SET daily_budget_usd = 100 WHERE id = 'off_b'`,
      args: [],
    });
    expect(await applyProjectBudget(client, 'wsp_b', 'off_b')).toBe(0);
  });

  test('a paused campaign is not allocated to', async () => {
    const client = await fresh('paused');
    await client.execute({
      sql: `UPDATE campaigns SET status = 'paused' WHERE id = 'cmp_2'`,
      args: [],
    });
    await client.execute({
      sql: `UPDATE offerings SET daily_budget_usd = 6, autopilot = 1 WHERE id = 'off_b'`,
      args: [],
    });

    await applyProjectBudgets(client, 'wsp_b');
    expect((await budgetOf(client, 'cmp_1')).dailyBudgetUsd).toBe(6);
    expect((await budgetOf(client, 'cmp_2')).dailyBudgetUsd).toBeUndefined();
  });
});
