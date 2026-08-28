/**
 * Who else is in this organization, and how they got here.
 *
 * `organization_members` was written once, at registration, and never again:
 * an account was permanently a party of one. This is the missing half — mint
 * an invitation, mail a link, and turn that link into a membership row.
 *
 * The shape follows the two token flows already in `auth.ts` (verification and
 * password reset) rather than inventing a third: mint a random token, store
 * only its hash, hand the plaintext to the mail, and consume it once. Anything
 * that diverges from that pattern here is a deliberate difference, noted where
 * it happens.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import { hashToken, mintSessionToken } from './auth';

/** Long enough to survive a weekend and an ignored inbox, short enough to expire. */
export const INVITATION_TTL_DAYS = 14;

/**
 * The roles an invitation may grant.
 *
 * `owner` is deliberately absent. It is the role registration gives the person
 * who created the organization, and an invitation that can mint a second owner
 * is an invitation that can lock the first one out.
 */
export const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: unknown): value is InvitableRole {
  return typeof value === 'string' && (INVITABLE_ROLES as readonly string[]).includes(value);
}

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamError';
  }
}

/** Normalised the same way `users.email` is, so the two can be compared. */
function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

export interface MemberRow {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
  readonly joinedAt: string;
}

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string | null;
  readonly expiresAt: string;
  readonly createdAt: string;
  /** True once the expiry has passed, so the UI can say so rather than imply it is live. */
  readonly expired: boolean;
}

export async function listMembers(db: Client, organizationId: string): Promise<MemberRow[]> {
  const rows = await queryAll<{
    user_id: string;
    email: string;
    name: string | null;
    role: string;
    created_at: string;
  }>(
    db,
    `SELECT m.user_id, u.email, u.name, m.role, m.created_at
       FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ?
      ORDER BY m.created_at ASC`,
    [organizationId],
  );

  return rows.map((row) => ({
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    joinedAt: row.created_at,
  }));
}

/**
 * Invitations still outstanding.
 *
 * Accepted and revoked ones are kept in the table for the audit trail but are
 * not listed: a settings page that shows every invitation ever sent is one
 * nobody reads, and the question being asked here is "who is still expected".
 */
export async function listInvitations(
  db: Client,
  organizationId: string,
): Promise<InvitationRow[]> {
  const stamp = now();

  const rows = await queryAll<{
    id: string;
    email: string;
    role: string;
    invited_by: string | null;
    expires_at: string;
    created_at: string;
  }>(
    db,
    `SELECT i.id, i.email, i.role, u.email AS invited_by, i.expires_at, i.created_at
       FROM invitations i
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.organization_id = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC`,
    [organizationId],
  );

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    expired: row.expires_at <= stamp,
  }));
}

export interface MintedInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: InvitableRole;
  /** Plaintext, returned once. Only the hash is stored. */
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Invites one address into an organization.
 *
 * Re-inviting somebody replaces their outstanding invitation rather than
 * adding a second: two live tokens for one person means revoking the one you
 * can see still leaves a working link in an inbox. The unique partial index in
 * migration 0029 is what makes that a guarantee rather than a convention, and
 * the delete below is what keeps it from being an error.
 */
export async function inviteMember(
  db: Client,
  input: {
    organizationId: string;
    invitedBy: string;
    email: string;
    role: InvitableRole;
  },
): Promise<MintedInvitation> {
  const email = normaliseEmail(input.email);

  if (!email.includes('@') || email.length < 3) {
    throw new TeamError('that does not look like an email address');
  }

  // Already inside. Minting a token that grants what the holder has would
  // produce a link that appears to fail when it is used.
  const existing = await queryOne<{ user_id: string }>(
    db,
    `SELECT m.user_id FROM organization_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ? AND u.email = ?`,
    [input.organizationId, email],
  );

  if (existing) throw new TeamError('that person is already on your team');

  const token = mintSessionToken();
  const stamp = now();
  const expiresAt = new Date(
    new Date(stamp).getTime() + INVITATION_TTL_DAYS * 86_400_000,
  ).toISOString();
  const id = newId('invitation');

  await db.batch([
    {
      sql: `DELETE FROM invitations
             WHERE organization_id = ? AND email = ?
               AND accepted_at IS NULL AND revoked_at IS NULL`,
      args: [input.organizationId, email],
    },
    {
      sql: `INSERT INTO invitations (id, organization_id, email, role, token_hash, invited_by,
              expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.organizationId,
        email,
        input.role,
        await hashToken(token),
        input.invitedBy,
        expiresAt,
        stamp,
      ],
    },
  ]);

  return { id, email, role: input.role, token, expiresAt };
}

/** Withdraws an outstanding invitation. Returns false if there was nothing to withdraw. */
export async function revokeInvitation(
  db: Client,
  organizationId: string,
  invitationId: string,
): Promise<boolean> {
  const result = await db.execute({
    sql: `UPDATE invitations SET revoked_at = ?
           WHERE id = ? AND organization_id = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
    args: [now(), invitationId, organizationId],
  });

  return result.rowsAffected > 0;
}

export interface InvitationPreview {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly email: string;
  readonly role: string;
}

/**
 * What a link says before anybody signs in.
 *
 * Deliberately thin: the organization's name, the address it was sent to and
 * the role. Anyone holding the token already knows those, and a preview that
 * leaked the member list would make an invitation link a reconnaissance tool.
 */
export async function previewInvitation(
  db: Client,
  token: string,
): Promise<InvitationPreview | undefined> {
  const row = await queryOne<{
    organization_id: string;
    organization_name: string;
    email: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  }>(
    db,
    `SELECT i.organization_id, o.name AS organization_name, i.email, i.role, i.expires_at,
            i.accepted_at, i.revoked_at
       FROM invitations i
       JOIN organizations o ON o.id = i.organization_id
      WHERE i.token_hash = ?`,
    [await hashToken(token)],
  );

  if (!row) return undefined;
  if (row.accepted_at || row.revoked_at) return undefined;
  if (row.expires_at <= now()) return undefined;

  return {
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    email: row.email,
    role: row.role,
  };
}

export interface AcceptedInvitation {
  readonly organizationId: string;
  readonly role: string;
  /** A workspace in that organization, so the session can be re-pinned onto it. */
  readonly workspaceId: string | undefined;
}

/**
 * Turns a token into a membership for the signed-in user.
 *
 * **The address is not checked against the account's.** A link mailed to a
 * personal address and accepted by a work login is the common case, not an
 * attack: whoever holds the token was given it deliberately, which is the same
 * trust model as every other emailed link in the product. What the token
 * cannot do is grant `owner`, which is enforced when it is minted.
 *
 * Accepting twice is a no-op rather than an error — a double-clicked link and
 * a refreshed tab both produce it, and neither is a problem.
 */
export async function acceptInvitation(
  db: Client,
  token: string,
  userId: string,
): Promise<AcceptedInvitation> {
  const hash = await hashToken(token);

  const row = await queryOne<{
    id: string;
    organization_id: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
    revoked_at: string | null;
  }>(
    db,
    `SELECT id, organization_id, role, expires_at, accepted_at, revoked_at
       FROM invitations WHERE token_hash = ?`,
    [hash],
  );

  if (!row) throw new TeamError('that invitation link is not valid');
  if (row.revoked_at) throw new TeamError('that invitation was withdrawn');
  if (row.expires_at <= now()) throw new TeamError('that invitation has expired');

  const stamp = now();

  if (!row.accepted_at) {
    await db.batch([
      {
        // `INSERT OR IGNORE`: the user may already be a member by another
        // route, and the invitation should still be marked answered.
        sql: `INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at)
              VALUES (?, ?, ?, ?)`,
        args: [row.organization_id, userId, row.role, stamp],
      },
      {
        sql: `UPDATE invitations SET accepted_at = ?, accepted_by = ? WHERE id = ?`,
        args: [stamp, userId, row.id],
      },
    ]);
  }

  const workspace = await queryOne<{ id: string }>(
    db,
    `SELECT id FROM workspaces WHERE organization_id = ? ORDER BY created_at ASC LIMIT 1`,
    [row.organization_id],
  );

  return {
    organizationId: row.organization_id,
    role: row.role,
    workspaceId: workspace?.id,
  };
}

/**
 * Removes somebody from an organization.
 *
 * The last owner cannot be removed. Not paternalism: `primaryMembership` is
 * what resolves a session to a workspace, so an organization with no members
 * is one whose data no login can ever reach again.
 */
export async function removeMember(
  db: Client,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const target = await queryOne<{ role: string }>(
    db,
    `SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ?`,
    [organizationId, userId],
  );

  if (!target) return false;

  if (target.role === 'owner') {
    const owners = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM organization_members
        WHERE organization_id = ? AND role = 'owner'`,
      [organizationId],
    );

    if (Number(owners?.n ?? 0) <= 1) {
      throw new TeamError('an organization must keep at least one owner');
    }
  }

  const result = await db.execute({
    sql: `DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?`,
    args: [organizationId, userId],
  });

  return result.rowsAffected > 0;
}
