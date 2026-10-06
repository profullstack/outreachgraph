/**
 * Finding a lead's LinkedIn profile and job title through Google results,
 * because LinkedIn's own search needs a login and this product never logs in
 * there (see CLAUDE.md: LinkedIn acts only through the member's session).
 *
 * Ported from cli-tools `linkedin-lookup`, where it ran over ~2,000 queries
 * of a real user list. A result is taken only when it is evidence, by the
 * same standard the photo lookup uses (`carriesName`):
 *
 *   - the link is a `linkedin.com/in/<slug>` profile and its title carries
 *     every part of the name;
 *   - with a company, the company's name (the domain's first label) is in the
 *     title or the snippet too;
 *   - with no company, exactly one profile in the results carries the name,
 *     and its slug is the name: "John Smith" alone is everybody.
 *
 * The title is read off the result title, which Google shows as
 * `Name - Title - Company | LinkedIn`. A lead still without a profile but
 * with a company domain gets the company's `linkedin.com/company/<slug>`
 * page instead, taken only when the result names the domain or the company.
 */

import { carriesName } from './index';

export interface SerpResult {
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly snippet?: string | undefined;
}

export interface LinkedinSubject {
  readonly firstName: string;
  readonly lastName: string;
  /** The employer's own domain, when known. Never a webmail host. */
  readonly companyDomain?: string | undefined;
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** `shop.acme.co.uk` -> `acme.co.uk`: the domain a company registered. */
export function registrable(domain: string): string {
  const labels = domain
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.');
  const secondLast = labels[labels.length - 2] ?? '';
  const last = labels[labels.length - 1] ?? '';
  const keep =
    labels.length >= 3 && /^(co|com|org|net|ac|gov|edu)$/.test(secondLast) && last.length === 2
      ? 3
      : 2;
  return labels.slice(-keep).join('.');
}

/** `shop.acme.co.uk` -> `acme`: the label a company is usually called by. */
export function companyToken(domain: string): string {
  return registrable(domain).split('.')[0] ?? '';
}

/** The profile or company slug as words: `/in/ada-lovelace-42` -> `ada lovelace 42`. */
function slugWords(url: string): string {
  return (url.split('/').pop() ?? '').replace(/[-_.]+/g, ' ');
}

/** A LinkedIn profile (`in`) or company page URL, canonical, or '' for anything else. */
export function linkedinPath(link: string | undefined, kind: 'in' | 'company'): string {
  if (!link) return '';
  try {
    const url = new URL(link);
    const host = url.hostname.toLowerCase();
    if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return '';
    const match = (kind === 'in' ? /^\/in\/([^/]+)/ : /^\/company\/([^/]+)/).exec(url.pathname);
    if (!match?.[1]) return '';
    return `https://www.linkedin.com/${kind}/${decodeURIComponent(match[1])}`;
  } catch {
    return '';
  }
}

export function personQuery(subject: LinkedinSubject): string {
  const name = `${subject.firstName} ${subject.lastName}`.trim();
  const company = subject.companyDomain ? companyToken(subject.companyDomain) : '';
  return `site:linkedin.com/in "${name}"${company ? ` ${company}` : ''}`;
}

/** The one profile the results evidence for this person, or ''. */
export function pickPerson(results: readonly SerpResult[], subject: LinkedinSubject): string {
  const name = `${subject.firstName} ${subject.lastName}`;
  const company = subject.companyDomain ? fold(companyToken(subject.companyDomain)) : '';
  const profiles = new Set<string>();
  for (const result of results) {
    const url = linkedinPath(result.link, 'in');
    if (!url || !carriesName(result.title ?? '', name)) continue;
    if (company) {
      if (company.length >= 3 && fold(`${result.title} ${result.snippet}`).includes(company)) {
        return url;
      }
    } else if (carriesName(slugWords(url), name)) {
      profiles.add(url);
    }
  }
  return profiles.size === 1 ? ([...profiles][0] ?? '') : '';
}

/**
 * The headline from a profile result's title. With two parts the second is
 * as often the company as the title, so it only counts when it is not the
 * company's name.
 */
export function titleFromResult(title: string, companyDomain = ''): string {
  const parts = title
    .replace(/\s*[|·]\s*LinkedIn.*$/i, '')
    .split(/\s+[-–—]\s+/)
    .map((part) => part.trim());
  const candidate = parts.length >= 2 ? (parts[1] ?? '') : '';
  if (candidate.length < 2 || candidate.length > 100 || candidate.endsWith('...')) return '';
  const company = companyDomain ? fold(companyToken(companyDomain)) : '';
  if (parts.length === 2 && company && fold(candidate).replace(/\s+/g, '').includes(company)) {
    return '';
  }
  return candidate;
}

export function companyQuery(domain: string): string {
  return `site:linkedin.com/company "${registrable(domain)}"`;
}

/**
 * The company page whose title or slug names the company, or whose text
 * carries the domain itself. A snippet that merely mentions the name is not
 * enough: a school district's name turns up on every one of its schools' pages.
 */
export function pickCompany(results: readonly SerpResult[], domain: string): string {
  const site = registrable(domain);
  const token = fold(companyToken(domain));
  for (const result of results) {
    const url = linkedinPath(result.link, 'company');
    if (!url) continue;
    const named = fold(`${result.title} ${slugWords(url)}`).replace(/\s+/g, '');
    if (
      fold(`${result.title} ${result.snippet}`).includes(site) ||
      (token.length >= 3 && named.includes(token))
    ) {
      return url;
    }
  }
  return '';
}
