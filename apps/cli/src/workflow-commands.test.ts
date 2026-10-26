import { describe, expect, test } from 'bun:test';
import { createClient, type FetchLike } from '@outreachgraph/mcp/src/client';
import { commandByName } from './commands';

const CONFIG = {
  baseUrl: 'https://api.test',
  token: 'tok',
  workspaceId: 'wsp_1',
  organizationId: 'org_1',
};

function client(body: unknown) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { client: createClient(CONFIG, fetchImpl), calls };
}

const WORKFLOW = {
  id: 'wfl_1',
  name: 'Engineering Contract Acquisition',
  status: 'draft',
  version: 1,
  publishedVersion: null,
  plan: [
    { id: 'trigger', title: 'Every weekday at 08:00 America/Los_Angeles', detail: 'Each run…' },
    {
      id: 'send',
      title: 'Send (policy-checked)',
      detail: 'Up to 25 a day (asked for 200)',
      warnings: ['the workspace sends at most 25 a day'],
    },
  ],
};

describe('og workflow commands', () => {
  test('create from the template posts to the API and prints the plan', async () => {
    const { client: c, calls } = client({ workflow: WORKFLOW });
    const output = await commandByName('workflow-create')!.run({
      client: c,
      args: [],
      flags: { template: 'engineering-contract-acquisition' },
    });

    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v1/workflows',
      body: { templateId: 'engineering-contract-acquisition' },
    });
    expect(output).toContain('Created wfl_1');
    expect(output).toContain('Up to 25 a day (asked for 200)');
    expect(output).toContain('! the workspace sends at most 25 a day');
  });

  test('edit sends the English instruction as a PATCH', async () => {
    const { client: c, calls } = client({
      workflow: { ...WORKFLOW, version: 2 },
      interpretedBy: 'rules',
    });
    await commandByName('workflow-edit')!.run({
      client: c,
      args: ['wfl_1', 'make it', '100 a day'],
      flags: {},
    });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.test/api/v1/workflows/wfl_1',
      body: { instruction: 'make it 100 a day' },
    });
  });

  test('a run prints each step and the errors', async () => {
    const { client: c } = client({
      run: {
        runId: 'wfr_1',
        status: 'retry_scheduled',
        retryAt: '2026-10-26T16:05:00.000Z',
        steps: [{ id: 'discover-1', status: 'failed', detail: 'ValueSERP answered 503' }],
        error: 'Search job boards: ValueSERP answered 503',
      },
    });
    const output = await commandByName('workflow-run')!.run({
      client: c,
      args: ['wfl_1'],
      flags: {},
    });
    expect(output).toContain('Run wfr_1: retry_scheduled (retry at 2026-10-26T16:05:00.000Z)');
    expect(output).toContain('failed    discover-1');
    expect(output).toContain('Errors:');
  });

  test('every workflow command is listed', () => {
    for (const name of [
      'workflows',
      'workflow',
      'workflow-create',
      'workflow-edit',
      'workflow-dry-run',
      'workflow-publish',
      'workflow-run',
      'workflow-pause',
      'workflow-resume',
      'workflow-runs',
      'workflow-cancel',
      'workflow-export',
      'workflow-import',
    ]) {
      expect(commandByName(name)).toBeDefined();
    }
  });
});
