/**
 * The CLI, tested at its two edges: how a shell's argv becomes a request, and
 * how a failure becomes something a person can act on.
 */

import { describe, expect, test } from 'bun:test';
import { ApiError, createClient, type FetchLike } from '@outreachgraph/mcp/src/client';
import { commandByName, usage } from './commands';
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
