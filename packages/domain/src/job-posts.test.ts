import { describe, expect, test } from 'bun:test';
import {
  addressBelongsTo,
  companyDomainFrom,
  contactSearchQuery,
  isAgencyPosting,
  jobSearchQueries,
  keywordTerms,
  linkedInContactFrom,
  namedOnPage,
  namesCompany,
  parseJobUrl,
  rankContact,
} from './job-posts';

describe('parseJobUrl', () => {
  test('workable, with and without the account', () => {
    expect(parseJobUrl('https://apply.workable.com/raydar/j/C39C58F585/')).toEqual({
      source: 'workable',
      account: 'raydar',
      jobId: 'C39C58F585',
      url: 'https://apply.workable.com/raydar/j/C39C58F585/',
    });
    expect(parseJobUrl('apply.workable.com/oversee-1/j/0465b14863/apply/')).toMatchObject({
      account: 'oversee-1',
      jobId: '0465B14863',
      url: 'https://apply.workable.com/oversee-1/j/0465B14863/',
    });
    expect(parseJobUrl('https://apply.workable.com/j/062C6AEB79')).toEqual({
      source: 'workable',
      jobId: '062C6AEB79',
      url: 'https://apply.workable.com/j/062C6AEB79/',
    });
  });

  test('greenhouse on either host, lever and ashby', () => {
    expect(parseJobUrl('http://boards.greenhouse.io/givedirectly/jobs/4558349005?x=1')).toEqual({
      source: 'greenhouse',
      account: 'givedirectly',
      jobId: '4558349005',
      url: 'https://job-boards.greenhouse.io/givedirectly/jobs/4558349005',
    });
    expect(
      parseJobUrl('https://jobs.lever.co/ethena/f85bcfd1-8d2c-4cf5-a6ab-1c8ddab14c65/apply'),
    ).toMatchObject({ source: 'lever', account: 'ethena' });
    expect(
      parseJobUrl('https://jobs.ashbyhq.com/close/01fc4ad7-4d33-4f64-919f-502bb2c20efc'),
    ).toMatchObject({ source: 'ashby', account: 'close' });
  });

  test('a board page with no posting is refused, any other page is kept', () => {
    expect(parseJobUrl('https://jobs.lever.co/ethena')).toEqual({
      reason: 'not a lever posting',
    });
    expect(parseJobUrl('https://apply.workable.com/raydar/')).toHaveProperty('reason');
    expect(parseJobUrl('https://example.com/careers/123#apply')).toEqual({
      source: 'other',
      url: 'https://example.com/careers/123',
    });
    expect(parseJobUrl('not a url at all')).toHaveProperty('reason');
  });
});

describe('keyword search', () => {
  test('the title is quoted and parentheses are loose qualifiers', () => {
    expect(keywordTerms('senior software engineer (remote)')).toBe(
      '"senior software engineer" remote',
    );
    expect(keywordTerms('"AI engineer"')).toBe('"AI engineer"');
  });

  test('one query per board, because ValueSERP ignores OR between sites', () => {
    const queries = jobSearchQueries('senior software engineer (remote)', ['workable', 'lever']);
    expect(queries).toEqual([
      { board: 'workable', q: 'site:apply.workable.com "senior software engineer" remote' },
      { board: 'lever', q: 'site:jobs.lever.co "senior software engineer" remote' },
    ]);
    expect(jobSearchQueries('   ')).toEqual([]);
  });
});

test('agency postings are recognised', () => {
  expect(
    isAgencyPosting(
      'Our client is an education technology company. Raydar is recruiting for this role on behalf of our client.',
    ),
  ).toBe(true);
  expect(isAgencyPosting('We are hiring a Senior Software Engineer to join us.')).toBe(false);
});

describe('contacts', () => {
  test('the search names the company and the titles that buy', () => {
    expect(contactSearchQuery('Raydar')).toStartWith('site:linkedin.com/in "Raydar" (founder OR');
  });

  test('rank depends on whether the poster is the employer or an agency', () => {
    expect(rankContact('CTO at Acme', '', false)).toEqual({ role: 'cto', score: 1 });
    expect(rankContact('Founder @ Raydar', '', true)).toEqual({ role: 'founder', score: 1 });
    expect(rankContact('Senior Tech Recruiter @ Raydar', '', true).role).toBe('recruiter');
    expect(rankContact('Raydar Inc, Founder & Owner Emeritus', '', true).score).toBe(0.4);
  });

  test('the headline decides the role; the snippet only fills a silent headline', () => {
    // Live 2026-10-02: "talent" in the snippet made a VP of Technology a recruiter.
    expect(
      rankContact(
        'VP of Technology at Raydar',
        'At Raydar we help companies in emerging technologies find the talent',
        true,
      ).role,
    ).toBe('engineering_leader');
    expect(rankContact('Raydar', 'Senior Technical Recruiter. Raydar.', true)).toEqual({
      role: 'recruiter',
      score: 0.64,
    });
  });

  test('namedOnPage wants first and last name together', () => {
    const page = 'Our team. 01. David Phillips. Founder & CEO 02. Noah Kingsdale. VP, Technology';
    expect(namedOnPage(page, 'David Phillips')).toBe(true);
    expect(namedOnPage(page, 'Noah Kingsdale')).toBe(true);
    expect(namedOnPage(page, 'Ray Daniels')).toBe(false);
    expect(namedOnPage('Write to David at david@raydar.xyz', 'David Phillips')).toBe(false);
    expect(namedOnPage('Jane Q. Smith, CTO', 'Jane Smith')).toBe(true);
  });

  test('a LinkedIn result is accepted only when it names the company as itself', () => {
    expect(
      linkedInContactFrom(
        {
          link: 'https://www.linkedin.com/in/davidphillips97',
          title: 'David Phillips - Raydar',
          snippet: 'Building teams & products in emerging tech. · Experience: Raydar',
        },
        'Raydar',
      ),
    ).toEqual({
      name: 'David Phillips',
      handle: 'davidphillips97',
      profileUrl: 'https://www.linkedin.com/in/davidphillips97',
      headline: 'Raydar',
      snippet: 'Building teams & products in emerging tech. · Experience: Raydar',
    });

    expect(
      linkedInContactFrom(
        {
          link: 'https://uk.linkedin.com/in/chris-rayson-820b0126',
          title: 'Chris Rayson - Director at Raydar Studios Ltd',
          snippet: 'Raydar Studios is a dynamic new independent media company',
        },
        'Raydar',
      ),
    ).toBeUndefined();

    expect(
      linkedInContactFrom(
        { link: 'https://www.linkedin.com/company/raydar-xyz', title: 'Raydar | LinkedIn' },
        'Raydar',
      ),
    ).toBeUndefined();

    expect(
      linkedInContactFrom(
        {
          link: 'https://www.linkedin.com/in/kyra-wyman',
          title: 'Kyra Phillips (Wyman) - VP, Head of Legal',
          snippet: "Head of Raydar's In-House Legal Recruitment division.",
        },
        'Raydar',
      )?.name,
    ).toBe('Kyra Phillips');
  });

  test('namesCompany tells a company from a longer name sharing its first word', () => {
    expect(namesCompany('Founder @ Raydar', 'Raydar')).toBe(true);
    expect(namesCompany('Raydar Inc, Founder', 'Raydar')).toBe(true);
    expect(namesCompany('Experience: Raydar & Associates', 'Raydar')).toBe(false);
    expect(namesCompany('Director at Raydar Studios Ltd', 'Raydar')).toBe(false);
    expect(namesCompany('Raydarx', 'Raydar')).toBe(false);
  });
});

test('companyDomainFrom refuses boards and networks', () => {
  expect(companyDomainFrom('http://raydar.xyz')).toBe('raydar.xyz');
  expect(companyDomainFrom('https://www.workhero.pro/hvac')).toBe('workhero.pro');
  expect(companyDomainFrom('https://www.linkedin.com/company/x')).toBeUndefined();
  expect(companyDomainFrom('https://apply.workable.com/raydar')).toBeUndefined();
  expect(companyDomainFrom(undefined)).toBeUndefined();
});

test('addressBelongsTo matches the shapes a person uses for their own address', () => {
  expect(addressBelongsTo('david@raydar.xyz', 'David Phillips')).toBe(true);
  expect(addressBelongsTo('dphillips@raydar.xyz', 'David Phillips')).toBe(true);
  expect(addressBelongsTo('jobs@raydar.xyz', 'David Phillips')).toBe(false);
  expect(addressBelongsTo('noah@raydar.xyz', 'David Phillips')).toBe(false);
});
