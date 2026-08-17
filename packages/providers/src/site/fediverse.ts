/**
 * Recognising Fediverse accounts, which no host list can enumerate.
 *
 * Every other network in `NETWORK_HOSTS` is one company on a handful of
 * domains, so a regex over the hostname settles it. Mastodon has thousands of
 * independent instances and anyone can start another one this afternoon, so
 * the only durable signals are the URL's *shape* and, when it matters, asking
 * the host itself.
 *
 * Shape alone is not enough to store an identity. `/@name` is also how YouTube,
 * Medium and TikTok address their users, and a junk identity is worse than a
 * missing one (see `NOT_HANDLES` in `extract.ts` for the same argument). So
 * this module separates two questions:
 *
 *   - `parseFediverseUrl` — could this be a Fediverse account, and if so which?
 *     Pure, no network, safe to run over every link on a page.
 *   - `verifyFediverseAccount` — does that account actually exist there?
 *     One WebFinger request, which is the protocol's own answer to exactly
 *     this question.
 *
 * The pipeline uses the first to find candidates and the second before
 * treating one as a fact.
 */

import type { FetchLike } from './fetch';
import { USER_AGENT } from './fetch';

/** A Fediverse account, normalised to the form its own server would use. */
export interface FediverseAccount {
  /** The local part, without any leading `@`. */
  readonly user: string;
  /** The host that actually hosts the account — not necessarily the URL's. */
  readonly host: string;
  /** `user@host`, the canonical cross-instance address. */
  readonly acct: string;
  /** The account's own instance profile URL. */
  readonly profileUrl: string;
  /**
   * Set when the link we found was a *different* instance's view of the
   * account, e.g. `defcon.social/@b0rk@jvns.ca`. Kept because it is evidence
   * about where the link was published, and dropped from `acct` because it is
   * not part of the account's identity.
   */
  readonly viewedVia?: string;
}

/**
 * Hosts that use `/@name` for their own users and are not Fediverse servers.
 *
 * These are the false positives that matter, because each one is popular
 * enough to appear in an ordinary site footer. `youtube.com` is caught earlier
 * by the known-network host map, but is listed anyway so this function is
 * correct when called on its own.
 */
const NOT_FEDIVERSE = /(^|\.)(medium\.com|youtube\.com|tiktok\.com|substack\.com)$/i;

/** Local parts are conservative on purpose; instances vary, junk does not. */
const LOCAL_PART = /^[a-z0-9_](?:[a-z0-9_.-]{0,61}[a-z0-9_])?$/i;

/** A hostname with at least one dot and no credentials, port or path. */
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

function isPlausibleAccount(user: string, host: string): boolean {
  return LOCAL_PART.test(user) && HOSTNAME.test(host);
}

function build(user: string, host: string, viewedVia?: string): FediverseAccount {
  const normalisedHost = host.toLowerCase();
  return {
    user,
    host: normalisedHost,
    acct: `${user}@${normalisedHost}`,
    profileUrl: `https://${normalisedHost}/@${user}`,
    ...(viewedVia && viewedVia.toLowerCase() !== normalisedHost
      ? { viewedVia: viewedVia.toLowerCase() }
      : {}),
  };
}

/**
 * Parses a bare address such as `@b0rk@jvns.ca` or `b0rk@jvns.ca`.
 *
 * Returns nothing for a plain email address shape it cannot distinguish — that
 * is deliberate. `someone@example.com` in a page's contact block is far more
 * likely to be email than a Fediverse handle, and `extract.ts` already has a
 * path for addresses. Only the leading `@`, which is unambiguous, is accepted.
 */
export function parseFediverseHandle(raw: string): FediverseAccount | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('@')) return undefined;

  const parts = trimmed.slice(1).split('@');
  if (parts.length !== 2) return undefined;

  const [user, host] = parts;
  if (!user || !host) return undefined;
  if (!isPlausibleAccount(user, host)) return undefined;
  if (NOT_FEDIVERSE.test(host)) return undefined;

  return build(user, host);
}

/**
 * Parses a profile URL into the account it points at.
 *
 * The case worth naming is the remote view. `https://defcon.social/@b0rk@jvns.ca`
 * is defcon.social rendering an account that lives on `jvns.ca`; keying off the
 * URL's hostname would file it under the wrong server, and every later lookup —
 * WebFinger, profile fetch, reply — would go to a host that does not own the
 * account. The address in the path wins over the host serving the page.
 */
export function parseFediverseUrl(url: string): FediverseAccount | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;

  const viewingHost = parsed.hostname.replace(/^www\./, '');
  if (NOT_FEDIVERSE.test(viewingHost)) return undefined;

  const segments = parsed.pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (!first) return undefined;

  // `/@user` and `/@user@host` — the form instances link to each other with.
  if (first.startsWith('@')) {
    const remote = parseFediverseHandle(first);
    if (remote) return build(remote.user, remote.host, viewingHost);

    const user = first.slice(1);
    if (!user || !isPlausibleAccount(user, viewingHost)) return undefined;
    return build(user, viewingHost);
  }

  // `/users/name` is Mastodon's canonical actor URL, which is what `sameAs`
  // and ActivityPub payloads carry even when the human-facing link is `/@name`.
  if (/^users$/i.test(first)) {
    const user = segments[1];
    if (!user || !isPlausibleAccount(user, viewingHost)) return undefined;
    return build(user, viewingHost);
  }

  return undefined;
}

export interface VerifyOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

/** What the account's own server said about it. */
export interface VerifiedFediverseAccount extends FediverseAccount {
  /** The `rel="self"` ActivityPub actor, when the server published one. */
  readonly actorUrl?: string;
}

const WEBFINGER_TIMEOUT_MS = 8_000;

interface WebfingerLink {
  readonly rel?: unknown;
  readonly type?: unknown;
  readonly href?: unknown;
}

interface WebfingerResponse {
  readonly subject?: unknown;
  readonly links?: unknown;
}

/**
 * Asks the account's own host whether the account exists (RFC 7033).
 *
 * This is the precision half. A shape match says "this looks like a Fediverse
 * profile"; a WebFinger hit says the server that would receive our reply
 * agrees the account is there. Anything short of a clean answer returns
 * `undefined`, because an unreachable or unparseable host is not evidence of
 * an account — it is an absence of evidence, and the identity resolver treats
 * those differently.
 */
export async function verifyFediverseAccount(
  account: FediverseAccount,
  options: VerifyOptions = {},
): Promise<VerifiedFediverseAccount | undefined> {
  const call = options.fetchImpl ?? fetch;
  const endpoint = new URL(`https://${account.host}/.well-known/webfinger`);
  endpoint.searchParams.set('resource', `acct:${account.acct}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WEBFINGER_TIMEOUT_MS);

  try {
    const response = await call(endpoint.toString(), {
      headers: {
        accept: 'application/jrd+json, application/json',
        'user-agent': options.userAgent ?? USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });

    if (!response.ok) return undefined;

    const body = (await response.json()) as WebfingerResponse;
    const subject = typeof body.subject === 'string' ? body.subject : undefined;

    // A server that answers about a *different* account has told us the link
    // was wrong, so the shape match does not survive it.
    if (subject && subject.toLowerCase() !== `acct:${account.acct}`.toLowerCase()) {
      return undefined;
    }

    const links: WebfingerLink[] = Array.isArray(body.links) ? (body.links as WebfingerLink[]) : [];
    const self = links.find(
      (link) => link.rel === 'self' && typeof link.href === 'string' && isActivityJson(link.type),
    );

    // No ActivityPub actor means whatever answered is not a Fediverse server.
    if (!self || typeof self.href !== 'string') return undefined;

    return { ...account, actorUrl: self.href };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function isActivityJson(type: unknown): boolean {
  return typeof type === 'string' && /application\/activity\+json|ld\+json/i.test(type);
}
