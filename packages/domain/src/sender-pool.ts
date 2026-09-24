/**
 * Sender pools: several sending accounts per network, each warmed up and
 * capped on its own (the we-connect "account pooling" and "safe scaling"
 * features).
 *
 * A workspace used to own exactly one mailbox, one LinkedIn session and one X
 * account, and every daily limit in the product was really a limit on that one
 * account. That is the ceiling a growing team hits first: the only way to send
 * more was to push a single identity harder, which is precisely the pattern
 * mail providers and both social networks punish. Pooling raises the ceiling
 * the safe way — more identities, each kept at a volume it has earned.
 *
 * Everything in this file is a pure function of its arguments. The pipeline
 * reads the rows and the counts; this decides what they mean. That split is
 * what lets the ramp, the choice of sender and the health rule be tested
 * exhaustively without a database, and it keeps the decision deterministic in
 * the same sense the policy engine is: the same inputs always pick the same
 * account, so a surprising send can be replayed and explained.
 */

/** The networks that send through a pool. Bluesky stays one account for now. */
export const SENDER_NETWORKS = ['email', 'linkedin', 'x'] as const;
export type SenderNetwork = (typeof SENDER_NETWORKS)[number];

export function isSenderNetwork(network: string): network is SenderNetwork {
  return (SENDER_NETWORKS as readonly string[]).includes(network);
}

/**
 * An account's standing.
 *
 *   - `active`: may be chosen.
 *   - `paused`: a human stopped it. Temporary by definition, so a conversation
 *     already running on it waits for it rather than moving elsewhere.
 *   - `error`: the product stopped it — a rejected login, or bounces over the
 *     threshold. Needs a human to look, then resume or reconnect.
 *   - `revoked`: the provider signed the credential out. Only a reconnect
 *     brings it back.
 */
export const SENDER_STATUSES = ['active', 'paused', 'error', 'revoked'] as const;
export type SenderStatus = (typeof SENDER_STATUSES)[number];

/**
 * What one account may send in a day when nobody has set a number.
 *
 * LinkedIn and X match the pacing the single-account scheduler has always
 * used, so a workspace with one account there sees exactly the limit it had.
 * Email's 50 matches the campaign default `maxActionsPerDay`; the migration
 * that introduced pools raised it for any existing mailbox whose workspace
 * was configured to send more, so no upgrade tightened anyone's limit.
 */
export const DEFAULT_DAILY_CAP: Readonly<Record<SenderNetwork, number>> = {
  email: 50,
  linkedin: 25,
  x: 20,
};

/**
 * The warm-up ramp: what a new account may send on its first day, and how
 * much more each day after.
 *
 * Linear and slow on purpose. A new mailbox that goes from nothing to fifty a
 * day is the textbook shape of a compromised or purchased account, and the
 * provider's filters learn its reputation from those first weeks. Email
 * reaches the default cap of 50 on day 15; LinkedIn reaches 25 on day 10.
 */
export const WARMUP_RAMP: Readonly<Record<SenderNetwork, { start: number; step: number }>> = {
  email: { start: 5, step: 3 },
  linkedin: { start: 5, step: 2 },
  x: { start: 5, step: 2 },
};

const DAY_MS = 86_400_000;

/**
 * Which day of warm-up `at` falls on: 0 on the day it started, 1 the next.
 *
 * Counted in UTC calendar days rather than elapsed 24-hour periods, because
 * the caps it feeds are per UTC day too. An account started at 23:00 moves to
 * day 1 an hour later, which is the conservative direction: day 0's allowance
 * was mostly unusable anyway. A start in the future reads as day 0.
 */
export function warmupDay(startedAt: string, at: Date): number {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return 0;
  const startDay = Math.floor(start / DAY_MS);
  const today = Math.floor(at.getTime() / DAY_MS);
  return Math.max(0, today - startDay);
}

/** The ramp's allowance on a given day of warm-up, before any configured cap. */
export function warmupCap(network: SenderNetwork, day: number): number {
  const ramp = WARMUP_RAMP[network];
  return ramp.start + ramp.step * Math.max(0, Math.floor(day));
}

export interface SenderCapInput {
  readonly network: SenderNetwork;
  readonly status: string;
  /** NULL means the network default. */
  readonly dailyCap: number | null;
  readonly warmupEnabled: boolean;
  readonly warmupStartedAt: string | null;
}

/** The cap the account is working towards: what was set, or the default. */
export function configuredCap(input: Pick<SenderCapInput, 'network' | 'dailyCap'>): number {
  const cap = input.dailyCap;
  return typeof cap === 'number' && Number.isFinite(cap) && cap >= 0
    ? Math.floor(cap)
    : DEFAULT_DAILY_CAP[input.network];
}

/**
 * What the account may send on the day `at` falls on.
 *
 * `min(configured, ramp(day))` while warming up, the configured cap after,
 * and zero for anything that is not `active` — a paused account has no
 * capacity, which is simpler for every caller than a second check.
 */
export function effectiveDailyCap(input: SenderCapInput, at: Date): number {
  if (input.status !== 'active') return 0;
  const cap = configuredCap(input);
  if (!input.warmupEnabled || !input.warmupStartedAt) return cap;
  return Math.min(cap, warmupCap(input.network, warmupDay(input.warmupStartedAt, at)));
}

/** True once the ramp no longer binds, so the UI can stop showing progress. */
export function warmupComplete(input: SenderCapInput, at: Date): boolean {
  if (!input.warmupEnabled || !input.warmupStartedAt) return true;
  return warmupCap(input.network, warmupDay(input.warmupStartedAt, at)) >= configuredCap(input);
}

// ------------------------------------------------------------------ choice

export interface PoolCandidate {
  readonly id: string;
  readonly status: string;
  /** From `effectiveDailyCap`, for today. */
  readonly effectiveCap: number;
  readonly sentToday: number;
  /** When it last sent anything, for the round-robin tie-break. */
  readonly lastUsedAt: string | null;
}

export type PoolChoice =
  | { readonly kind: 'picked'; readonly id: string; readonly reason: 'continuity' | 'capacity' }
  /** No account can send at all. The caller keeps its pre-pool behaviour. */
  | { readonly kind: 'none_active' }
  /** Accounts exist but none may send this one today. Try again later. */
  | {
      readonly kind: 'deferred';
      readonly reason: 'all_capped' | 'continuity_capped' | 'continuity_paused';
      /** The account the conversation belongs to, when that is the reason. */
      readonly id?: string;
    };

/**
 * Picks the account one action goes out from.
 *
 * Continuity first. The account that last wrote to this person keeps the
 * conversation: a follow-up from a different mailbox arrives as a stranger's
 * first message, breaks the thread, and doubles the number of our addresses
 * the prospect has seen. So when that account is merely full today, or
 * paused by a human, the action waits for it rather than moving. Only when it
 * is gone for good — in error, revoked or removed — does the person move to
 * another account, because waiting would then mean never.
 *
 * Otherwise capacity: the active account with the most room left today, so
 * the pool drains evenly and a new, warming account is not hammered to its
 * cap while an established one idles. Ties go to the account used least
 * recently, then to the lowest id — a round robin that needs no counter,
 * because "last used" already is one.
 */
export function choosePoolSender(
  candidates: readonly PoolCandidate[],
  stickyId?: string | null,
): PoolChoice {
  if (stickyId) {
    const sticky = candidates.find((candidate) => candidate.id === stickyId);
    if (sticky?.status === 'active') {
      return sticky.sentToday < sticky.effectiveCap
        ? { kind: 'picked', id: sticky.id, reason: 'continuity' }
        : { kind: 'deferred', reason: 'continuity_capped', id: sticky.id };
    }
    if (sticky?.status === 'paused') {
      return { kind: 'deferred', reason: 'continuity_paused', id: sticky.id };
    }
    // In error, revoked or deleted: fall through and reassign.
  }

  const active = candidates.filter((candidate) => candidate.status === 'active');
  if (active.length === 0) return { kind: 'none_active' };

  const open = active.filter((candidate) => candidate.sentToday < candidate.effectiveCap);
  if (open.length === 0) return { kind: 'deferred', reason: 'all_capped' };

  const best = [...open].sort(compareForCapacity)[0]!;
  return { kind: 'picked', id: best.id, reason: 'capacity' };
}

function compareForCapacity(a: PoolCandidate, b: PoolCandidate): number {
  const room = b.effectiveCap - b.sentToday - (a.effectiveCap - a.sentToday);
  if (room !== 0) return room;
  // Never used sorts first: a brand-new account has the oldest possible claim.
  const lastA = a.lastUsedAt ?? '';
  const lastB = b.lastUsedAt ?? '';
  if (lastA !== lastB) return lastA < lastB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The start of the UTC day after `at` — when a capped pool has room again. */
export function nextUtcDay(at: Date): Date {
  return new Date((Math.floor(at.getTime() / DAY_MS) + 1) * DAY_MS);
}

// ------------------------------------------------------------------ health

/** Sends the bounce rate is measured over. */
export const BOUNCE_WINDOW = 100;

/** Above this share of bounced sends, the account stops. */
export const BOUNCE_THRESHOLD = 0.05;

/**
 * The smallest denominator the rate is ever taken over.
 *
 * Without it one bounce on an account's first send reads as a 100% bounce
 * rate and stops a perfectly good mailbox on its first morning. With it, two
 * bounces in the first twenty sends — 10%, a genuinely bad list — still stop
 * it, which is the case the rule exists for.
 */
export const BOUNCE_MIN_SAMPLE = 20;

/**
 * True when an account's recent bounces say it should stop sending.
 *
 * `sends` is how many of the last `BOUNCE_WINDOW` sends it made (at most
 * 100), `bounces` how many bounces arrived over the same stretch. Mail
 * providers start throttling and junking a sender somewhere past 2–5%;
 * stopping at 5% keeps the account on the right side of that line while the
 * list that caused it gets cleaned.
 */
export function bounceRateExceeded(sends: number, bounces: number): boolean {
  if (bounces <= 0) return false;
  const denominator = Math.max(Math.min(sends, BOUNCE_WINDOW), BOUNCE_MIN_SAMPLE);
  return bounces / denominator > BOUNCE_THRESHOLD;
}

/**
 * A provider refusing the account's own credential.
 *
 * Retrying that is pointless and, repeated, is what gets a mailbox locked for
 * suspicious logins — so it stops the account at once rather than counting
 * towards anything. Matched on the SMTP reply codes and the phrasings the big
 * providers use, since the transport hands us text.
 */
export function isAuthFailure(message: string): boolean {
  return /\((?:530|534|535)\)|\b(?:530|534|535)[ -]|EAUTH|invalid login|authentication (?:failed|unsuccessful|credentials invalid)|username and password not accepted|bad credentials/i.test(
    message,
  );
}

/**
 * A recipient the provider refused outright — a synchronous hard bounce.
 *
 * Counted towards the bounce rate exactly like one that arrives later in the
 * inbox: to the receiving side they are the same event, and a sender that
 * keeps writing to addresses that do not exist is judged the same either way.
 */
export function isRecipientBounce(message: string): boolean {
  return /\((?:550|551|553|554)\)|\b5\.1\.\d\b|user unknown|no such user|unknown user|mailbox (?:unavailable|not found|does not exist)|recipient (?:address )?rejected|address rejected|does not exist/i.test(
    message,
  );
}
