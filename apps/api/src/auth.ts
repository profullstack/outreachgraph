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
  readonly offeringId: string;
  readonly campaignId: string;
}

/**
 * Creates a user with their own organization, workspace, offering and campaign.
 *
 * A user with no workspace cannot do anything in this product, so registration
 * provisions one rather than leaving a half-created account. The offering and
 * campaign are provisioned for the same reason: a campaign requires an
 * offering, and a prospect requires a campaign, so an account without both is
 * one where "add a prospect" has nowhere to write. They are placeholders the
 * user is expected to edit — the composer grounds every draft in the offering,
 * so leaving it unedited produces weak drafts, not wrong ones.
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
  const offeringId = newId('offering');
  const campaignId = newId('campaign');
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
    {
      sql: `INSERT INTO offerings (id, workspace_id, name, category, description, created_at, updated_at)
            VALUES (?, ?, ?, 'unspecified', ?, ?, ?)`,
      args: [
        offeringId,
        workspaceId,
        orgName,
        'Describe what you sell here. Every draft is grounded in this text.',
        stamp,
        stamp,
      ],
    },
    {
      sql: `INSERT INTO campaigns (id, workspace_id, name, offering_id, approval_mode, status,
                                   created_at, updated_at, started_at)
            VALUES (?, ?, 'First campaign', ?, 'draft_and_approve', 'active', ?, ?, ?)`,
      args: [campaignId, workspaceId, offeringId, stamp, stamp, stamp],
    },
  ]);

  return { userId, organizationId, workspaceId, offeringId, campaignId };
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

/**
 * Re-points a live session at another workspace.
 *
 * The session row already carries `workspace_id` and `actorFromSession`
 * already prefers it over `primaryMembership` — the column was written once at
 * login and never again, so a user belonging to two workspaces could only ever
 * reach the older one. This is the write that was missing.
 *
 * Membership is re-checked here rather than trusted from the caller: the
 * request names a workspace id, and without this a member of one organization
 * could pin their session to another's and every workspace-scoped route
 * downstream would happily serve it.
 */
export async function switchSessionWorkspace(
  db: Client,
  token: string,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const membership = await membershipForWorkspace(db, userId, workspaceId);
  if (!membership) return false;

  const result = await db.execute({
    sql: `UPDATE sessions SET workspace_id = ? WHERE token_hash = ? AND user_id = ?`,
    args: [workspaceId, await hashToken(token), userId],
  });

  return result.rowsAffected > 0;
}

/**
 * A second workspace under an organization the user already belongs to.
 *
 * The schema has allowed this since 0000 — it is how an agency keeps one
 * client's prospect graph out of another's — and nothing could create one.
 * Slug is derived and de-duplicated because `UNIQUE (organization_id, slug)`
 * makes a collision an error rather than a rename.
 */
export async function createWorkspace(
  db: Client,
  organizationId: string,
  name: string,
): Promise<{ id: string; name: string; slug: string }> {
  const trimmed = name.trim().slice(0, 120);
  if (!trimmed) throw new ApiError(400, 'bad_request', 'give the workspace a name');

  const base = slugify(trimmed) || 'workspace';
  let slug = base;

  for (let attempt = 2; attempt < 50; attempt += 1) {
    const taken = await queryOne<{ id: string }>(
      db,
      'SELECT id FROM workspaces WHERE organization_id = ? AND slug = ?',
      [organizationId, slug],
    );
    if (!taken) break;
    slug = `${base}-${attempt}`;
  }

  const id = newId('workspace');
  const stamp = now();

  await db.execute({
    sql: `INSERT INTO workspaces (id, organization_id, name, slug, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, organizationId, trimmed, slug, stamp, stamp],
  });

  return { id, name: trimmed, slug };
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

// ------------------------------------------------------------ verification

/** Long enough to survive a spam folder, short enough to bound a leaked link. */
const VERIFICATION_TTL_HOURS = 24;

export interface VerificationToken {
  readonly token: string;
  readonly email: string;
  readonly expiresAt: string;
}

/**
 * Mints a verification token, replacing any outstanding one.
 *
 * Superseding rather than accumulating means "resend" cannot be used to build
 * a pile of simultaneously valid links, and the newest mail in the inbox is
 * always the one that works — the behaviour people actually expect.
 */
export async function mintVerificationToken(
  db: Client,
  userId: string,
  email: string,
): Promise<VerificationToken> {
  const token = mintSessionToken();
  const stamp = now();
  const expiresAt = new Date(
    new Date(stamp).getTime() + VERIFICATION_TTL_HOURS * 3_600_000,
  ).toISOString();

  await db.batch([
    { sql: 'DELETE FROM email_verification_tokens WHERE user_id = ?', args: [userId] },
    {
      sql: `INSERT INTO email_verification_tokens (id, user_id, token_hash, email, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [newId('session'), userId, await hashToken(token), email, stamp, expiresAt],
    },
  ]);

  return { token, email, expiresAt };
}

export interface VerificationResult {
  readonly userId: string;
  readonly email: string;
}

/**
 * Consumes a verification token and marks the address confirmed.
 *
 * Every failure — unknown, expired, already used — answers the same way. A
 * verification endpoint that distinguishes them tells an attacker holding a
 * guessed token whether it ever existed.
 */
export async function verifyEmailToken(db: Client, token: string): Promise<VerificationResult> {
  const invalid = new ApiError(400, 'invalid_token', 'that link is invalid or has expired');
  if (!token) throw invalid;

  const row = await queryOne<{
    id: string;
    user_id: string;
    email: string;
    expires_at: string;
    consumed_at: string | null;
  }>(db, 'SELECT * FROM email_verification_tokens WHERE token_hash = ?', [await hashToken(token)]);

  if (!row || row.consumed_at) throw invalid;

  const stamp = now();
  if (new Date(row.expires_at).getTime() <= new Date(stamp).getTime()) throw invalid;

  // The address may have changed since the token was minted; verifying the
  // old one would confirm something the user no longer uses.
  const user = await queryOne<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', [
    row.user_id,
  ]);
  if (!user || user.email !== row.email) throw invalid;

  await db.batch([
    {
      sql: 'UPDATE email_verification_tokens SET consumed_at = ? WHERE id = ?',
      args: [stamp, row.id],
    },
    {
      sql: 'UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?',
      args: [stamp, stamp, row.user_id],
    },
  ]);

  return { userId: row.user_id, email: row.email };
}

export async function isEmailVerified(db: Client, userId: string): Promise<boolean> {
  const row = await queryOne<{ email_verified_at: string | null }>(
    db,
    'SELECT email_verified_at FROM users WHERE id = ?',
    [userId],
  );
  return Boolean(row?.email_verified_at);
}

// ---------------------------------------------------------- password reset

/**
 * Short by design. A reset link is a live credential sitting in an inbox, and
 * an hour is long enough to walk to a laptop but short enough that a mailbox
 * skimmed weeks later yields nothing.
 */
const RESET_TTL_MINUTES = 60;

/**
 * How soon a second link may be mailed to the same account.
 *
 * Superseding alone does not stop someone typing a stranger's address into the
 * form repeatedly to bury their inbox, because every request would still send.
 * The cooldown bounds that to one message a minute per account while leaving a
 * genuine "it never arrived" retry available.
 */
const RESET_RESEND_COOLDOWN_SECONDS = 60;

export interface ResetToken {
  readonly token: string;
  readonly userId: string;
  readonly email: string;
  readonly expiresAt: string;
}

/**
 * Mints a reset token for an address, or returns undefined if there is nothing
 * to send.
 *
 * Returning undefined rather than throwing is the whole point: the caller
 * answers identically whether or not the address exists, so the endpoint
 * cannot be used to enumerate accounts. The three silent cases are an unknown
 * address, a suspended account, and a request inside the cooldown.
 */
export async function mintPasswordResetToken(
  db: Client,
  rawEmail: string,
): Promise<ResetToken | undefined> {
  const email = normalizeEmail(rawEmail);
  if (!isPlausibleEmail(email)) return undefined;

  const user = await queryOne<{ id: string; status: string }>(
    db,
    'SELECT id, status FROM users WHERE email = ?',
    [email],
  );
  if (!user || user.status !== 'active') return undefined;

  const stamp = now();

  const recent = await queryOne<{ created_at: string }>(
    db,
    `SELECT created_at FROM password_reset_tokens
      WHERE user_id = ? AND consumed_at IS NULL
   ORDER BY created_at DESC LIMIT 1`,
    [user.id],
  );
  if (
    recent &&
    new Date(stamp).getTime() - new Date(recent.created_at).getTime() <
      RESET_RESEND_COOLDOWN_SECONDS * 1_000
  ) {
    return undefined;
  }

  const token = mintSessionToken();
  const expiresAt = new Date(new Date(stamp).getTime() + RESET_TTL_MINUTES * 60_000).toISOString();

  // Replacing rather than accumulating: the newest mail in the inbox is always
  // the one that works, and a pile of live links never builds up.
  await db.batch([
    { sql: 'DELETE FROM password_reset_tokens WHERE user_id = ?', args: [user.id] },
    {
      sql: `INSERT INTO password_reset_tokens (id, user_id, token_hash, email, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [newId('session'), user.id, await hashToken(token), email, stamp, expiresAt],
    },
  ]);

  return { token, userId: user.id, email, expiresAt };
}

export interface ResetResult {
  readonly userId: string;
  readonly email: string;
}

/**
 * Consumes a reset token and installs the new password.
 *
 * Three things happen alongside the write, and each is load-bearing:
 *
 *   - Every session for the user is deleted. Someone resetting a password may
 *     be doing it because another party has one, and leaving those cookies
 *     alive would make the reset cosmetic.
 *   - The lockout counter is cleared, so an account locked by the failed
 *     guesses that prompted the reset is usable immediately afterwards.
 *   - The address is marked verified if it was not already. Receiving the mail
 *     proves the mailbox as well as any verification link does, and stranding
 *     someone behind a second confirmation they have just demonstrated would
 *     be ceremony.
 *
 * The password is checked before the token is looked up so that a weak choice
 * is rejected without burning the link.
 */
export async function resetPassword(
  db: Client,
  token: string,
  password: string,
): Promise<ResetResult> {
  const invalid = new ApiError(400, 'invalid_token', 'that link is invalid or has expired');

  const problem = passwordProblem(password);
  if (problem) throw ApiError.badRequest(problem);
  if (!token) throw invalid;

  const row = await queryOne<{
    id: string;
    user_id: string;
    email: string;
    expires_at: string;
    consumed_at: string | null;
  }>(db, 'SELECT * FROM password_reset_tokens WHERE token_hash = ?', [await hashToken(token)]);

  if (!row || row.consumed_at) throw invalid;

  const stamp = now();
  if (new Date(row.expires_at).getTime() <= new Date(stamp).getTime()) throw invalid;

  // The address may have changed since the token was minted; honouring it
  // would let a former address take over the account.
  const user = await queryOne<{ email: string; status: string }>(
    db,
    'SELECT email, status FROM users WHERE id = ?',
    [row.user_id],
  );
  if (!user || user.email !== row.email || user.status !== 'active') throw invalid;

  const passwordHash = await hashPassword(password);

  await db.batch([
    {
      sql: 'UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?',
      args: [stamp, row.id],
    },
    {
      sql: `UPDATE users
               SET password_hash = ?,
                   failed_login_count = 0,
                   locked_until = NULL,
                   email_verified_at = COALESCE(email_verified_at, ?),
                   updated_at = ?
             WHERE id = ?`,
      args: [passwordHash, stamp, stamp, row.user_id],
    },
    { sql: 'DELETE FROM sessions WHERE user_id = ?', args: [row.user_id] },
  ]);

  return { userId: row.user_id, email: row.email };
}

/** Removes spent and expired reset tokens. Called by the background loop. */
export async function prunePasswordResetTokens(db: Client): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM password_reset_tokens WHERE expires_at <= ? OR consumed_at IS NOT NULL',
    args: [now()],
  });
  return Number(result.rowsAffected ?? 0);
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
