/**
 * Introductions between members who both asked for them (PRD §38).
 *
 * The rest of this API is scoped to a workspace and fails closed across them
 * (§34). This module is the one deliberate exception, and it is narrow: the
 * only thing that crosses a workspace boundary is an **intro card**, which is
 * text a person typed about themselves and switched on. No prospect, signal,
 * score, campaign or provider record is read here, and none can be reached
 * from a card.
 *
 * What each side learns, and when:
 *
 *   - Browsing matches requires your own card to be open. You cannot read the
 *     pool without being in it.
 *   - A match shows the other card and the words that produced the match. It
 *     never shows an email address or a user id.
 *   - Asking shows the other person your card and your note. Still no address.
 *   - Only an **accepted** request shows each side the other's verified account
 *     email. That is the introduction; nothing is mailed by this module.
 *   - A decline is final for the pair, and the asker is never told it happened
 *     in so many words: a declined person simply stops being available.
 *
 * The rules themselves (`decideIntroRequest`, `nextIntroStatus`,
 * `rankIntroMatches`) are pure and live in `packages/domain/src/intros.ts`.
 * This file gathers current facts for them and re-gathers at accept time
 * rather than trusting what was true when the request was made.
 */

import { Hono } from 'hono';
import { introCardInputSchema, introRequestInputSchema } from '@outreachgraph/contracts';
import { now, queryAll, queryOne, type Client } from '@outreachgraph/db';
import {
  cleanIntroText,
  cleanIntroTopics,
  decideIntroRequest,
  effectiveIntroStatus,
  INTRO_DAILY_REQUEST_LIMIT,
  INTRO_LIMITS,
  INTRO_REQUEST_TTL_DAYS,
  isIntroStatus,
  missingForOpenIntroCard,
  newId,
  nextIntroStatus,
  rankIntroMatches,
  type IntroCard,
  type IntroDenial,
  type IntroMatch,
  type IntroResponse,
  type IntroStatus,
} from '@outreachgraph/domain';
import { ApiError, type AppEnv } from './context';
import * as repo from './repository';

const DAY_MS = 86_400_000;

/**
 * How many open cards one match call reads.
 *
 * Ranking happens in memory over the most recently updated cards. That is the
 * right trade while the pool is small; once it is not, this becomes an index
 * on terms rather than a larger number.
 */
const MATCH_POOL_LIMIT = 2_000;

export class IntroError extends Error {
  constructor(
    readonly code:
      | IntroDenial
      | 'no_user'
      | 'email_unverified'
      | 'card_incomplete'
      | 'not_found'
      | 'not_pending'
      | 'requester_left',
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'IntroError';
  }
}

/** A person's own card, including whether it is switched on. */
export interface OwnIntroCard {
  /** Absent until the card has been saved once. */
  readonly id: string | null;
  readonly open: boolean;
  readonly displayName: string;
  readonly headline: string;
  readonly lookingFor: string;
  readonly canOffer: string;
  readonly topics: readonly string[];
  readonly openedAt: string | null;
  readonly updatedAt: string | null;
}

export interface IntroRequestView {
  readonly id: string;
  readonly direction: 'incoming' | 'outgoing';
  readonly status: IntroStatus;
  readonly note: string;
  /** The other person's card as they wrote it. */
  readonly card: IntroCard;
  /** Present only once accepted: how to reach the other person. */
  readonly contact?: { readonly email: string };
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

interface CardRow {
  id: string;
  user_id: string;
  is_open: number | bigint;
  display_name: string;
  headline: string;
  looking_for: string;
  can_offer: string;
  topics: string;
  opened_at: string | null;
  updated_at: string;
}

// Each query is written out whole. Sharing a column list by interpolation
// would be shorter, and would also be the one shape of SQL in this file that a
// reader (or a scanner) has to stop and prove safe.
const CARD_BY_USER = `SELECT id, user_id, is_open, display_name, headline, looking_for,
    can_offer, topics, opened_at, updated_at
  FROM intro_cards WHERE user_id = ?`;

const CARD_BY_ID = `SELECT id, user_id, is_open, display_name, headline, looking_for,
    can_offer, topics, opened_at, updated_at
  FROM intro_cards WHERE id = ?`;

const OPEN_CARDS_EXCEPT = `SELECT id, user_id, is_open, display_name, headline, looking_for,
    can_offer, topics, opened_at, updated_at
  FROM intro_cards
  WHERE is_open = 1 AND user_id <> ?
  ORDER BY updated_at DESC LIMIT ?`;

function parseTopics(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    return cleanIntroTopics(JSON.parse(value));
  } catch {
    return [];
  }
}

function toCard(row: CardRow): IntroCard {
  return {
    id: row.id,
    displayName: row.display_name,
    headline: row.headline,
    lookingFor: row.looking_for,
    canOffer: row.can_offer,
    topics: parseTopics(row.topics),
  };
}

function isOpen(row: CardRow | undefined): boolean {
  return row !== undefined && Number(row.is_open) === 1;
}

async function cardRowForUser(db: Client, userId: string): Promise<CardRow | undefined> {
  return queryOne<CardRow>(db, CARD_BY_USER, [userId]);
}

/**
 * The person behind the caller, or a refusal.
 *
 * A service token with no `x-user-id` acts as `usr_service`, which has a users
 * row (migration 0077) but is nobody: an `.invalid` address and no
 * organization. Membership is what separates a person from a principal, so
 * that is what is checked. An intro is between two people.
 */
async function requireUser(
  db: Client,
  userId: string,
): Promise<{ email: string; verified: boolean }> {
  const user = await queryOne<{ email: string; email_verified_at: string | null }>(
    db,
    `SELECT u.email, u.email_verified_at FROM users u
      WHERE u.id = ? AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)`,
    [userId],
  );
  if (!user) {
    throw new IntroError('no_user', 'introductions belong to a person; this credential has none');
  }
  return { email: user.email, verified: Boolean(user.email_verified_at) };
}

export async function getOwnIntroCard(db: Client, userId: string): Promise<OwnIntroCard> {
  const row = await cardRowForUser(db, userId);
  if (!row) {
    return {
      id: null,
      open: false,
      displayName: '',
      headline: '',
      lookingFor: '',
      canOffer: '',
      topics: [],
      openedAt: null,
      updatedAt: null,
    };
  }
  return { ...toCard(row), open: isOpen(row), openedAt: row.opened_at, updatedAt: row.updated_at };
}

export interface IntroCardPatch {
  readonly open?: boolean | undefined;
  readonly displayName?: string | undefined;
  readonly headline?: string | undefined;
  readonly lookingFor?: string | undefined;
  readonly canOffer?: string | undefined;
  readonly topics?: readonly string[] | undefined;
}

/**
 * Saves the caller's card. Fields left out keep their value.
 *
 * Opening has two conditions beyond the text being there. The account's email
 * must be verified, because an accepted introduction hands that address to
 * another member and an unverified one may belong to somebody else entirely.
 * And the card must say who it is, what it wants and what it offers, because
 * anything less either matches nobody or asks a stranger to accept a blank.
 *
 * Closing always works, and closing is what makes the caller's own pending
 * requests unacceptable (see `respondToIntroRequest`).
 */
export async function saveOwnIntroCard(
  db: Client,
  userId: string,
  patch: IntroCardPatch,
): Promise<OwnIntroCard> {
  const user = await requireUser(db, userId);
  const existing = await cardRowForUser(db, userId);
  const current = existing ? toCard(existing) : undefined;

  const next = {
    displayName:
      patch.displayName === undefined
        ? (current?.displayName ?? '')
        : cleanIntroText(patch.displayName, INTRO_LIMITS.displayName),
    headline:
      patch.headline === undefined
        ? (current?.headline ?? '')
        : cleanIntroText(patch.headline, INTRO_LIMITS.headline),
    lookingFor:
      patch.lookingFor === undefined
        ? (current?.lookingFor ?? '')
        : cleanIntroText(patch.lookingFor, INTRO_LIMITS.lookingFor),
    canOffer:
      patch.canOffer === undefined
        ? (current?.canOffer ?? '')
        : cleanIntroText(patch.canOffer, INTRO_LIMITS.canOffer),
    topics: patch.topics === undefined ? (current?.topics ?? []) : cleanIntroTopics(patch.topics),
  };
  const open = patch.open ?? isOpen(existing);

  if (open) {
    if (!user.verified) {
      throw new IntroError(
        'email_unverified',
        'verify your email before opening your card: an accepted introduction shares it',
      );
    }
    const missing = missingForOpenIntroCard(next);
    if (missing.length > 0) {
      throw new IntroError('card_incomplete', `an open card needs ${missing.join(', ')}`, {
        missing,
      });
    }
  }

  const stamp = now();
  // Kept across a close and reopen only while open; a reopened card is newly opened.
  const openedAt = open ? (isOpen(existing) ? (existing?.opened_at ?? stamp) : stamp) : null;

  if (existing) {
    await db.execute({
      sql: `UPDATE intro_cards SET is_open = ?, display_name = ?, headline = ?, looking_for = ?,
              can_offer = ?, topics = ?, opened_at = ?, updated_at = ? WHERE id = ?`,
      args: [
        open ? 1 : 0,
        next.displayName,
        next.headline,
        next.lookingFor,
        next.canOffer,
        JSON.stringify(next.topics),
        openedAt,
        stamp,
        existing.id,
      ],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO intro_cards (id, user_id, is_open, display_name, headline, looking_for,
              can_offer, topics, opened_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        newId('introCard'),
        userId,
        open ? 1 : 0,
        next.displayName,
        next.headline,
        next.lookingFor,
        next.canOffer,
        JSON.stringify(next.topics),
        openedAt,
        stamp,
        stamp,
      ],
    });
  }

  return getOwnIntroCard(db, userId);
}

/** Marks the caller's stale pending rows so the stored status matches what is shown. */
async function expireStale(db: Client, userId: string, stamp: string): Promise<void> {
  await db.execute({
    sql: `UPDATE intro_requests SET status = 'expired', decided_at = ?
           WHERE status = 'pending' AND expires_at <= ?
             AND (requester_user_id = ? OR target_user_id = ?)`,
    args: [stamp, stamp, userId, userId],
  });
}

/** Users the caller may not be matched with or ask: a decline in either direction. */
async function blockedWith(db: Client, userId: string): Promise<Set<string>> {
  const rows = await queryAll<{ blocker_user_id: string; blocked_user_id: string }>(
    db,
    `SELECT blocker_user_id, blocked_user_id FROM intro_blocks
      WHERE blocker_user_id = ? OR blocked_user_id = ?`,
    [userId, userId],
  );
  return new Set(
    rows.map((row) => (row.blocker_user_id === userId ? row.blocked_user_id : row.blocker_user_id)),
  );
}

/** Users the caller already has a live or completed introduction with. */
async function linkedWith(db: Client, userId: string): Promise<Set<string>> {
  const rows = await queryAll<{ requester_user_id: string; target_user_id: string }>(
    db,
    `SELECT requester_user_id, target_user_id FROM intro_requests
      WHERE status IN ('pending', 'accepted')
        AND (requester_user_id = ? OR target_user_id = ?)`,
    [userId, userId],
  );
  return new Set(
    rows.map((row) =>
      row.requester_user_id === userId ? row.target_user_id : row.requester_user_id,
    ),
  );
}

/**
 * The people worth asking, best first, with the words that put them there.
 *
 * Leaves out anyone the caller could not ask anyway: a decline between the two
 * in either direction, or an introduction already open or made.
 */
export async function findIntroMatches(
  db: Client,
  userId: string,
  limit = 10,
): Promise<IntroMatch[]> {
  await requireUser(db, userId);
  const own = await cardRowForUser(db, userId);
  if (!own || !isOpen(own)) {
    throw new IntroError(
      'requester_not_open',
      'open your own card first: you can only see the pool from inside it',
    );
  }

  await expireStale(db, userId, now());
  const [blocked, linked] = await Promise.all([blockedWith(db, userId), linkedWith(db, userId)]);

  const rows = await queryAll<CardRow>(db, OPEN_CARDS_EXCEPT, [userId, MATCH_POOL_LIMIT]);
  const candidates = rows
    .filter((row) => !blocked.has(row.user_id) && !linked.has(row.user_id))
    .map(toCard);

  return rankIntroMatches(toCard(own), candidates, Math.min(Math.max(1, limit), 50));
}

interface RequestRow {
  id: string;
  requester_user_id: string;
  target_user_id: string;
  note: string;
  status: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

const REQUEST_FOR_PARTY = `SELECT id, requester_user_id, target_user_id, note, status,
    created_at, expires_at, decided_at
  FROM intro_requests
  WHERE id = ? AND (requester_user_id = ? OR target_user_id = ?)`;

const REQUESTS_INCOMING = `SELECT id, requester_user_id, target_user_id, note, status,
    created_at, expires_at, decided_at
  FROM intro_requests WHERE target_user_id = ?
  ORDER BY created_at DESC LIMIT 200`;

const REQUESTS_OUTGOING = `SELECT id, requester_user_id, target_user_id, note, status,
    created_at, expires_at, decided_at
  FROM intro_requests WHERE requester_user_id = ?
  ORDER BY created_at DESC LIMIT 200`;

const REQUESTS_EITHER = `SELECT id, requester_user_id, target_user_id, note, status,
    created_at, expires_at, decided_at
  FROM intro_requests WHERE requester_user_id = ? OR target_user_id = ?
  ORDER BY created_at DESC LIMIT 200`;

async function viewRequest(
  db: Client,
  row: RequestRow,
  userId: string,
  stamp: string,
): Promise<IntroRequestView | undefined> {
  const outgoing = row.requester_user_id === userId;
  const otherUserId = outgoing ? row.target_user_id : row.requester_user_id;
  const other = await cardRowForUser(db, otherUserId);
  // No card means no account behind the other side any more; nothing to show.
  if (!other) return undefined;

  const stored = isIntroStatus(row.status) ? row.status : 'expired';
  const status = effectiveIntroStatus(stored, row.expires_at, stamp);

  let contact: { email: string } | undefined;
  if (status === 'accepted') {
    const user = await queryOne<{ email: string }>(db, 'SELECT email FROM users WHERE id = ?', [
      otherUserId,
    ]);
    if (user) contact = { email: user.email };
  }

  return {
    id: row.id,
    direction: outgoing ? 'outgoing' : 'incoming',
    status,
    note: row.note,
    card: toCard(other),
    ...(contact ? { contact } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
  };
}

/** What the asker is told for each refusal. Two of them share a sentence on purpose. */
const DENIAL_MESSAGES: Record<IntroDenial, string> = {
  same_user: 'that is your own card',
  requester_not_open: 'open your own card before asking for an introduction',
  // Indistinguishable from a card that was never there: saying "they declined
  // you" is a disclosure the other person did not agree to.
  target_not_open: 'that card is not available',
  blocked: 'that card is not available',
  already_linked: 'you already have an introduction open or made with this person',
  note_required: 'say why you are asking: the note is what they decide on',
  daily_limit: `you can ask for ${INTRO_DAILY_REQUEST_LIMIT} introductions a day`,
};

/**
 * Opens a request from the caller to the owner of a card.
 *
 * The asker's consent is the act of asking. The other side's is still to come,
 * so nothing about them beyond their card is returned here.
 */
export async function requestIntro(
  db: Client,
  userId: string,
  input: { cardId: string; note: string },
): Promise<IntroRequestView> {
  await requireUser(db, userId);
  const stamp = now();
  await expireStale(db, userId, stamp);

  const note = cleanIntroText(input.note, INTRO_LIMITS.note);
  const own = await cardRowForUser(db, userId);
  const target = await queryOne<CardRow>(db, CARD_BY_ID, [input.cardId]);

  const [blocked, linked, recent] = await Promise.all([
    blockedWith(db, userId),
    linkedWith(db, userId),
    queryOne<{ n: number | bigint }>(
      db,
      // Every request counts, withdrawn ones included: withdrawing is not a way
      // to get the day's allowance back.
      'SELECT count(*) AS n FROM intro_requests WHERE requester_user_id = ? AND created_at > ?',
      [userId, new Date(Date.parse(stamp) - DAY_MS).toISOString()],
    ),
  ]);

  const decision = decideIntroRequest({
    sameUser: target?.user_id === userId,
    requesterOpen: isOpen(own),
    targetOpen: isOpen(target),
    blocked: target !== undefined && blocked.has(target.user_id),
    alreadyLinked: target !== undefined && linked.has(target.user_id),
    requestsInLastDay: Number(recent?.n ?? 0),
    noteLength: note.length,
  });

  if (!decision.allowed || !target) {
    const reason: IntroDenial = decision.allowed ? 'target_not_open' : decision.reason;
    throw new IntroError(reason, DENIAL_MESSAGES[reason]);
  }

  const id = newId('introRequest');
  const expiresAt = new Date(Date.parse(stamp) + INTRO_REQUEST_TTL_DAYS * DAY_MS).toISOString();
  await db.execute({
    sql: `INSERT INTO intro_requests (id, requester_user_id, target_user_id, note, status,
            created_at, expires_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    args: [id, userId, target.user_id, note, stamp, expiresAt],
  });

  return {
    id,
    direction: 'outgoing',
    status: 'pending',
    note,
    card: toCard(target),
    createdAt: stamp,
    expiresAt,
    decidedAt: null,
  };
}

/** The caller's requests, newest first. `box` narrows to one direction. */
export async function listIntroRequests(
  db: Client,
  userId: string,
  box?: 'incoming' | 'outgoing',
): Promise<IntroRequestView[]> {
  await requireUser(db, userId);
  const stamp = now();
  await expireStale(db, userId, stamp);

  const rows =
    box === 'incoming'
      ? await queryAll<RequestRow>(db, REQUESTS_INCOMING, [userId])
      : box === 'outgoing'
        ? await queryAll<RequestRow>(db, REQUESTS_OUTGOING, [userId])
        : await queryAll<RequestRow>(db, REQUESTS_EITHER, [userId, userId]);

  const views: IntroRequestView[] = [];
  for (const row of rows) {
    // A declined request stays pending-looking to the person who asked for as
    // long as it would have lived, then expires like any unanswered one.
    const view = await viewRequest(db, maskDecline(row, userId), userId, stamp);
    if (view) views.push(view);
  }
  return views;
}

/**
 * Hides a decline from the person who was declined.
 *
 * To the asker a declined request reads as still waiting until its expiry and
 * as expired after: the same thing an ignored request looks like. The decliner
 * sees it as declined.
 */
function maskDecline(row: RequestRow, viewerUserId: string): RequestRow {
  if (row.status !== 'declined' || row.requester_user_id !== viewerUserId) return row;
  return { ...row, status: 'pending', decided_at: null };
}

/**
 * Accepts, declines or withdraws a request.
 *
 * Nothing recorded when the request was made is trusted here. Acceptance reads
 * the asker's card again: somebody who has since closed it has left the pool,
 * and accepting would hand their address over after they withdrew consent.
 */
export async function respondToIntroRequest(
  db: Client,
  userId: string,
  requestId: string,
  response: IntroResponse,
): Promise<IntroRequestView> {
  await requireUser(db, userId);
  const stamp = now();
  await expireStale(db, userId, stamp);

  const row = await queryOne<RequestRow>(db, REQUEST_FOR_PARTY, [requestId, userId, userId]);
  // Somebody else's request is not found, not forbidden: its existence is not ours to confirm.
  if (!row) throw new IntroError('not_found', 'introduction request not found');

  const role = row.requester_user_id === userId ? 'requester' : 'target';
  const stored = isIntroStatus(row.status) ? row.status : 'expired';
  // The asker sees a declined request as still waiting (`maskDecline`), so a
  // withdrawal has to work on one or the refusal would be the announcement.
  // The block the decline left stays either way.
  const maskedWithdraw = stored === 'declined' && role === 'requester' && response === 'withdraw';
  const next = nextIntroStatus(maskedWithdraw ? 'pending' : stored, response, role);
  if (!next) throw new IntroError('not_pending', 'that request can no longer be changed');

  if (next === 'accepted') {
    const requesterCard = await cardRowForUser(db, row.requester_user_id);
    const blocked = await blockedWith(db, userId);
    if (!isOpen(requesterCard) || blocked.has(row.requester_user_id)) {
      throw new IntroError(
        'requester_left',
        'they are no longer open to introductions, so this one cannot be accepted',
      );
    }
  }

  const updated = await db.execute({
    sql: `UPDATE intro_requests SET status = ?, decided_at = ?
           WHERE id = ? AND status = ?`,
    args: [next, stamp, row.id, maskedWithdraw ? 'declined' : 'pending'],
  });
  if (updated.rowsAffected === 0) {
    throw new IntroError('not_pending', 'that request can no longer be changed');
  }

  if (next === 'declined') {
    await db.execute({
      sql: `INSERT INTO intro_blocks (blocker_user_id, blocked_user_id, created_at)
            VALUES (?, ?, ?) ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
      args: [userId, row.requester_user_id, stamp],
    });
  }

  const view = await viewRequest(db, { ...row, status: next, decided_at: stamp }, userId, stamp);
  if (!view) throw new IntroError('not_found', 'introduction request not found');
  return view;
}

function toApiError(error: unknown): never {
  if (!(error instanceof IntroError)) throw error;

  switch (error.code) {
    case 'no_user':
      throw ApiError.forbidden(error.message);
    case 'not_found':
    case 'target_not_open':
    case 'blocked':
      throw new ApiError(404, 'not_found', error.message);
    case 'daily_limit':
      throw new ApiError(429, 'rate_limited', error.message);
    case 'card_incomplete':
    case 'note_required':
    case 'same_user':
      throw ApiError.badRequest(error.message, error.details);
    default:
      throw ApiError.conflict(error.message);
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return undefined;
  }
}

const RESPONSES: Record<string, IntroResponse> = {
  accept: 'accept',
  decline: 'decline',
  withdraw: 'withdraw',
};

export function introRoutes(): Hono<AppEnv> {
  const router = new Hono<AppEnv>();

  router.get('/card', async (c) => {
    const actor = c.get('actor');
    return c.json({ card: await getOwnIntroCard(c.get('db'), actor.userId) });
  });

  router.put('/card', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    const parsed = introCardInputSchema.safeParse(safeJson(await c.req.raw.text()));
    if (!parsed.success) {
      throw ApiError.badRequest(`invalid card: ${parsed.error.issues[0]?.message ?? 'bad shape'}`);
    }

    const before = await getOwnIntroCard(db, actor.userId);
    const card = await saveOwnIntroCard(db, actor.userId, parsed.data).catch(toApiError);

    if (before.open !== card.open) {
      await repo.audit(db, {
        workspaceId: actor.workspaceId,
        actorKind: 'user',
        actorId: actor.userId,
        eventType: card.open ? 'intro.card_opened' : 'intro.card_closed',
        entityKind: 'intro_card',
        entityId: card.id ?? actor.userId,
        detail: {},
      });
    }

    return c.json({ card });
  });

  router.get('/matches', async (c) => {
    const actor = c.get('actor');
    const limit = Number(c.req.query('limit') ?? 10);
    const matches = await findIntroMatches(
      c.get('db'),
      actor.userId,
      Number.isFinite(limit) ? limit : 10,
    ).catch(toApiError);
    return c.json({ matches });
  });

  router.get('/requests', async (c) => {
    const actor = c.get('actor');
    const box = c.req.query('box');
    if (box !== undefined && box !== 'incoming' && box !== 'outgoing') {
      throw ApiError.badRequest('box is incoming or outgoing');
    }
    const requests = await listIntroRequests(c.get('db'), actor.userId, box).catch(toApiError);
    return c.json({ requests });
  });

  router.post('/requests', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    const parsed = introRequestInputSchema.safeParse(safeJson(await c.req.raw.text()));
    if (!parsed.success) {
      throw ApiError.badRequest(
        `invalid request: ${parsed.error.issues[0]?.message ?? 'bad shape'}`,
      );
    }

    let request: IntroRequestView;
    try {
      request = await requestIntro(db, actor.userId, parsed.data);
    } catch (error) {
      if (error instanceof IntroError) {
        // The log keeps the real reason; the caller gets the masked one.
        await repo.audit(db, {
          workspaceId: actor.workspaceId,
          actorKind: 'user',
          actorId: actor.userId,
          eventType: 'intro.request_refused',
          entityKind: 'intro_card',
          entityId: parsed.data.cardId,
          detail: { reason: error.code },
        });
      }
      return toApiError(error);
    }

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: 'intro.requested',
      entityKind: 'intro_request',
      entityId: request.id,
      detail: { via: actor.credential ?? 'session' },
    });

    return c.json({ request }, 201);
  });

  router.post('/requests/:id/:response', async (c) => {
    const actor = c.get('actor');
    const db = c.get('db');

    const response = RESPONSES[c.req.param('response')];
    if (!response) throw ApiError.notFound('route');

    const request = await respondToIntroRequest(
      db,
      actor.userId,
      c.req.param('id'),
      response,
    ).catch(toApiError);

    await repo.audit(db, {
      workspaceId: actor.workspaceId,
      actorKind: 'user',
      actorId: actor.userId,
      eventType: `intro.${request.status}`,
      entityKind: 'intro_request',
      entityId: request.id,
      detail: { via: actor.credential ?? 'session' },
    });

    return c.json({ request });
  });

  return router;
}
