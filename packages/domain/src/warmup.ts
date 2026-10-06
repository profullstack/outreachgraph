/**
 * The warm-up network: mailboxes that write to each other so providers see
 * mail from them being opened, rescued from spam and answered.
 *
 * Pure functions only. The pipeline reads the rows, opens the sockets and
 * passes the randomness in, so every choice here is reproducible in a test.
 *
 * Two things about the mail itself:
 *
 *   - **It reads like people.** Short notes and short answers built from a
 *     few hundred combinations, never a template a filter can fingerprint by
 *     its first line.
 *   - **It is easy to throw away.** Every message carries an
 *     `X-OG-Warmup` header (the network finds its own mail by it) and, on its
 *     last line, the RECIPIENT's tag: one word its owner can filter on in a
 *     mail client that never sees the header, such as Gmail behind a forward.
 */

export const WARMUP_HEADER = 'X-OG-Warmup';

/** Daily warm-up volume per mailbox: starts small, climbs, then holds. */
export const WARMUP_NETWORK_RAMP = { start: 2, step: 2, max: 20 } as const;

/** Waking hours the sends are spread over, so nothing goes out as a burst. */
const SEND_WINDOW_MS = 16 * 3_600_000;

/** Of the messages a mailbox receives, how many it answers, by thread depth. */
const REPLY_RATE: readonly number[] = [0.45, 0.25];

const DAY_MS = 86_400_000;

/** How many warm-up messages a mailbox may send on its `day`-th day in the network. */
export function warmupNetworkTarget(day: number): number {
  const { start, step, max } = WARMUP_NETWORK_RAMP;
  return Math.min(max, start + step * Math.max(0, Math.floor(day)));
}

/** UTC calendar days since joining, 0 on the day it joined. */
export function warmupNetworkDay(startedAt: string, at: Date): number {
  const start = Date.UTC(
    new Date(startedAt).getUTCFullYear(),
    new Date(startedAt).getUTCMonth(),
    new Date(startedAt).getUTCDate(),
  );
  const today = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return Math.max(0, Math.round((today - start) / DAY_MS));
}

/**
 * Whether a mailbox should send its next warm-up message now.
 *
 * The day's allowance is spread across the waking window: the gap after each
 * send is the window divided by the target, jittered by `random` (0..1) so
 * the sends do not tick like a clock.
 */
export function warmupSendDue(input: {
  readonly sentToday: number;
  readonly target: number;
  readonly lastSentAt: string | null;
  readonly at: Date;
  readonly random: number;
}): boolean {
  if (input.sentToday >= input.target) return false;
  if (!input.lastSentAt) return true;
  const gap = (SEND_WINDOW_MS / Math.max(1, input.target)) * (0.6 + 0.8 * input.random);
  return input.at.getTime() - new Date(input.lastSentAt).getTime() >= gap;
}

export interface WarmupPeer {
  readonly id: string;
  readonly email: string;
  /** Messages this sender has sent the peer today. */
  readonly sentToPeerToday: number;
}

/**
 * Who to write to: never yourself, preferably another domain (mail between
 * two addresses on one domain teaches a provider little), and whoever this
 * sender has written to least today. `random` breaks ties.
 */
export function pickWarmupPeer(
  self: { readonly id: string; readonly email: string },
  peers: readonly WarmupPeer[],
  random: number,
): WarmupPeer | undefined {
  const others = peers.filter((peer) => peer.id !== self.id && peer.email !== self.email);
  if (others.length === 0) return undefined;
  const domain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  const foreign = others.filter((peer) => domain(peer.email) !== domain(self.email));
  const pool = foreign.length > 0 ? foreign : others;
  const least = Math.min(...pool.map((peer) => peer.sentToPeerToday));
  const tied = pool.filter((peer) => peer.sentToPeerToday === least);
  return tied[Math.min(tied.length - 1, Math.floor(random * tied.length))];
}

/** Whether to answer a received warm-up message at this depth. */
export function warmupShouldReply(depth: number, random: number): boolean {
  const rate = REPLY_RATE[depth];
  return rate !== undefined && random < rate;
}

/**
 * A mailbox's filter tag: `og` plus six letters and digits, from `random`.
 * Short enough to type into a filter, odd enough never to occur by accident.
 */
export function newWarmupTag(random: () => number): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let tag = 'og';
  for (let i = 0; i < 6; i += 1) tag += alphabet[Math.floor(random() * alphabet.length)];
  return tag;
}

/** The Gmail "Has the words" filter that catches one mailbox's warm-up mail. */
export function warmupGmailFilter(tag: string): string {
  return `"${tag}"`;
}

// ------------------------------------------------------------------ content

const OPENERS = ['Hi', 'Hey', 'Hello', 'Morning', 'Hi there', 'Hey there'];
const TOPICS = [
  'the notes from last week',
  'the timeline we talked about',
  'the draft you sent over',
  'next quarter',
  'the call on Thursday',
  'the budget sheet',
  'the new onboarding flow',
  'the vendor shortlist',
  'the launch checklist',
  'the pricing page',
];
const ASKS = [
  'Could you take a quick look when you have a minute?',
  'Does that still work on your side?',
  'Let me know if anything looks off.',
  'Happy to jump on a call if that is easier.',
  'No rush, whenever you get a chance.',
  'Want me to send the updated version?',
];
const LEADS = [
  'Just following up on',
  'Quick question about',
  'Wanted to check in on',
  'I had another look at',
  'Circling back on',
  'A thought on',
];
const SUBJECTS = [
  'Quick question',
  'Following up',
  'Checking in',
  'Re: next steps',
  'Thoughts?',
  'Small update',
  'One more thing',
  'Catching up',
];
const REPLIES = [
  'Thanks, that works for me.',
  'Got it, I will take a look today.',
  'Sounds good. Talk soon.',
  'Appreciate it, thanks for sending.',
  'Yes, Thursday is fine.',
  'Makes sense. Let us keep it as is.',
  'Perfect, thank you.',
];
const SIGNOFFS = ['Thanks', 'Best', 'Cheers', 'Talk soon', 'Thanks again'];

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)] ?? list[0]!;
}

function firstName(name: string | null | undefined): string {
  const first = name?.trim().split(/\s+/)[0];
  return first && /^[\p{L}'-]{2,}$/u.test(first) ? first : '';
}

export interface WarmupContent {
  readonly subject: string;
  readonly text: string;
}

/** A first message. `recipientTag` ends it on its own line. */
export function composeWarmup(input: {
  readonly recipientName?: string | null;
  readonly senderName?: string | null;
  readonly recipientTag: string;
  readonly random: () => number;
}): WarmupContent {
  const r = input.random;
  const greeting = [pick(OPENERS, r), firstName(input.recipientName)].filter(Boolean).join(' ');
  const signer = firstName(input.senderName);
  const body = [
    `${greeting},`,
    '',
    `${pick(LEADS, r)} ${pick(TOPICS, r)}. ${pick(ASKS, r)}`,
    '',
    signer ? `${pick(SIGNOFFS, r)},\n${signer}` : pick(SIGNOFFS, r),
    '',
    input.recipientTag,
  ].join('\n');
  return { subject: pick(SUBJECTS, r), text: body };
}

/** An answer in the same thread. */
export function composeWarmupReply(input: {
  readonly subject: string;
  readonly senderName?: string | null;
  readonly recipientTag: string;
  readonly random: () => number;
}): WarmupContent {
  const signer = firstName(input.senderName);
  const subject = /^re:/i.test(input.subject) ? input.subject : `Re: ${input.subject}`;
  const text = [
    pick(REPLIES, input.random),
    '',
    signer || pick(SIGNOFFS, input.random),
    '',
    input.recipientTag,
  ].join('\n');
  return { subject, text };
}

/** Share of received warm-up mail that landed in the inbox, 0..1, or null with none. */
export function inboxPlacement(inbox: number, spam: number): number | null {
  const total = inbox + spam;
  return total === 0 ? null : inbox / total;
}
