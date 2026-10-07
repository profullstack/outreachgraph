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

  test('products-add sends every site and points at the batch', async () => {
    const { client: api, calls } = client({
      batchId: 'job_1',
      queued: ['ugig.net', 'bl0ggers.com'],
      existing: [{ domain: 'nichedb.dev', offeringId: 'off_1', name: 'nichedb' }],
      invalid: [],
    });

    const output = await commandByName('products-add')!.run({
      client: api,
      args: ['ugig.net', 'nichedb.dev', 'bl0ggers.com'],
      flags: { autopilot: true },
    });

    expect(calls[0]?.url).toBe('https://api.test/api/v1/campaigns/bulk');
    expect(calls[0]?.body).toEqual({
      domains: ['ugig.net', 'nichedb.dev', 'bl0ggers.com'],
      autopilot: true,
    });
    expect(output).toContain('Queued 2 sites');
    expect(output).toContain('og batch job_1');
    expect(output).toContain('Already products: nichedb.dev');
  });

  test('products-add with no sites asks for one instead of posting nothing', async () => {
    const { client: api, calls } = client({});
    await expect(
      commandByName('products-add')!.run({ client: api, args: [], flags: {} }),
    ).rejects.toThrow('at least one site');
    expect(calls).toHaveLength(0);
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

  test('webhooks add posts the url and filter, and prints the secret once', async () => {
    const { client: api, calls } = client({
      endpoint: { id: 'whk_1', urlHint: 'https://hooks.slack.com/…abcd' },
      secret: 'whsec_abc',
    });

    const output = await commandByName('webhooks')!.run({
      client: api,
      args: ['add', 'https://hooks.slack.com/services/T/B/abcd'],
      flags: { slack: true, events: 'reply.received, action.sent' },
    });

    expect(calls[0]?.url).toBe('https://api.test/api/v1/webhooks');
    expect(calls[0]?.body).toEqual({
      url: 'https://hooks.slack.com/services/T/B/abcd',
      kind: 'slack',
      events: ['reply.received', 'action.sent'],
    });
    expect(output).toContain('whk_1');
    expect(output).toContain('whsec_abc');
  });

  test('webhooks list prints one endpoint per line, id first; rm and test hit the id', async () => {
    const { client: api, calls } = client({
      endpoints: [
        { id: 'whk_1', kind: 'generic', active: true, events: [], urlHint: 'https://a.example' },
      ],
    });
    const webhooks = commandByName('webhooks')!;

    const listed = await webhooks.run({ client: api, args: ['list'], flags: {} });
    expect(listed.startsWith('whk_1')).toBe(true);
    expect(listed).toContain('all events');

    await webhooks.run({ client: api, args: ['test', 'whk_1'], flags: {} });
    await webhooks.run({ client: api, args: ['rm', 'whk_1'], flags: {} });
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'https://api.test/api/v1/webhooks/whk_1/test',
    });
    expect(calls[2]).toMatchObject({
      method: 'DELETE',
      url: 'https://api.test/api/v1/webhooks/whk_1',
    });
  });

  test('connect hubspot sends the token to the CRM route', async () => {
    const { client: api, calls } = client({ connection: { provider: 'hubspot', connected: true } });

    const output = await commandByName('connect')!.run({
      client: api,
      args: ['hubspot'],
      flags: { token: 'pat-123' },
    });

    expect(calls[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.test/api/v1/integrations/crm/hubspot',
      body: { token: 'pat-123' },
    });
    expect(output).toContain('HubSpot');
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

describe('og mailboxes', () => {
  test('lists health, bounce risk and whether replies are read', async () => {
    const { client: api } = client({
      mailboxes: [
        {
          id: 'ita_1',
          fromEmail: 'ana@acme.com',
          status: 'active',
          healthScore: 80,
          bounceRisk: 'low',
          sentToday: 3,
          effectiveCapToday: 8,
          readsReplies: false,
          repliesError: null,
        },
      ],
    });
    const output = await commandByName('mailboxes')!.run({ client: api, args: [], flags: {} });
    expect(output).toContain('ana@acme.com');
    expect(output).toContain('health 80');
    expect(output).toContain('replies NOT read');
  });

  test('add detects the servers, connects, then sets cap and warm-up', async () => {
    const { client: api, calls } = client({
      detected: {
        providerLabel: 'Forward Email',
        source: 'mx',
        smtp: { host: 'smtp.forwardemail.net', port: 465, secure: true },
        imap: { host: 'imap.forwardemail.net', port: 993 },
        note: null,
      },
      account: { accountId: 'ita_9' },
    });
    process.env.OG_MAILBOX_PASSWORD = 'pw';
    try {
      const output = await commandByName('mailboxes')!.run({
        client: api,
        args: ['add', 'ana@acme.com'],
        flags: { cap: '30', 'no-warmup': true },
      });
      expect(output).toContain('Connected ana@acme.com (ita_9)');
    } finally {
      delete process.env.OG_MAILBOX_PASSWORD;
    }

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', 'https://api.test/api/v1/mailboxes/detect'],
      ['PUT', 'https://api.test/api/v1/integrations/email'],
      ['PATCH', 'https://api.test/api/v1/senders/ita_9'],
    ]);
    expect(calls[1]!.body).toMatchObject({
      host: 'smtp.forwardemail.net',
      imapHost: 'imap.forwardemail.net',
      username: 'ana@acme.com',
      password: 'pw',
    });
    expect(calls[2]!.body).toEqual({ dailyCap: 30, warmup: false });
  });
});

describe('og senders', () => {
  test('lists each account with today’s numbers and warm-up day', async () => {
    const { client: api } = client({
      senders: [
        {
          id: 'ita_1',
          network: 'email',
          label: null,
          handle: 'ana@acme.com',
          status: 'active',
          statusReason: null,
          configuredCap: 50,
          effectiveCapToday: 8,
          sentToday: 3,
          warmup: { enabled: true, day: 1, complete: false },
        },
        {
          id: 'ita_2',
          network: 'linkedin',
          label: 'Bo',
          handle: 'bo',
          status: 'error',
          statusReason: 'LinkedIn signed this session out',
          configuredCap: 25,
          effectiveCapToday: 0,
          sentToday: 0,
          warmup: { enabled: false, day: null, complete: true },
        },
      ],
    });

    const output = await commandByName('senders')!.run({ client: api, args: [], flags: {} });
    const [first, second] = output.split('\n');

    expect(first).toStartWith('ita_1');
    expect(first).toContain('3/8 today (cap 50)');
    expect(first).toContain('warm-up day 1');
    expect(second).toContain('Bo');
    expect(second).toContain('LinkedIn signed this session out');
  });

  test('pause, resume and cap become one PATCH each', async () => {
    const { client: api, calls } = client({
      sender: {
        id: 'ita_1',
        status: 'paused',
        sentToday: 0,
        effectiveCapToday: 0,
        configuredCap: 50,
      },
    });
    const run = (args: string[]) => commandByName('senders')!.run({ client: api, args, flags: {} });

    await run(['pause', 'ita_1']);
    await run(['resume', 'ita_1']);
    await run(['cap', 'ita_1', '12']);
    await run(['cap', 'ita_1', 'default']);

    expect(calls.map((call) => [call.method, call.url, call.body])).toEqual([
      ['PATCH', 'https://api.test/api/v1/senders/ita_1', { paused: true }],
      ['PATCH', 'https://api.test/api/v1/senders/ita_1', { paused: false }],
      ['PATCH', 'https://api.test/api/v1/senders/ita_1', { dailyCap: 12 }],
      ['PATCH', 'https://api.test/api/v1/senders/ita_1', { dailyCap: null }],
    ]);
    await expect(run(['cap', 'ita_1', 'lots'])).rejects.toThrow('whole number');
  });
});

describe('audience', () => {
  test('watch takes network:handle or a profile URL', async () => {
    const { client: api, calls } = client({ watch: { id: 'awt_1', kinds: ['follow'] } });
    const run = (args: string[], flags = {}) =>
      commandByName('audience')!.run({ client: api, args, flags });

    await run(['watch', 'bluesky:acme.bsky.social'], { campaign: 'cmp_1', kinds: 'follow,like' });
    await run(['watch', 'https://x.com/acme']);

    expect(calls[0]?.body).toEqual({
      network: 'bluesky',
      account: 'acme.bsky.social',
      campaignId: 'cmp_1',
      kinds: ['follow', 'like'],
    });
    // The URL is passed through: the API normalises it, and doing it twice is
    // two places for the rule to drift.
    expect(calls[1]?.body).toEqual({ network: 'x', account: 'https://x.com/acme' });
  });

  test('a refused run reports the reason rather than pretending it worked', async () => {
    const { client: api } = client({
      result: { outcome: 'disabled', detail: 'needs a paid X API tier' },
    });

    const output = await commandByName('audience')!.run({
      client: api,
      args: ['run', 'awt_1'],
      flags: {},
    });

    expect(output).toContain('needs a paid X API tier');
  });

  test('an empty list says how to make one', async () => {
    const { client: api } = client({ watches: [] });

    const output = await commandByName('audience')!.run({ client: api, args: ['list'], flags: {} });
    expect(output).toContain('og audience watch');
  });

  test('an unknown verb names the ones that exist', async () => {
    const { client: api } = client({});

    await expect(
      commandByName('audience')!.run({ client: api, args: ['frobnicate'], flags: {} }),
    ).rejects.toThrow('og audience list');
  });
});

describe('og leads', () => {
  test('add sends the file to the append route and prints the report', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const dir = mkdtempSync(`${import.meta.dir}/../.test-leads-`);
    const file = `${dir}/leads.csv`;
    writeFileSync(file, 'email,first_name\nada@acme.dev,Ada\ninfo@acme.dev,\n');

    try {
      const { client: api, calls } = client({
        task_id: 'cim_1',
        received: 2,
        added: 2,
        skipped: 0,
        rejected: 0,
        flagged: 1,
        flagged_held: 1,
        report: [
          {
            row: 2,
            email: 'info@acme.dev',
            outcome: 'flagged',
            reason: 'role_address',
            why: 'role address',
            detail: 'role_address: info@ is a team inbox, not a person',
          },
        ],
      });
      const out = await commandByName('leads')!.run({
        client: api,
        args: ['add', 'cmp_1', file],
        flags: { 'consent-source': 'signups' },
      });

      expect(calls[0]?.url).toBe('https://api.test/api/v1/autogtm/campaigns/cmp_1/leads');
      expect(calls[0]?.body).toMatchObject({
        csv: 'email,first_name\nada@acme.dev,Ada\ninfo@acme.dev,\n',
        consent_source: 'signups',
        allow_flagged: false,
        skip_project_duplicates: true,
      });
      expect(out).toContain('2 of 2 added');
      expect(out).toContain('held back from sending');
      expect(out).toContain('info@ is a team inbox');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('allow clears a screening hold', async () => {
    const { client: api, calls } = client({ person_id: 'per_1', held: false });
    await commandByName('leads')!.run({ client: api, args: ['allow', 'per_1'], flags: {} });
    expect(calls[0]?.url).toBe('https://api.test/api/v1/autogtm/leads/per_1/screening');
    expect(calls[0]?.body).toEqual({ allow: true });
  });
});

describe('og linkpost', () => {
  test('a link becomes a draft request with the networks asked for', async () => {
    const { client: api, calls } = client({
      page: { read: true, title: 'Fast builds' },
      posts: [
        {
          id: 'lpo_1',
          label: 'LinkedIn',
          status: 'open',
          chars: 40,
          limit: 3000,
          text: 'Our CI got faster.',
          openUrl: 'https://www.linkedin.com/feed/?shareActive=true&text=x',
          steps: ['Press Copy.', 'Press Mark done.'],
        },
      ],
      missing: [],
    });
    const out = await commandByName('linkpost')!.run({
      client: api,
      args: ['https://blog.example.com/fast'],
      flags: { to: 'linkedin,X', notes: 'open source' },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      body: {
        url: 'https://blog.example.com/fast',
        networks: ['linkedin', 'x'],
        notes: 'open source',
      },
    });
    expect(calls[0]!.url).toEndWith('/api/v1/link-posts');
    expect(out).toContain('Fast builds');
    expect(out).toContain('lpo_1  LinkedIn');
    expect(out).toContain('1. Press Copy.');
  });

  test('done records where it was posted', async () => {
    const { client: api, calls } = client({ post: {} });
    await commandByName('linkpost')!.run({
      client: api,
      args: ['done', 'lpo_1'],
      flags: { url: 'https://x.com/me/status/1' },
    });
    expect(calls[0]!.url).toEndWith('/api/v1/link-posts/lpo_1/done');
    expect(calls[0]!.body).toEqual({ postedUrl: 'https://x.com/me/status/1' });
  });
});
