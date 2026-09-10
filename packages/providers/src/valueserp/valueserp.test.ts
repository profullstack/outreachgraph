/**
 * What counts as the right face.
 *
 * The adapter's whole value is in what it refuses. A search for a common name
 * returns a page of strangers; only a result whose page vouches for the person
 * — their LinkedIn profile, their employer's site — is worth attaching to them.
 */

import { describe, expect, test } from 'bun:test';
import { ValueSerpClient, carriesName, corroborate, isLinkedInProfile } from './index';

const JANE = {
  name: 'Jane Smith',
  title: 'VP Engineering',
  company: 'Acme',
  companyDomain: 'acme.com',
};

describe('corroborate', () => {
  test('accepts a LinkedIn profile titled with the name', () => {
    const match = corroborate(
      {
        title: 'Jane Smith - VP Engineering - Acme | LinkedIn',
        link: 'https://www.linkedin.com/in/janesmith',
        image: 'https://media.licdn.com/dms/image/jane.jpg',
      },
      JANE,
    );
    expect(match).toEqual({
      photoUrl: 'https://media.licdn.com/dms/image/jane.jpg',
      pageUrl: 'https://www.linkedin.com/in/janesmith',
      source: 'linkedin',
    });
  });

  test('accepts the company’s own site', () => {
    const match = corroborate(
      {
        title: 'Our team — Jane Smith',
        link: 'https://www.acme.com/team',
        image: 'https://www.acme.com/img/jane.jpg',
      },
      JANE,
    );
    expect(match?.source).toBe('site');
  });

  test('rejects a LinkedIn company page, a stranger’s site, and a title without the name', () => {
    const image = 'https://cdn.example/jane.jpg';

    expect(
      corroborate(
        { title: 'Jane Smith', link: 'https://www.linkedin.com/company/acme', image },
        JANE,
      ),
    ).toBeUndefined();
    expect(
      corroborate({ title: 'Jane Smith', link: 'https://someblog.example/jane', image }, JANE),
    ).toBeUndefined();
    expect(
      corroborate(
        { title: 'Jane Doe - Acme | LinkedIn', link: 'https://linkedin.com/in/jd', image },
        JANE,
      ),
    ).toBeUndefined();
  });

  test('needs both an image and a page', () => {
    expect(
      corroborate({ title: 'Jane Smith | LinkedIn', link: 'https://linkedin.com/in/js' }, JANE),
    ).toBeUndefined();
  });
});

describe('carriesName', () => {
  test('folds case and accents and ignores initials', () => {
    expect(carriesName('KLAUDIA MAJCHER – Właściciel', 'Klaudia Majcher')).toBe(true);
    expect(carriesName('Stefan Wienold | Vertriebstrainer', 'Stefan Wienöld')).toBe(true);
    expect(carriesName('Mark J. Ramsey — Citipointe', 'Mark J Ramsey')).toBe(true);
    expect(carriesName('Mark Ramsay — Citipointe', 'Mark Ramsey')).toBe(false);
  });
});

describe('isLinkedInProfile', () => {
  test('is a person, on any LinkedIn host', () => {
    expect(isLinkedInProfile('www.linkedin.com', '/in/jane')).toBe(true);
    expect(isLinkedInProfile('uk.linkedin.com', '/in/jane/')).toBe(true);
    expect(isLinkedInProfile('linkedin.com', '/company/acme')).toBe(false);
    expect(isLinkedInProfile('notlinkedin.com', '/in/jane')).toBe(false);
  });
});

describe('ValueSerpClient', () => {
  function respond(body: unknown, status = 200): { calls: URL[]; fetchImpl: typeof fetch } {
    const calls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input instanceof Request ? input.url : input)));
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test('searches images for the quoted name with title and company', async () => {
    const { calls, fetchImpl } = respond({
      image_results: [
        { title: 'Someone Else', link: 'https://linkedin.com/in/else', image: 'https://x/1.jpg' },
        {
          title: 'Jane Smith - Acme | LinkedIn',
          link: 'https://linkedin.com/in/jane',
          image: 'https://media.licdn.com/jane.jpg',
        },
      ],
    });

    const client = new ValueSerpClient({ apiKey: 'k', fetchImpl });
    const photo = await client.findProfilePhoto(JANE);

    expect(photo?.photoUrl).toBe('https://media.licdn.com/jane.jpg');
    expect(calls[0]?.searchParams.get('search_type')).toBe('images');
    expect(calls[0]?.searchParams.get('q')).toBe('"Jane Smith" Acme VP Engineering');
    expect(calls[0]?.searchParams.get('api_key')).toBe('k');
  });

  test('a refused request is a miss, not an error', async () => {
    const { fetchImpl } = respond({ request_info: { success: false } }, 401);
    const client = new ValueSerpClient({ apiKey: 'k', fetchImpl });
    expect(await client.findProfilePhoto(JANE)).toBeUndefined();
  });
});
