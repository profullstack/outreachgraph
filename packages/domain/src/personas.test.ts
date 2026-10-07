import { describe, expect, test } from 'bun:test';
import { classifyPersona, orderForExpansion, personaRank } from './personas';

describe('classifyPersona', () => {
  test.each([
    ['CEO', 'budget_holder'],
    ['Co-founder & CTO', 'budget_holder'],
    ['VP of Sales', 'budget_holder'],
    ['Head of Growth', 'budget_holder'],
    ['Director, Marketing', 'budget_holder'],
    ['General Counsel', 'blocker'],
    ['VP Legal', 'blocker'],
    ['Chief Information Security Officer', 'blocker'],
    ['CFO', 'blocker'],
    ['Procurement Manager', 'blocker'],
    ['IT Manager', 'blocker'],
    ['Engineering Manager', 'champion'],
    ['Team Lead, Support Operations', 'champion'],
    ['Senior Software Engineer', 'pain_feeler'],
    ['Marketing Specialist', 'pain_feeler'],
    ['Customer Success Associate', 'pain_feeler'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['Wizard', 'unknown'],
  ] as const)('%s → %s', (title, persona) => {
    expect(classifyPersona(title)).toBe(persona);
  });

  test('ranks in planner order, unknown last', () => {
    expect(personaRank('budget_holder')).toBe(0);
    expect(personaRank('pain_feeler')).toBe(1);
    expect(personaRank('blocker')).toBe(2);
    expect(personaRank('champion')).toBe(3);
    expect(personaRank('unknown')).toBe(4);
  });
});

describe('orderForExpansion', () => {
  test('a company opens with its budget holder, other companies keep their places', () => {
    const queue = [
      { id: 'acme-engineer', company: 'acme', title: 'Software Engineer' },
      { id: 'solo', company: null, title: 'CEO' },
      { id: 'acme-ceo', company: 'acme', title: 'CEO' },
      { id: 'beta-cfo', company: 'beta', title: 'CFO' },
    ];
    const ordered = orderForExpansion(
      queue,
      (item) => item.company,
      (item) => classifyPersona(item.title),
    );
    expect(ordered.map((item) => item.id)).toEqual([
      'acme-ceo',
      'acme-engineer',
      'solo',
      'beta-cfo',
    ]);
  });
});
