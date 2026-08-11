import { describe, expect, test } from 'bun:test';
import { DEFAULT_MERGE_THRESHOLDS } from '@outreachgraph/domain';
import { aggregateIdentityConfidence, resolveIdentity, type EvidenceInput } from './resolver';

describe('evidence combination', () => {
  test('no evidence resolves to zero and rejects', () => {
    const result = resolveIdentity([]);

    expect(result.score).toBe(0);
    expect(result.decision).toBe('reject');
    expect(result.verifiedBy).toHaveLength(0);
  });

  test('a self-published cross-link alone reaches the auto-merge band', () => {
    const result = resolveIdentity([{ kind: 'cross_linked_profile' }]);

    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_MERGE_THRESHOLDS.autoMerge);
    expect(result.decision).toBe('merge');
    // 0.92 clears auto-merge while still sitting in the "high" band —
    // "verified" is reserved for corroborated evidence, not a single link.
    expect(result.level).toBe('high');
  });

  test('corroborated links reach the verified band', () => {
    const result = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'same_public_email' },
    ]);

    expect(result.level).toBe('verified');
    expect(result.decision).toBe('merge');
  });

  test('a common name alone is nowhere near a merge', () => {
    const result = resolveIdentity([{ kind: 'exact_name_match' }]);

    expect(result.score).toBeLessThan(DEFAULT_MERGE_THRESHOLDS.candidate);
    expect(result.decision).toBe('reject');
  });

  test('name plus city plus title stays below auto-merge', () => {
    // The classic false-merge trap: lots of weak demographic agreement.
    const result = resolveIdentity([
      { kind: 'exact_name_match' },
      { kind: 'same_location' },
      { kind: 'same_title' },
    ]);

    expect(result.decision).not.toBe('merge');
  });

  test('independent evidence accumulates with diminishing returns', () => {
    const single = resolveIdentity([{ kind: 'same_employer' }]).score;
    const double = resolveIdentity([{ kind: 'same_employer' }, { kind: 'same_username' }]).score;

    expect(double).toBeGreaterThan(single);
    // Noisy-OR, not a sum: 0.45 + 0.55 would be 1.0 exactly.
    expect(double).toBeLessThan(1);
  });

  test('never exceeds 1 no matter how much evidence piles up', () => {
    const everything: EvidenceInput[] = [
      { kind: 'cross_linked_profile' },
      { kind: 'same_personal_domain' },
      { kind: 'same_public_email' },
      { kind: 'provider_asserted_link' },
      { kind: 'same_username' },
      { kind: 'same_employer' },
      { kind: 'uncommon_name_match' },
      { kind: 'profile_photo_match' },
      { kind: 'bio_similarity' },
    ];

    expect(resolveIdentity(everything).score).toBeLessThanOrEqual(1);
  });

  test('duplicate evidence of one kind does not stack', () => {
    const once = resolveIdentity([{ kind: 'same_employer', strength: 0.8 }]).score;
    const thrice = resolveIdentity([
      { kind: 'same_employer', strength: 0.8 },
      { kind: 'same_employer', strength: 0.5 },
      { kind: 'same_employer', strength: 0.3 },
    ]).score;

    expect(thrice).toBeCloseTo(once, 10);
  });

  test('strength scales an evidence kind proportionally', () => {
    const full = resolveIdentity([{ kind: 'same_personal_domain', strength: 1 }]).score;
    const half = resolveIdentity([{ kind: 'same_personal_domain', strength: 0.5 }]).score;

    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(0);
  });
});

describe('contradictions', () => {
  test('a conflicting employer reduces an otherwise strong match', () => {
    const clean = resolveIdentity([{ kind: 'provider_asserted_link' }]).score;
    const conflicted = resolveIdentity([
      { kind: 'provider_asserted_link' },
      { kind: 'conflicting_employer' },
    ]).score;

    expect(conflicted).toBeLessThan(clean);
  });

  test('a different platform user id disqualifies outright', () => {
    const result = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'same_personal_domain' },
      { kind: 'same_public_email' },
      { kind: 'different_platform_user_id' },
    ]);

    expect(result.score).toBe(0);
    expect(result.decision).toBe('reject');
    expect(result.disqualifiedBy).toBe('different_platform_user_id');
    expect(result.verifiedBy).toHaveLength(0);
  });

  test('an impossible timeline disqualifies outright', () => {
    const result = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'impossible_timeline' },
    ]);

    expect(result.decision).toBe('reject');
    expect(result.disqualifiedBy).toBe('impossible_timeline');
  });

  test('a checked-but-absent contradiction does not disqualify', () => {
    // strength 0 means "we looked, and the ids do not differ".
    const result = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'different_platform_user_id', strength: 0 },
    ]);

    expect(result.disqualifiedBy).toBeUndefined();
    expect(result.decision).toBe('merge');
  });

  test('contradictions bite hardest when the positive case is weak', () => {
    const strongBefore = resolveIdentity([{ kind: 'cross_linked_profile' }]).score;
    const strongAfter = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'incompatible_geography' },
    ]).score;

    const weakBefore = resolveIdentity([{ kind: 'same_location' }]).score;
    const weakAfter = resolveIdentity([
      { kind: 'same_location' },
      { kind: 'incompatible_geography' },
    ]).score;

    // Proportional penalty: both lose the same fraction, so the weak case
    // drops below the floor while the strong case survives.
    expect(strongAfter / strongBefore).toBeCloseTo(weakAfter / weakBefore, 6);
    expect(strongAfter).toBeGreaterThan(weakAfter);
  });
});

describe('thresholds (PRD §9.4)', () => {
  test('the candidate band lands between reject and merge', () => {
    // same_public_email (0.9) alone sits in the merge band; degrade it.
    const result = resolveIdentity([{ kind: 'same_public_email', strength: 0.85 }]);

    expect(result.decision).toBe('candidate');
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_MERGE_THRESHOLDS.candidate);
    expect(result.score).toBeLessThan(DEFAULT_MERGE_THRESHOLDS.autoMerge);
  });

  test('thresholds are configurable per workspace', () => {
    const evidence: EvidenceInput[] = [{ kind: 'provider_asserted_link' }];

    const strict = resolveIdentity(evidence, {
      thresholds: { autoMerge: 0.99, candidate: 0.95 },
    });
    const lenient = resolveIdentity(evidence, {
      thresholds: { autoMerge: 0.5, candidate: 0.3 },
    });

    expect(strict.decision).toBe('reject');
    expect(lenient.decision).toBe('merge');
    // Same evidence, same score — only the banding moved.
    expect(strict.score).toBeCloseTo(lenient.score, 10);
  });

  test('rejects an invalid threshold pair rather than guessing', () => {
    expect(() =>
      resolveIdentity([{ kind: 'same_employer' }], {
        thresholds: { autoMerge: 0.5, candidate: 0.9 },
      }),
    ).toThrow(/cannot exceed/);
  });
});

describe('explanations', () => {
  test('name the evidence that drove a merge', () => {
    const result = resolveIdentity([
      { kind: 'cross_linked_profile', detail: 'jane.dev links github.com/janesmith' },
      { kind: 'same_employer' },
    ]);

    expect(result.explanation).toContain('Merged automatically');
    expect(result.explanation).toContain('cross linked profile');
  });

  test('name the disqualifying contradiction', () => {
    const result = resolveIdentity([
      { kind: 'cross_linked_profile' },
      { kind: 'impossible_timeline' },
    ]);

    expect(result.explanation).toContain('impossible timeline');
  });

  test('order contributions strongest first', () => {
    const result = resolveIdentity([
      { kind: 'same_location' },
      { kind: 'cross_linked_profile' },
      { kind: 'same_employer' },
    ]);

    const effects = result.contributions.map((c) => c.effect);
    expect(effects).toEqual([...effects].sort((a, b) => b - a));
    expect(result.contributions[0]?.kind).toBe('cross_linked_profile');
  });
});

describe('determinism', () => {
  test('evidence order does not change the score', () => {
    const evidence: EvidenceInput[] = [
      { kind: 'same_employer' },
      { kind: 'same_username' },
      { kind: 'uncommon_name_match' },
      { kind: 'conflicting_name' },
    ];

    const forward = resolveIdentity(evidence).score;
    const backward = resolveIdentity([...evidence].reverse()).score;

    expect(forward).toBeCloseTo(backward, 12);
  });

  test('repeated evaluation is stable', () => {
    const evidence: EvidenceInput[] = [{ kind: 'same_personal_domain' }, { kind: 'same_employer' }];
    const first = resolveIdentity(evidence);

    for (let i = 0; i < 20; i += 1) {
      expect(resolveIdentity(evidence).score).toBe(first.score);
    }
  });
});

describe('aggregate confidence', () => {
  test('is the weakest link, not the average', () => {
    expect(aggregateIdentityConfidence([0.99, 0.98, 0.72])).toBeCloseTo(0.72, 10);
  });

  test('is zero with no identities', () => {
    expect(aggregateIdentityConfidence([])).toBe(0);
  });
});
