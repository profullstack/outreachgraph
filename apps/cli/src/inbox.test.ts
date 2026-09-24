/**
 * `og inbox`: listing, reading and answering a conversation from a shell.
 *
 * Checked at the edge that matters for a CLI — the request each subcommand
 * makes, and that "not sent" never renders like success.
 */

import { describe, expect, test } from 'bun:test';
import { createClient, type FetchLike } from '@outreachgraph/mcp/src/client';
import { commandByName, renderThread } from './commands';

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

const inbox = commandByName('inbox')!;

describe('og inbox', () => {
  test('lists conversations with the id first and the label beside it', async () => {
    const { client: api, calls } = client({
      conversations: [
        {
          person_id: 'per_jane',
          name: 'Jane Smith',
          status: 'need_reply',
          label: { label: 'question', confidence: 0.9 },
          pending_reply_id: 'rec_1',
        },
      ],
    });

    const output = await inbox.run({
      client: api,
      args: [],
      flags: { filter: 'need_reply' },
    });

    expect(calls[0]?.url).toContain('/inbox?filter=need_reply');
    expect(output.startsWith('per_jane')).toBe(true);
    expect(output).toContain('question');
    expect(output).toContain('draft');
  });

  test('show reads one thread', async () => {
    const { client: api, calls } = client({
      person: { name: 'Jane Smith', company: 'Acme' },
      status: 'need_reply',
      messages: [
        { from: 'us', network: 'email', at: '2026-09-20', body: 'Hi Jane', original: true },
        {
          from: 'them',
          network: 'email',
          at: '2026-09-21',
          body: 'How much?',
          label: { label: 'question', confidence: 0.93, source: 'model' },
        },
      ],
      pending_reply: { recommendation_id: 'rec_1', body: 'It depends on volume.' },
    });

    const output = await inbox.run({ client: api, args: ['show', 'per_jane'], flags: {} });

    expect(calls[0]?.url).toBe('https://api.test/api/v1/inbox/per_jane');
    expect(output).toContain('(original)');
    expect(output).toContain('[question 93% model]');
    expect(output).toContain('It depends on volume.');
  });

  test('reply posts the words and says whether they left', async () => {
    const { client: api, calls } = client({ sent: true, to: 'jane@acme.com', subject: 'Re: x' });

    const output = await inbox.run({
      client: api,
      args: ['reply', 'per_jane', 'Thursday', 'works?'],
      flags: {},
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.test/api/v1/inbox/per_jane/reply');
    expect(calls[0]?.body).toEqual({ text: 'Thursday works?' });
    expect(output).toContain('Sent to jane@acme.com');
  });

  test('a reply that did not leave does not read as success', async () => {
    const { client: api } = client({ sent: false, reason: 'no mailbox' });
    const output = await inbox.run({ client: api, args: ['reply', 'per_jane', 'hi'], flags: {} });
    expect(output).toBe('Not sent: no mailbox');
  });

  test('reply without words is refused before any request', async () => {
    const { client: api, calls } = client({});
    expect(inbox.run({ client: api, args: ['reply', 'per_jane'], flags: {} })).rejects.toThrow(
      'usage',
    );
    expect(calls).toHaveLength(0);
  });

  test('renderThread marks automated messages as such', () => {
    const output = renderThread({
      person: { name: 'Jane' },
      status: 'sent',
      messages: [{ from: 'automated', network: 'email', at: 't', body: 'Back Monday' }],
    });
    expect(output).toContain('AUTO');
  });
});
