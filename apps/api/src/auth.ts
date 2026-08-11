/**
 * Authentication (PRD §34, §38 "Account").
 *
 * Sessions, not a shared secret. Design points that matter:
 *
 *   - Passwords are hashed with argon2id via `Bun.password`, which picks and
 *     stores its own parameters, so there is no hand-rolled crypto here.
 *   - The session cookie value is random and never stored. The database keeps
 *     only its SHA-256 hash, so a database leak yields no usable sessions.
 *   - Login failures are counted and the account locks temporarily, which is
 *     what makes online brute force impractical.
 *   - The response is deliberately identical for "no such user" and "wrong
 *     password", so the endpoint cannot be used to enumerate accounts.
 */

import { newId } from '@outreachgraph/domain';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import type { RequestActor } from './context';
import { ApiError } from './context';

export const SESSION_COOKIE = 'og_session';

/** Long enough to be convenient, short enough to bound a stolen cookie. */
const SESSION_TTL_DAYS = 30;
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  password_hash: string | null;
  status: string;
  failed_login_count: number;
  locked_until: string | null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Cheap structural check; real validation is the delivery attempt. */
export function isPlausibleEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320;
}

/**
 * Password floor. Length does more work than composition rules, so this asks
 * for length rather than punctuation the user will write on a sticky note.
 */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 12) return 'password must be at least 12 characters';
  if (password.length > 512) return 'password must be at most 512 characters';
  return undefined;
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed stored hash must read as "wrong password", not crash a login.
    return false;
  }
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function mintSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly organizationName?: string;
}

export interface RegisterResult {
  readonly userId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}

/**
 * Creates a user with their own organization and first workspace.
 *
 * A user with no workspace cannot do anything in this product, so registration
 * provisions one rather than leaving a half-created account.
 */
export async function registerUser(db: Client, input: RegisterInput): Promise<RegisterResult> {
  const email = normalizeEmail(input.email);

  if (!isPlausibleEmail(email)) throw ApiError.badRequest('enter a valid email address');
  const problem = passwordProblem(input.password);
  if (problem) throw ApiError.badRequest(problem);

  const existing = await queryOne<{ id: string }>(db, 'SELECT id FROM users WHERE email = ?', [
    email,
  ]);
  if (existing) throw new ApiError(409, 'email_taken', 'that email is already registered');

  const userId = newId('user');
  const organizationId = newId('organization');
  const workspaceId = newId('workspace');
  const stamp = now();
  const passwordHash = await hashPassword(input.password);

  const orgName = input.organizationName?.trim() || `${input.name?.trim() || email} workspace`;
  const slug = `${slugify(orgName)}-${userId.slice(-6)}`;

  await db.batch([
    {
      sql: `INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      args: [userId, email, input.name?.trim() ?? null, passwordHash, stamp, stamp],
    },
    {
      sql: `INSERT INTO organizations (id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [organizationId, orgName, slug, stamp, stamp],
    },
    {
      sql: `INSERT INTO organization_members (organization_id, user_id, role, created_at)
            VALUES (?, ?, 'owner', ?)`,
      args: [organizationId, userId, stamp],
    },
    {
      sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
            VALUES (?, ?, ?, 'default', ?, ?)`,
      args: [workspaceId, organizationId, orgName, stamp, stamp],
    },
  ]);

  return { userId, organizationId, workspaceId };
}

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: string;
  readonly actor: RequestActor;
}

export async function login(
  db: Client,
  email: string,
  password: string,
  userAgent?: string,
): Promise<LoginResult> {
  const normalized = normalizeEmail(email);
  const user = await queryOne<UserRow>(db, 'SELECT * FROM users WHERE email = ?', [normalized]);

  // Identical failure for unknown user and wrong password.
  const invalid = new ApiError(401, 'invalid_credentials', 'email or password is incorrect');

  if (!user || !user.password_hash) throw invalid;
  if (user.status !== 'active') throw ApiError.forbidden('this account is not active');

  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    throw new ApiError(
      429,
      'account_locked',
      'too many failed attempts; try again in a few minutes',
    );
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const failures = user.failed_login_count + 1;
    const lockedUntil =
      failures >= MAX_FAILED_LOGINS
        ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
        : null;

    await db.execute({
      sql: 'UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?',
      args: [failures, lockedUntil, user.id],
    });
    throw invalid;
  }

  const membership = await primaryMembership(db, user.id);
  if (!membership) throw ApiError.forbidden('this account has no workspace');

  const token = mintSessionToken();
  const stamp = now();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000).toISOString();

  await db.batch([
    {
      sql: `INSERT INTO sessions (id, user_id, token_hash, workspace_id, user_agent,
            created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('session'),
        user.id,
        await hashToken(token),
        membership.workspaceId,
        userAgent?.slice(0, 200) ?? null,
        stamp,
        stamp,
        expiresAt,
      ],
    },
    {
      sql: 'UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?',
      args: [stamp, user.id],
    },
  ]);

  return {
    token,
    expiresAt,
    actor: {
      userId: user.id,
      workspaceId: membership.workspaceId,
      organizationId: membership.organizationId,
      role: membership.role,
    },
  };
}

export async function logout(db: Client, token: string): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM sessions WHERE token_hash = ?',
    args: [await hashToken(token)],
  });
}

/**
 * Resolves a session cookie to an actor, or undefined.
 *
 * An expired session is deleted on sight rather than merely rejected, so the
 * table does not accumulate dead rows between sweeps.
 */
export async function actorFromSession(
  db: Client,
  token: string,
): Promise<RequestActor | undefined> {
  const tokenHash = await hashToken(token);

  const session = await queryOne<{
    id: string;
    user_id: string;
    workspace_id: string | null;
    expires_at: string;
  }>(db, 'SELECT id, user_id, workspace_id, expires_at FROM sessions WHERE token_hash = ?', [
    tokenHash,
  ]);

  if (!session) return undefined;

  if (Date.parse(session.expires_at) <= Date.now()) {
    await db.execute({ sql: 'DELETE FROM sessions WHERE id = ?', args: [session.id] });
    return undefined;
  }

  const membership = session.workspace_id
    ? await membershipForWorkspace(db, session.user_id, session.workspace_id)
    : await primaryMembership(db, session.user_id);

  // Membership can be revoked while a session is still valid.
  if (!membership) return undefined;

  await db.execute({
    sql: 'UPDATE sessions SET last_seen_at = ? WHERE id = ?',
    args: [now(), session.id],
  });

  return {
    userId: session.user_id,
    workspaceId: membership.workspaceId,
    organizationId: membership.organizationId,
    role: membership.role,
  };
}

interface Membership {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly role: RequestActor['role'];
}

async function primaryMembership(db: Client, userId: string): Promise<Membership | undefined> {
  const row = await queryOne<{ organization_id: string; role: string; workspace_id: string }>(
    db,
    `SELECT m.organization_id, m.role, w.id AS workspace_id
       FROM organization_members m
       JOIN workspaces w ON w.organization_id = m.organization_id
      WHERE m.user_id = ? AND w.status = 'active'
   ORDER BY w.created_at LIMIT 1`,
    [userId],
  );

  if (!row) return undefined;
  return {
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    role: asRole(row.role),
  };
}

/** Confirms the user may act in this specific workspace. */
async function membershipForWorkspace(
  db: Client,
  userId: string,
  workspaceId: string,
): Promise<Membership | undefined> {
  const row = await queryOne<{ organization_id: string; role: string }>(
    db,
    `SELECT m.organization_id, m.role
       FROM organization_members m
       JOIN workspaces w ON w.organization_id = m.organization_id
      WHERE m.user_id = ? AND w.id = ?`,
    [userId, workspaceId],
  );

  if (!row) return undefined;
  return { organizationId: row.organization_id, workspaceId, role: asRole(row.role) };
}

export async function workspacesForUser(db: Client, userId: string) {
  return queryAll<{ id: string; name: string; organization_id: string; role: string }>(
    db,
    `SELECT w.id, w.name, w.organization_id, m.role
       FROM organization_members m
       JOIN workspaces w ON w.organization_id = m.organization_id
      WHERE m.user_id = ? ORDER BY w.created_at`,
    [userId],
  );
}

/** Removes expired sessions. Called by the background loop. */
export async function pruneSessions(db: Client): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM sessions WHERE expires_at <= ?',
    args: [now()],
  });
  return Number(result.rowsAffected ?? 0);
}

function asRole(role: string): RequestActor['role'] {
  return role === 'owner' || role === 'admin' || role === 'viewer' ? role : 'member';
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'workspace'
  );
}

/** Cookie attributes. `secure` is dropped only for plain-HTTP local dev. */
export function sessionCookie(token: string, expiresAt: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearedCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}
