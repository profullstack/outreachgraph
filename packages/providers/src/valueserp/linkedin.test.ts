import { describe, expect, test } from 'bun:test';
import {
  companyToken,
  personQuery,
  pickCompany,
  pickPerson,
  titleFromResult,
  type LinkedinSubject,
  type SerpResult,
} from './linkedin';
import { SearchOutOfCredits, ValueSerpClient } from './index';
import { PeopleDataLabsClient } from '../pdl';

const ada: LinkedinSubject = { firstName: 'Ada', lastName: 'Lovelace', companyDomain: 'acme.com' };

describe('LinkedIn matching', () => {
  test('names the company by its first label', () => {
    expect(companyToken('acme.com')).toBe('acme');
    expect(companyToken('shop.acme.co.uk')).toBe('acme');
    expect(companyToken('ai.nookplot.com')).toBe('nookplot');
  });

  test('searches profiles by quoted name and company', () => {
    expect(personQuery(ada)).toBe('site:linkedin.com/in "Ada Lovelace" acme');
    expect(personQuery({ firstName: 'Bob', lastName: 'Ng' })).toBe('site:linkedin.com/in "Bob Ng"');
  });

  test('takes a profile that carries the name and the company', () => {
    const results: SerpResult[] = [
      {
        title: 'Ada Lovelace - Engineer - Initech | LinkedIn',
        link: 'https://www.linkedin.com/in/ada-other',
        snippet: 'Initech',
      },
      {
        title: 'Adá LOVELACE - CTO - Acme | LinkedIn',
        link: 'https://uk.linkedin.com/in/ada-l?trk=x',
        snippet: '',
      },
    ];
    expect(pickPerson(results, ada)).toBe('https://www.linkedin.com/in/ada-l');
  });

  test('without a company, takes only a single matching profile whose slug is the name', () => {
    const bob = { firstName: 'Bob', lastName: 'Ng' };
    const one = [
      { title: 'Bob Ng | LinkedIn', link: 'https://www.linkedin.com/in/bob-ng' },
      { title: 'Posts', link: 'https://www.linkedin.com/posts/x' },
    ];
    expect(pickPerson(one, bob)).toBe('https://www.linkedin.com/in/bob-ng');
    expect(
      pickPerson(
        [...one, { title: 'Bob Ng - Chef', link: 'https://www.linkedin.com/in/bob-ng-2' }],
        bob,
      ),
    ).toBe('');
    expect(
      pickPerson([{ title: 'Bob Ng | LinkedIn', link: 'https://www.linkedin.com/in/b8812' }], bob),
    ).toBe('');
  });

  test('rejects other people and non-profile pages', () => {
    expect(
      pickPerson([{ title: 'Ada Byron - Acme', link: 'https://www.linkedin.com/in/ab' }], ada),
    ).toBe('');
    expect(
      pickPerson(
        [{ title: 'Ada Lovelace - Acme', link: 'https://www.linkedin.com/company/acme' }],
        ada,
      ),
    ).toBe('');
  });

  test('takes a company page that names the domain or the company, not a passing mention', () => {
    expect(
      pickCompany(
        [{ title: 'Acme Corp | LinkedIn', link: 'https://www.linkedin.com/company/acme-corp/' }],
        'acme.com',
      ),
    ).toBe('https://www.linkedin.com/company/acme-corp');
    expect(
      pickCompany(
        [{ title: 'Other | LinkedIn', link: 'https://www.linkedin.com/company/other' }],
        'acme.com',
      ),
    ).toBe('');
    expect(
      pickCompany(
        [
          {
            title: 'National City Adult School',
            link: 'https://www.linkedin.com/company/ncas',
            snippet: 'part of Sweetwater schools',
          },
        ],
        'sweetwaterschools.net',
      ),
    ).toBe('');
    expect(
      pickCompany(
        [
          {
            title: 'Adult School',
            link: 'https://www.linkedin.com/company/ncas',
            snippet: 'sweetwaterschools.net',
          },
        ],
        'sweetwaterschools.net',
      ),
    ).toBe('https://www.linkedin.com/company/ncas');
  });

  test('reads the headline out of a profile title', () => {
    expect(titleFromResult('Ada Lovelace - CTO - Acme | LinkedIn', 'acme.com')).toBe('CTO');
    expect(titleFromResult('Ada Lovelace – Head of Growth | LinkedIn', 'acme.com')).toBe(
      'Head of Growth',
    );
    expect(titleFromResult('Ada Lovelace - Acme | LinkedIn', 'acme.com')).toBe('');
    expect(titleFromResult('Ada Lovelace | LinkedIn')).toBe('');
  });
});

describe('out of credits', () => {
  const answer = (status: number, body: unknown = {}) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

  test('ValueSERP turns a 402 into SearchOutOfCredits', async () => {
    const client = new ValueSerpClient({ apiKey: 'k', fetchImpl: answer(402) });
    await expect(client.search('q')).rejects.toBeInstanceOf(SearchOutOfCredits);
  });

  test('People Data Labs: a match, no match, and a 402', async () => {
    const hit = new PeopleDataLabsClient({
      apiKey: 'k',
      fetchImpl: answer(200, {
        likelihood: 8,
        data: {
          first_name: 'ada',
          last_name: 'lovelace',
          job_title: 'chief technology officer',
          linkedin_url: 'linkedin.com/in/ada-l',
          job_company_name: 'acme',
          job_company_website: 'acme.com',
        },
      }),
    });
    expect(await hit.enrichByEmail('ada@acme.com')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'Chief Technology Officer',
      linkedinUrl: 'https://www.linkedin.com/in/ada-l',
      companyName: 'Acme',
      companyDomain: 'acme.com',
      likelihood: 8,
    });

    const miss = new PeopleDataLabsClient({ apiKey: 'k', fetchImpl: answer(404) });
    expect(await miss.enrichByEmail('nobody@acme.com')).toBeUndefined();

    const broke = new PeopleDataLabsClient({ apiKey: 'k', fetchImpl: answer(402) });
    await expect(broke.enrichByEmail('ada@acme.com')).rejects.toBeInstanceOf(SearchOutOfCredits);
  });
});
