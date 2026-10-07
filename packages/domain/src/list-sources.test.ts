import { describe, expect, test } from 'bun:test';
import {
  isEventPeoplePage,
  isPastEvent,
  marketTerms,
  parseFundingHeadline,
  parseLeadershipHeadline,
} from './list-sources';

describe('parseFundingHeadline', () => {
  test.each([
    [
      'Acme raises $12M Series A to automate payroll',
      { company: 'Acme', amount: '$12M', round: 'Series A' },
    ],
    [
      'Nimbus Labs secures $4.5 million seed round led by Index',
      { company: 'Nimbus Labs', amount: '$4.5 million', round: 'seed' },
    ],
    ['Payfold closes €20M Series B', { company: 'Payfold', amount: '€20M', round: 'Series B' }],
  ])('%s', (headline, expected) => {
    expect(parseFundingHeadline(headline)).toEqual(expected);
  });

  test.each([
    ['Exclusive: Split Pay raises $125 million for rent and mortgage lending', 'Split Pay'],
    ['Egyptian fintech startup Paymob raises $35m pre-Series C funding round', 'Paymob'],
    [
      'Exclusive: Latitude, founded by Stripe and Uber alums, raises $35 million to turn stablecoins into local payments',
      'Latitude',
    ],
    ['Piston raises $15M to expand cardless fuel payments network', 'Piston'],
    [
      'Pay-i rebrands as Ascerta and raises $18M to help enterprises track AI business value',
      'Ascerta',
    ],
    [
      'Stablecoin payments firm dtcpay closes $25 million Series A with SBI Group investment',
      'dtcpay',
    ],
    ['Payment startup Infini raises $6M seed round', 'Infini'],
  ])('real headline: %s', (headline, company) => {
    expect(parseFundingHeadline(headline)?.company).toBe(company);
  });

  test.each([
    'Why fintech startups raise less in 2026',
    'The startup that raises $10M every year',
    'Investors pull back from AI deals',
  ])('ignores %s', (headline) => {
    expect(parseFundingHeadline(headline)).toBeUndefined();
  });
});

describe('parseLeadershipHeadline', () => {
  test('X appoints Person as Title', () => {
    expect(parseLeadershipHeadline('Acme Appoints Jane Doe as Chief Revenue Officer')).toEqual({
      company: 'Acme',
      person: 'Jane Doe',
      title: 'Chief Revenue Officer',
    });
  });

  test('X names Person Title to lead growth', () => {
    expect(
      parseLeadershipHeadline('Nimbus Labs names Carlos Ruiz VP of Sales to lead expansion'),
    ).toEqual({
      company: 'Nimbus Labs',
      person: 'Carlos Ruiz',
      title: 'VP of Sales',
    });
  });

  test('Person joins X as Title', () => {
    expect(parseLeadershipHeadline('Priya Shah joins Payfold as Head of Marketing')).toEqual({
      company: 'Payfold',
      person: 'Priya Shah',
      title: 'Head of Marketing',
    });
  });

  test.each([
    [
      'Solana Foundation Appoints Rachel Conlan as Chief Strategy Officer and Jamal Raees as General Manager of Payments',
      { company: 'Solana Foundation', person: 'Rachel Conlan', title: 'Chief Strategy Officer' },
    ],
    [
      'BNB Chain Appoints Thomas Chen as Chief Business Officer',
      { company: 'BNB Chain', person: 'Thomas Chen', title: 'Chief Business Officer' },
    ],
    [
      'Usio, Inc. Appoints Linda Loof as Senior Vice President of Strategic Partnerships',
      {
        company: 'Usio, Inc.',
        person: 'Linda Loof',
        title: 'Senior Vice President of Strategic Partnerships',
      },
    ],
  ])('real headline: %s', (headline, expected) => {
    expect(parseLeadershipHeadline(headline)).toEqual(expected);
  });

  test('a board seat is not a new decision-maker', () => {
    expect(
      parseLeadershipHeadline('Flywire Appoints Sabrina Farmer to its Board of Directors'),
    ).toBeUndefined();
  });

  test('not an appointment', () => {
    expect(parseLeadershipHeadline('Acme launches a new product line')).toBeUndefined();
  });
});

describe('helpers', () => {
  test('market terms drop filler words', () => {
    expect(marketTerms({ category: 'developer payments infrastructure platform' })).toBe(
      'developer payments infrastructure',
    );
  });

  test('event people pages', () => {
    expect(isEventPeoplePage('https://saastr.com/annual/speakers/')).toBe(true);
    expect(isEventPeoplePage('https://devcon.example/2026/sponsors')).toBe(true);
    expect(isEventPeoplePage('https://devcon.example/blog/recap')).toBe(false);
    expect(isEventPeoplePage('https://www.eventbrite.com/e/speakers')).toBe(false);
  });
});

describe('isPastEvent', () => {
  test('a page naming only past years is a past edition', () => {
    expect(
      isPastEvent(
        'https://2024.platformcon.com/speakers',
        'Meet Our PlatformCon 2024 Speakers',
        2026,
      ),
    ).toBe(true);
    expect(isPastEvent('https://x.example/speakers', 'Future of AM 2027', 2026)).toBe(false);
    expect(isPastEvent('https://x.example/2025-2026/speakers', 'Speakers', 2026)).toBe(false);
    expect(isPastEvent('https://x.example/speakers', 'Speakers', 2026)).toBe(false);
  });
});
