import { describe, expect, test } from 'bun:test';
import {
  cleanIntroText,
  cleanIntroTopics,
  decideIntroRequest,
  effectiveIntroStatus,
  INTRO_DAILY_REQUEST_LIMIT,
  INTRO_LIMITS,
  introTerms,
  missingForOpenIntroCard,
  nextIntroStatus,
  rankIntroMatches,
  scoreIntroMatch,
  type IntroCard,
  type IntroRequestFacts,
} from './intros';

function card(id: string, over: Partial<IntroCard> = {}): IntroCard {
  return {
    id,
    displayName: id,
    headline: '',
    lookingFor: '',
    canOffer: '',
    topics: [],
    ...over,
  };
}

const SEEKER = card('itp_seeker', {
  lookingFor: 'Security teams who want a design partner for server monitoring',
  canOffer: 'Open-source monitoring daemon, payments engineering',
  topics: ['security', 'payments'],
});

describe('cleaning', () => {
  test('collapses whitespace and cuts to length', () => {
    expect(cleanIntroText('  two\n\n words  ', 80)).toBe('two words');
    expect(cleanIntroText('x'.repeat(200), INTRO_LIMITS.displayName)).toHaveLength(80);
    expect(cleanIntroText(42, 80)).toBe('');
  });

  test('topics are lowercased, deduplicated and bounded', () => {
    expect(cleanIntroTopics(['Security', 'security ', '', 7, 'Payments'])).toEqual([
      'security',
      'payments',
    ]);
    expect(cleanIntroTopics(Array.from({ length: 30 }, (_, i) => `t${i}`))).toHaveLength(
      INTRO_LIMITS.topics,
    );
    expect(cleanIntroTopics('security')).toEqual([]);
  });

  test('an open card needs a name, an ask and an offer', () => {
    expect(missingForOpenIntroCard({ displayName: '', lookingFor: 'x', canOffer: '' })).toEqual([
      'displayName',
      'canOffer',
    ]);
    expect(missingForOpenIntroCard({ displayName: 'a', lookingFor: 'b', canOffer: 'c' })).toEqual(
      [],
    );
  });
});

describe('introTerms', () => {
  test('drops filler every card shares and keeps technical tokens whole', () => {
    expect(introTerms('Looking for people who can help with Node.js and C++')).toEqual([
      'node.js',
      'c++',
    ]);
  });

  test('is deduplicated and order-preserving', () => {
    expect(introTerms('payments, Payments; security payments')).toEqual(['payments', 'security']);
  });
});

describe('scoreIntroMatch', () => {
  test('no match unless the candidate covers something the seeker asked for', () => {
    // They want what the seeker offers, but offer nothing the seeker asked for.
    const taker = card('itp_taker', { lookingFor: 'monitoring daemon', canOffer: 'catering' });
    expect(scoreIntroMatch(SEEKER, taker)).toBeUndefined();
  });

  test('a card never matches itself and an empty ask matches nobody', () => {
    expect(scoreIntroMatch(SEEKER, SEEKER)).toBeUndefined();
    const silent = card('itp_silent', { canOffer: 'security' });
    expect(scoreIntroMatch(silent, SEEKER)).toBeUndefined();
  });

  test('carries the words that produced it, in both directions', () => {
    const partner = card('itp_partner', {
      lookingFor: 'monitoring for our fleet',
      canOffer: 'We run security for forty servers and want a design partner',
    });
    const match = scoreIntroMatch(SEEKER, partner);

    expect(match?.theyOffer).toEqual(['security', 'design', 'partner']);
    expect(match?.youOffer).toEqual(['monitoring']);
    expect(match?.score).toBeGreaterThan(0);
    expect(match?.score).toBeLessThanOrEqual(1);
  });

  test('topics count as supply', () => {
    const tagged = card('itp_tagged', { canOffer: 'advice', topics: ['security'] });
    expect(scoreIntroMatch(SEEKER, tagged)?.theyOffer).toEqual(['security']);
  });
});

describe('rankIntroMatches', () => {
  const oneWay = card('itp_b_oneway', { canOffer: 'security teams' });
  const twoWay = card('itp_a_twoway', {
    canOffer: 'security teams',
    lookingFor: 'payments engineering',
  });
  const nobody = card('itp_c_nobody', { canOffer: 'gardening' });

  test('a two-way fit outranks a one-way fit of the same coverage', () => {
    const ranked = rankIntroMatches(SEEKER, [oneWay, nobody, twoWay]);
    expect(ranked.map((m) => m.card.id)).toEqual(['itp_a_twoway', 'itp_b_oneway']);
  });

  test('is stable: the same pool in any order gives the same list', () => {
    const twin = card('itp_a_twin', { canOffer: 'security teams' });
    const forward = rankIntroMatches(SEEKER, [oneWay, twin]).map((m) => m.card.id);
    const backward = rankIntroMatches(SEEKER, [twin, oneWay]).map((m) => m.card.id);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(['itp_a_twin', 'itp_b_oneway']);
  });

  test('honours the limit', () => {
    expect(rankIntroMatches(SEEKER, [oneWay, twoWay], 1)).toHaveLength(1);
    expect(rankIntroMatches(SEEKER, [oneWay, twoWay], 0)).toHaveLength(0);
  });
});

describe('decideIntroRequest', () => {
  const OK: IntroRequestFacts = {
    requesterOpen: true,
    targetOpen: true,
    sameUser: false,
    blocked: false,
    alreadyLinked: false,
    requestsInLastDay: 0,
    noteLength: 20,
  };

  test('allows only when every fact is in order', () => {
    expect(decideIntroRequest(OK)).toEqual({ allowed: true });
  });

  test.each([
    [{ sameUser: true }, 'same_user'],
    [{ requesterOpen: false }, 'requester_not_open'],
    [{ targetOpen: false }, 'target_not_open'],
    [{ blocked: true }, 'blocked'],
    [{ alreadyLinked: true }, 'already_linked'],
    [{ noteLength: 0 }, 'note_required'],
    [{ requestsInLastDay: INTRO_DAILY_REQUEST_LIMIT }, 'daily_limit'],
  ] as const)('refuses %o as %s', (change, reason) => {
    expect(decideIntroRequest({ ...OK, ...change })).toEqual({ allowed: false, reason });
  });

  test('the last request of the day is allowed, the next is not', () => {
    expect(
      decideIntroRequest({ ...OK, requestsInLastDay: INTRO_DAILY_REQUEST_LIMIT - 1 }).allowed,
    ).toBe(true);
  });
});

describe('request lifecycle', () => {
  test('a pending request past its date reads as expired; decided ones do not', () => {
    const past = '2026-01-01T00:00:00.000Z';
    const current = '2026-02-01T00:00:00.000Z';
    expect(effectiveIntroStatus('pending', past, current)).toBe('expired');
    expect(effectiveIntroStatus('pending', current, past)).toBe('pending');
    expect(effectiveIntroStatus('accepted', past, current)).toBe('accepted');
  });

  test('only the person asked may accept or decline', () => {
    expect(nextIntroStatus('pending', 'accept', 'target')).toBe('accepted');
    expect(nextIntroStatus('pending', 'decline', 'target')).toBe('declined');
    expect(nextIntroStatus('pending', 'accept', 'requester')).toBeUndefined();
    expect(nextIntroStatus('pending', 'decline', 'requester')).toBeUndefined();
  });

  test('only the person who asked may withdraw', () => {
    expect(nextIntroStatus('pending', 'withdraw', 'requester')).toBe('withdrawn');
    expect(nextIntroStatus('pending', 'withdraw', 'target')).toBeUndefined();
  });

  test('nothing moves once decided, an accepted introduction included', () => {
    for (const status of ['accepted', 'declined', 'withdrawn', 'expired'] as const) {
      expect(nextIntroStatus(status, 'accept', 'target')).toBeUndefined();
      expect(nextIntroStatus(status, 'decline', 'target')).toBeUndefined();
      expect(nextIntroStatus(status, 'withdraw', 'requester')).toBeUndefined();
    }
  });
});
