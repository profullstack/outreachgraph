/**
 * Deterministic extraction — the first half of the hybrid.
 *
 * Everything here reads markup the site published *about itself*: JSON-LD,
 * OpenGraph, `rel="me"`, outbound links to networks we know. That matters
 * beyond convenience. The grounding rule says no claim without stored
 * evidence, and a value lifted from a site's own structured data has evidence
 * by construction — we can point at the element it came from.
 *
 * The model only runs when this finds nothing, so a site with decent markup
 * never costs a token.
 */

import type { Network } from '@outreachgraph/domain';
import type { CandidateIdentity, PersonCandidate } from '../provider';
import { parseFediverseUrl } from './fediverse';

export interface ExtractedCompany {
  readonly name?: string;
  readonly description?: string;
  readonly domain?: string;
  readonly location?: string;
  /** Company-level profiles found on the page, e.g. its own X account. */
  readonly identities: readonly CandidateIdentity[];
}

export interface SiteExtraction {
  readonly company: ExtractedCompany;
  readonly people: readonly PersonCandidate[];
  /** Which routes produced something, for the log and for tests. */
  readonly usedSignals: readonly string[];
}

/** Hosts that identify a network, longest-first so `x.com` beats a bare match. */
const NETWORK_HOSTS: readonly (readonly [RegExp, Network])[] = [
  [/(^|\.)github\.com$/i, 'github'],
  [/(^|\.)twitter\.com$/i, 'x'],
  [/(^|\.)x\.com$/i, 'x'],
  [/(^|\.)bsky\.app$/i, 'bluesky'],
  [/(^|\.)linkedin\.com$/i, 'linkedin'],
  [/(^|\.)reddit\.com$/i, 'reddit'],
  [/(^|\.)youtube\.com$/i, 'youtube'],
  [/(^|\.)instagram\.com$/i, 'instagram'],
];

function knownHostNetwork(url: string): Network | undefined {
  try {
    const host = new URL(url).hostname;
    return NETWORK_HOSTS.find(([pattern]) => pattern.test(host))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The network a link belongs to.
 *
 * Ordering is load-bearing. The host map runs first so `youtube.com/@name` is a
 * YouTube channel rather than a Fediverse account — both use `/@name`, and only
 * the host tells them apart. Fediverse detection is the fallback precisely
 * because its hosts cannot be enumerated: Mastodon is thousands of independent
 * servers and anyone can start another one this afternoon, so shape is the only
 * durable signal.
 */
export function networkForUrl(url: string): Network | undefined {
  return knownHostNetwork(url) ?? (parseFediverseUrl(url) ? 'mastodon' : undefined);
}

/** `https://github.com/octocat/repo` → `octocat`. */
/**
 * Path roots that carry the handle in the *next* segment rather than this one.
 */
const NESTED_ROOTS = /^(company|school|showcase|in|pub|c|channel|user|r|profile)$/i;

/**
 * Path roots that are content, search or site furniture — never an account.
 *
 * Found by crawling stripe.com: a footer link to a YouTube video produced the
 * "handle" `watch`, which would have been resolved as if it were somebody's
 * account. A junk identity is worse than a missing one, because the resolver
 * treats it as a claim worth weighing.
 */
const NOT_HANDLES =
  /^(watch|playlist|embed|shorts|results|feed|hashtag|search|explore|about|legal|terms|privacy|help|login|signup|share|intent|home|posts|status|p|reel|stories|tv|jobs|pricing|blog|docs|features|events|groups|topics|orgs|sponsors|marketplace|pulse|learning|today|new|trending)$/i;

export function handleFromUrl(url: string): string | undefined {
  // A Fediverse handle is `user@host`, not a path segment, and the host is the
  // one that *owns* the account rather than the one serving the page. Taking
  // the first segment of `defcon.social/@b0rk@jvns.ca` would yield the handle
  // `@b0rk@jvns.ca` filed under defcon.social, and every later lookup would go
  // to a server that has never heard of the account.
  if (!knownHostNetwork(url)) {
    const account = parseFediverseUrl(url);
    if (account) return account.acct;
  }

  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const first = segments[0];
    if (!first) return undefined;

    const candidate = NESTED_ROOTS.test(first) ? segments[1] : first;
    if (!candidate) return undefined;
    if (NOT_HANDLES.test(candidate)) return undefined;

    // A handle is one path segment of plausible characters. Anything carrying
    // a dot-extension or punctuation beyond the usual is a file or a page.
    if (!/^[@\w][\w.-]{0,63}$/.test(candidate)) return undefined;
    if (/\.(html?|php|aspx?|jsp)$/i.test(candidate)) return undefined;

    return candidate;
  } catch {
    return undefined;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function collapse(text: string): string {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

/** Every `<script type="application/ld+json">` payload on the page. */
function jsonLdBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  const pattern =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

  for (const match of html.matchAll(pattern)) {
    const body = match[1];
    if (!body) continue;
    try {
      const parsed: unknown = JSON.parse(body.trim());
      // A page may ship one object, an array, or an @graph wrapper.
      if (Array.isArray(parsed)) blocks.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        const graph = (parsed as { '@graph'?: unknown })['@graph'];
        if (Array.isArray(graph)) blocks.push(...graph);
        else blocks.push(parsed);
      }
    } catch {
      // Malformed JSON-LD is extremely common and is not an error worth
      // failing a crawl over. The other routes still run.
    }
  }

  return blocks;
}

function typeOf(node: unknown): string[] {
  if (!node || typeof node !== 'object') return [];
  const raw = (node as { '@type'?: unknown })['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

function stringField(node: unknown, field: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as Record<string, unknown>)[field];
  if (typeof value === 'string' && value.trim()) return collapse(value);
  // schema.org allows a nested object with a name, e.g. an address or a brand.
  if (value && typeof value === 'object') {
    const nested = (value as Record<string, unknown>).name;
    if (typeof nested === 'string' && nested.trim()) return collapse(nested);
  }
  return undefined;
}

function urlList(node: unknown, field: string): string[] {
  if (!node || typeof node !== 'object') return [];
  const value = (node as Record<string, unknown>)[field];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function metaContent(html: string, attr: 'property' | 'name', key: string): string | undefined {
  const pattern = new RegExp(
    `<meta\\b[^>]*${attr}\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    'i',
  );
  const reversed = new RegExp(
    `<meta\\b[^>]*content\\s*=\\s*["']([^"']*)["'][^>]*${attr}\\s*=\\s*["']${key}["']`,
    'i',
  );
  const found = html.match(pattern)?.[1] ?? html.match(reversed)?.[1];
  return found && found.trim() ? collapse(found) : undefined;
}

/**
 * Every anchor on the page, with its href and where it starts.
 *
 * The alternation exists because HTML minifiers drop the quotes around any
 * attribute value that needs none, and a URL usually needs none — so a minified
 * page ships `href=https://twitter.com/someone`. A quotes-only pattern reads
 * that as no link at all.
 *
 * This is not a rare edge. Smashing Magazine's about page carries thirteen
 * distinct social links and the crawler reported the company as having none,
 * because every one of them is unquoted. Any site behind an HTML minifier had
 * its entire social graph invisible to us.
 */
export interface Anchor {
  readonly href: string;
  /** The opening tag alone, for attribute tests like `rel="me"`. */
  readonly tag: string;
  /**
   * The whole element, opening tag through `</a>`.
   *
   * Carried because the label that says whose link this is usually lives in the
   * *content* rather than the tag — an avatar's `alt` text, most often. Without
   * it, a linked portrait is an anonymous URL sitting near somebody's name.
   */
  readonly element: string;
  readonly index: number;
}

/** How much of an anchor's content to keep. Long enough for a label, no more. */
const MAX_ANCHOR_CONTENT = 400;

export function anchors(html: string): Anchor[] {
  const found: Anchor[] = [];
  const pattern = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>/gi;

  for (const match of html.matchAll(pattern)) {
    const href = match[1] ?? match[2] ?? match[3];
    if (!href || match.index === undefined) continue;

    // The closing tag is searched for rather than matched, so an anchor that
    // was never closed still yields its opening tag instead of nothing.
    const from = match.index + match[0].length;
    const closing = html.indexOf('</a', from);
    const end =
      closing === -1 || closing - from > MAX_ANCHOR_CONTENT ? from + MAX_ANCHOR_CONTENT : closing;

    found.push({
      href,
      tag: match[0],
      element: html.slice(match.index, Math.min(end, html.length)),
      index: match.index,
    });
  }

  return found;
}

/**
 * A person's name used as an element's own label, if it carries one.
 *
 * `alt` and `title` on a linked portrait are the page stating who the link is
 * for. That statement outranks any neighbouring heading, and — more importantly
 * — a label naming somebody we have *not* heard of is proof the link is not the
 * nearest known person's.
 */
export function labelName(element: string): string | undefined {
  for (const match of element.matchAll(
    /\b(?:alt|title)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi,
  )) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    // Two to four capitalised words: the shape of a person's name, and not of
    // "Read more", "LinkedIn", or a file name.
    if (/^[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’.-]+){1,3}$/u.test(raw)) return raw;
  }

  return undefined;
}

/** True when an anchor tag carries `rel="me"`, quoted or not. */
export function isRelMe(tag: string): boolean {
  return /rel\s*=\s*(?:["'][^"']*\bme\b[^"']*["']|me\b)/i.test(tag);
}

/** Outbound links, plus anything the page marked `rel="me"`. */
function linkedProfiles(html: string): CandidateIdentity[] {
  const found = new Map<string, CandidateIdentity>();

  for (const match of anchors(html)) {
    const href = match.href;
    if (!href) continue;
    const network = networkForUrl(href);
    if (!network) continue;

    const handle = handleFromUrl(href);
    if (!handle) continue;

    const key = `${network}:${handle.toLowerCase()}`;
    if (found.has(key)) continue;

    found.set(key, {
      network,
      handle,
      profileUrl: href,
      // A link the site published is a self-declared association, but the page
      // is the *company's*, so it says less about any individual than a
      // person's own profile does. The resolver weighs it accordingly.
      providerConfidence: isRelMe(match.tag) ? 0.9 : 0.6,
    });
  }

  return [...found.values()];
}

function domainOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/**
 * Reads what a page says about the organisation behind it.
 *
 * Order is by trustworthiness, not convenience: JSON-LD is a deliberate
 * machine-readable statement, OpenGraph is for social cards and is often the
 * page title rather than the company, and `<title>` is a last resort.
 */
export function extractCompany(html: string, pageUrl: string): ExtractedCompany {
  const blocks = jsonLdBlocks(html);
  const org = blocks.find((node) =>
    typeOf(node).some((t) => /^(Organization|Corporation|LocalBusiness|NGO)$/i.test(t)),
  );

  const identities = new Map<string, CandidateIdentity>();
  for (const identity of linkedProfiles(html)) {
    identities.set(`${identity.network}:${identity.handle?.toLowerCase()}`, identity);
  }

  // `sameAs` is schema.org's own cross-link field and is the strongest thing a
  // company page offers about its other profiles.
  for (const url of urlList(org, 'sameAs')) {
    const network = networkForUrl(url);
    const handle = handleFromUrl(url);
    if (!network || !handle) continue;
    identities.set(`${network}:${handle.toLowerCase()}`, {
      network,
      handle,
      profileUrl: url,
      providerConfidence: 0.9,
    });
  }

  const name =
    stringField(org, 'name') ??
    metaContent(html, 'property', 'og:site_name') ??
    metaContent(html, 'property', 'og:title') ??
    collapse(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') ??
    undefined;

  const description =
    stringField(org, 'description') ??
    metaContent(html, 'property', 'og:description') ??
    metaContent(html, 'name', 'description');

  const location = stringField(org, 'address');

  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(domainOf(pageUrl) ? { domain: domainOf(pageUrl)! } : {}),
    ...(location ? { location } : {}),
    identities: [...identities.values()],
  };
}

/**
 * People the page names in structured data.
 *
 * Only JSON-LD `Person`, and only entries carrying a name. Guessing at people
 * from prose is exactly the job handed to the model, and inventing a colleague
 * from a stray capitalised phrase is worse than finding nobody.
 */
export function extractPeople(
  html: string,
  pageUrl: string,
  company: ExtractedCompany,
): PersonCandidate[] {
  const observedAt = new Date().toISOString();
  const people: PersonCandidate[] = [];
  const seen = new Set<string>();

  for (const node of jsonLdBlocks(html)) {
    if (!typeOf(node).some((t) => /^Person$/i.test(t))) continue;

    const fullName = stringField(node, 'name');
    if (!fullName) continue;

    const key = fullName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const identities: CandidateIdentity[] = [];
    for (const url of [...urlList(node, 'sameAs'), ...urlList(node, 'url')]) {
      const network = networkForUrl(url);
      const handle = handleFromUrl(url);
      if (!network || !handle) continue;
      identities.push({ network, handle, profileUrl: url, providerConfidence: 0.9 });
    }

    people.push({
      fullName,
      ...(stringField(node, 'jobTitle') ? { title: stringField(node, 'jobTitle')! } : {}),
      ...(company.name ? { companyName: company.name } : {}),
      ...(company.domain ? { companyDomain: company.domain } : {}),
      identities,
      observedAt,
      sourceRecordId: pageUrl,
    });
  }

  return people;
}

export function extractSite(html: string, pageUrl: string): SiteExtraction {
  const company = extractCompany(html, pageUrl);
  const people = extractPeople(html, pageUrl, company);

  const usedSignals: string[] = [];
  if (jsonLdBlocks(html).length > 0) usedSignals.push('json-ld');
  if (metaContent(html, 'property', 'og:site_name')) usedSignals.push('opengraph');
  if (company.identities.length > 0) usedSignals.push('links');

  return { company, people, usedSignals };
}
