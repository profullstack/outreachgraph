/**
 * Link tracking, as arithmetic (PRD §12.5).
 *
 * Everything here is pure so the same rules run in the sender (rewriting a
 * body on its way out), in the API (deciding whether a hit was a person), and
 * in tests, without a database or a clock between them.
 *
 * The honest-measurement rule from `receive-email.ts` applies again, and for
 * the same reason: the two ways this can be wrong are not symmetric. Missing a
 * click understates warmth, which a reply will correct. Inventing one from a
 * mail scanner's prefetch tells a user that a prospect is interested when they
 * have not read the message, and nobody ever goes looking for the enthusiasm
 * that was not real.
 */

/**
 * URLs in a plain-text body.
 *
 * Deliberately only `http(s)://…` with an explicit scheme. Bare `example.com`
 * is common in prose ("we looked at stripe.com and ...") and rewriting it
 * would turn a sentence into a link the writer never wrote.
 */
const URL_PATTERN = /https?:\/\/[^\s<>[\]{}"'`]+/g;

/**
 * Characters that are legal in a URL but are almost always sentence
 * punctuation when they end one in prose: "see https://x.dev/docs." should
 * link to `/docs`, not `/docs.`.
 *
 * `)` is not trimmed unconditionally — a balanced pair inside the URL is real
 * (Wikipedia-style paths), so it is only trimmed when unmatched.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/;

export function extractUrls(text: string): readonly string[] {
  const found = text.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const raw of found) {
    const url = trimTrailing(raw);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }

  return urls;
}

function trimTrailing(raw: string): string {
  let url = raw.replace(TRAILING_PUNCTUATION, '');

  // Trim only closing parens the URL does not open itself.
  while (url.endsWith(')')) {
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (opens >= closes) break;
    url = url.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }

  return url;
}

/**
 * Replaces every URL in `text` with whatever `replace` returns for it.
 *
 * Returning `undefined` leaves that URL alone, which is how a caller declines
 * to track a link it could not persist rather than dropping it from the body.
 * A rewrite that silently deleted a link would ship a message whose sentence
 * no longer makes sense.
 */
export function rewriteUrls(
  text: string,
  replace: (url: string) => string | undefined,
): { readonly text: string; readonly rewritten: number } {
  let rewritten = 0;

  const out = text.replace(URL_PATTERN, (match) => {
    const url = trimTrailing(match);
    const tail = match.slice(url.length);
    const replacement = replace(url);
    if (replacement === undefined) return match;
    rewritten += 1;
    return `${replacement}${tail}`;
  });

  return { text: out, rewritten };
}

/** Why a hit on a tracked link was not counted as a human click. */
export type AutomatedFetch = 'bot' | 'prefetch';

/**
 * Self-identifying non-humans.
 *
 * Matching on the user agent catches the polite half of the traffic. The
 * impolite half is what the timing rule below is for, and neither is
 * exhaustive — the goal is to be wrong in the direction that understates
 * engagement.
 */
const BOT_AGENTS = [
  'bot',
  'crawler',
  'spider',
  'preview',
  'proofpoint',
  'barracuda',
  'mimecast',
  'symantec',
  'microsoft office',
  'ms-office',
  'bingpreview',
  'slackbot',
  'discordbot',
  'whatsapp',
  'telegrambot',
  'curl/',
  'wget/',
  'python-requests',
  'go-http-client',
  'headlesschrome',
];

/**
 * A fetch this soon after delivery was made by whatever received the message,
 * not by whoever reads it. Scanners resolve links as part of accepting mail;
 * people take at least a moment to open an inbox.
 */
export const PREFETCH_WINDOW_SECONDS = 10;

export interface FetchContext {
  readonly userAgent?: string | undefined;
  /** When the message carrying this link was sent. */
  readonly sentAt?: Date | undefined;
  readonly fetchedAt: Date;
}

export function classifyFetch(context: FetchContext): AutomatedFetch | undefined {
  const agent = context.userAgent?.toLowerCase() ?? '';

  // An empty user agent is not evidence either way. Plenty of privacy-minded
  // clients strip it, and refusing to count those people would quietly bias
  // the metric against exactly the audience this product sells to.
  if (agent && BOT_AGENTS.some((needle) => agent.includes(needle))) return 'bot';

  const sentAt = context.sentAt;
  if (sentAt) {
    const elapsed = (context.fetchedAt.getTime() - sentAt.getTime()) / 1000;
    if (elapsed >= 0 && elapsed < PREFETCH_WINDOW_SECONDS) return 'prefetch';
  }

  return undefined;
}

/**
 * The public URL a tracked link resolves from.
 *
 * Kept here so the sender and the redirect handler cannot disagree about the
 * path, which would produce links that are dead the moment they are clicked.
 */
export function trackedLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/t/${token}`;
}
