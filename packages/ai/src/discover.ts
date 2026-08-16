/**
 * Turning a phrase into somewhere to look (PRD §11 targeting, §26 filters).
 *
 * The product could only ever be handed URLs. That is fine once you know who
 * you are chasing and useless before then — "dental practices in Austin" is
 * how people actually describe a market, and until now there was nowhere to
 * type it.
 *
 * This asks the model for real companies matching a description and returns
 * their domains. Two deliberate limits on how much that is trusted:
 *
 *   - **Nothing here is treated as fact.** A model naming a company is a lead
 *     to check, not a record. Every domain returned is then fetched by the
 *     crawler, and one that does not resolve or does not serve a page simply
 *     drops out of the run. The crawl is the verification step.
 *   - **No contact details are ever asked for.** Addresses come off the page
 *     the company published, never out of a model's memory, because an
 *     invented address is indistinguishable from a real one until it bounces.
 */

import type { TextModel } from './model';

export interface DiscoveredCompany {
  readonly name: string;
  /** Bare host, lowercased, no scheme and no `www.` */
  readonly domain: string;
  /** One line on why this company matches the description. */
  readonly reason?: string;
}

export interface DiscoveryResult {
  readonly ok: boolean;
  readonly companies: readonly DiscoveredCompany[];
  /** A short human name for the campaign this seeds. */
  readonly campaignName?: string;
  /** What the model understood the target market to be, for the campaign brief. */
  readonly brief?: string;
  readonly reason?: string;
}

const SYSTEM = [
  'You are given a description of a target market and you name real companies in it.',
  '',
  'Return one JSON object and nothing else:',
  '{',
  ' "campaignName": string,',
  ' "brief": string,',
  ' "companies": [{"name": string, "domain": string, "reason": string}]',
  '}',
  '',
  'Rules:',
  '- Only real companies you are confident exist, with the domain they actually use.',
  '- "domain" is a bare hostname: "acme.com", never a URL, never a path, no "www.".',
  '- Prefer the primary marketing site over a directory, marketplace or listing page.',
  '- Never return an aggregator, directory, review site, job board or social network',
  '  as a company — yelp.com is not a dental practice.',
  '- If the description names a place, the companies must actually operate there.',
  '- Return no contact details of any kind. No email addresses, no phone numbers.',
  '- If you are not confident of a real domain for a company, leave that company out.',
  '  A short accurate list is worth more than a long invented one.',
  '- "campaignName" is a few words a human would recognise, e.g. "Austin dental practices".',
  '- "brief" is one or two sentences describing who this campaign targets and why.',
].join('\n');

/** Hosts that are never a prospect company, whatever the model says. */
const NEVER = new Set([
  'google.com',
  'facebook.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'instagram.com',
  'yelp.com',
  'youtube.com',
  'wikipedia.org',
  'crunchbase.com',
  'indeed.com',
  'glassdoor.com',
  'tripadvisor.com',
  'amazon.com',
  'apple.com',
  'yellowpages.com',
  'bbb.org',
  'angi.com',
  'thumbtack.com',
  'example.com',
]);

/** Pulls the JSON object out of a reply that may be fenced or prefaced. */
function parseReply(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Reduces whatever the model wrote to a bare hostname, or rejects it.
 *
 * Models return `https://acme.com/about`, `www.acme.com` and `acme.com`
 * interchangeably for the same company, and a crawl queue that treats those as
 * three targets fetches the same site three times.
 */
export function normaliseDomain(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;

  let value = raw.trim().toLowerCase();
  if (!value) return undefined;

  value = value.replace(/^[a-z]+:\/\//, '');
  value = value.split('/')[0] ?? '';
  value = value.split('?')[0] ?? '';
  value = value.split('#')[0] ?? '';
  value = value.split('@').pop() ?? '';
  value = value.replace(/^www\./, '').replace(/\.$/, '');

  if (!value.includes('.')) return undefined;
  if (!/^[a-z0-9.-]+$/.test(value)) return undefined;
  if (value.startsWith('.') || value.includes('..')) return undefined;

  const tld = value.split('.').pop() ?? '';
  if (tld.length < 2) return undefined;
  if (NEVER.has(value)) return undefined;

  return value;
}

export interface DiscoverOptions {
  /** How many companies to ask for. The crawl budget is what really bounds it. */
  readonly limit?: number;
  /**
   * What the customer sells, when they have told us.
   *
   * Materially better targeting: "companies that would buy incident-response
   * training" beats the same query with no idea who is asking.
   */
  readonly offeringSummary?: string;
}

/**
 * Names companies matching a free-text market description.
 *
 * Never throws — a capped key or an unparseable reply comes back `ok: false`
 * with a reason worth showing, because the caller's fallback is to tell the
 * user to paste URLs instead, which is a worse start and not a crash.
 */
export async function discoverCompanies(
  model: TextModel,
  description: string,
  options: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const query = description.trim();
  if (!query) return { ok: false, companies: [], reason: 'nothing to search for' };

  const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);

  const user = [
    `Target market: ${query}`,
    options.offeringSummary ? `\nThe person searching sells: ${options.offeringSummary}` : '',
    `\nReturn up to ${limit} companies.`,
  ].join('');

  let reply;
  try {
    reply = await model.generate({ system: SYSTEM, user, maxTokens: 3000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, companies: [], reason: `the model could not be reached: ${message}` };
  }

  if (reply.refused) {
    return { ok: false, companies: [], reason: 'the model declined that search' };
  }

  const parsed = parseReply(reply.text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, companies: [], reason: 'the model did not return a usable list' };
  }

  const root = parsed as Record<string, unknown>;
  const rows = Array.isArray(root.companies) ? root.companies : [];

  const seen = new Set<string>();
  const companies: DiscoveredCompany[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const entry = row as Record<string, unknown>;

    const domain = normaliseDomain(entry.domain);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);

    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : domain;
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';

    companies.push({
      name: name.slice(0, 120),
      domain,
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
    });
    if (companies.length >= limit) break;
  }

  if (companies.length === 0) {
    return { ok: false, companies: [], reason: 'no companies could be identified for that' };
  }

  const campaignName =
    typeof root.campaignName === 'string' && root.campaignName.trim()
      ? root.campaignName.trim().slice(0, 120)
      : query.slice(0, 120);

  const brief = typeof root.brief === 'string' ? root.brief.trim().slice(0, 1000) : '';

  return { ok: true, companies, campaignName, ...(brief ? { brief } : {}) };
}
