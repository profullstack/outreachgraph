import { describe, expect, test } from 'bun:test';
import {
  isEventPeoplePage,
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
