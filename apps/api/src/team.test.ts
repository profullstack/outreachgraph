import { afterEach, describe, expect, test } from 'bun:test';
import { now, queryAll, queryOne } from '@outreachgraph/db';
import { seedDatabase, SEED, type SeededDatabase } from './test-seed';
import {
  acceptInvitation,
  inviteMember,
  listInvitations,
  listMembers,
  previewInvitation,
  removeMember,
  revokeInvitation,
  TeamError,
} from './team';

let seeded: SeededDatabase | undefined;

afterEach(() => {
  seeded?.cleanup();
  seeded = undefined;
});

const INVITER = { organizationId: SEED.organizationId, invitedBy: SEED.userId };

/** A second account, so accepting has somebody to attach a membership to. */
async function addUser(db: SeededDatabase['db'], id: string, email: string): Promise<void> {
  const stamp = now();
  await db.execute({
    sql: `INSERT INTO users (id, email, name, email_verified_at, created_at, updated_at)
          VALUES (?, ?, 'Colleague', ?, ?, ?)`,
    args: [id, email, stamp, stamp, stamp],
  });
}

describe('inviteMember', () => {
  test('mints one pending invitation and stores only the hash', async () => {
    seeded = await seedDatabase('team-invite');
    const { db } = seeded;

    const minted = await inviteMember(db, {
      ...INVITER,
      email: '  Sam@Example.com ',
      role: 'member',
    });

    expect(minted.email).toBe('sam@example.com');
    expect(minted.token).toHaveLength(64);

    const row = await queryOne<{ token_hash: string; email: string }>(
      db,
      'SELECT token_hash, email FROM invitations WHERE id = ?',
      [minted.id],
    );

    // A database copy must not confer the ability to join the organization.
    expect(row?.token_hash).not.toBe(minted.token);
    expect(row?.email).toBe('sam@example.com');

    const pending = await listInvitations(db, SEED.organizationId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.expired).toBe(false);
  });

  test('re-inviting replaces the outstanding token rather than adding a second', async () => {
    seeded = await seedDatabase('team-reinvite');
    const { db } = seeded;

    const first = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    const second = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'admin' });

    const rows = await queryAll<{ id: string }>(
      db,
      'SELECT id FROM invitations WHERE organization_id = ?',
      [SEED.organizationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(second.id);

    // The point of replacing rather than adding: the first link must stop
    // working, or revoking the one you can see leaves a live one in an inbox.
    expect(await previewInvitation(db, first.token)).toBeUndefined();
    expect((await previewInvitation(db, second.token))?.role).toBe('admin');
  });

  test('somebody already on the team is refused', async () => {
    seeded = await seedDatabase('team-existing');
    const { db } = seeded;

    await expect(
      inviteMember(db, { ...INVITER, email: 'test@example.com', role: 'member' }),
    ).rejects.toBeInstanceOf(TeamError);
  });

  test('a malformed address is refused before a token is minted', async () => {
    seeded = await seedDatabase('team-bad-address');
    const { db } = seeded;

    await expect(
      inviteMember(db, { ...INVITER, email: 'not-an-address', role: 'member' }),
    ).rejects.toBeInstanceOf(TeamError);
  });
});

describe('acceptInvitation', () => {
  test('turns a token into a membership and names a workspace to land in', async () => {
    seeded = await seedDatabase('team-accept');
    const { db } = seeded;
    await addUser(db, 'usr_sam', 'sam@example.com');

    const minted = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    const accepted = await acceptInvitation(db, minted.token, 'usr_sam');

    expect(accepted.organizationId).toBe(SEED.organizationId);
    expect(accepted.workspaceId).toBe(SEED.workspaceId);

    const members = await listMembers(db, SEED.organizationId);
    expect(members.map((m) => m.email).sort()).toEqual(['sam@example.com', 'test@example.com']);

    // Answered invitations drop off the pending list.
    expect(await listInvitations(db, SEED.organizationId)).toHaveLength(0);
  });

  test('accepting twice is a no-op rather than an error', async () => {
    seeded = await seedDatabase('team-accept-twice');
    const { db } = seeded;
    await addUser(db, 'usr_sam', 'sam@example.com');

    const minted = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    await acceptInvitation(db, minted.token, 'usr_sam');

    // A double-clicked link and a refreshed tab both produce this.
    await acceptInvitation(db, minted.token, 'usr_sam');
    expect(await listMembers(db, SEED.organizationId)).toHaveLength(2);
  });

  test('a withdrawn invitation stops working', async () => {
    seeded = await seedDatabase('team-revoked');
    const { db } = seeded;
    await addUser(db, 'usr_sam', 'sam@example.com');

    const minted = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    expect(await revokeInvitation(db, SEED.organizationId, minted.id)).toBe(true);

    await expect(acceptInvitation(db, minted.token, 'usr_sam')).rejects.toBeInstanceOf(TeamError);
    expect(await listMembers(db, SEED.organizationId)).toHaveLength(1);
  });

  test('an expired invitation stops working', async () => {
    seeded = await seedDatabase('team-expired');
    const { db } = seeded;
    await addUser(db, 'usr_sam', 'sam@example.com');

    const minted = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    await db.execute({
      sql: 'UPDATE invitations SET expires_at = ? WHERE id = ?',
      args: ['2020-01-01T00:00:00.000Z', minted.id],
    });

    await expect(acceptInvitation(db, minted.token, 'usr_sam')).rejects.toBeInstanceOf(TeamError);
    expect(await previewInvitation(db, minted.token)).toBeUndefined();
  });

  test('an unknown token is refused', async () => {
    seeded = await seedDatabase('team-unknown-token');
    const { db } = seeded;

    await expect(acceptInvitation(db, 'not-a-token', SEED.userId)).rejects.toBeInstanceOf(
      TeamError,
    );
  });
});

describe('removeMember', () => {
  test('removes a teammate', async () => {
    seeded = await seedDatabase('team-remove');
    const { db } = seeded;
    await addUser(db, 'usr_sam', 'sam@example.com');

    const minted = await inviteMember(db, { ...INVITER, email: 'sam@example.com', role: 'member' });
    await acceptInvitation(db, minted.token, 'usr_sam');

    expect(await removeMember(db, SEED.organizationId, 'usr_sam')).toBe(true);
    expect(await listMembers(db, SEED.organizationId)).toHaveLength(1);
  });

  test('the last owner cannot be removed', async () => {
    seeded = await seedDatabase('team-last-owner');
    const { db } = seeded;

    // An organization with no members is one whose data no login can reach:
    // `primaryMembership` is what resolves a session to a workspace.
    await expect(removeMember(db, SEED.organizationId, SEED.userId)).rejects.toBeInstanceOf(
      TeamError,
    );
  });
});
