/** planPatch: what a re-imported row changes on a person we already hold. */

import { describe, expect, test } from 'bun:test';
import { cleanContact, type CleanContact } from '@outreachgraph/domain';
import { planPatch, type StoredPerson } from './contact-import';

const stored: StoredPerson = {
  display_name: 'Dave Mackenzie',
  first_name: 'Dave',
  last_name: 'Mackenzie',
  current_title: 'Engineer',
  location: null,
  current_company_id: 'cmp_old',
  updated_at: '2026-09-01T00:00:00.000Z',
};

const row = (raw: Record<string, string>): CleanContact => {
  const result = cleanContact({ email: 'dave.mackenzie@corp.com', ...raw });
  if (!result.ok) throw new Error(result.detail);
  return result.contact;
};

describe('planPatch', () => {
  test('newer values replace different stored ones, and fill blanks', () => {
    expect(
      planPatch(
        stored,
        row({ name: 'Dave Mackenzie', title: 'VP', location: 'Oakland' }),
        'cmp_new',
      ),
    ).toEqual({ current_title: 'VP', location: 'Oakland', current_company_id: 'cmp_new' });
  });

  test('empty cells and equal values change nothing', () => {
    expect(planPatch(stored, row({ name: 'Dave Mackenzie', title: 'Engineer' }))).toEqual({});
  });

  test('a name derived from the address never replaces a real one', () => {
    expect(planPatch(stored, row({ title: 'VP' }))).toEqual({ current_title: 'VP' });
  });

  test('a row dated before the stored person only fills blanks', () => {
    expect(
      planPatch(
        stored,
        row({ name: 'D. Mackenzie', title: 'Intern', location: 'Reno', updatedAt: '2020-01-01' }),
        'cmp_other',
      ),
    ).toEqual({ location: 'Reno' });
  });

  test('a row dated after the stored person wins', () => {
    expect(
      planPatch(stored, row({ name: 'Dave Mackenzie', title: 'CTO', updatedAt: '2026-10-05' })),
    ).toEqual({ current_title: 'CTO' });
  });
});
