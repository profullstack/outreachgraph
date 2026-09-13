/**
 * OpenProfile.md, assembled from a person's public profiles.
 *
 * OpenProfile (https://logicsrc.com/openprofile) is one Markdown file that
 * says who somebody is and where they are: a name, an identity block, one
 * headline, and an Accounts section whose bullets are the URLs that are them.
 * A person who serves their own at `/.well-known/openprofile.md` is the
 * authority and we keep their file. For everyone else this module builds one
 * from three places, in order of how much each is allowed to say:
 *
 *   1. The network's public API for the profile we were handed (Bluesky,
 *      Mastodon). Display name, bio, avatar, and the links the person put in
 *      their own profile.
 *   2. The site those links point at: its OpenGraph tags, and every `rel="me"`
 *      link on it. A `rel="me"` back to the profile is the person confirming,
 *      on a page they control, that the profile is theirs.
 *   3. The profile page's own OpenGraph tags, for networks with no public API.
 *
 * Everything here is pure over strings and JSON except the two readers that
 * take a `fetchImpl`, so a test can hand in pages and never touch the network.
 */

import { anchors, collapse, decodeEntities, isRelMe, metaContent, networkForUrl } from './extract';
import { parseFediverseHandle, parseFediverseUrl } from './fediverse';
import type { FetchLike } from './fetch';
import { USER_AGENT } from './fetch';
import type { Network } from '@outreachgraph/domain';

/** One account the profile names, with how sure we are it is the same person. */
export interface ProfileAccount {
  readonly url: string;
  /** Which network the URL belongs to, when it is one we know. */
  readonly network?: Network | undefined;
  /** `me` when the page marked it rel=me or the network verified it; `link` otherwise. */
  readonly relation: 'me' | 'link';
  /** What to call it: "Bluesky", "GitHub", or the site's host for a plain link. */
  readonly label: string;
}

/** What one source said about the person. */
export interface ProfileFacts {
  readonly source: string;
  readonly name?: string | undefined;
  readonly headline?: string | undefined;
  readonly avatar?: string | undefined;
  /** The home page the profile names, when it names one. */
  readonly web?: string | undefined;
  readonly accounts: readonly ProfileAccount[];
  /** `#tags` and comma topics the bio carried, lower-cased, deduplicated. */
  readonly topics: readonly string[];
  /** A network-native stable id, such as a Bluesky DID. */
  readonly platformUserId?: string | undefined;
  /** Set when the page linked or served an OpenProfile.md of its own. */
  readonly openprofileUrl?: string | undefined;
}

/** What the builder needs, after every source has been merged. */
export interface ProfileInput {
  readonly name: string;
  readonly handle: string;
  readonly kind?: 'person' | 'agent' | 'organization';
  readonly headline?: string | undefined;
  readonly web?: string | undefined;
  readonly avatar?: string | undefined;
  readonly email?: string | undefined;
  readonly accounts: readonly ProfileAccount[];
  readonly topics: readonly string[];
}

const LABELS: Readonly<Record<string, string>> = {
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  x: 'X',
  github: 'GitHub',
  linkedin: 'LinkedIn',
  reddit: 'Reddit',
  youtube: 'YouTube',
  instagram: 'Instagram',
  nostr: 'Nostr',
  website: 'Website',
};

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** A label for an account: the network's name, or the host for a plain site. */
export function labelFor(url: string, network?: Network): string {
  if (network && LABELS[network]) return LABELS[network] as string;
  return hostOf(url) ?? 'Link';
}

function stripTags(html: string): string {
  return collapse(html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' '));
}

/** Every http(s) URL written out in plain text. */
export function urlsInText(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>()"']+/gi)) {
    found.add(match[0].replace(/[.,;:!?)]+$/, ''));
  }
  return [...found];
}

/** `#tag` words in a bio, lower-cased and deduplicated. */
export function hashtagsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]{2,40})/gu)) {
    found.add(match[1]!.toLowerCase());
  }
  return [...found];
}

function account(url: string, relation: 'me' | 'link'): ProfileAccount {
  const network = networkForUrl(url);
  return { url, network, relation, label: labelFor(url, network) };
}

function samePage(a: string, b: string): boolean {
  const norm = (url: string) =>
    url
      .replace(/^https?:\/\/(www\.)?/i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * What a page says about the person behind it: OpenGraph card, every
 * `rel="me"` link, and a linked OpenProfile.md if it advertises one.
 *
 * The OpenGraph title is the page's name for itself, which on a profile page
 * is usually the person and on a home page is usually the site. Callers
 * decide which; this only reads.
 */
export function extractProfilePage(html: string, pageUrl: string): ProfileFacts {
  const title =
    metaContent(html, 'property', 'og:title') ??
    collapse(html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] ?? '');
  const description =
    metaContent(html, 'property', 'og:description') ?? metaContent(html, 'name', 'description');
  const image = metaContent(html, 'property', 'og:image');

  const accounts = new Map<string, ProfileAccount>();
  let openprofileUrl: string | undefined;

  for (const anchor of anchors(html)) {
    const href = resolveHref(anchor.href, pageUrl);
    if (!href) continue;
    if (/^mailto:/i.test(href)) {
      if (isRelMe(anchor.tag))
        accounts.set(href.toLowerCase(), { url: href, relation: 'me', label: 'Email' });
      continue;
    }
    if (!/^https?:\/\//i.test(href) || samePage(href, pageUrl)) continue;
    const relation: 'me' | 'link' = isRelMe(anchor.tag) ? 'me' : 'link';
    const existing = accounts.get(href);
    if (existing?.relation === 'me') continue;
    // A plain link is only worth keeping when it names a network we know;
    // rel=me is kept whatever it points at, because the page said so.
    if (relation === 'link' && !networkForUrl(href)) continue;
    accounts.set(href, { ...account(href, relation) });
  }

  // `<link rel="me">` in the head counts the same as an anchor.
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const href = resolveHref(/href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1], pageUrl);
    if (!href) continue;
    if (/rel\s*=\s*["'][^"']*\bopenprofile\b/i.test(tag)) openprofileUrl ??= href;
    else if (isRelMe(tag) && /^https?:\/\//i.test(href) && !samePage(href, pageUrl)) {
      accounts.set(href, { ...account(href, 'me') });
    }
  }

  const text = stripTags(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));

  return {
    source: pageUrl,
    name: title || undefined,
    headline: description ? collapse(description) : undefined,
    avatar: image ? resolveHref(image, pageUrl) : undefined,
    accounts: [...accounts.values()],
    topics: hashtagsIn(description ?? '')
      .concat(hashtagsIn(text.slice(0, 2000)))
      .filter((topic, index, all) => all.indexOf(topic) === index),
    openprofileUrl,
  };
}

function resolveHref(href: string | undefined, base: string): string | undefined {
  if (!href) return undefined;
  const trimmed = decodeEntities(href.trim());
  if (!trimmed || trimmed.startsWith('#') || /^javascript:/i.test(trimmed)) return undefined;
  if (/^mailto:/i.test(trimmed)) return trimmed;
  try {
    return new URL(trimmed, base).toString();
  } catch {
    return undefined;
  }
}

interface ReaderOptions {
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

async function getJson<T>(url: string, options: ReaderOptions): Promise<T | undefined> {
  const call = options.fetchImpl ?? fetch;
  try {
    const response = await call(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } catch {
    return undefined;
  }
}

interface BlueskyActor {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
}

/** A Bluesky profile from the public AppView. No token, no session. */
export async function readBlueskyProfile(
  handle: string,
  options: ReaderOptions = {},
): Promise<ProfileFacts | undefined> {
  const actor = handle
    .replace(/^@/, '')
    .replace(/^https?:\/\/bsky\.app\/profile\//i, '')
    .replace(/\/.*$/, '');
  if (!actor) return undefined;
  const found = await getJson<BlueskyActor>(
    `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`,
    options,
  );
  if (!found?.handle) return undefined;

  const bio = found.description ?? '';
  const links = urlsInText(bio);
  const web = links.find((url) => !networkForUrl(url));
  return {
    source: `https://bsky.app/profile/${found.handle}`,
    name: found.displayName?.trim() || undefined,
    headline: bio
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean),
    avatar: found.avatar,
    web,
    accounts: links.map((url) => account(url, 'link')),
    topics: hashtagsIn(bio),
    platformUserId: found.did,
  };
}

interface MastodonAccount {
  id?: string;
  acct?: string;
  url?: string;
  display_name?: string;
  note?: string;
  avatar?: string;
  fields?: { name?: string; value?: string; verified_at?: string | null }[];
}

/** A Mastodon (or compatible) profile from the instance's public lookup. */
export async function readMastodonProfile(
  ref: string,
  options: ReaderOptions = {},
): Promise<ProfileFacts | undefined> {
  const parsed = /^https?:\/\//i.test(ref)
    ? parseFediverseUrl(ref)
    : parseFediverseHandle(ref.startsWith('@') ? ref : `@${ref}`);
  if (!parsed) return undefined;
  const found = await getJson<MastodonAccount>(
    `https://${parsed.host}/api/v1/accounts/lookup?acct=${encodeURIComponent(parsed.user)}`,
    options,
  );
  if (!found?.acct) return undefined;

  const bio = stripTags(found.note ?? '');
  const accounts = new Map<string, ProfileAccount>();
  let web: string | undefined;
  for (const field of found.fields ?? []) {
    for (const url of urlsInText(stripTags(field.value ?? '')).concat(
      urlsInText(field.value ?? ''),
    )) {
      const relation: 'me' | 'link' = field.verified_at ? 'me' : 'link';
      const existing = accounts.get(url);
      if (existing?.relation === 'me') continue;
      accounts.set(url, account(url, relation));
      if (!web && !networkForUrl(url)) web = url;
    }
  }
  for (const url of urlsInText(bio)) {
    if (!accounts.has(url)) accounts.set(url, account(url, 'link'));
    if (!web && !networkForUrl(url)) web = url;
  }

  return {
    source: found.url ?? parsed.profileUrl,
    name: found.display_name?.trim() || undefined,
    headline: bio.split(/(?<=[.!?])\s+/).find(Boolean),
    avatar: found.avatar,
    web,
    accounts: [...accounts.values()],
    topics: hashtagsIn(bio),
    platformUserId: found.id ? `${parsed.host}:${found.id}` : undefined,
  };
}

/**
 * The person's own OpenProfile.md at a site, if they serve one.
 *
 * Tries the linked URL first, then the well-known path. Accepts only a body
 * that starts with a Markdown heading, because a site that answers every
 * path with its home page would otherwise hand us HTML as a profile.
 */
export async function readPublishedOpenProfile(
  candidates: readonly string[],
  options: ReaderOptions = {},
): Promise<{ url: string; markdown: string } | undefined> {
  const call = options.fetchImpl ?? fetch;
  for (const url of candidates) {
    try {
      const response = await call(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) continue;
      const body = (await response.text()).trim();
      if (/^#\s+\S/.test(body) && !/^\s*<!doctype|<html/i.test(body))
        return { url, markdown: body.slice(0, 64_000) };
    } catch {
      // The next candidate may still answer.
    }
  }
  return undefined;
}

/** `https://ada.example/blog/x` → `https://ada.example/.well-known/openprofile.md`. */
export function wellKnownOpenProfile(url: string): string | undefined {
  try {
    return new URL('/.well-known/openprofile.md', url).toString();
  } catch {
    return undefined;
  }
}

/**
 * Fold several sources into one profile. Earlier sources win on every scalar,
 * so callers list them most trusted first; accounts merge with `me` beating
 * `link` for the same URL, and the profile's own URL is always listed.
 */
export function mergeFacts(
  handle: string,
  profileUrl: string,
  facts: readonly ProfileFacts[],
): ProfileInput {
  const first = <K extends keyof ProfileFacts>(key: K): ProfileFacts[K] | undefined =>
    facts.map((fact) => fact[key]).find((value) => value !== undefined && value !== '');

  const accounts = new Map<string, ProfileAccount>();
  accounts.set(profileUrl, account(profileUrl, 'me'));
  for (const fact of facts) {
    for (const entry of fact.accounts) {
      const existing = accounts.get(entry.url);
      if (existing?.relation === 'me') continue;
      accounts.set(entry.url, entry);
    }
  }
  const email = [...accounts.values()]
    .find((entry) => /^mailto:/i.test(entry.url))
    ?.url.replace(/^mailto:/i, '')
    .split('?')[0];

  const topics = [...new Set(facts.flatMap((fact) => fact.topics))];
  return {
    name: (first('name') as string | undefined) ?? handle.replace(/^@/, ''),
    handle: handle.replace(/^@/, ''),
    kind: 'person',
    headline: first('headline') as string | undefined,
    web: first('web') as string | undefined,
    avatar: first('avatar') as string | undefined,
    email,
    accounts: [...accounts.values()].filter((entry) => !/^mailto:/i.test(entry.url)),
    topics,
  };
}

/** Render the Markdown the spec describes. One `#`, an identity block, one line, sections. */
export function buildOpenProfile(input: ProfileInput): string {
  const lines: string[] = [`# ${input.name.trim() || input.handle}`, ''];
  lines.push(`- **Kind**: ${input.kind ?? 'person'}`);
  lines.push(`- **Handle**: @${input.handle.replace(/^@/, '')}`);
  if (input.web) lines.push(`- **Web**: ${input.web}`);
  if (input.email) lines.push(`- **Email**: ${input.email}`);
  if (input.avatar) lines.push(`- **Avatar**: ${input.avatar}`);
  lines.push('');
  if (input.headline) lines.push(input.headline.trim(), '');

  // The home page is the Web line; listing it again under Links says nothing new.
  const isWeb = (entry: ProfileAccount) => Boolean(input.web && samePage(entry.url, input.web));
  const me = input.accounts.filter((entry) => entry.relation === 'me' && !isWeb(entry));
  const links = input.accounts.filter((entry) => entry.relation === 'link' && !isWeb(entry));
  if (me.length) {
    lines.push('## Accounts', '');
    for (const entry of me) lines.push(`- [${entry.label}](${entry.url})`);
    lines.push('');
  }
  if (input.topics.length) {
    lines.push('## Topics', '', `- ${input.topics.join(', ')}`, '');
  }
  if (links.length) {
    lines.push('## Links', '');
    for (const entry of links) lines.push(`- [${entry.label}](${entry.url})`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
