import { describe, expect, test } from 'bun:test';
import { SearchOutOfCredits } from '../valueserp';
import {
  addressesAt,
  ContactOutEmailFinder,
  HunterEmailFinder,
  isContactOutSample,
  PublishedEmailFinder,
} from './index';

const respond = (status: number, body: unknown): typeof fetch =>
  (async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
    })) as unknown as typeof fetch;

const QUERY = { firstName: 'Priya', lastName: 'Raman', domain: 'acme.com' };

describe('email finders', () => {
  test('addressesAt keeps only the domain', () => {
    expect(addressesAt('Mail Priya.Raman@acme.com. or bob@other.com', 'acme.com')).toEqual([
      'priya.raman@acme.com',
    ]);
  });

  test("ContactOut's sample body after credits run out is out of credits, not data", async () => {
    const sample = {
      status_code: 200,
      message: 'This is a sample response',
      profile: { work_email: ['priya.raman@acme.com'] },
    };
    expect(isContactOutSample(sample)).toBe(true);
    const client = new ContactOutEmailFinder({ apiKey: 'k', fetchImpl: respond(200, sample) });
    await expect(client.find(QUERY)).rejects.toBeInstanceOf(SearchOutOfCredits);
  });

  test('ContactOut real answer yields the address at the domain', async () => {
    const client = new ContactOutEmailFinder({
      apiKey: 'k',
      fetchImpl: respond(200, { profile: { work_email: ['priya.raman@acme.com'] } }),
    });
    expect((await client.find(QUERY))?.address).toBe('priya.raman@acme.com');
  });

  test('Hunter: score and status; 429 means spent; a challenge page throws', async () => {
    const ok = new HunterEmailFinder({
      apiKey: 'k',
      fetchImpl: respond(200, {
        data: { email: 'Priya@acme.com', score: 88, verification: { status: 'valid' } },
      }),
    });
    expect(await ok.find(QUERY)).toEqual({
      address: 'priya@acme.com',
      score: 0.88,
      status: 'valid',
    });

    const spent = new HunterEmailFinder({ apiKey: 'k', fetchImpl: respond(429, {}) });
    await expect(spent.find(QUERY)).rejects.toBeInstanceOf(SearchOutOfCredits);

    const challenge = new HunterEmailFinder({
      apiKey: 'k',
      fetchImpl: respond(403, '<html>Just a moment...</html>'),
    });
    await expect(challenge.find(QUERY)).rejects.toThrow('non-JSON');
  });

  test('a published address must carry part of their name', async () => {
    const searcher = {
      search: async () => [
        { title: 'Acme team', snippet: 'Contact sales@acme.com or Priya at praman@acme.com' },
      ],
    };
    expect((await new PublishedEmailFinder(searcher).find(QUERY))?.address).toBe('praman@acme.com');

    const colleagueOnly = { search: async () => [{ snippet: 'Write to bob.jones@acme.com' }] };
    expect(await new PublishedEmailFinder(colleagueOnly).find(QUERY)).toBeUndefined();
  });
});
