/**
 * What the product tells you while it runs unattended.
 *
 * Autopilot means nobody is watching the screen, so the mail *is* the
 * interface. Two kinds, and the split matters:
 *
 *   - A **lead alert** is an interruption. It fires the moment someone worth
 *     talking to is found, and it has to be worth the interruption — one
 *     person, why they surfaced, and what was sent to them.
 *   - The **daily digest** is a summary. It is the thing you read instead of
 *     opening the app, so it has to be complete enough that not opening the
 *     app is a reasonable choice.
 *
 * Both are written to be readable with images off and links unclicked, because
 * that is how most people will see them.
 */

import type { Message } from './mailer';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Absolute, on the origin the links point at. Same derivation as the verify mail. */
function markUrl(link: string): string | undefined {
  try {
    return new URL('/favicon.png', link).toString();
  } catch {
    return undefined;
  }
}

function markHtml(appUrl: string): string {
  const mark = markUrl(appUrl);
  return mark
    ? `<p><img src="${escapeHtml(mark)}" alt="OutreachGraph" width="48" height="48" ` +
        'style="width:48px;height:48px;border:0" /></p>'
    : '';
}

/** The one-line "why you got this and how to stop" footer both mails carry. */
function footer(appUrl: string): { text: string; html: string } {
  const settings = `${appUrl.replace(/\/$/, '')}/settings`;
  return {
    text: `\n\n—\nYou are getting this because notifications are on for your workspace.\nChange or switch them off: ${settings}`,
    html:
      '<hr style="border:0;border-top:1px solid #e5e5e5;margin:24px 0" />' +
      '<p style="color:#666;font-size:13px">You are getting this because notifications are on ' +
      `for your workspace. <a href="${escapeHtml(settings)}">Change or switch them off</a>.</p>`,
  };
}

export interface LeadAlert {
  readonly personName: string;
  readonly personId: string;
  readonly title?: string;
  readonly companyName?: string;
  readonly companyDomain?: string;
  readonly opportunity?: number;
  /** Why this person surfaced — the recommendation's reason, in its own words. */
  readonly reason?: string;
  /** The signals the draft was grounded in, one line each. */
  readonly evidence?: readonly string[];
  /** Set when autopilot already sent to them; absent when it is waiting on you. */
  readonly sentTo?: string;
  readonly draftSubject?: string;
  readonly draftBody?: string;
}

/**
 * The instant "we found someone" mail.
 *
 * The subject line carries the name and company because that is all most
 * people will read on a phone, and a subject of "New lead" tells them nothing
 * they can act on.
 */
export function leadAlertEmail(to: string, alert: LeadAlert, appUrl: string): Message {
  const base = appUrl.replace(/\/$/, '');
  const link = `${base}/prospects/${alert.personId}`;
  const where = [alert.title, alert.companyName].filter(Boolean).join(' at ');

  const subject = alert.companyName
    ? `New lead: ${alert.personName} at ${alert.companyName}`
    : `New lead: ${alert.personName}`;

  const status = alert.sentTo
    ? `Autopilot has already written to them at ${alert.sentTo}. Replies come straight to you.`
    : 'This one is waiting for your approval before anything is sent.';

  const text = [
    `${alert.personName}${where ? ` — ${where}` : ''}`,
    alert.companyDomain ? alert.companyDomain : '',
    alert.opportunity !== undefined ? `Opportunity score: ${alert.opportunity}` : '',
    '',
    alert.reason ? `Why: ${alert.reason}` : '',
    alert.evidence?.length
      ? `\nBased on:\n${alert.evidence.map((e) => `  · ${e}`).join('\n')}`
      : '',
    '',
    status,
    '',
    alert.draftSubject ? `Subject: ${alert.draftSubject}` : '',
    alert.draftBody ? `\n${alert.draftBody}` : '',
    '',
    link,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const foot = footer(base);

  const html = [
    markHtml(base),
    `<p style="font-size:18px;margin:0 0 4px"><strong>${escapeHtml(alert.personName)}</strong></p>`,
    where ? `<p style="margin:0 0 12px;color:#444">${escapeHtml(where)}</p>` : '',
    alert.opportunity !== undefined
      ? `<p style="margin:0 0 12px">Opportunity score <strong>${alert.opportunity}</strong></p>`
      : '',
    alert.reason ? `<p>${escapeHtml(alert.reason)}</p>` : '',
    alert.evidence?.length
      ? `<ul>${alert.evidence.map((e) => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
      : '',
    `<p>${escapeHtml(status)}</p>`,
    alert.draftBody
      ? '<blockquote style="border-left:3px solid #e5e5e5;margin:16px 0;padding:4px 0 4px 12px;color:#333">' +
        (alert.draftSubject
          ? `<p style="margin:0 0 8px"><strong>${escapeHtml(alert.draftSubject)}</strong></p>`
          : '') +
        `<p style="margin:0;white-space:pre-wrap">${escapeHtml(alert.draftBody)}</p>` +
        '</blockquote>'
      : '',
    `<p><a href="${escapeHtml(link)}">Open this prospect</a></p>`,
    foot.html,
  ].join('');

  return { to, subject: `${subject} · OutreachGraph`, text: text + foot.text, html };
}

export interface DigestLead {
  readonly personName: string;
  readonly personId: string;
  readonly title?: string;
  readonly companyName?: string;
  readonly opportunity?: number;
  readonly sentTo?: string;
}

export interface DailyDigest {
  /** The UTC date this digest covers, `YYYY-MM-DD`. */
  readonly date: string;
  readonly sitesCrawled: number;
  readonly peopleFound: number;
  readonly messagesSent: number;
  readonly awaitingApproval: number;
  readonly repliesReceived?: number;
  readonly leads: readonly DigestLead[];
  /** Campaigns that produced nothing, and why, when the reason is knowable. */
  readonly notes?: readonly string[];
}

/**
 * The once-a-day summary.
 *
 * A digest for a day where nothing happened is still sent, and says so. The
 * alternative — silence — is indistinguishable from the product being broken,
 * which is the exact failure this whole change exists to fix.
 */
export function dailyDigestEmail(to: string, digest: DailyDigest, appUrl: string): Message {
  const base = appUrl.replace(/\/$/, '');
  const quiet = digest.peopleFound === 0 && digest.messagesSent === 0;

  const subject = quiet
    ? `Nothing new today · OutreachGraph`
    : `${digest.peopleFound} new ${digest.peopleFound === 1 ? 'lead' : 'leads'}, ` +
      `${digest.messagesSent} sent · OutreachGraph`;

  const counts = [
    `Sites read:        ${digest.sitesCrawled}`,
    `New people:        ${digest.peopleFound}`,
    `Messages sent:     ${digest.messagesSent}`,
    `Awaiting approval: ${digest.awaitingApproval}`,
    digest.repliesReceived !== undefined ? `Replies:           ${digest.repliesReceived}` : '',
  ].filter(Boolean);

  const leadLines = digest.leads.map((lead) => {
    const where = [lead.title, lead.companyName].filter(Boolean).join(' at ');
    const score = lead.opportunity !== undefined ? ` [${lead.opportunity}]` : '';
    const sent = lead.sentTo ? ' — written to' : '';
    return `  · ${lead.personName}${where ? ` — ${where}` : ''}${score}${sent}`;
  });

  const foot = footer(base);

  const text = [
    `OutreachGraph · ${digest.date}`,
    '',
    ...counts,
    '',
    quiet
      ? 'Nothing new came back today. Campaigns are still running.'
      : leadLines.length
        ? `Today's leads:\n${leadLines.join('\n')}`
        : '',
    digest.notes?.length ? `\nNotes:\n${digest.notes.map((n) => `  · ${n}`).join('\n')}` : '',
    '',
    `${base}/today`,
  ]
    .filter((line) => line !== '')
    .join('\n');

  const html = [
    markHtml(base),
    `<p style="font-size:18px;margin:0 0 12px"><strong>${escapeHtml(digest.date)}</strong></p>`,
    '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 16px">',
    row('Sites read', digest.sitesCrawled),
    row('New people', digest.peopleFound),
    row('Messages sent', digest.messagesSent),
    row('Awaiting approval', digest.awaitingApproval),
    digest.repliesReceived !== undefined ? row('Replies', digest.repliesReceived) : '',
    '</table>',
    quiet
      ? '<p>Nothing new came back today. Campaigns are still running.</p>'
      : digest.leads.length
        ? `<ul>${digest.leads
            .map((lead) => {
              const where = [lead.title, lead.companyName].filter(Boolean).join(' at ');
              const score = lead.opportunity !== undefined ? ` <em>[${lead.opportunity}]</em>` : '';
              const sent = lead.sentTo ? ' — written to' : '';
              return (
                `<li><a href="${escapeHtml(`${base}/prospects/${lead.personId}`)}">` +
                `${escapeHtml(lead.personName)}</a>` +
                `${where ? ` — ${escapeHtml(where)}` : ''}${score}${sent}</li>`
              );
            })
            .join('')}</ul>`
        : '',
    digest.notes?.length
      ? `<p style="color:#666">${digest.notes.map((n) => escapeHtml(n)).join('<br />')}</p>`
      : '',
    `<p><a href="${escapeHtml(`${base}/today`)}">Open OutreachGraph</a></p>`,
    foot.html,
  ].join('');

  return { to, subject, text: text + foot.text, html };
}

function row(label: string, value: number): string {
  return (
    `<tr><td style="padding:2px 16px 2px 0;color:#666">${escapeHtml(label)}</td>` +
    `<td style="padding:2px 0;text-align:right"><strong>${value}</strong></td></tr>`
  );
}
