import type { Message } from './mailer';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The brand mark, as an absolute URL on the same origin the link points at.
 *
 * Derived rather than configured, so there is no second base-URL setting to
 * drift out of sync with the one that builds the verification link. `logo.png`
 * is deliberately not used here: its "Outreach" is white, and mail clients
 * compose on white.
 *
 * Returns undefined for anything that is not a parseable absolute URL — a
 * relative link in a test or a local run should still produce a sendable
 * message, just without the image.
 */
function markUrl(link: string): string | undefined {
  try {
    return new URL('/favicon.png', link).toString();
  } catch {
    return undefined;
  }
}

/**
 * The verification email.
 *
 * Plain text carries the full link rather than hiding it behind an anchor,
 * because a verification mail that looks like a phishing test is one people
 * refuse to click — and because text-only clients must be able to finish
 * signup too.
 */
export function verificationEmail(to: string, link: string): Message {
  const text = [
    'Confirm your email to finish setting up OutreachGraph.',
    '',
    link,
    '',
    'The link expires in 24 hours. If you did not create this account you can',
    'ignore this message — nothing was sent on your behalf and no outreach can',
    'happen until an address is confirmed.',
  ].join('\n');

  const safe = escapeHtml(link);
  const mark = markUrl(link);

  const html = [
    // Sized in the attributes as well as the style, because Outlook ignores CSS
    // on images and would otherwise draw this at its full 512px.
    mark
      ? `<p><img src="${escapeHtml(mark)}" alt="OutreachGraph" width="48" height="48" ` +
        'style="width:48px;height:48px;border:0" /></p>'
      : '',
    '<p>Confirm your email to finish setting up OutreachGraph.</p>',
    `<p><a href="${safe}">${safe}</a></p>`,
    '<p>The link expires in 24 hours. If you did not create this account you can ',
    'ignore this message — nothing was sent on your behalf and no outreach can ',
    'happen until an address is confirmed.</p>',
  ].join('');

  return { to, subject: 'Confirm your email · OutreachGraph', text, html };
}
