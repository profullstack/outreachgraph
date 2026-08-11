import { describe, expect, test } from 'bun:test';
import {
  extractClaims,
  failedChecks,
  findUnsupportedClaims,
  runChecks,
  similarityFingerprint,
  type CheckInput,
  type GroundingContext,
} from './checks';

const GROUNDING: GroundingContext = {
  evidence: [
    'Does anyone have a good alternative to Stripe for cross-border payouts? ' +
      'Fees are brutal and settlement takes days.',
  ],
  facts: ['Jane Smith', 'Jane', 'VP Engineering', 'Acme', 'x'],
  offering: [
    'ExamplePay',
    'developer payments infrastructure',
    'reduce payment integration time',
    'support crypto and fiat',
    'Stripe',
  ],
};

function input(overrides: Partial<CheckInput> = {}): CheckInput {
  return {
    body: 'Saw your note about cross-border settlement taking days. We hit the same thing.',
    grounding: GROUNDING,
    identityConfidence: 0.97,
    minIdentityConfidence: 0.85,
    ...overrides,
  };
}

describe('grounding (PRD §14.1)', () => {
  test('accepts a message built only from the evidence', () => {
    const report = runChecks(input());
    expect(report.passed).toBe(true);
    expect(report.unsupported).toHaveLength(0);
  });

  test('rejects an invented product name', () => {
    const report = runChecks(
      input({ body: 'Saw your note on payouts. We built Fluxwire to solve exactly this.' }),
    );

    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain('unsupported_claim');
    expect(report.unsupported).toContain('Fluxwire');
  });

  test('rejects an invented statistic', () => {
    const report = runChecks(
      input({ body: 'Saw your note on payouts. Teams like yours cut fees by 40% with us.' }),
    );

    expect(report.passed).toBe(false);
    expect(report.unsupported).toContain('40%');
  });

  test('rejects a fabricated article the person never wrote', () => {
    // The canonical failure from PRD §14.1.
    const report = runChecks(
      input({ body: 'I loved your recent article about payments infrastructure.' }),
    );

    expect(report.passed).toBe(false);
  });

  test('permits a competitor the offering already names', () => {
    const report = runChecks(
      input({ body: 'Saw your Stripe note. Cross-border settlement was our pain too.' }),
    );

    expect(report.unsupported).not.toContain('Stripe');
  });

  test('permits the prospect’s own name and employer', () => {
    const report = runChecks(
      input({ body: 'Jane, your note on cross-border payouts at Acme rings true.' }),
    );

    expect(report.unsupported).toHaveLength(0);
  });

  test('flags a message that cites nothing at all', () => {
    const report = runChecks(input({ body: 'Hi there, would you be open to a chat this week?' }));

    expect(report.passed).toBe(false);
    expect(failedChecks(report)).toContain('grounding');
  });

  test('is not fooled by paraphrase that still invents a specific', () => {
    const report = runChecks(
      input({ body: 'Your settlement delays sound painful. Our Ledger Bridge fixes them.' }),
    );

    expect(report.unsupported.length).toBeGreaterThan(0);
  });
});

describe('claim extraction', () => {
  test('picks out mid-sentence capitalised terms', () => {
    expect(extractClaims('we tried Fluxwire and it worked')).toContain('Fluxwire');
  });

  test('ignores the first word of a sentence', () => {
    // Sentence-initial capitals carry no information.
    expect(extractClaims('Payments are hard.')).not.toContain('Payments');
  });

  test('picks out numbers and percentages', () => {
    const claims = extractClaims('we saw 40% lower fees across 12 markets');
    expect(claims).toContain('40%');
    expect(claims).toContain('12');
  });

  test('picks out quoted phrases', () => {
    expect(extractClaims('you said "fees are brutal" last week')).toContain('fees are brutal');
  });

  test('ignores common words even when capitalised', () => {
    expect(extractClaims('the thing is Thanks matters')).not.toContain('Thanks');
  });
});

describe('flattery (PRD §13.3)', () => {
  test.each([
    'I loved your recent post about payouts.',
    'Big fan of your work on cross-border settlement.',
    'Your amazing thread on settlement delays caught my eye.',
    'Love what you are doing with payouts.',
  ])('rejects %s', (body) => {
    const report = runChecks(input({ body }));
    expect(failedChecks(report)).toContain('excessive_flattery');
  });

  test('allows a plain factual opener', () => {
    const report = runChecks(
      input({ body: 'Your note on cross-border settlement caught my eye.' }),
    );
    expect(failedChecks(report)).not.toContain('excessive_flattery');
  });
});

describe('spam patterns (PRD §18)', () => {
  test.each([
    'Quick question about your cross-border settlement setup.',
    'Limited time offer on cross-border settlement.',
    'Just bumping this on cross-border settlement.',
    'Circling back on cross-border settlement.',
  ])('rejects %s', (body) => {
    expect(failedChecks(runChecks(input({ body })))).toContain('spam_pattern');
  });

  test('rejects a draft over the channel limit', () => {
    const report = runChecks(
      input({ body: `cross-border settlement ${'x'.repeat(300)}`, maxLength: 280 }),
    );

    expect(failedChecks(report)).toContain('spam_pattern');
  });

  test('rejects multiple links', () => {
    const report = runChecks(
      input({
        body: 'Your cross-border settlement note: https://a.example and https://b.example',
      }),
    );

    expect(failedChecks(report)).toContain('spam_pattern');
  });

  test('allows one link', () => {
    const report = runChecks(
      input({ body: 'On cross-border settlement, this helped us: https://a.example' }),
    );

    expect(failedChecks(report)).not.toContain('spam_pattern');
  });
});

describe('sensitive categories (PRD §17.4)', () => {
  test.each([
    'Saw your cross-border settlement note after your diagnosis.',
    'Congrats on the maternity leave — also, cross-border settlement.',
    'Sorry you were laid off. On cross-border settlement:',
  ])('rejects %s', (body) => {
    expect(failedChecks(runChecks(input({ body })))).toContain('sensitive_topic');
  });

  test('rejects a claim the customer prohibited', () => {
    const report = runChecks(
      input({
        body: 'Your cross-border settlement note — we are the cheapest option anywhere.',
        prohibitedClaims: ['cheapest'],
      }),
    );

    expect(failedChecks(report)).toContain('sensitive_topic');
  });
});

describe('identity confidence (PRD §48 Decision 4)', () => {
  test('rejects a draft for a prospect below the threshold', () => {
    const report = runChecks(input({ identityConfidence: 0.6, minIdentityConfidence: 0.85 }));
    expect(failedChecks(report)).toContain('identity_confidence');
  });

  test('accepts exactly at the threshold', () => {
    const report = runChecks(input({ identityConfidence: 0.85, minIdentityConfidence: 0.85 }));
    expect(failedChecks(report)).not.toContain('identity_confidence');
  });
});

describe('duplicate detection (PRD §18)', () => {
  test('two drafts differing only by name share a fingerprint', () => {
    const a = similarityFingerprint('Jane, your note on cross-border settlement rings true.', [
      'Jane',
      'Alex',
    ]);
    const b = similarityFingerprint('Alex, your note on cross-border settlement rings true.', [
      'Jane',
      'Alex',
    ]);

    // The classic mail-merge: this is exactly what must be caught.
    expect(a).toBe(b);
  });

  test('genuinely different messages differ', () => {
    const a = similarityFingerprint('Your note on cross-border settlement rings true.');
    const b = similarityFingerprint('We published a teardown of payout latency last month.');

    expect(a).not.toBe(b);
  });

  test('word order does not change the fingerprint', () => {
    expect(similarityFingerprint('settlement delays payouts')).toBe(
      similarityFingerprint('payouts settlement delays'),
    );
  });

  test('rejects a draft matching one already sent', () => {
    const body = 'Your note on cross-border settlement rings true.';
    const report = runChecks(input({ body, priorDraftHashes: [similarityFingerprint(body)] }));

    expect(failedChecks(report)).toContain('duplicate_similarity');
  });
});

describe('report shape', () => {
  test('covers every PRD §14.2 gate', () => {
    const report = runChecks(input());
    const checks = report.results.map((r) => r.check).sort();

    expect(checks).toEqual([
      'duplicate_similarity',
      'excessive_flattery',
      'grounding',
      'identity_confidence',
      'policy',
      'sensitive_topic',
      'spam_pattern',
      'unsupported_claim',
    ]);
  });

  test('every failure carries an explanation', () => {
    const report = runChecks(input({ body: 'I loved your Fluxwire post — act now for 90% off!' }));

    for (const result of report.results) {
      if (!result.passed) expect(result.detail).toBeTruthy();
    }
  });

  test('is deterministic', () => {
    const state = input();
    const first = runChecks(state);
    for (let i = 0; i < 20; i += 1) {
      expect(runChecks(state)).toEqual(first);
    }
  });
});

describe('findUnsupportedClaims', () => {
  test('separates supported from unsupported', () => {
    const { unsupported, allowed } = findUnsupportedClaims(
      'Jane, your Stripe note matches what we saw at Fluxwire.',
      GROUNDING,
    );

    expect(allowed).toContain('Stripe');
    expect(unsupported).toContain('Fluxwire');
  });

  test('reports nothing for prose with no specifics', () => {
    const { unsupported } = findUnsupportedClaims(
      'we ran into something very similar and it took a while to sort out',
      GROUNDING,
    );

    expect(unsupported).toHaveLength(0);
  });
});
