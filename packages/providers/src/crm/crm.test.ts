/**
 * The CRM adapters against a recorded fake of each vendor's API. What matters:
 * find-before-create (an existing contact is never overwritten), the note is
 * attached to the right record, and a refused token is not retried.
 */

import { describe, expect, test } from 'bun:test';
import { CrmError } from './types';
import { HubSpotClient } from './hubspot';
import { PipedriveClient } from './pipedrive';
import { crmClientFor } from './index';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function fake(routes: (call: Call) => Response): {
  fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      return routes(call);
    },
  };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const CONTACT = {
  email: 'Jane@Acme.com',
  name: 'Jane Smith',
  firstName: 'Jane',
  lastName: 'Smith',
  title: 'CTO',
  company: 'Acme',
  website: 'https://acme.com',
};

describe('HubSpot', () => {
  test('creates a contact that does not exist, then notes against it', async () => {
    const { fetchImpl, calls } = fake((call) => {
      if (call.url.endsWith('/contacts/search')) return json({ total: 0, results: [] });
      if (call.url.endsWith('/objects/contacts')) return json({ id: '501' }, 201);
      if (call.url.endsWith('/objects/notes')) return json({ id: '901' }, 201);
      return json({}, 404);
    });

    const client = new HubSpotClient({ token: 'pat-1', fetchImpl });
    const contact = await client.ensureContact(CONTACT);
    const note = await client.addNote(contact.id, 'Replied', new Date('2026-09-24T00:00:00Z'));

    expect(contact).toEqual({ id: '501', created: true });
    expect(note.id).toBe('901');
    expect(calls[0]?.headers.authorization).toBe('Bearer pat-1');
    expect(calls[0]?.body).toMatchObject({
      filterGroups: [
        { filters: [{ propertyName: 'email', operator: 'EQ', value: 'jane@acme.com' }] },
      ],
    });
    expect(calls[1]?.body).toEqual({
      properties: {
        email: 'jane@acme.com',
        firstname: 'Jane',
        lastname: 'Smith',
        jobtitle: 'CTO',
        company: 'Acme',
        website: 'https://acme.com',
      },
    });
    expect(calls[2]?.body).toMatchObject({
      properties: { hs_note_body: 'Replied', hs_timestamp: '2026-09-24T00:00:00.000Z' },
      associations: [{ to: { id: '501' }, types: [{ associationTypeId: 202 }] }],
    });
  });

  test('finds an existing contact and never writes to it', async () => {
    const { fetchImpl, calls } = fake(() => json({ total: 1, results: [{ id: '77' }] }));
    const contact = await new HubSpotClient({ token: 't', fetchImpl }).ensureContact(CONTACT);

    expect(contact).toEqual({ id: '77', created: false });
    expect(calls).toHaveLength(1);
  });

  test('a refused token is not retryable; a 429 is', async () => {
    const refused = new HubSpotClient({
      token: 't',
      fetchImpl: fake(() => json({}, 401)).fetchImpl,
    });
    const error = await refused.verify().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CrmError);
    expect((error as CrmError).retryable).toBe(false);

    const limited = new HubSpotClient({
      token: 't',
      fetchImpl: fake(() => json({}, 429)).fetchImpl,
    });
    const busy = await limited.verify().catch((e: unknown) => e);
    expect((busy as CrmError).retryable).toBe(true);
  });
});

describe('Pipedrive', () => {
  test('creates a person and adds a note, with the token in a header', async () => {
    const { fetchImpl, calls } = fake((call) => {
      if (call.url.includes('/v1/persons/search'))
        return json({ success: true, data: { items: [] } });
      if (call.url.endsWith('/v1/persons')) return json({ success: true, data: { id: 42 } }, 201);
      if (call.url.endsWith('/v1/notes')) return json({ success: true, data: { id: 7 } }, 201);
      return json({}, 404);
    });

    const client = new PipedriveClient({ token: 'pd-1', fetchImpl });
    const contact = await client.ensureContact(CONTACT);
    await client.addNote(contact.id, 'Approved');

    expect(contact).toEqual({ id: '42', created: true });
    for (const call of calls) {
      expect(call.headers['x-api-token']).toBe('pd-1');
      expect(call.url).not.toContain('pd-1');
    }
    expect(calls[0]?.url).toContain('term=jane%40acme.com');
    expect(calls[0]?.url).toContain('exact_match=true');
    expect(calls[1]?.body).toEqual({
      name: 'Jane Smith',
      email: [{ value: 'jane@acme.com', primary: true, label: 'work' }],
    });
    expect(calls[2]?.body).toEqual({ content: 'Approved', person_id: 42 });
  });

  test('reuses an existing person', async () => {
    const { fetchImpl, calls } = fake(() =>
      json({ success: true, data: { items: [{ item: { id: 9 } }] } }),
    );
    const contact = await new PipedriveClient({ token: 't', fetchImpl }).ensureContact(CONTACT);
    expect(contact).toEqual({ id: '9', created: false });
    expect(calls).toHaveLength(1);
  });
});

test('crmClientFor picks the adapter by name', () => {
  expect(crmClientFor('hubspot', { token: 't' })).toBeInstanceOf(HubSpotClient);
  expect(crmClientFor('pipedrive', { token: 't' })).toBeInstanceOf(PipedriveClient);
});
