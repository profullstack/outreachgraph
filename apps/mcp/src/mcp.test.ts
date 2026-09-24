/**
 * The MCP surface, and the claim it exists to make.
 *
 * The claim is that an agent driving these tools cannot be talked into
 * breaking a platform's terms. That is not a property of a prompt, so it is
 * not tested by reading one — it is a property of *where the decision is
 * made*. These tests pin the two things that make it true: every mutation
 * leaves as an HTTP call to `/api/v1`, and a refusal comes back as final
 * rather than as something worth retrying.
 */

import { describe, expect, test } from 'bun:test';
import { ApiError, configFromEnv, createClient, type FetchLike } from './client';
import { runTool, TOOLS, toolByName } from './tools';
import { describe as describeError } from './index';

const CONFIG = {
  baseUrl: 'https://api.test',
  token: 'tok_secret',
  workspaceId: 'wsp_1',
  organizationId: 'org_1',
};

function recorder(response: () => Response) {
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return response();
  };

  return { fetchImpl, calls };
}

function ok(body: unknown = { ok: true }) {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

function denied() {
  return () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'policy_denied',
          message: 'Automated messaging is prohibited; open the profile yourself.',
          details: { gate: 'capability_mode', decision: 'manual_only' },
        },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    );
}

describe('configFromEnv', () => {
  test('names every missing variable at once', () => {
    // Half-configured is worse than unconfigured: it fails later, on a call,
    // where the error reaches an agent rather than the person who set it up.
    let message = '';
    try {
      configFromEnv({} as NodeJS.ProcessEnv);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('OUTREACHGRAPH_API_URL');
    expect(message).toContain('OUTREACHGRAPH_API_TOKEN');
    expect(message).toContain('OUTREACHGRAPH_WORKSPACE_ID');
    expect(message).toContain('OUTREACHGRAPH_ORGANIZATION_ID');
  });

  test('trims a trailing slash off the base url', () => {
    const config = configFromEnv({
      OUTREACHGRAPH_API_URL: 'https://api.test/',
      OUTREACHGRAPH_API_TOKEN: 't',
      OUTREACHGRAPH_WORKSPACE_ID: 'wsp_1',
      OUTREACHGRAPH_ORGANIZATION_ID: 'org_1',
    } as NodeJS.ProcessEnv);

    expect(config.baseUrl).toBe('https://api.test');
  });
});

describe('createClient', () => {
  test('sends the token and the workspace scope', async () => {
    const { fetchImpl, calls } = recorder(ok());
    await createClient(CONFIG, fetchImpl).get('/people');

    expect(calls[0]?.url).toBe('https://api.test/api/v1/people');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok_secret');
    expect(calls[0]?.headers.get('x-workspace-id')).toBe('wsp_1');
    expect(calls[0]?.headers.get('x-organization-id')).toBe('org_1');
  });

  test('turns an API error body into a typed error', async () => {
    const { fetchImpl } = recorder(denied());

    try {
      await createClient(CONFIG, fetchImpl).post('/recommendations/rec_1/approve', {});
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe('policy_denied');
    }
  });

  test('drops undefined query parameters rather than sending "undefined"', async () => {
    const { fetchImpl, calls } = recorder(ok());
    await createClient(CONFIG, fetchImpl).get('/people', { campaignId: undefined, limit: '10' });

    expect(calls[0]?.url).toBe('https://api.test/api/v1/people?limit=10');
  });
});

describe('tools', () => {
  test('every tool has a unique name and a schema', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);

    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  test('every mutation leaves as an HTTP call', async () => {
    // The load-bearing property. This process holds no database handle, so
    // there is no faster path a persuasive caller can be pointed at.
    for (const tool of TOOLS.filter((t) => !t.readOnly)) {
      const { fetchImpl, calls } = recorder(ok());
      const client = createClient(CONFIG, fetchImpl);

      await tool
        .run(client, {
          recommendationId: 'rec_1',
          personId: 'per_1',
          gridId: 'grd_1',
          network: 'linkedin',
          url: 'https://example.com',
          name: 'grid',
          questions: ['q'],
          personIds: ['per_1'],
        })
        .catch(() => undefined);

      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]?.url.startsWith('https://api.test/api/v1')).toBe(true);
    }
  });

  test('update_openprofile sends the overlay as a PUT and refuses an empty one', async () => {
    const { fetchImpl, calls } = recorder(ok());
    const client = createClient(CONFIG, fetchImpl);
    const tool = toolByName('update_openprofile')!;
    await runTool(tool, client, {
      personId: 'per_1',
      sections: { guest: '- **Available**: yes' },
      public: true,
    });
    expect(calls[0]?.url).toBe('https://api.test/api/v1/people/per_1/openprofile');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toEqual({ sections: { guest: '- **Available**: yes' }, public: true });
    // An empty overlay still goes to the server, which is where it is refused.
    await runTool(tool, client, { personId: 'per_1' });
    expect(calls[1]?.body).toEqual({});
  });

  test('there is no tool that posts to a network directly', () => {
    // A tool named "post_to_linkedin" would be a way around the policy engine
    // whatever its implementation did today.
    for (const tool of TOOLS) {
      expect(tool.name).not.toContain('linkedin');
      expect(tool.name).not.toContain('dm');
    }
  });

  test('create_cadence sends step conditions through untouched, for the server to judge', async () => {
    const { fetchImpl, calls } = recorder(ok({ cadenceId: 'cad_1' }));
    const steps = [
      { network: 'linkedin', action: 'connect', waitForAcceptanceHours: 168 },
      { network: 'linkedin', action: 'send_dm', condition: 'if_connected' },
      { network: 'email', action: 'send_email', condition: 'if_not_connected' },
    ];

    await runTool(toolByName('create_cadence')!, createClient(CONFIG, fetchImpl), {
      name: 'Invite then DM or email',
      steps,
    });

    expect(calls[0]?.url).toBe('https://api.test/api/v1/cadences');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ name: 'Invite then DM or email', steps });
  });

  test('share_link is what the manual networks route through', async () => {
    const { fetchImpl, calls } = recorder(ok({ shareUrl: 'https://linkedin.com/…' }));
    const tool = toolByName('share_link')!;

    await tool.run(createClient(CONFIG, fetchImpl), {
      recommendationId: 'rec_1',
      network: 'linkedin',
    });

    expect(calls[0]?.url).toContain('/recommendations/rec_1/share');
    expect(calls[0]?.body).toEqual({ network: 'linkedin' });
  });

  test('a required argument is refused rather than defaulted', async () => {
    const { fetchImpl, calls } = recorder(ok());
    const tool = toolByName('get_signals')!;

    // Through `runTool`, because validation happens before the first await and
    // would otherwise throw synchronously out of a promise-typed arrow.
    expect(runTool(tool, createClient(CONFIG, fetchImpl), {})).rejects.toThrow(
      'personId is required',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('describe', () => {
  test('presents a policy refusal as final, and points somewhere useful', async () => {
    const { fetchImpl } = recorder(denied());

    let message = '';
    try {
      await createClient(CONFIG, fetchImpl).post('/recommendations/rec_1/approve', {});
    } catch (error) {
      message = describeError(error);
    }

    // An agent that reads "failed" retries. An agent that reads this does
    // something different, which is the entire point.
    expect(message).toContain('deterministic');
    expect(message).toContain('share_link');
    expect(message).toContain('capability_mode');
  });

  test('says which credential is wrong on a 401', () => {
    const message = describeError(new ApiError(401, 'unauthorized', 'no session'));

    expect(message).toContain('token');
  });

  test('passes an ordinary error through', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});
