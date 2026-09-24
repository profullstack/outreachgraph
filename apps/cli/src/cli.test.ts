/**
 * The CLI, tested at its two edges: how a shell's argv becomes a request, and
 * how a failure becomes something a person can act on.
 */

import { describe, expect, test } from 'bun:test';
import { ApiError, createClient, type FetchLike } from '@outreachgraph/mcp/src/client';
import { commandByName, parseStepSpec, usage } from './commands';
import { explain, parseArgv } from './index';

const CONFIG = {
  baseUrl: 'https://api.test',
  token: 'tok',
  workspaceId: 'wsp_1',
  organizationId: 'org_1',
};

function client(body: unknown, status = 200) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { client: createClient(CONFIG, fetchImpl), calls };
}

describe('parseArgv', () => {
  test('splits a command from its positional arguments', () => {
    const parsed = parseArgv(['signals', 'per_1']);

    expect(parsed.command).toBe('signals');
    expect(parsed.args).toEqual(['per_1']);
  });

  test('reads a flag with a value', () => {
    expect(parseArgv(['prospects', '--limit', '10']).flags.limit).toBe('10');
  });

  test('treats a valueless flag as true', () => {
    expect(parseArgv(['today', '--help']).flags.help).toBe(true);
  });

  test('collects a repeated flag into a list', () => {
    // `--ask a --ask b` is how a shell expresses a list without inventing a
    // delimiter that will eventually appear inside one of the values.
    const parsed = parseArgv(['grid', '--ask', 'one?', '--ask', 'two?']);

    expect(parsed.flags.ask).toEqual(['one?', 'two?']);
  });

  test('does not swallow the next flag as a value', () => {
    const parsed = parseArgv(['grid', '--name', '--limit', '5']);

    expect(parsed.flags.name).toBe(true);
    expect(parsed.flags.limit).toBe('5');
  });

  test('reports no command for an empty argv', () => {
    expect(parseArgv([]).command).toBeUndefined();
  });
});

describe('profile', () => {
  test('show prints the file; edit sends the whole edited file; publish sends one flag', async () => {
    const { client: reader } = client({ raw: '# Jane\n\n- **Kind**: person\n' });
    const shown = await commandByName('profile')!.run({
      client: reader,
      args: ['per_1'],
      flags: {},
    });
    expect(shown).toBe('# Jane\n\n- **Kind**: person');

    // The editor is injected, so nothing is spawned; what it returns is what is sent.
    const { client: editor, calls } = client({
      raw: '# Jane\n\n- **Kind**: person\n',
      markdown: '# Jane\n\n- **Kind**: person\n\nEdited.\n',
      updatedAt: '2026-09-13T00:00:00.000Z',
    });
    const edited = await commandByName('profile')!.run({
      client: editor,
      args: ['edit', 'per_1'],
      flags: { edit: async (markdown: string) => `${markdown}\nEdited.\n` } as never,
    });
    expect(edited.startsWith('Saved per_1 at 2026-09-13')).toBe(true);
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.url).toBe('https://api.test/api/v1/people/per_1/openprofile');
    expect((put?.body as { markdown: string }).markdown).toContain('Edited.');

    const { client: publisher, calls: publishCalls } = client({
      public: true,
      url: 'https://og/x.md',
    });
    const published = await commandByName('profile')!.run({
      client: publisher,
      args: ['publish', 'per_1'],
      flags: { public: true },
    });
    expect(published).toBe('Public: https://og/x.md');
    expect(publishCalls[0]?.url).toBe('https://api.test/api/v1/people/per_1/openprofile/publish');
    expect(publishCalls[0]?.body).toEqual({ public: true });

    await expect(
      commandByName('profile')!.run({ client: publisher, args: ['publish', 'per_1'], flags: {} }),
    ).rejects.toThrow('--public | --private');
  });
});

describe('commands', () => {
  test('today lists the queue with ids first', async () => {
    const { client: api } = client({
      recommendations: [
        {
          id: 'rec_1',
          action: 'send_email',
          network: 'email',
          policy_status: 'allow',
          display_name: 'Jane',
        },
      ],
    });

    const output = await commandByName('today')!.run({ client: api, args: [], flags: {} });

    // The id leads, because it is what the next command needs.
    expect(output.startsWith('rec_1')).toBe(true);
    expect(output).toContain('Jane');
  });

  test('today says so plainly when there is nothing to do', async () => {
    const { client: api } = client({ recommendations: [] });

    const output = await commandByName('today')!.run({ client: api, args: [], flags: {} });

    expect(output).toContain('empty');
  });

  test('add requires a url rather than guessing', async () => {
    const { client: api, calls } = client({});

    expect(commandByName('add')!.run({ client: api, args: [], flags: {} })).rejects.toThrow(
      'url is required',
    );
    expect(calls).toHaveLength(0);
  });

  test('post asks for a share link and puts the url last', async () => {
    const { client: api, calls } = client({ shareUrl: 'https://linkedin.com/compose' });

    const output = await commandByName('post')!.run({
      client: api,
      args: ['rec_1'],
      flags: { network: 'linkedin' },
    });

    expect(calls[0]?.url).toContain('/recommendations/rec_1/share');
    // Alone on the last line, so `og post … | tail -1 | xargs open` works.
    expect(output.split('\n').pop()).toBe('https://linkedin.com/compose');
  });

  test('post refuses without a network', async () => {
    const { client: api } = client({});

    expect(commandByName('post')!.run({ client: api, args: ['rec_1'], flags: {} })).rejects.toThrow(
      '--network is required',
    );
  });

  test('grid requires a question and a person', async () => {
    const { client: api } = client({});

    expect(
      commandByName('grid')!.run({ client: api, args: [], flags: { name: 'x' } }),
    ).rejects.toThrow('--ask');
  });

  test('grid-run reports how far it got', async () => {
    const { client: api } = client({
      answered: 4,
      noEvidence: 1,
      remaining: 7,
      status: 'running',
    });

    const output = await commandByName('grid-run')!.run({
      client: api,
      args: ['grd_1'],
      flags: {},
    });

    expect(output).toContain('4 answered');
    expect(output).toContain('7 remaining');
  });
});

describe('cadences', () => {
  test('a step spec carries its delay, condition and acceptance wait', () => {
    expect(parseStepSpec('linkedin:connect:24::168', 1)).toEqual({
      position: 1,
      network: 'linkedin',
      action: 'connect',
      delayHours: 24,
      waitForAcceptanceHours: 168,
    });
    expect(parseStepSpec('email:send_email:0:if_not_connected', 3)).toEqual({
      position: 3,
      network: 'email',
      action: 'send_email',
      delayHours: 0,
      condition: 'if_not_connected',
    });
    expect(() => parseStepSpec('linkedin', 0)).toThrow('network:action');
    expect(() => parseStepSpec('linkedin:connect:soon', 0)).toThrow('not a number');
  });

  test('create posts the whole branching plan', async () => {
    const { client: api, calls } = client({ cadenceId: 'cad_1' });

    const output = await commandByName('cadences')!.run({
      client: api,
      args: ['create'],
      flags: {
        name: 'Visit, invite, DM or email',
        step: [
          'linkedin:view_profile',
          'linkedin:connect:24::168',
          'linkedin:send_dm:0:if_connected',
          'email:send_email:0:if_not_connected',
        ] as never,
        active: true,
      },
    });

    expect(output).toBe('Created cad_1 (active)');
    expect(calls[0]?.url).toBe('https://api.test/api/v1/cadences');
    expect(calls[0]?.body).toMatchObject({
      name: 'Visit, invite, DM or email',
      status: 'active',
      steps: [
        { position: 0, network: 'linkedin', action: 'view_profile', delayHours: 0 },
        { position: 1, action: 'connect', delayHours: 24, waitForAcceptanceHours: 168 },
        { position: 2, action: 'send_dm', condition: 'if_connected' },
        { position: 3, network: 'email', condition: 'if_not_connected' },
      ],
    });
  });

  test('show prints each step’s condition', async () => {
    const { client: api } = client({
      cadence: { id: 'cad_1', name: 'Plan', status: 'active' },
      steps: [
        {
          position: 0,
          network: 'linkedin',
          action: 'connect',
          delay_hours: 0,
          condition: 'always',
          wait_for_acceptance_hours: 168,
        },
        {
          position: 1,
          network: 'linkedin',
          action: 'send_dm',
          delay_hours: 24,
          condition: 'if_connected',
          wait_for_acceptance_hours: null,
        },
      ],
    });

    const output = await commandByName('cadences')!.run({
      client: api,
      args: ['show', 'cad_1'],
      flags: {},
    });

    expect(output).toContain('waits 168h for acceptance');
    expect(output).toContain('if_connected');
  });
});

describe('usage', () => {
  test('lists every command and the configuration it needs', () => {
    const text = usage();

    expect(text).toContain('today');
    expect(text).toContain('OUTREACHGRAPH_API_TOKEN');
  });
});

describe('explain', () => {
  test('presents a policy refusal as final, with the alternative', () => {
    const message = explain(
      new ApiError(403, 'policy_denied', 'Automated messaging is prohibited.'),
    );

    expect(message).toContain('refused again');
    expect(message).toContain('og post');
  });

  test('points at the credential on a 401', () => {
    expect(explain(new ApiError(401, 'unauthorized', 'no'))).toContain('OUTREACHGRAPH_API_TOKEN');
  });

  test('passes an ordinary error through', () => {
    expect(explain(new Error('network down'))).toBe('network down');
  });
});
