/**
 * The daily buyer-lead digest: public posts from people looking for what a
 * brand sells, each with a quoted excerpt, the thread link, and a link to
 * draft a reply in the app.
 *
 * Replies are drafted, never posted: a human reads the thread and posts in
 * their own name. The mail says so, because the reader should not wonder
 * whether something already went out under their brand.
 */

import type { Message } from './mailer';
import { escapeHtml, footer, markHtml } from './notifications';

export interface CommunityLeadDigestItem {
  readonly id: string;
  /** 'reddit' | 'hackernews' | 'bluesky' */
  readonly source: string;
  readonly container?: string | undefined;
  readonly title?: string | undefined;
  readonly excerpt: string;
  readonly url: string;
  readonly intent: number;
  readonly reason?: string | undefined;
}

export interface CommunityLeadDigest {
  /** The UTC date, `YYYY-MM-DD`. */
  readonly date: string;
  /** Brand names the leads were found for, in order. */
  readonly brands: readonly string[];
  readonly leads: readonly CommunityLeadDigestItem[];
}

const SOURCE_NAMES: Record<string, string> = {
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  bluesky: 'Bluesky',
};

export function intentLabel(intent: number): string {
  return intent >= 80 ? 'High buyer intent' : intent >= 60 ? 'Buyer intent' : 'Possible intent';
}

function quote(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const DRAFTS_ONLY =
  'Replies are drafts. Nothing is posted for you: read the thread and post in your own name.';

export function communityLeadDigestEmail(
  to: string,
  digest: CommunityLeadDigest,
  appUrl: string,
): Message {
  const base = appUrl.replace(/\/$/, '');
  const n = digest.leads.length;
  const brands = digest.brands.join(', ');
  const things = `${n} fresh buyer ${n === 1 ? 'discussion' : 'discussions'}`;
  const subject = `${n} fresh buyer ${n === 1 ? 'lead' : 'leads'} for ${brands} · OutreachGraph`;
  const leadsUrl = `${base}/buyer-leads`;
  const draftUrl = (id: string) => `${base}/buyer-leads?lead=${encodeURIComponent(id)}`;
  const where = (lead: CommunityLeadDigestItem) =>
    `${SOURCE_NAMES[lead.source] ?? lead.source}${lead.container ? ` · ${lead.container}` : ''}`;

  const text = [
    `${things} found for ${brands}`,
    '',
    ...digest.leads.flatMap((lead) =>
      [
        `${where(lead).toUpperCase()} · ${intentLabel(lead.intent)} (${lead.intent})`,
        lead.title ?? '',
        `“${quote(lead.excerpt)}”`,
        lead.reason ? `Why: ${lead.reason}` : '',
        `Thread: ${lead.url}`,
        `Draft a reply: ${draftUrl(lead.id)}`,
      ]
        .filter(Boolean)
        .concat(''),
    ),
    `All leads: ${leadsUrl}`,
    DRAFTS_ONLY,
  ].join('\n');

  const card = (lead: CommunityLeadDigestItem) =>
    '<div style="border:1px solid #e5e5e5;border-radius:8px;padding:12px 14px;margin:0 0 12px">' +
    '<p style="margin:0 0 6px;font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.04em">' +
    `${escapeHtml(where(lead))} · <strong style="color:${lead.intent >= 80 ? '#15803d' : '#a16207'}">` +
    `${intentLabel(lead.intent)} ${lead.intent}</strong></p>` +
    (lead.title
      ? `<p style="margin:0 0 6px"><a href="${escapeHtml(lead.url)}"><strong>${escapeHtml(lead.title)}</strong></a></p>`
      : '') +
    '<blockquote style="margin:0 0 8px;padding:0 0 0 10px;border-left:3px solid #ddd;color:#333">' +
    `“${escapeHtml(quote(lead.excerpt))}”</blockquote>` +
    (lead.reason
      ? `<p style="margin:0 0 8px;color:#666;font-size:13px">${escapeHtml(lead.reason)}</p>`
      : '') +
    `<p style="margin:0"><a href="${escapeHtml(lead.url)}">Open the thread</a> · ` +
    `<a href="${escapeHtml(draftUrl(lead.id))}"><strong>Draft AI reply →</strong></a></p>` +
    '</div>';

  const foot = footer(base);
  const html = [
    markHtml(base),
    `<p style="font-size:18px;margin:0 0 4px"><strong>${things} for ${escapeHtml(brands)}</strong></p>`,
    `<p style="color:#666;margin:0 0 16px">High-intent posts in public communities, ${escapeHtml(digest.date)}</p>`,
    ...digest.leads.map(card),
    `<p><a href="${escapeHtml(leadsUrl)}">View all monitored leads</a></p>`,
    `<p style="color:#666;font-size:13px">${DRAFTS_ONLY}</p>`,
    foot.html,
  ].join('');

  return { to, subject, text: text + foot.text, html };
}
