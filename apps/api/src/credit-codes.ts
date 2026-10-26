/**
 * Credit codes and invites.
 *
 * Two house packages, and no second balance:
 *
 * - `@profullstack/redeem-credits` mints scarce codes (stored only as sha256
 *   hashes) and decides whether one may be redeemed: unknown, revoked,
 *   expired, used up, or already redeemed by this person. On success the
 *   prospect credits are written into `credit_ledger`, the ledger CoinPay
 *   purchases already fill, so `/billing` and the spend path need no change.
 *   The package's own `redeem_ledger` keeps one audit row per redemption and is
 *   never read as a balance.
 * - `@profullstack/affiliates` gives every account three single-use invites
 *   and one open `?ref=` code, and records who brought whom.
 *
 * Every grant goes through `grantCredits`, keyed by a `payment_id` built from
 * (source, user), so the unique index on that column makes it exactly-once:
 * `code:<codeId>:<userId>`, `invite:<inviteeUserId>:invitee|inviter`.
 *
 * An invite is accepted when the account is created (so the link still counts
 * when the verification mail is opened on another device) and its bonus is
 * paid only when the address is confirmed, and only after the checks in
 * `settleInviteBonus`.
 */

import {
  Credits,
  postgresStore as creditPostgresStore,
  sqliteStore as creditSqliteStore,
  memoryStore as creditMemoryStore,
  type CreditStore,
  type MintedCode,
  type RedeemResult,
} from '@profullstack/redeem-credits';
import {
  Affiliates,
  postgresStore as affPostgresStore,
  sqliteStore as affSqliteStore,
  memoryStore as affMemoryStore,
  normalizeCode as normalizeInviteCode,
  type AffiliateStore,
  type Invite,
} from '@profullstack/affiliates';
import { emailDedupeKey, isDisposableDomain } from '@outreachgraph/domain';
import { now, queryOne, type Client, type RawHandle } from '@outreachgraph/db';
import { creditsFor, grantCredits } from '@outreachgraph/pipeline';

export { REF_COOKIE } from '@profullstack/affiliates';

/** What a code grants: prospect credits, the unit `credit_ledger` already counts. */
export const CODE_UNIT = 'prospect';
/** Invites per account. Scarce on purpose: an invite says someone wanted you here. */
export const INVITE_QUOTA = 3;
/** Where an /i/<code> visit is remembered until the person creates an account. */
export const INVITE_COOKIE = 'og_invite';
/** Bonuses one inviter can earn in 30 days, whatever their quota is raised to. */
export const INVITER_MONTHLY_CAP = 10;
/** Table prefix for the codes package: `credit_ledger` is already this app's ledger. */
const CODE_TABLE_PREFIX = 'redeem_';

export interface CodeServices {
  readonly credits: Credits;
  readonly affiliates: Affiliates;
  /** Prospect credits paid to each side of an accepted invite. 0 turns the bonus off. */
  readonly inviteBonus: number;
  /** An inviter younger than this earns no bonus (hours). */
  readonly inviterMinAgeHours: number;
}

export interface CodeServiceOptions {
  readonly inviteBonus?: number;
  readonly inviterMinAgeHours?: number;
  readonly now?: () => number;
}

function build(
  creditStore: CreditStore,
  affStore: AffiliateStore,
  options: CodeServiceOptions,
): CodeServices {
  const clock = options.now ? { now: options.now } : {};
  return {
    credits: new Credits(creditStore, clock),
    affiliates: new Affiliates(affStore, { defaultQuota: INVITE_QUOTA, ...clock }),
    inviteBonus: Math.max(0, Math.floor(options.inviteBonus ?? 25)),
    inviterMinAgeHours: Math.max(0, options.inviterMinAgeHours ?? 24),
  };
}

/** The services over a raw handle on the app's own database. */
export function codeServicesFor(handle: RawHandle, options: CodeServiceOptions = {}): CodeServices {
  if (handle.kind === 'postgres') {
    return build(
      creditPostgresStore(handle.pool, { prefix: CODE_TABLE_PREFIX }),
      affPostgresStore(handle.pool),
      options,
    );
  }
  return build(
    creditSqliteStore(handle.db, { prefix: CODE_TABLE_PREFIX }),
    affSqliteStore(handle.db),
    options,
  );
}

/** In-memory services, for tests that do not care where codes live. */
export function memoryCodeServices(options: CodeServiceOptions = {}): CodeServices {
  return build(creditMemoryStore(), affMemoryStore(), options);
}

/** Bonus settings from the environment, read when the server starts. */
export function codeOptionsFromEnv(env: Record<string, string | undefined>): CodeServiceOptions {
  const bonus = Number(env.INVITE_BONUS_PROSPECTS ?? '25');
  const age = Number(env.INVITE_MIN_INVITER_AGE_HOURS ?? '24');
  return {
    inviteBonus: Number.isFinite(bonus) ? bonus : 25,
    inviterMinAgeHours: Number.isFinite(age) ? age : 24,
  };
}

// --- input -------------------------------------------------------------------

/**
 * A code as typed, or null when it cannot be one. The packages forgive case,
 * spaces and dashes; this only keeps junk out.
 */
export function cleanCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 48) return null;
  if (!/^[A-Za-z0-9 _-]+$/.test(trimmed)) return null;
  return trimmed;
}

/** The canonical spelling of an invite code, or null when it cannot be one. */
export function canonicalInvite(value: unknown): string | null {
  const cleaned = cleanCode(value);
  if (cleaned === null) return null;
  const normal = normalizeInviteCode(cleaned);
  return /^INV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(normal) ? normal : null;
}

/** An affiliate code from ?ref= or the cookie: short, letters and digits. */
export function cleanRef(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9]{4,32}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

// --- codes -------------------------------------------------------------------

export const REDEEM_MESSAGES: Record<Exclude<RedeemResult, { ok: true }>['reason'], string> = {
  invalid: 'That code does not exist. Check it and try again.',
  expired: 'That code has expired.',
  used_up: 'That code has already been used.',
  already_redeemed: 'You have already redeemed that code.',
  revoked: 'That code has been withdrawn.',
};

export type RedeemOutcome =
  | { ok: true; prospects: number; remaining: number }
  | {
      ok: false;
      reason: Exclude<RedeemResult, { ok: true }>['reason'] | 'wrong_unit';
      message: string;
    };

/**
 * Redeems a code for the organization the person is working in.
 *
 * The redemption is the package's (one per person per code, concurrency-safe);
 * the credit is a `credit_ledger` grant keyed on (code, person). If that write
 * fails the redemption still stands, so a retry repairs it: an
 * `already_redeemed` answer re-applies every code grant this person holds,
 * which the unique `payment_id` turns into a no-op for the ones already paid.
 */
export async function redeemCreditCode(
  db: Client,
  services: CodeServices,
  input: { userId: string; organizationId: string; code: string },
): Promise<RedeemOutcome> {
  const result = await services.credits.redeem(input.code, input.userId);

  if (!result.ok) {
    if (result.reason === 'already_redeemed') {
      await repairCodeGrants(db, services, input.userId, input.organizationId);
    }
    return { ok: false, reason: result.reason, message: REDEEM_MESSAGES[result.reason] };
  }

  if (result.grant.unit !== CODE_UNIT || result.grant.every) {
    // Minting refuses these; a code from another site's table would land here.
    return { ok: false, reason: 'wrong_unit', message: 'That code is not for OutreachGraph.' };
  }

  await grantCredits(db, {
    organizationId: input.organizationId,
    credits: result.grant.amount,
    paymentId: `code:${result.codeId}:${input.userId}`,
    reason: 'Credit code',
  });

  const balance = await creditsFor(db, input.organizationId);
  return { ok: true, prospects: result.grant.amount, remaining: balance.remaining };
}

async function repairCodeGrants(
  db: Client,
  services: CodeServices,
  userId: string,
  organizationId: string,
): Promise<void> {
  const history = await services.credits.history(userId, CODE_UNIT);
  for (const entry of history) {
    if (entry.kind !== 'grant' || !entry.source.startsWith('code:')) continue;
    await grantCredits(db, {
      organizationId,
      credits: entry.amount,
      paymentId: `${entry.source}:${userId}`,
      reason: 'Credit code',
    });
  }
}

export interface MintRequest {
  readonly prospects: number;
  readonly label: string;
  readonly maxRedemptions?: number;
  readonly expiresInDays?: number | null;
  readonly createdBy?: string;
}

/** An operator mints a code. The plaintext is in the result and nowhere else. */
export async function mintCreditCode(
  services: CodeServices,
  request: MintRequest,
): Promise<MintedCode> {
  if (
    !Number.isInteger(request.prospects) ||
    request.prospects <= 0 ||
    request.prospects > 100_000
  ) {
    throw new Error('prospects must be a whole number from 1 to 100000');
  }
  const max = request.maxRedemptions ?? 1;
  if (!Number.isInteger(max) || max < 1 || max > 10_000) {
    throw new Error('maxRedemptions must be a whole number from 1 to 10000');
  }
  const days = request.expiresInDays ?? null;
  return services.credits.mint({
    // One-off only: this app's ledger has no monthly top-up, and a monthly
    // code would pay once and then silently stop.
    grant: { unit: CODE_UNIT, amount: request.prospects },
    label: request.label.trim().slice(0, 120) || 'OutreachGraph credit',
    maxRedemptions: max,
    expiresAt: days === null ? null : Date.now() + days * 86_400_000,
    prefix: 'OG',
    ...(request.createdBy === undefined ? {} : { createdBy: request.createdBy }),
  });
}

// --- invites -----------------------------------------------------------------

export interface InviteView {
  readonly id: string;
  readonly note: string;
  readonly createdAt: string;
  readonly expiresAt: string | null;
  readonly used: boolean;
  readonly usedAt: string | null;
  readonly revoked: boolean;
}

export interface InviteSummary {
  readonly quota: { total: number; used: number; left: number };
  readonly invites: InviteView[];
  readonly affiliateCode: string;
  readonly affiliateUrl: string;
  readonly invitedCount: number;
  readonly bonusProspects: number;
}

function inviteView(invite: Omit<Invite, 'code'> & { revokedAt?: number | null }): InviteView {
  return {
    id: invite.id,
    note: invite.note,
    createdAt: new Date(invite.createdAt).toISOString(),
    expiresAt: invite.expiresAt === null ? null : new Date(invite.expiresAt).toISOString(),
    used: invite.usedBy !== null,
    usedAt: invite.usedAt === null ? null : new Date(invite.usedAt).toISOString(),
    revoked: (invite.revokedAt ?? null) !== null,
  };
}

export function inviteUrl(origin: string, code: string): string {
  return `${origin}/i/${encodeURIComponent(code)}`;
}

export async function inviteSummary(
  services: CodeServices,
  userId: string,
  origin: string,
): Promise<InviteSummary> {
  const { affiliates } = services;
  const [quota, invites, affiliateCode, invitees] = await Promise.all([
    affiliates.quota(userId),
    affiliates.invites(userId),
    affiliates.affiliateCode(userId),
    affiliates.invitees(userId),
  ]);
  return {
    quota,
    invites: invites.map(inviteView),
    affiliateCode,
    affiliateUrl: `${origin}/?ref=${affiliateCode}`,
    invitedCount: invitees.length,
    bonusProspects: services.inviteBonus,
  };
}

export type CreateInviteOutcome =
  | {
      ok: true;
      code: string;
      url: string;
      invite: InviteView;
      quota: InviteSummary['quota'];
    }
  | { ok: false; reason: 'no_invites_left' };

export async function createInvite(
  services: CodeServices,
  userId: string,
  note: string,
  origin: string,
): Promise<CreateInviteOutcome> {
  try {
    const invite = await services.affiliates.createInvite(userId, note.trim().slice(0, 120));
    return {
      ok: true,
      code: invite.code,
      url: inviteUrl(origin, invite.code),
      invite: inviteView(invite),
      quota: await services.affiliates.quota(userId),
    };
  } catch (error) {
    if (error instanceof Error && /no invites left/i.test(error.message)) {
      return { ok: false, reason: 'no_invites_left' };
    }
    throw error;
  }
}

/**
 * Records an invite and a `?ref=` against a brand-new account.
 *
 * Called from registration only, so an existing account can never accept one.
 * Never throws: a bad or spent invite must not cost somebody their signup.
 */
export async function acceptAtSignup(
  services: CodeServices,
  input: { userId: string; invite: string | null; ref: string | null },
): Promise<{ invite: string | null; ref: boolean }> {
  let inviteResult: string | null = null;
  let attributed = false;

  try {
    if (input.invite) {
      const r = await services.affiliates.redeemInvite(input.invite, input.userId);
      inviteResult = r.ok ? 'accepted' : r.reason;
    }
    if (input.ref) {
      const r = await services.affiliates.attribute(input.ref, input.userId);
      attributed = r.ok;
    }
  } catch (error) {
    console.error('invite/ref at signup failed', error);
  }

  return { invite: inviteResult, ref: attributed };
}

export type BonusStatus =
  | 'granted'
  | 'disabled'
  | 'disposable_domain'
  | 'same_mailbox'
  | 'inviter_too_new'
  | 'inviter_cap'
  | 'no_organization';

/** The organization a person's credit goes to: the one they own, oldest first. */
async function homeOrganization(db: Client, userId: string): Promise<string | undefined> {
  const row = await queryOne<{ organization_id: string }>(
    db,
    `SELECT organization_id FROM organization_members WHERE user_id = ?
      ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at
      LIMIT 1`,
    [userId],
  );
  return row?.organization_id;
}

function isUniqueViolation(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(message);
}

/**
 * Pays an accepted invite's bonus once the invitee's address is confirmed.
 *
 * No bonus (recorded with the reason) when: the bonus is off; the invitee
 * signed up from a throwaway mailbox; the two addresses are one mailbox (case,
 * +tag, Gmail dots); the inviter's account is younger than the minimum age; or
 * the inviter has already earned `INVITER_MONTHLY_CAP` bonuses in 30 days.
 *
 * The `invite_bonuses` row is claimed before either grant, so a second
 * verification (or a retry) never pays twice; the grants themselves are keyed
 * by `payment_id` as well.
 */
export async function settleInviteBonus(
  db: Client,
  services: CodeServices,
  inviteeUserId: string,
): Promise<{ status: BonusStatus; prospects: number } | null> {
  const invites = await services.affiliates.invitedBy(inviteeUserId);
  if (!invites) return null;
  const inviterUserId = invites;

  const already = await queryOne<{ status: string }>(
    db,
    'SELECT status FROM invite_bonuses WHERE invitee_user_id = ?',
    [inviteeUserId],
  );
  if (already) return null;

  const [invitee, inviter] = await Promise.all([
    queryOne<{ email: string; email_verified_at: string | null }>(
      db,
      'SELECT email, email_verified_at FROM users WHERE id = ?',
      [inviteeUserId],
    ),
    queryOne<{ email: string; created_at: string }>(
      db,
      'SELECT email, created_at FROM users WHERE id = ?',
      [inviterUserId],
    ),
  ]);
  // Not confirmed yet: nothing to decide, and nothing claimed.
  if (!invitee?.email_verified_at || !inviter) return null;

  const stamp = now();
  let status: BonusStatus = 'granted';
  const domain = invitee.email.split('@')[1] ?? '';
  const ageHours = (Date.parse(stamp) - Date.parse(inviter.created_at)) / 3_600_000;

  if (services.inviteBonus <= 0) status = 'disabled';
  else if (isDisposableDomain(domain)) status = 'disposable_domain';
  else if (
    emailDedupeKey(invitee.email.toLowerCase()) === emailDedupeKey(inviter.email.toLowerCase())
  )
    status = 'same_mailbox';
  else if (ageHours < services.inviterMinAgeHours) status = 'inviter_too_new';
  else {
    const since = new Date(Date.parse(stamp) - 30 * 86_400_000).toISOString();
    const earned = await queryOne<{ n: number }>(
      db,
      `SELECT count(*) AS n FROM invite_bonuses
        WHERE inviter_user_id = ? AND status = 'granted' AND created_at >= ?`,
      [inviterUserId, since],
    );
    if (Number(earned?.n ?? 0) >= INVITER_MONTHLY_CAP) status = 'inviter_cap';
  }

  const [inviteeOrg, inviterOrg] = await Promise.all([
    homeOrganization(db, inviteeUserId),
    homeOrganization(db, inviterUserId),
  ]);
  if (status === 'granted' && (!inviteeOrg || !inviterOrg)) status = 'no_organization';

  const prospects = status === 'granted' ? services.inviteBonus : 0;
  const inviteId =
    (await services.affiliates.invites(inviterUserId)).find((i) => i.usedBy === inviteeUserId)
      ?.id ?? 'unknown';

  try {
    await db.execute({
      sql: `INSERT INTO invite_bonuses (invitee_user_id, inviter_user_id, invite_id, status,
            prospects, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      args: [inviteeUserId, inviterUserId, inviteId, status, prospects, stamp],
    });
  } catch (error) {
    // Another request claimed it first; that one pays.
    if (isUniqueViolation(error)) return null;
    throw error;
  }

  if (status === 'granted' && inviteeOrg && inviterOrg) {
    await grantCredits(db, {
      organizationId: inviteeOrg,
      credits: prospects,
      paymentId: `invite:${inviteeUserId}:invitee`,
      reason: 'Invite bonus',
    });
    await grantCredits(db, {
      organizationId: inviterOrg,
      credits: prospects,
      paymentId: `invite:${inviteeUserId}:inviter`,
      reason: 'Invite bonus',
    });
  }

  return { status, prospects };
}
