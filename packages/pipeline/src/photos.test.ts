/**
 * Finding a face for a lead.
 *
 * What matters here is the bookkeeping around the lookup, not the lookup: a
 * miss must be remembered so it is never paid for twice, a hit must record the
 * profile it came from as research, and the daily ceiling must hold.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { queryOne } from '@outreachgraph/db';
import type { ProfilePhoto, ProfilePhotoFinder, ProfilePhotoQuery } from '@outreachgraph/providers';
import { seedDatabase, SEED, type SeededDatabase } from '../../../apps/api/src/test-seed';
import { sweepProfilePhotos, workspacesAwaitingPhotos } from './photos';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

function finder(answer: ProfilePhoto | undefined): {
  asked: ProfilePhotoQuery[];
  finder: ProfilePhotoFinder;
} {
  const asked: ProfilePhotoQuery[] = [];
  return {
    asked,
    finder: {
      findProfilePhoto: async (query) => {
        asked.push(query);
        return answer;
      },
    },
  };
}

const LINKEDIN_HIT: ProfilePhoto = {
  photoUrl: 'https://media.licdn.com/dms/image/jane.jpg',
  pageUrl: 'https://www.linkedin.com/in/jane-smith-123/',
  source: 'linkedin',
};

describe('sweepProfilePhotos', () => {
  test('asks with everything known and records the picture and the profile', async () => {
    seeded = await seedDatabase('photos-hit');
    const { db } = seeded;
    const { asked, finder: found } = finder(LINKEDIN_HIT);

    const result = await sweepProfilePhotos(
      { db, finder: found },
      { workspaceId: SEED.workspaceId },
    );

    expect(result).toEqual({ looked: 1, found: 1, profiles: 1, remainingToday: 299 });
    expect(asked[0]).toEqual({
      name: 'Jane Smith',
      title: 'VP Engineering',
      company: 'Acme',
      companyDomain: 'acme.com',
    });

    const person = await queryOne<{ avatar_url: string; avatar_source: string }>(
      db,
      'SELECT avatar_url, avatar_source FROM people WHERE id = ?',
      [SEED.personId],
    );
    expect(person?.avatar_url).toBe(LINKEDIN_HIT.photoUrl);
    expect(person?.avatar_source).toBe('search');

    // Research, at a confidence no machine can act on.
    const identity = await queryOne<{ handle: string; profile_url: string; confidence: number }>(
      db,
      `SELECT handle, profile_url, confidence FROM social_identities
        WHERE person_id = ? AND network = 'linkedin'`,
      [SEED.personId],
    );
    expect(identity?.handle).toBe('jane-smith-123');
    expect(identity?.profile_url).toBe('https://www.linkedin.com/in/jane-smith-123/');
    expect(identity?.confidence).toBeLessThan(0.85);

    // Done: nothing left to look up.
    expect(await workspacesAwaitingPhotos(db)).toEqual([]);
  });

  test('a miss is remembered and never paid for again', async () => {
    seeded = await seedDatabase('photos-miss');
    const { db } = seeded;
    const { asked, finder: missed } = finder(undefined);

    const first = await sweepProfilePhotos(
      { db, finder: missed },
      { workspaceId: SEED.workspaceId },
    );
    const second = await sweepProfilePhotos(
      { db, finder: missed },
      { workspaceId: SEED.workspaceId },
    );

    expect(first.looked).toBe(1);
    expect(second.looked).toBe(0);
    expect(asked).toHaveLength(1);

    const person = await queryOne<{ avatar_url: string | null; photo_looked_up_at: string | null }>(
      db,
      'SELECT avatar_url, photo_looked_up_at FROM people WHERE id = ?',
      [SEED.personId],
    );
    expect(person?.avatar_url).toBeNull();
    expect(person?.photo_looked_up_at).not.toBeNull();
  });

  test('the daily ceiling stops the sweep before it asks', async () => {
    seeded = await seedDatabase('photos-cap');
    const { db } = seeded;
    const { asked, finder: found } = finder(LINKEDIN_HIT);

    const result = await sweepProfilePhotos(
      { db, finder: found, dailyCap: 0 },
      { workspaceId: SEED.workspaceId },
    );

    expect(result.looked).toBe(0);
    expect(asked).toHaveLength(0);
  });
});
